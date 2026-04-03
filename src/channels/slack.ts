import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';
import { readFileSync } from 'fs';
import { basename } from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// --- File extraction helpers ---

// Matches [[send-file:/path/to/file]] markers placed by agents
const FILE_MARKER_RE = /\[\[send-file:([^\]]+?)\]\]/g;

/**
 * Extracts `[[send-file:/path/to/file]]` markers placed by agents. Returns the
 * cleaned text (markers removed) and an array of absolute file paths to upload.
 */
function extractFileMarkers(text: string): {
  cleanText: string;
  filePaths: string[];
} {
  const filePaths: string[] = [];
  const cleanText = text
    .replace(FILE_MARKER_RE, (_, p: string) => {
      filePaths.push(p.trim());
      return '';
    })
    .trim();
  return { cleanText, filePaths };
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private personas = new Map<
    string,
    { username: string; iconEmoji?: string }
  >();
  // thread_ts of the last triggering user message per JID — used to reply in-thread
  private activeThreads = new Map<string, string>();
  // Locked reply thread per JID — snapshotted at agent run start so replies
  // go to the triggering thread even if new messages arrive during processing.
  private lockedReplyThreads = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Track the thread_ts of each triggering user message so replies go back into the same thread.
      // Use thread_ts if the message is already in a thread, otherwise use ts (starts a new thread).

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      // A bot_message with a custom username that isn't our own name is a
      // guest agent response. Treat it as a visible participant so the channel
      // owner can see it in their message history (is_bot_message stays false).
      const msgUsername = (msg as { username?: string }).username;
      const isGuestAgentMessage =
        isBotMessage && !!msgUsername && msgUsername !== ASSISTANT_NAME;

      let senderName: string;
      if (isGuestAgentMessage) {
        senderName = msgUsername!;
      } else if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track the thread_ts of each triggering user message so replies go back
      // into the same thread. Not persisted — on restart, the next incoming message
      // sets the correct thread. Stale persisted threads caused wrong-thread replies.
      if (!isBotMessage) {
        const threadTs = (msg as { thread_ts?: string }).thread_ts || msg.ts;
        this.activeThreads.set(jid, threadTs);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage && !isGuestAgentMessage,
        is_bot_message: isBotMessage && !isGuestAgentMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  /** Lock the reply thread for a JID at agent run start. */
  lockReplyThread(jid: string): void {
    const ts = this.activeThreads.get(jid);
    if (ts) this.lockedReplyThreads.set(jid, ts);
  }

  /** Unlock the reply thread after agent run completes. */
  unlockReplyThread(jid: string): void {
    this.lockedReplyThreads.delete(jid);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Extract [[send-file:/path]] markers before chunking.
      const { cleanText, filePaths } = extractFileMarkers(text);

      // Slack limits messages to ~4000 characters; split if needed.
      // Use markdown blocks for rich rendering (standard Markdown: **bold**, ## headers, pipe tables).
      // Falls back to plain text on unsupported plans.
      const persona = this.personas.get(jid);
      // Use locked thread (snapshotted at agent run start) so replies go to the
      // correct thread even if new messages arrived during processing.
      const threadTs = this.lockedReplyThreads.get(jid) ?? this.activeThreads.get(jid);
      const sendChunk = async (chunk: string) => {
        try {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            blocks: [{ type: 'markdown', text: chunk }],
            ...(threadTs && { thread_ts: threadTs }),
            ...(persona?.username && { username: persona.username }),
            ...(persona?.iconEmoji && { icon_emoji: persona.iconEmoji }),
          });
        } catch {
          // Markdown block unsupported — fall back to plain text
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            ...(threadTs && { thread_ts: threadTs }),
            ...(persona?.username && { username: persona.username }),
            ...(persona?.iconEmoji && { icon_emoji: persona.iconEmoji }),
          });
        }
      };

      if (cleanText.length <= MAX_MESSAGE_LENGTH) {
        await sendChunk(cleanText);
      } else {
        for (let i = 0; i < cleanText.length; i += MAX_MESSAGE_LENGTH) {
          await sendChunk(cleanText.slice(i, i + MAX_MESSAGE_LENGTH));
        }
      }

      // Upload any files requested via [[send-file:/path]] markers
      for (const filePath of filePaths) {
        await this.uploadFile(jid, filePath);
      }

      logger.info(
        { jid, length: text.length, files: filePaths.length },
        'Slack message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  /**
   * Post to channel root, bypassing any active reply thread.
   * Used for scheduled reports, morning briefs, and announcements that should
   * start their own thread when replied to — not land inside an existing thread.
   */
  async sendReport(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const persona = this.personas.get(jid);
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
        blocks: [{ type: 'markdown', text }],
        // Deliberately no thread_ts — always posts to channel root
        ...(persona?.username && { username: persona.username }),
        ...(persona?.iconEmoji && { icon_emoji: persona.iconEmoji }),
      });
      logger.info({ jid, length: text.length }, 'Slack report posted to channel root');
    } catch {
      // Markdown block unsupported — fall back to plain text (still root)
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(persona?.username && { username: persona.username }),
          ...(persona?.iconEmoji && { icon_emoji: persona.iconEmoji }),
        });
      } catch (err) {
        // Queue for retry like sendMessage does — avoids silently dropping reports
        this.outgoingQueue.push({ jid, text });
        logger.warn(
          { jid, err, queueSize: this.outgoingQueue.length },
          'Failed to post report to channel root, queued for retry',
        );
      }
    }
  }

  /**
   * Send a message to `jid` using the persona registered for `asJid`.
   * Used by guest agents to respond in a host channel while keeping their own identity.
   */
  async sendMessageAs(jid: string, text: string, asJid: string): Promise<void> {
    // Temporarily register the guest persona under the host JID, send, then restore.
    const original = this.personas.get(jid);
    const guestPersona = this.personas.get(asJid);
    if (guestPersona) {
      this.personas.set(jid, guestPersona);
    }
    try {
      await this.sendMessage(jid, text);
    } finally {
      if (original) {
        this.personas.set(jid, original);
      } else {
        this.personas.delete(jid);
      }
    }
  }

  /**
   * Upload a local file to Slack and share it in the given channel.
   * Uses the v2 upload API: getUploadURLExternal → POST → completeUploadExternal.
   *
   * Agents trigger this by including `[[send-file:/absolute/path/to/file]]` in their output.
   */
  async uploadFile(
    jid: string,
    filePath: string,
    filename?: string,
    title?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const resolvedName = filename || basename(filePath);
    const content = readFileSync(filePath);

    // Step 1: Request an upload URL from Slack
    const urlResponse = await this.app.client.files.getUploadURLExternal({
      filename: resolvedName,
      length: content.length,
    });

    const uploadUrl = urlResponse.upload_url as string;
    const fileId = urlResponse.file_id as string;

    // Step 2: PUT the file bytes to the pre-signed URL
    await fetch(uploadUrl, {
      method: 'POST',
      body: content,
    });

    // Step 3: Complete the upload and share it in the channel
    await this.app.client.files.completeUploadExternal({
      files: [{ id: fileId, title: title || resolvedName }],
      channel_id: channelId,
    });

    logger.info(
      { jid, filePath, fileId, filename: resolvedName },
      'File uploaded to Slack',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  /**
   * Register a per-workspace display name and icon for outbound messages.
   * Requires the `chat:write.customize` OAuth scope on the Slack app.
   */
  registerPersona(jid: string, username: string, iconEmoji?: string): void {
    this.personas.set(jid, { username, iconEmoji });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});

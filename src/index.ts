import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  ChannelGuest,
  deleteSession,
  getAllChats,
  getAllChannelGuests,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// Map from channelJid -> array of guest assignments for that channel
let channelGuests: Record<string, ChannelGuest[]> = {};
// Map from folder -> RegisteredGroup for guest lookup
let groupsByFolder: Record<string, RegisteredGroup> = {};
// Map from folder -> JID (reverse of registeredGroups) for persona lookups
let jidByFolder: Record<string, string> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Build folder -> group map and folder -> JID map for guest lookups
  groupsByFolder = {};
  jidByFolder = {};
  for (const [jid, group] of Object.entries(registeredGroups)) {
    groupsByFolder[group.folder] = group;
    jidByFolder[group.folder] = jid;
  }

  // Load channel guest assignments: channelJid -> [{guestFolder, trigger}]
  channelGuests = {};
  for (const guest of getAllChannelGuests()) {
    if (!channelGuests[guest.channelJid]) {
      channelGuests[guest.channelJid] = [];
    }
    channelGuests[guest.channelJid].push({
      guestFolder: guest.guestFolder,
      trigger: guest.trigger,
    });
  }

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      guestChannelCount: Object.keys(channelGuests).length,
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Keep folder maps in sync
  groupsByFolder[group.folder] = group;
  jidByFolder[group.folder] = jid;

  // Refresh channel guest cache so newly-registered groups are visible as guests
  channelGuests = {};
  for (const guest of getAllChannelGuests()) {
    if (!channelGuests[guest.channelJid]) {
      channelGuests[guest.channelJid] = [];
    }
    channelGuests[guest.channelJid].push({
      guestFolder: guest.guestFolder,
      trigger: guest.trigger,
    });
  }

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Guest-silence check: only look at the LAST message in the batch.
  // This prevents a stale @Cody from earlier in the queue from permanently
  // deadlocking the owner. If Kevin's most recent message is @Cody, suppress;
  // if it's anything else, let the owner respond even if @Cody was in backlog.
  if (!isMainGroup && group.requiresTrigger === false) {
    const guestsForSilence = channelGuests[chatJid];
    if (guestsForSilence && guestsForSilence.length > 0) {
      const silenceAllowlist = loadSenderAllowlist();
      const ownerTriggerPattern = getTriggerPattern(group.trigger);
      const lastMsg = missedMessages[missedMessages.length - 1];
      const guestTriggeredLast = guestsForSilence.some((g) => {
        const gp = getTriggerPattern(g.trigger);
        return (
          gp.test(lastMsg.content.trim()) &&
          (lastMsg.is_from_me ||
            isTriggerAllowed(chatJid, lastMsg.sender, silenceAllowlist))
        );
      });
      const ownerTriggeredLast =
        ownerTriggerPattern.test(lastMsg.content.trim()) &&
        (lastMsg.is_from_me ||
          isTriggerAllowed(chatJid, lastMsg.sender, silenceAllowlist));
      if (guestTriggeredLast && !ownerTriggeredLast) {
        logger.info(
          { chatJid, group: group.name },
          'Owner suppressed — last message is guest-only trigger',
        );
        return true;
      }
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Lock the reply thread for this agent run so replies go to the triggering
  // thread even if new messages arrive during processing (race condition fix).
  (channel as unknown as { lockReplyThread?: (jid: string) => void }).lockReplyThread?.(chatJid);

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
        // Explicitly store the agent's own response so other agents in the same
        // channel can see it via getMessagesSince on their next trigger.
        // is_bot_message=false marks it as a visible channel participant, not noise.
        storeMessage({
          id: `agent-${group.folder}-${Date.now()}`,
          chat_jid: chatJid,
          sender: group.folder,
          sender_name: group.agentName || ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        });
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Unlock reply thread after agent run completes (success or error).
  (channel as unknown as { unlockReplyThread?: (jid: string) => void }).unlockReplyThread?.(chatJid);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  queueKey?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  let sessionId: string | undefined = sessions[group.folder];

  // Rotate session if JSONL file exceeds size threshold to prevent
  // container timeouts from unbounded append-only compaction growth
  const MAX_SESSION_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
  if (sessionId) {
    const sessionFile = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
      `${sessionId}.jsonl`,
    );
    try {
      const size = fs.statSync(sessionFile).size;
      if (size > MAX_SESSION_FILE_SIZE) {
        logger.info(
          { group: group.folder, sizeBytes: size, sessionId },
          'Session file exceeds size threshold, rotating to new session',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
        sessionId = undefined;
      }
    } catch {
      // File doesn't exist or stat failed — proceed with existing sessionId
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: group.agentName || ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(
          queueKey ?? chatJid,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // --- Owner dispatch ---
          // Owner suppression: only suppress if the CURRENT incoming batch
          // (groupMessages) contains an exclusive guest trigger. We never look
          // at accumulated history — that caused permanent deadlocks.
          let ownerSuppressedByGuest = false;
          if (!isMainGroup && group.requiresTrigger === false) {
            const guestsForChannel = channelGuests[chatJid];
            if (guestsForChannel && guestsForChannel.length > 0) {
              const suppressAllowlist = loadSenderAllowlist();
              const ownerTriggerPat = getTriggerPattern(group.trigger);
              const guestTriggeredNow = guestsForChannel.some((g) => {
                const gp = getTriggerPattern(g.trigger);
                return groupMessages.some(
                  (m) =>
                    gp.test(m.content.trim()) &&
                    (m.is_from_me ||
                      isTriggerAllowed(chatJid, m.sender, suppressAllowlist)),
                );
              });
              const ownerTriggeredNow = groupMessages.some(
                (m) =>
                  ownerTriggerPat.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, suppressAllowlist)),
              );
              if (guestTriggeredNow && !ownerTriggeredNow) {
                ownerSuppressedByGuest = true;
                logger.info(
                  { chatJid, group: group.name },
                  'Owner suppressed by guest trigger',
                );
              }
            }
          }

          if (!ownerSuppressedByGuest) {
            if (queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            } else {
              queue.enqueueMessageCheck(chatJid);
            }
          }

          // --- Guest dispatch ---
          // Guests are dispatched independently of the owner, always from this
          // path only (processGroupMessages has no guest logic). Each guest uses
          // a composite queue key (guestFolder:chatJid) and composite cursor key
          // to avoid colliding with the owner or other guests.
          const guestsNow = channelGuests[chatJid];
          if (guestsNow && guestsNow.length > 0) {
            const guestAllowlistCfg = loadSenderAllowlist();
            for (const guest of guestsNow) {
              const guestGroup = groupsByFolder[guest.guestFolder];
              if (!guestGroup) continue;

              const guestTriggerPattern = getTriggerPattern(guest.trigger);
              const guestHasTrigger = groupMessages.some(
                (m) =>
                  guestTriggerPattern.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, guestAllowlistCfg)),
              );
              if (!guestHasTrigger) continue;

              // Composite keys: isolate each guest-in-channel pair
              const guestQueueKey = `${guest.guestFolder}:${chatJid}`;
              const guestCursorKey = `${guest.guestFolder}:${chatJid}`;

              logger.info(
                { guest: guestGroup.name, channel: group.name },
                'Guest agent triggered',
              );

              // Fetch context since this guest's own cursor for this channel
              const guestPending = getMessagesSince(
                chatJid,
                lastAgentTimestamp[guestCursorKey] || '',
                ASSISTANT_NAME,
              );
              const guestMessages =
                guestPending.length > 0 ? guestPending : groupMessages;
              const guestFormatted = formatMessages(guestMessages, TIMEZONE);

              // Try active guest container first, otherwise spawn fresh
              if (queue.sendMessage(guestQueueKey, guestFormatted)) {
                lastAgentTimestamp[guestCursorKey] =
                  guestMessages[guestMessages.length - 1].timestamp;
                saveState();
              } else {
                lastAgentTimestamp[guestCursorKey] =
                  guestMessages[guestMessages.length - 1].timestamp;
                saveState();
                const guestJid = jidByFolder[guestGroup.folder];
                runAgent(
                  guestGroup,
                  guestFormatted,
                  chatJid,
                  async (result) => {
                    if (result.result) {
                      const raw =
                        typeof result.result === 'string'
                          ? result.result
                          : JSON.stringify(result.result);
                      const text = raw
                        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                        .trim();
                      if (text) {
                        if (channel.sendMessageAs && guestJid) {
                          await channel.sendMessageAs(chatJid, text, guestJid);
                        } else {
                          await channel.sendMessage(chatJid, text);
                        }
                        // Explicitly store guest response so the channel owner and
                        // other guests see it via getMessagesSince on their next trigger.
                        // is_bot_message=false marks it as a visible participant.
                        storeMessage({
                          id: `agent-${guestGroup.folder}-${Date.now()}`,
                          chat_jid: chatJid,
                          sender: guestGroup.folder,
                          sender_name: guestGroup.agentName || guestGroup.name,
                          content: text,
                          timestamp: new Date().toISOString(),
                          is_from_me: false,
                          is_bot_message: false,
                        });
                      }
                    }
                    // Mark the guest container idle so the queue releases it
                    // immediately instead of waiting for the 30-min idle timeout.
                    // Without this, the next trigger pipes into a zombie container.
                    if (result.status === 'success') {
                      queue.notifyIdle(guestQueueKey);
                    }
                    if (result.status === 'error') {
                      if (result.error && result.error.includes('No conversation found')) {
                        logger.warn(
                          { guest: guestGroup.name, sessionId: sessions[guestGroup.folder] },
                          'Guest session file missing — clearing stale session ID',
                        );
                        delete sessions[guestGroup.folder];
                        deleteSession(guestGroup.folder);
                      }
                      queue.notifyIdle(guestQueueKey);
                    }
                  },
                  guestQueueKey,
                ).catch((err) => {
                  logger.error(
                    { guest: guestGroup.name, channel: group.name, err },
                    'Guest agent error',
                  );
                });
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Register per-workspace Slack personas (requires chat:write.customize scope)
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.agentName) {
      const ch = findChannel(channels, jid);
      ch?.registerPersona?.(jid, group.agentName, group.slackIcon);
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    sendReport: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send report');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        if (channel.sendReport) {
          await channel.sendReport(jid, text);
        } else {
          await channel.sendMessage(jid, text);
        }
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendReport: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Use sendReport if the channel supports it (Slack); otherwise fall back to sendMessage
      return channel.sendReport ? channel.sendReport(jid, text) : channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
// Use fs.realpathSync to resolve symlinks so the check works when
// the working directory is behind a symlink (e.g. ~/nanoclaw -> Dropbox path).
// fileURLToPath handles URL-encoded characters (spaces → %20) in import.meta.url.
const isDirectRun =
  process.argv[1] &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

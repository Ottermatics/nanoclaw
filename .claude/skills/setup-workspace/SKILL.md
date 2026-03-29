---
name: setup-workspace
description: Bind a directory to a Slack channel. The agent in that channel gets filesystem access to the directory, with its own isolated memory, tasks, and logs. Use when user wants to set up a project channel, assign a folder to a channel, or create isolated workspaces.
---

# Setup Workspace

Bind a host directory to a Slack channel. Messages in that channel go to an agent with access to that directory. Each binding is isolated — separate memory, scheduled tasks, and audit trail.

**Principle:** Do the work. Only pause when the user needs to act in Slack or provide information.

## 0. Pre-flight

```bash
source setup_env.sh
systemctl --user is-active nanoclaw 2>/dev/null && echo "RUNNING" || echo "STOPPED"
```

If stopped: `bash start-nanoclaw.sh`

Show existing bindings:

```bash
claw-workspace
```

If `claw-workspace` is not in PATH, run `bash scripts/install-cli.sh` first.

Show the user their current bindings before proceeding.

## 1. Collect the Binding

AskUserQuestion — two things are needed:

**Question 1 — "Which directory do you want to bind?"**
Free text. Accept an absolute path (e.g. `/home/olly/projects/webapp`). Verify it exists on disk.

**Question 2 — "Which Slack channel should it bind to?"**
Options:
- "I have one" — collect the channel ID (`C...` from the channel URL or right-click → Copy link)
- "I'll create one now" — user creates channel in Slack, adds the bot, then provides the ID

## 2. Validate the Directory

Check the path exists:

```bash
ls -d "<path>" 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```

Check it's under an allowed mount root:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

If the path is NOT under an allowed root with write access, add it automatically:

- Read the current allowlist from `~/.config/nanoclaw/mount-allowlist.json`
- **Prepend** the path (or its parent) to the start of `allowedRoots` with `allowReadWrite: true`
- Write it back

**CRITICAL: Order matters.** The mount validator returns the **first** matching root. Specific writable paths MUST come before broad read-only catch-alls (like the Dropbox root). Always insert new writable roots at the **beginning** of the `allowedRoots` array, not the end.

**Workspace directories MUST be writable for their group.** A workspace that can't write to its own project directory is useless. Always add with `allowReadWrite: true` unless the user explicitly requests read-only.

Also verify `nonMainReadOnly` is `false` in the allowlist. If it's `true`, non-main groups are forced read-only regardless of the root config — which breaks all workspaces. Fix it:

```bash
# Check and fix nonMainReadOnly
python3 -c "
import json
f = open('$HOME/.config/nanoclaw/mount-allowlist.json')
d = json.load(f); f.close()
if d.get('nonMainReadOnly'):
    d['nonMainReadOnly'] = False
    with open('$HOME/.config/nanoclaw/mount-allowlist.json', 'w') as f:
        json.dump(d, f, indent=2)
    print('Fixed nonMainReadOnly → false')
else:
    print('nonMainReadOnly already false')
"
```

## 3. Register the Channel

Read ASSISTANT_NAME from `.env` (fallback: "Olly").

Derive the folder name from the directory basename: lowercase, prefix with `slack_`. Example: `/home/olly/projects/webapp` → `slack_webapp`. If that folder already exists in `groups/`, append a number.

AskUserQuestion: "Should the agent respond to every message in this channel, or only when @mentioned?"
- "Every message (Recommended)" — best for dedicated project channels
- "Only when @mentioned" — best for shared channels

Register:

```bash
source setup_env.sh
npx tsx setup/index.ts --step register -- \
  --jid "slack:<channel-id>" \
  --name "<directory-basename>" \
  --folder "<folder-name>" \
  --trigger "@<ASSISTANT_NAME>" \
  --channel slack \
  [--no-trigger-required]
```

## 4. Bind the Directory

Set the container config. The mount rules are:

- **Target workspace folder → read-write** (the whole point of a workspace)
- **OttermaticsNotes → read-only** (shared knowledge base)
- **NanoClaw → read-only** (project reference)

These are the defaults. Only the target folder is writable. Everything else is read-only.

```bash
source setup_env.sh
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const config = JSON.stringify({additionalMounts:[
  {hostPath:'<absolute-path>',containerPath:'<basename>',readonly:false},
  {hostPath:'/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/OttermaticsNotes',containerPath:'obsidian',readonly:true},
  {hostPath:'/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/agents/nanoclaw',containerPath:'nanoclaw',readonly:true}
]});
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(config, '<folder-name>');
db.close();
"
```

The agent will see:
- **`/workspace/extra/<basename>` (read-write)** — the workspace's own project directory
- `/workspace/extra/obsidian` (read-only) — Obsidian vault
- `/workspace/extra/nanoclaw` (read-only) — NanoClaw project

Verify:

```bash
source setup_env.sh
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db', {readonly:true});
console.log(db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('<folder-name>'));
db.close();
"
```

## 5. Choose Model

AskUserQuestion: "Which Claude model should this workspace use?"
- "Sonnet (default)" — `claude-sonnet-4-6`. Fast, cost-effective. Good for most project work.
- "Opus" — `claude-opus-4-6`. Most capable. Better for complex reasoning and architecture.

Set the model in the workspace's Claude settings:

```bash
cat > "data/sessions/<folder-name>/.claude/settings.json" << 'EOF'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
    "CLAUDE_CODE_USE_MODEL": "<chosen-model-id>"
  }
}
EOF
```

To check available model IDs, run `claude --help` and look at the `--model` flag description. Current aliases: `sonnet` → `claude-sonnet-4-6`, `opus` → `claude-opus-4-6`.

## 6. Customize Agent Context (optional)

AskUserQuestion: "Describe what this project is so the agent has context (or skip)."

Options:
- "Here's the context" — collect description, prepend it to `groups/<folder-name>/CLAUDE.md` after the heading. Include that the primary workspace is at `/workspace/extra/<basename>`.
- "Skip" — just add a note to CLAUDE.md that the agent's project directory is at `/workspace/extra/<basename>`.

Either way, ensure the CLAUDE.md tells the agent where to find the bound directory.

## 6. Restart and Test

```bash
bash start-nanoclaw.sh
```

Wait and verify:

```bash
sleep 3 && tail -5 logs/nanoclaw.log
```

Confirm `groupCount` increased.

Send a test message:

```bash
source setup_env.sh
SLACK_TOKEN=$(grep SLACK_BOT_TOKEN .env | cut -d= -f2)
printf '{"channel":"<channel-id>","text":"Workspace bound to <path>. Ready."}' | \
  curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d @-
```

If `"error": "not_in_channel"`, tell user to add the bot to the channel.

## 7. Summary

Print:

```
Binding: <absolute-path> → #<channel-name>
Folder:  groups/<folder-name>/
Channel: slack:<channel-id>
Mount:   /workspace/extra/<basename> (<read-write|read-only>)
Trigger: <every message | @Olly>
```

Then tell the user to run `claw-workspace` to see all bindings and scheduled tasks at any time.

## Troubleshooting

**Agent can't see the directory:**
- Check container_config: `node -e "const db=require('better-sqlite3')('store/messages.db',{readonly:true});console.log(db.prepare('SELECT container_config FROM registered_groups WHERE folder=?').get('<folder>'));db.close()"`
- Check mount allowlist: `cat ~/.config/nanoclaw/mount-allowlist.json`
- Check container log for mount rejection: `grep -i mount groups/<folder>/logs/container-*.log`
- Non-main groups are read-only if `nonMainReadOnly: true` in allowlist

**Remove a binding:**
```bash
source setup_env.sh
node -e "const db=require('better-sqlite3')('store/messages.db');db.prepare('DELETE FROM registered_groups WHERE folder=?').run('<folder-name>');db.close()"
bash start-nanoclaw.sh
```

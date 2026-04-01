---
name: setup-workspace
description: Bind a directory to a Slack channel. The agent in that channel gets filesystem access to the directory, with its own isolated memory, tasks, and logs. Use when user wants to set up a project channel, assign a folder to a channel, or create isolated workspaces.
---

# Setup Workspace

Bind a host directory to a Slack channel. Messages in that channel go to an agent with access to that directory. Each binding is isolated — separate memory, scheduled tasks, and audit trail.

**Principle:** Do the work. Only pause when the user needs to act in Slack or provide information.

---

## Universal Workspace Behaviors

**This is the master reference for workspace behavior.** Every workspace — regardless of its purpose, agent name, or access level — follows the same behavioral contract. Channel owners and channel guests have equivalent obligations; they differ only in what they have access to, not in how they communicate.

When these standards change, update:
1. This section (the source of truth)
2. `groups/global/CLAUDE.md` (inherited base for all agents)
3. Each existing `groups/<workspace>/CLAUDE.md` (workspace-specific examples)
4. The CLAUDE.md template in **Step 6** of this skill (applied to all new workspaces)

### Traceability (Required in all Slack responses)

Every agent must explain itself before giving an answer. This applies symmetrically to every agent in every channel — there is no exception for owners vs. guests.

**Four rules:**
- **Name your source** — file path, command output, DB query, log line, or prior session
- **Connect the dots** — one sentence: what you checked and why your conclusion follows
- **Log changes** — when you write a file, run a command, or modify state, say what you did and why
- **Identify as guest** — if responding in another agent's channel, open with your agent name ("**[your name] here** — [what you're doing]:")

**Examples:**
> ❌ "The config looks correct."
> ✅ "Checked `container_config` in the DB — bridge mount is present and read-only."

> ❌ "You have overdue tasks."
> ✅ "From `vault-query tasks` — 3 items overdue: DetoxBox infra, micropython wifi setup, resin molds."

Keep it brief — one sentence of context is enough. But never skip it.

### Guest / Owner Protocol

A **channel owner** is the primary agent for a workspace. A **channel guest** is any other agent responding in that channel (e.g. Mage invited into the detoxbox channel).

Both follow identical traceability rules. The only difference is that guests must open with their name so the channel owner's user knows who is speaking. Guests do not have reduced obligations — and owners do not have elevated ones.

### Message Queuing

Messages to a workspace are serialized through a per-group queue (`GroupQueue`). New messages are piped into the idle container for that group — they do not spawn a second container. Responses are sequential and deterministic.

### Session History

Nightly cleanup (run by main at 1am) processes all workspaces:
- Session `.jsonl` files over threshold are compacted into `sessions/latest.md`
- Old `latest.md` is archived to `sessions/archive/YYYY-MM-DD.md`
- Session ID is cleared so the next container starts fresh

Every workspace CLAUDE.md should instruct the agent to read `sessions/latest.md` at session start.

---

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

AskUserQuestion — three things are needed:

**Question 1 — "Which directory do you want to bind?"**
Free text. Accept an absolute path (e.g. `/home/olly/projects/webapp`). Verify it exists on disk.

**Question 2 — "Which Slack channel should it bind to?"**
Options:
- "I have one" — collect the channel ID (`C...` from the channel URL or right-click → Copy link)
- "I'll create one now" — user creates channel in Slack, adds the bot, then provides the ID

**Question 3 — "What should the agent be called?"**
This is the agent's identity — used in its `CLAUDE.md`, as the Slack display name, and in `claw-workspace` output. Examples: `Dev`, `Scout`, `Aria`. Must be provided — there is no default for new workspaces.

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

Then set the agent name and Slack icon in the DB:

```bash
source setup_env.sh
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
db.prepare('UPDATE registered_groups SET agent_name = ?, slack_icon = ? WHERE folder = ?')
  .run('<AgentName>', ':robot_face:', '<folder-name>');
db.close();
"
```

## 4. Bind the Directory

Set the container config. The mount rules are:

- **Target workspace folder → read-write** (the whole point of a workspace)
- **Standard mounts → always included** (tmp, storage — see below)
- **OttermaticsNotes → read-only** (shared knowledge base)
- **NanoClaw → read-only** (project reference)

```bash
source setup_env.sh
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const config = JSON.stringify({additionalMounts:[
  {hostPath:'<absolute-path>',containerPath:'<basename>',readonly:false},
  {hostPath:'/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/OttermaticsNotes',containerPath:'obsidian',readonly:true},
  {hostPath:'/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/agents/nanoclaw',containerPath:'nanoclaw',readonly:true},
  {hostPath:'/tmp/app_storage',containerPath:'tmp',readonly:false},
  {hostPath:'/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/storage',containerPath:'storage',readonly:false}
]});
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(config, '<folder-name>');
db.close();
"
```

The agent will see:
- **`/workspace/extra/<basename>` (read-write)** — the workspace's own project directory
- **`/workspace/extra/tmp` (read-write)** — ephemeral shared storage (`/tmp/app_storage` on host)
- **`/workspace/extra/storage` (read-write)** — persistent shared storage (`Ottermatics/storage` on host)
- `/workspace/extra/obsidian` (read-only) — Obsidian vault
- `/workspace/extra/nanoclaw` (read-only) — NanoClaw project

### Python / Conda Environments

Each workspace can mount a conda env from the host's miniconda installation at `/home/olly/miniconda3/envs/<env-name>`. This gives the agent access to the full conda Python environment without any container rebuilds.

To add a conda env mount:

```bash
source setup_env.sh
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('<folder-name>');
const config = JSON.parse(row.container_config);
config.additionalMounts.push({
  hostPath: '/home/olly/miniconda3/envs/<env-name>',
  containerPath: 'conda',
  readonly: true
});
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(config), '<folder-name>');
db.close();
"
```

The env appears at `/workspace/extra/conda` inside the container. Run scripts with `/workspace/extra/conda/bin/python3` to use the conda packages.

**Creating a new env on the host (WSL):**
```bash
/home/olly/miniconda3/bin/conda create -n <env-name> python=3.11 -y
/home/olly/miniconda3/bin/conda activate <env-name>
pip install <packages>
```

No allowlist changes needed — `/home/olly` is already in the allowlist as read-only, which covers all conda envs.

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
  },
  "permissions": {
    "deny": [
      "Bash(git commit*)",
      "Bash(git push*)"
    ]
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

**Always include a Traceability section** in every generated CLAUDE.md, immediately before the Message Formatting section:

```markdown
## Traceability

**Always explain yourself.** State what you looked at before giving an answer.

- **Name your source** — file path, command output, log line, or prior session (e.g. "From `<project-dir>/…`", "Checked the task in `sessions/latest.md`…")
- **Connect the dots** — one sentence: what you checked and why your conclusion follows
- **Log changes** — when you write a file, run a command, or modify state, say what you did and why
- **Identify as guest** — if responding in another channel, open with your name ("**<AgentName> here** — reviewing:")

> ❌ "The config looks correct."
> ✅ "Checked `<project-dir>/config.json` — all required keys present, no parse errors."

Keep it brief — one sentence of context is enough. But always include it.
```

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
Agent:   <AgentName>
Folder:  groups/<folder-name>/
Channel: slack:<channel-id>
Mounts:  /workspace/extra/<basename> (rw)
         /workspace/extra/tmp (rw)
         /workspace/extra/storage (rw)
         /workspace/extra/obsidian (ro)
         /workspace/extra/nanoclaw (ro)
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

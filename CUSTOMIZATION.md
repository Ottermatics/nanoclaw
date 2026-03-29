# NanoClaw Customization — WSL/Linux Setup

Instance-specific configuration for this NanoClaw install on WSL2 (hostname: deathray).

## Systemd Service

NanoClaw runs as a user-level systemd service.

### Service file

`~/.config/systemd/user/nanoclaw.service`:

```ini
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=/home/olly/.nvm/versions/node/v22.22.2/bin/node /home/olly/nanoclaw/dist/index.js
WorkingDirectory=/home/olly/nanoclaw
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=/home/olly
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/olly/.local/bin
StandardOutput=append:/home/olly/nanoclaw/logs/nanoclaw.log
StandardError=append:/home/olly/nanoclaw/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
```

### Commands

```bash
systemctl --user start nanoclaw      # Start
systemctl --user stop nanoclaw       # Stop
systemctl --user restart nanoclaw    # Restart
systemctl --user status nanoclaw     # Status
journalctl --user -u nanoclaw -f     # Follow journal (service-level logs)
tail -f ~/nanoclaw/logs/nanoclaw.log # Follow app logs
```

### Keeping it alive

Three layers ensure the service stays up:

1. **`Restart=always`** — systemd restarts the process if it crashes or exits (5s delay).

2. **`systemctl --user enable nanoclaw`** — starts the service when the user session begins. Already done.

3. **`loginctl enable-linger olly`** — keeps the user session alive even when no terminal is open. **Required for WSL** where closing the last terminal would otherwise kill all user services.

   ```bash
   sudo loginctl enable-linger olly
   ```

   Without linger, NanoClaw dies every time you close your WSL windows. With it, the service starts when WSL boots and runs indefinitely.

### WSL boot

WSL2 with systemd enabled (`/etc/wsl.conf` has `[boot] systemd=true`) starts systemd on first WSL access. Combined with linger, NanoClaw will auto-start on the first `wsl` invocation or Windows Terminal open.

To make WSL start at Windows login without opening a terminal:

```
# Add to Windows Task Scheduler or shell:startup
wsl -d Ubuntu-22.04 -- /bin/true
```

This boots WSL (and systemd → nanoclaw) silently in the background.

### After Node upgrades

The service file has a hardcoded node path. After upgrading Node via nvm:

```bash
# Update the service file
sed -i "s|ExecStart=.*node |ExecStart=$(which node) |" \
  ~/.config/systemd/user/nanoclaw.service
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

## CLI Tools

Install both tools to `~/.local/bin`:

```bash
bash scripts/install-cli.sh
```

| Command | Purpose |
|---------|---------|
| `claw` | Run agent containers from the terminal (Python CLI) |
| `claw-workspace` | Show all workspaces, scheduled tasks, and running containers |

## Workspaces

A **workspace** binds a host directory to a Slack channel. The agent in that channel gets isolated filesystem access, its own memory, scheduled tasks, and conversation history.

### How it works

Each workspace is stored as a row in `store/messages.db` (`registered_groups` table) with:
- **jid** — Slack channel ID (e.g. `slack:C0AQ7MRCW80`)
- **folder** — group folder name under `groups/` (e.g. `slack_detoxbox`)
- **container_config** — JSON with `additionalMounts` specifying what host directories the container can see

When a message arrives in a Slack channel, NanoClaw looks up the registered group, spins up a Docker container with the configured mounts, and runs the agent inside it.

### Adding a workspace

Use the `/setup-workspace` skill:

```
/setup-workspace
```

It walks through: pick a directory, pick a Slack channel, configure mounts, choose a model, and optionally set agent context. The workspace is immediately active.

### Current workspaces

| Workspace | Channel | Model | Project Directory | Access |
|-----------|---------|-------|-------------------|--------|
| **slack_main** | C0ANX6BRRC7 | opus | (admin — sees nanoclaw rw) | main |
| **detoxbox** | C0AQ7MRCW80 | opus | `Dropbox/Projects/DetoxBox` | rw |
| **clique_project** | C0AQ7MN54SC | sonnet | `Dropbox/Projects/clique_project` | rw |
| **ottermaticsnotes** | C0APC39A1PG | sonnet | `Dropbox/Ottermatics/OttermaticsNotes` | rw |
| **life-agent** | C0ANZPEJ9HD | opus | `Personal Dropbox/modules` + `personal_journal` | rw |

All non-main workspaces also get read-only access to the Obsidian vault and NanoClaw project.

### Workspace file layout

```
groups/
  slack_detoxbox/           # Workspace folder (persistent across containers)
    CLAUDE.md               # Agent identity and instructions
    logs/                   # Container execution logs
    sessions/               # Archived session files
    conversations/          # Searchable conversation history
data/
  sessions/
    slack_detoxbox/         # Claude Code session state
      .claude/              # Settings, memory, session files
  ipc/
    slack_detoxbox/         # IPC channels (messages, tasks, input)
```

### Mount allowlist

Host directories must be listed in `~/.config/nanoclaw/mount-allowlist.json` before they can be mounted into containers. The `/setup-workspace` skill handles this automatically.

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

### Viewing workspaces

```bash
claw-workspace
```

### Removing a workspace

```bash
source setup_env.sh
node -e "
const db = require('better-sqlite3')('store/messages.db');
db.prepare('DELETE FROM registered_groups WHERE folder = ?').run('<folder-name>');
db.close();
"
bash start-nanoclaw.sh
```

The group folder and files are preserved (not deleted).

## Path Layout

| Path | Purpose |
|------|---------|
| `~/nanoclaw` | Symlink → Dropbox project root |
| `~/ottermatics` | Symlink → `/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/` |
| `~/dropbox` | Symlink → `/mnt/c/Users/Sup/Ottermatics Dropbox/` |
| `~/nanoclaw/logs/` | App logs (nanoclaw.log, nanoclaw.error.log) |
| `~/nanoclaw/store/messages.db` | SQLite database |

**Important:** The project lives on a Windows NTFS mount via Dropbox. Paths with spaces (`Ottermatics Dropbox`) require quoting in shell commands and care with URL-encoding in Node.js (`import.meta.url` uses `%20`).

## DetoxBox Windows Bridge

Runs as a system-level systemd service (not user-level, since it needs to survive session teardown).

- **Master file:** `~/dropbox/Projects/DetoxBox/utils/windows-bridge/windows-bridge.js`
- **Service:** `detoxbox-bridge@olly.service`
- **Port:** 127.0.0.1:8765
- **Auth:** IP-based (localhost + Docker subnets). No token needed.
- **Auto-reload:** Uses `node --watch` — file edits restart automatically.

```bash
# Status
systemctl status detoxbox-bridge@olly.service

# Reinstall (after moving files or upgrading node)
bash ~/dropbox/Projects/DetoxBox/utils/windows-bridge/install-bridge.sh

# Test
curl -s http://127.0.0.1:8765/health
```

## OneCLI

Runs as Docker Compose services. Updated via:

```bash
curl -fsSL onecli.sh/install | sh     # Gateway (Docker images)
curl -fsSL onecli.sh/cli/install | sh  # CLI binary
```

- Dashboard: http://localhost:10254
- Gateway (proxy): http://localhost:10255
- CLI: `onecli --help`
- Data persisted in Docker volume `onecli-data`

## Known Issues

### Symlink path mismatch (fixed)

`import.meta.url` resolves symlinks to the real Dropbox path while `process.argv[1]` keeps the symlink path. The `isDirectRun` guard in `src/index.ts` uses `fileURLToPath()` + `fs.realpathSync()` to normalize both sides.

### Stale Slack socket

After extended idle periods (8+ hours with no messages), the Slack Socket Mode connection can go stale — NanoClaw appears running but stops receiving messages. Restart the service to reconnect:

```bash
systemctl --user restart nanoclaw
```

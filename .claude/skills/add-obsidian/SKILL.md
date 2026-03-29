---
name: add-obsidian
description: Add Obsidian vault integration to NanoClaw. Mounts a vault into agent containers, installs notesmd-cli for headless interaction, and sets up weekly status reporting. Use when user wants to connect their Obsidian knowledge base.
---

# Add Obsidian Vault Integration

Connects an Obsidian vault to NanoClaw agent containers using `notesmd-cli` for headless interaction. Claude acts as a **contributor** to the vault — Obsidian manages note creation, templates, and structure. Claude only reads tasks and appends status entries.

## Prerequisites

- Obsidian vault accessible from the host filesystem (e.g., via Dropbox on WSL)
- Obsidian's Daily Notes or Periodic Notes plugin configured (the `daily-notes.json` config drives note creation)

## Phase 1: Pre-flight

1. Find the vault path. On WSL with Dropbox, it's typically under `/mnt/c/Users/<user>/...`. Look for a `.obsidian/` directory:
   ```bash
   find "/mnt/c/Users" -maxdepth 5 -name ".obsidian" -type d 2>/dev/null | head -5
   ```

2. Read the vault's daily-notes config to understand naming convention:
   ```bash
   cat "<vault_path>/.obsidian/daily-notes.json"
   ```

3. Verify the NanoClaw mount allowlist exists:
   ```bash
   cat ~/.config/nanoclaw/mount-allowlist.json
   ```

## Phase 2: Install notesmd-cli

`notesmd-cli` is a Go binary for headless Obsidian vault interaction. It reads vault config, respects templates, and works without Obsidian Desktop running.

Source: https://github.com/Yakitrak/notesmd-cli

### Download pre-built binary

```bash
# Check latest release
RELEASE_URL=$(curl -sL https://api.github.com/repos/Yakitrak/notesmd-cli/releases/latest | grep browser_download_url | grep linux_amd64 | head -1 | cut -d'"' -f4)
curl -L -o /tmp/notesmd-cli "$RELEASE_URL"
chmod +x /tmp/notesmd-cli
```

### Or build from source (requires Go 1.19+)

```bash
cd /tmp && git clone https://github.com/Yakitrak/notesmd-cli.git && cd notesmd-cli
go build -o notesmd-cli .
```

### Install into group bin/

```bash
cp /tmp/notesmd-cli "<project_root>/groups/<group_folder>/bin/notesmd-cli"
chmod +x "<project_root>/groups/<group_folder>/bin/notesmd-cli"
```

The binary lives alongside other tools (`rg`, `jq`) in the group's `bin/` directory, which is mounted into containers.

## Phase 3: Configure Mount

### Assumptions about Dropbox on WSL

- Windows Dropbox syncs to `C:\Users\<user>\<Dropbox Folder>\`
- WSL accesses this via `/mnt/c/Users/<user>/<Dropbox Folder>/`
- Dropbox paths commonly have spaces — always quote paths
- The vault path must resolve via `fs.realpathSync()` on the host

### Update mount allowlist

Add the vault path as an `AllowedRoot` object with `allowReadWrite: true`. **Do not remove existing roots** — add alongside them.

```bash
# Read current allowlist
cat ~/.config/nanoclaw/mount-allowlist.json

# Each entry in allowedRoots must be an object: { "path": "...", "allowReadWrite": bool, "description": "..." }
# If existing entries are plain strings, convert them to objects
```

Write the updated allowlist. Example for a vault at `/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/OttermaticsNotes`:

```json
{
  "allowedRoots": [
    { "path": "<existing_root_1>", "allowReadWrite": false, "description": "..." },
    { "path": "<vault_path>", "allowReadWrite": true, "description": "Obsidian vault" }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

### Update DB container_config

Add the vault as an additional mount for the target group:

```bash
sqlite3 "<project_root>/store/messages.db" "
  UPDATE registered_groups
  SET container_config = '{\"additionalMounts\":[{\"hostPath\":\"<vault_path>\",\"containerPath\":\"obsidian\",\"readonly\":false}]}'
  WHERE jid = '<group_jid>';
"
```

The vault will mount at `/workspace/extra/obsidian` inside the container.

### Create headless obsidian config

Inside the container, `notesmd-cli` needs to know where the vault is. The weekly-update script should ensure this config exists:

```json
// ~/.config/obsidian/obsidian.json (inside container)
{
  "vaults": {
    "workspace": { "path": "/workspace/extra/obsidian" }
  }
}
```

## Phase 4: Install Scripts

### weekly-update

The `weekly-update` script is a minimal contributor that:
1. Calls `notesmd-cli daily` to let Obsidian create/open the periodic note via its template
2. Fixes the self-referencing previous-week link (a known template issue where `![[{{date:YYYY-WW}}#Notes]]` references itself instead of the prior week)
3. Inserts a `##### YYYY-MM-DD` subheading under the `#### Weekly Notes` section
4. Reports only status **changes** (completed, added, overdue) as markdown bullets — no code blocks
5. Saves a task snapshot for next run's diff

Copy the script to `<project_root>/groups/<group_folder>/bin/weekly-update` and `chmod +x`.

### vault-query

If not already installed, copy the vault-query script for task querying with Obsidian Tasks plugin support. It handles `📅`, `⏳`, `🔼`, and other emoji metadata.

## Phase 5: Update Group CLAUDE.md

Update the group's CLAUDE.md Obsidian section to reflect:

- **Contributor philosophy**: Claude reads and appends to notes. Does not create, template, or structurally manage notes.
- **notesmd-cli**: Available at `/workspace/group/bin/notesmd-cli` for headless vault ops
- **Weekly note format**: `YYYY-WW.md` (driven by `daily-notes.json` config)
- **Daily entries**: `##### YYYY-MM-DD` subheadings under `#### Weekly Notes` — no code blocks
- **Task queries**: via `vault-query` (grep-based, supports Tasks plugin emoji syntax)

## Phase 6: Restart and Verify

The mount allowlist is cached at process startup. Restart NanoClaw:

```bash
# WSL/Linux
bash "<project_root>/start-nanoclaw.sh"
# or: systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Verify

1. Check logs for successful mount:
   ```bash
   grep -i "mount.*allowlist\|mount.*validated\|mount.*REJECTED" "<project_root>/logs/nanoclaw.log" | tail -5
   ```

2. Test weekly-update dry run (from inside container, on next message):
   ```bash
   /workspace/group/bin/weekly-update --dry-run
   ```

3. Verify vault is accessible:
   ```bash
   ls /workspace/extra/obsidian/
   ```

## Troubleshooting

### Mount REJECTED in logs

Check that:
- The vault path in `container_config` exactly matches a real path on the host
- The path is under an `allowedRoot` in `~/.config/nanoclaw/mount-allowlist.json`
- Each `allowedRoot` is an object `{ "path": "...", "allowReadWrite": bool }`, not a plain string
- The path doesn't match any blocked pattern (`.env`, `.ssh`, etc.)

### notesmd-cli: vault not found

Ensure `~/.config/obsidian/obsidian.json` exists inside the container with the correct vault path. The weekly-update script should create this automatically.

### Weekly note not created

`notesmd-cli daily` reads `.obsidian/daily-notes.json` from the vault. Verify this file exists and has the correct format/folder/template settings. If the template file is missing, Obsidian will create an empty note.

### Previous-week link still self-referencing

The template uses `![[{{date:YYYY-WW}}#Notes]]` which always resolves to the current week. The weekly-update script fixes this after creation. If it persists, check that the script can find prior weekly note files in the `notes/` directory.

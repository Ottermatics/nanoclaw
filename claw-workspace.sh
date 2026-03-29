#!/usr/bin/env bash
# claw-workspace — print workspace bindings and scheduled tasks
# Uses Node.js + better-sqlite3 (bundled with nanoclaw) instead of sqlite3 CLI.

# Resolve through symlinks to find the real nanoclaw directory
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

DB="$SCRIPT_DIR/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "No database found at $DB"
  exit 1
fi

# Status — check systemd first, fall back to PID file
if systemctl --user is-active nanoclaw &>/dev/null; then
  PID=$(systemctl --user show nanoclaw -p MainPID --value 2>/dev/null)
  STATUS="RUNNING (PID $PID, systemd)"
elif [ -f "$SCRIPT_DIR/nanoclaw.pid" ] && kill -0 "$(cat "$SCRIPT_DIR/nanoclaw.pid")" 2>/dev/null; then
  STATUS="RUNNING (PID $(cat "$SCRIPT_DIR/nanoclaw.pid"))"
else
  STATUS="STOPPED"
fi
echo "NanoClaw: $STATUS"
echo ""

# Use node + better-sqlite3 for all DB queries (cd so require() finds node_modules)
SESSIONS_DIR="$SCRIPT_DIR/data/sessions"
cd "$SCRIPT_DIR"
node -e "
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database('$DB', { readonly: true });

// Workspaces
const groups = db.prepare(
  'SELECT folder, name, jid, is_main, requires_trigger, trigger_pattern, container_config FROM registered_groups ORDER BY added_at'
).all();

console.log('=== WORKSPACES ===');
console.log('');
const hdr = (s, w) => s.padEnd(w);
console.log(
  hdr('WORKSPACE', 20) + hdr('CHANNEL', 24) + hdr('MAIN', 6) +
  hdr('MODEL', 24) + hdr('TRIGGER', 16) + 'MOUNTS'
);

for (const g of groups) {
  const settingsFile = path.join('$SESSIONS_DIR', g.folder, '.claude', 'settings.json');
  let model = 'default';
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (cfg.env?.CLAUDE_CODE_USE_MODEL) model = cfg.env.CLAUDE_CODE_USE_MODEL;
  } catch {}

  const role = g.is_main ? 'main' : '';
  const trig = g.requires_trigger === 0 ? 'all messages' : (g.trigger_pattern || '@Olly');

  let mounts = 'none';
  try {
    const cc = JSON.parse(g.container_config || '{}');
    if (cc.additionalMounts?.length) {
      mounts = cc.additionalMounts.map(m => m.containerPath).join(', ');
    }
  } catch {}

  // Truncate channel JID for display
  const chan = g.jid.length > 22 ? g.jid.slice(0, 20) + '..' : g.jid;
  console.log(
    hdr(g.name, 20) + hdr(chan, 24) + hdr(role, 6) +
    hdr(model, 24) + hdr(trig, 16) + mounts
  );
}
console.log('');

// Scheduled tasks
const taskCount = db.prepare(\"SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'active'\").get().c;
if (taskCount > 0) {
  console.log('=== SCHEDULED TASKS (' + taskCount + ' active) ===');
  console.log('');
  const tasks = db.prepare(
    \"SELECT group_folder, prompt, schedule_type, schedule_value, status, next_run FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run\"
  ).all();
  for (const t of tasks) {
    const label = t.prompt.replace(/\n/g, ' | ').replace(/\s+/g, ' ').trim().substring(0, 260);
    console.log(t.group_folder + ' [' + t.schedule_value + ']');
    console.log('  ' + label);
    console.log('');
  }
  console.log('');
} else {
  console.log('=== SCHEDULED TASKS ===');
  console.log('No active tasks.');
  console.log('');
}

db.close();
"

# Running containers
CONTAINERS=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}\t{{.Status}}" 2>/dev/null)
if [ -n "$CONTAINERS" ]; then
  echo "=== ACTIVE CONTAINERS ==="
  echo ""
  echo "$CONTAINERS"
  echo ""
fi

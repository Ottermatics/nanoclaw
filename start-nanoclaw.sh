#!/usr/bin/env bash
# Start/restart NanoClaw.
# Prefers systemd if available, falls back to direct process.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Systemd (preferred on Linux/WSL)
if command -v systemctl &>/dev/null && systemctl --user cat nanoclaw &>/dev/null 2>&1; then
  systemctl --user restart nanoclaw
  sleep 2
  systemctl --user status nanoclaw --no-pager
  exit 0
fi

# Fallback: direct process (macOS launchd users, or no systemd)
source "$SCRIPT_DIR/setup_env.sh"
cd "$SCRIPT_DIR"

if [ -f nanoclaw.pid ]; then
  kill "$(cat nanoclaw.pid)" 2>/dev/null || true
  rm -f nanoclaw.pid
fi

mkdir -p logs
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
echo $! > nanoclaw.pid
echo "NanoClaw started (PID $(cat nanoclaw.pid))"

#!/usr/bin/env bash
# Install NanoClaw CLI tools to ~/.local/bin
# Run from the nanoclaw directory: bash scripts/install-cli.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NANOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$BIN_DIR"

# Install claw (Python CLI)
CLAW_SRC="$NANOCLAW_DIR/scripts/claw"
if [ ! -f "$CLAW_SRC" ]; then
  # Copy from skill if not yet in scripts/
  SKILL_SRC="$NANOCLAW_DIR/.claude/skills/claw/scripts/claw"
  if [ -f "$SKILL_SRC" ]; then
    cp "$SKILL_SRC" "$CLAW_SRC"
    chmod +x "$CLAW_SRC"
  fi
fi
if [ -f "$CLAW_SRC" ]; then
  ln -sf "$CLAW_SRC" "$BIN_DIR/claw"
  echo "  claw         → $BIN_DIR/claw"
fi

# Install claw-workspace (status dashboard)
CWSH="$NANOCLAW_DIR/claw-workspace.sh"
if [ -f "$CWSH" ]; then
  ln -sf "$CWSH" "$BIN_DIR/claw-workspace"
  echo "  claw-workspace → $BIN_DIR/claw-workspace"
fi

# Check PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "  ~/.local/bin is not in PATH. Add to your shell profile:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "Done. Run 'claw --list-groups' and 'claw-workspace' to verify."

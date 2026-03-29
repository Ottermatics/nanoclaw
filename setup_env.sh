#!/usr/bin/env bash
# NanoClaw environment bootstrap
# Sources nvm and sets NANOCLAW_DIR. Used by lifecycle scripts and skills.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null 2>&1

# Resolve NANOCLAW_DIR: explicit env > symlink > fallback
if [ -z "$NANOCLAW_DIR" ]; then
  if [ -L "$HOME/nanoclaw" ]; then
    export NANOCLAW_DIR="$(readlink -f "$HOME/nanoclaw")"
  else
    export NANOCLAW_DIR="/mnt/c/Users/Sup/Ottermatics Dropbox/Ottermatics/agents/nanoclaw"
  fi
fi

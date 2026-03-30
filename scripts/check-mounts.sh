#!/usr/bin/env bash
# check-mounts.sh — mount external drives for NanoClaw on WSL startup
# Source from ~/.bashrc:
#   source /mnt/c/Users/Sup/Ottermatics\ Dropbox/Ottermatics/agents/nanoclaw/scripts/check-mounts.sh

# ── Personal Journal Vault (Cryptomator G:\Personal) ────────────────────────
if mountpoint -q /mnt/g 2>/dev/null; then
    : # already mounted, nothing to do
else
    if sudo mount -t drvfs G: /mnt/g 2>/dev/null; then
        echo "✓ Mounted Cryptomator journal vault at /mnt/g"
    else
        echo "⚠  Could not mount G: — make sure Cryptomator is unlocked first"
    fi
fi

# ── Ottermatics Secrets (Cryptomator T:\) ────────────────────────
if mountpoint -q /mnt/t 2>/dev/null; then
    : # already mounted, nothing to do
else
    if sudo mount -t drvfs T: /mnt/t 2>/dev/null; then
        echo "✓ Mounted Cryptomator secrets at /mnt/t"
    else
        echo "⚠  Could not mount T: — make sure Cryptomator is unlocked first"
    fi
fi
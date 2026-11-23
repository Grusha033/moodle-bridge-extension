#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  git pull origin main
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://github.com/Grusha033/moodle-bridge-extension/archive/refs/heads/main.zip" -o "$TMP/ext.zip"
  unzip -qo "$TMP/ext.zip" -d "$TMP"
  cp -rf "$TMP/moodle-bridge-extension-main/"* .
fi
echo "Updated! Now click Reload in chrome://extensions/"

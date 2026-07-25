#!/usr/bin/env bash
set -euo pipefail

# Wrapper around npx tauri that sets up the AppImage runtime if needed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Try to set up AppImage runtime if needed (non-fatal — .deb still builds)
LINUXDEPLOY_CACHE="$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage"
if [ ! -f "$LINUXDEPLOY_CACHE" ] && [ -x "$SCRIPT_DIR/prepare-appimage-runtime.sh" ]; then
  "$SCRIPT_DIR/prepare-appimage-runtime.sh" || true
fi

exec npx tauri "$@"

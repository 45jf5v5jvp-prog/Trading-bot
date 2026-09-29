#!/bin/bash
# One-time installer for Personal Assistant (macOS).
# Usage: cd personal-assistant && ./install.sh
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This assistant runs on a Mac (it needs Calendar, Reminders and Messages)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/.personal-assistant"
VENV="$HOME_DIR/venv"

# Find Python 3.11 or newer.
PY=""
for candidate in python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$PY" ]]; then
  echo "Python 3.11+ is needed. Install it with Homebrew:  brew install python@3.12" >&2
  echo "(Get Homebrew from https://brew.sh if you don't have it.)" >&2
  exit 1
fi
echo "Using $PY"

mkdir -p "$HOME_DIR"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "$HERE"

# Make `assistant` available in new Terminal windows.
if ! grep -q "personal-assistant/venv/bin/assistant" "$HOME/.zshrc" 2>/dev/null; then
  echo 'alias assistant="$HOME/.personal-assistant/venv/bin/assistant"' >> "$HOME/.zshrc"
fi

echo
echo "Installed. Starting setup..."
exec "$VENV/bin/assistant" setup

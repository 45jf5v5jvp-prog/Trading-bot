#!/bin/bash
# Personal Assistant installer for macOS.
# Double-click this file, or in Terminal run:  bash ~/Downloads/personal-assistant/install.command
set -euo pipefail

clear
echo "================================================"
echo "   Personal Assistant - installing"
echo "================================================"
echo

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This needs to run on a Mac." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/.personal-assistant"
VENV="$HOME_DIR/venv"
UV="$HOME/.local/bin/uv"
mkdir -p "$HOME_DIR"

# uv is a small tool that downloads its own copy of Python, so nothing else
# (Homebrew, Xcode, developer tools) needs to be installed first.
if [[ ! -x "$UV" ]]; then
  echo "Step 1 of 3: downloading helper tools..."
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null
else
  echo "Step 1 of 3: helper tools already installed."
fi

echo "Step 2 of 3: installing (this takes a minute or two)..."
"$UV" python install 3.12 >/dev/null 2>&1
rm -rf "$VENV"
"$UV" venv --quiet --python 3.12 "$VENV"
"$UV" pip install --quiet --python "$VENV/bin/python" "$HERE"

# Make `assistant` available in new Terminal windows.
if ! grep -q "personal-assistant/venv/bin/assistant" "$HOME/.zshrc" 2>/dev/null; then
  echo 'alias assistant="$HOME/.personal-assistant/venv/bin/assistant"' >> "$HOME/.zshrc"
fi

echo "Step 3 of 3: setup questions"
echo
exec "$VENV/bin/assistant" setup

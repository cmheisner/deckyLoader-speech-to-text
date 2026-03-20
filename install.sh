#!/bin/bash
set -e

PLUGIN_NAME="decky-speech-to-text"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
DECKY_PLUGINS="$HOME/homebrew/plugins"
INSTALL_DIR="$DECKY_PLUGINS/$PLUGIN_NAME"

# Load nvm (check both standard and VSCode Flatpak locations)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
elif [ -s "$HOME/.var/app/com.visualstudio.code/config/nvm/nvm.sh" ]; then
  source "$HOME/.var/app/com.visualstudio.code/config/nvm/nvm.sh"
fi

# Ensure xdotool is available
if ! command -v xdotool &>/dev/null; then
  echo "==> xdotool not found. Installing..."
  sudo pacman -S --noconfirm xdotool
fi

echo "==> Building $PLUGIN_NAME..."
cd "$PLUGIN_DIR"
npm install
npm run build

echo "==> Bundling Python dependencies into lib/..."
rm -rf "$PLUGIN_DIR/lib"
# SteamOS blocks system-wide pip (PEP 668). Use a temp venv to get pip,
# then install into lib/ with --target (user venvs bypass the restriction).
VENV=$(mktemp -d)
python3 -m venv "$VENV"
# Decky now embeds Python 3.13, which removed aifc and audioop.
# SpeechRecognition>=3.12 supports Python 3.13; audioop-lts restores audioop.
"$VENV/bin/pip" install --target="$PLUGIN_DIR/lib" --no-compile --quiet "SpeechRecognition" "audioop-lts"
rm -rf "$VENV"

echo "==> Installing to $INSTALL_DIR (requires sudo)..."
/usr/bin/sudo rm -rf "$INSTALL_DIR"
/usr/bin/sudo mkdir -p "$INSTALL_DIR"

/usr/bin/sudo cp plugin.json "$INSTALL_DIR/"
/usr/bin/sudo cp main.py "$INSTALL_DIR/"
/usr/bin/sudo cp -r dist "$INSTALL_DIR/"
/usr/bin/sudo cp -r lib "$INSTALL_DIR/"

echo "==> Done! Restart Decky Loader to load the plugin."
echo "    (Quick Access Menu -> Decky -> ... -> Reload)"

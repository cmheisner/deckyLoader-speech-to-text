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

echo "==> Installing to $INSTALL_DIR (requires sudo)..."
/usr/bin/sudo rm -rf "$INSTALL_DIR"
/usr/bin/sudo mkdir -p "$INSTALL_DIR"

/usr/bin/sudo cp plugin.json "$INSTALL_DIR/"
/usr/bin/sudo cp main.py "$INSTALL_DIR/"
/usr/bin/sudo cp -r dist "$INSTALL_DIR/"

echo "==> Done! Restart Decky Loader to load the plugin."
echo "    (Quick Access Menu -> Decky -> ... -> Reload)"

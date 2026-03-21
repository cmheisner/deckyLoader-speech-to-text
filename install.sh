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

# ── Dependencies ──────────────────────────────────────────────────────────────

# xdotool: X11 key injection (fallback for gaming mode)
if ! command -v xdotool &>/dev/null; then
  echo "==> xdotool not found. Installing..."
  sudo pacman -S --noconfirm xdotool
fi

# ydotool: kernel uinput key injection (primary method — works on Gamescope/Wayland)
if ! command -v ydotool &>/dev/null; then
  echo "==> ydotool not found. Installing..."
  sudo pacman -S --noconfirm ydotool || {
    echo "    WARNING: ydotool not available in repos — xdotool will be used as fallback."
  }
fi

# ydotoold: daemon required by ydotool
# Run it as a systemd user service so it survives reboots.
if command -v ydotool &>/dev/null; then
  echo "==> Setting up ydotoold service..."

  # Create a systemd service file that runs ydotoold as root (needed for /dev/uinput)
  sudo tee /etc/systemd/system/ydotoold.service > /dev/null <<'EOF'
[Unit]
Description=ydotool daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ydotoold
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now ydotoold || echo "    WARNING: Could not start ydotoold service."
fi

# wl-clipboard: Wayland clipboard fallback
if ! command -v wl-copy &>/dev/null; then
  echo "==> wl-clipboard not found. Installing..."
  sudo pacman -S --noconfirm wl-clipboard || echo "    WARNING: wl-clipboard not available."
fi

# ── Build frontend ────────────────────────────────────────────────────────────
echo "==> Building $PLUGIN_NAME..."
cd "$PLUGIN_DIR"
npm install
npm run build

# ── Bundle Python dependencies ────────────────────────────────────────────────
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

# ── Install to Decky plugins directory ───────────────────────────────────────
echo "==> Installing to $INSTALL_DIR (requires sudo)..."
/usr/bin/sudo rm -rf "$INSTALL_DIR"
/usr/bin/sudo mkdir -p "$INSTALL_DIR"

/usr/bin/sudo cp plugin.json "$INSTALL_DIR/"
/usr/bin/sudo cp main.py     "$INSTALL_DIR/"
/usr/bin/sudo cp -r dist     "$INSTALL_DIR/"
/usr/bin/sudo cp -r lib      "$INSTALL_DIR/"

echo ""
echo "==> Done! Restart Decky Loader to load the plugin."
echo "    Quick Access Menu -> Decky -> ... -> Reload plugins"
echo ""
echo "    Tip: if text still doesn't type, open the plugin's QAM panel"
echo "    and press 'Run Diagnostics' to see which tools are available."

# SpeechToText — Decky Loader Plugin

A floating microphone bubble for your Steam Deck that lets you speak and have text typed wherever your cursor is — like the mic button on Android.

## Install

> **Requires:** [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) already installed on your Steam Deck.

### Option 1: Decky Plugin Store (easiest)

1. Press the **⋮ (Quick Access)** button on your Steam Deck.
2. Go to the **Decky** tab and open the **Store** (shopping bag icon).
3. Search for **SpeechToText** and hit **Install**.

Dependencies are installed automatically in the background on first load — nothing else required.

### Option 2: Manual install

**Prerequisites** (do these first in Desktop Mode):

1. Make sure **Decky Loader** is installed ([install guide](https://github.com/SteamDeckHomebrew/decky-loader)).
2. Open **Konsole** (search for it in the application launcher).
3. Set a `sudo` password if you haven't already — you'll need it during install:
   ```bash
   passwd
   ```

Then run the installer:

```bash
curl -L https://github.com/cheisner/deckyLoader-speech-to-text/releases/latest/download/install.sh | bash
```

Or clone and install manually:

```bash
git clone https://github.com/cheisner/deckyLoader-speech-to-text.git
cd deckyLoader-speech-to-text
bash install.sh
```

> **Note:** If Node.js/npm isn't installed, the script will install it automatically via [nvm](https://github.com/nvm-sh/nvm). This requires an internet connection and may take a minute.

Then reload Decky:

> Quick Access Menu (⋮) → Decky → ··· → Reload plugins

## Features

- **Floating mic bubble** — draggable, always on screen
- **Tap to record / tap to stop** — turns red while listening
- **Types text at your cursor** — works in chat, search bars, browsers, and more
- **Wayland + Gamescope compatible** — uses `ydotool` (kernel-level input) with `xdotool` and clipboard as fallbacks
- **Settings panel** in the Quick Access Menu — resize, reposition, view last transcript

## Usage

1. The mic bubble appears on screen when the on-screen keyboard or Steam overlay is open.
2. **Tap** the bubble — it turns red and starts recording.
3. Speak naturally.
4. **Tap again** to stop — your words are typed at the cursor.
5. Drag the bubble to reposition it.

### Settings (Quick Access Menu)

| Setting                | Description                                    |
| ---------------------- | ---------------------------------------------- |
| Show microphone button | Toggle the floating mic bubble             |
| Icon size              | Adjust the bubble size (32–80 px)         |
| Position               | Snap to any screen corner                  |
| Last Transcript        | View the most recent result; copy or clear |

## Requirements

| Requirement                                                    | Notes                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) | Plugin host                                                               |
| Internet connection                                            | Speech recognition uses Google's API                                      |
| `ydotool` + `ydotoold`                                     | Primary text injection (Wayland/Gamescope) — installed by `install.sh` |
| `xdotool`                                                    | Fallback text injection (X11) — installed by `install.sh`              |
| `wl-clipboard`                                               | Clipboard fallback — installed by `install.sh`                         |

System dependencies (`ydotool`, `xdotool`, `wl-clipboard`) and Node.js are installed automatically by `install.sh` if missing. A `sudo` password and internet connection are required.

## How It Works

- **Frontend** (TypeScript/React): Renders the floating bubble and settings panel. Sends recording commands to the backend via Decky's RPC bridge.
- **Backend** (Python): Uses `parecord` to capture microphone audio, sends it to Google's Speech Recognition API via the `SpeechRecognition` library, then types the result using `ydotool type` (Gamescope/Wayland), falling back to `xdotool type` (X11) or clipboard if needed.

## Troubleshooting

**Text isn't being typed**
Make sure `ydotoold` is running: `sudo systemctl enable --now ydotoold`. If you installed from the store, this is handled automatically on first load.

**Mic bubble not showing**
The bubble only appears when the on-screen keyboard or Steam overlay is open. Toggle "Show microphone button" in the QAM panel.

**Speech not recognized**
Make sure you have an internet connection — recognition is done via Google's servers.

**"ydotoold is not running"**
Run `sudo systemctl enable --now ydotoold` in a terminal, or re-run `install.sh`.

## License

MIT — see [LICENSE](LICENSE)

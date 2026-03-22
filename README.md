
# deckyLoader-speech-to-text

A Steam Deck DeckyLoader plugin that adds a floating microphone bubble to your screen for speech-to-text input — like the mic button on Android phones.

## Features

- **Floating mic bubble** — always visible, draggable anywhere on screen
- **Tap to start / tap to stop** — click/tap the bubble to toggle recording
- **Types text at your cursor** — recognized speech is typed into whatever is currently focused (text fields, chat boxes, browsers, etc.)
- **Last transcript display** — the QAM settings panel shows the most recent transcription result
## Requirements

- [DeckyLoader](https://github.com/SteamDeckHomebrew/decky-loader) installed on your Steam Deck
- `xdotool` (installed automatically by `install.sh`, or manually: `sudo pacman -S xdotool`)
- Internet connection for speech recognition (uses the browser's built-in Web Speech API via Google's servers)

## Installation

```bash
# On your Steam Deck (Desktop Mode)
git clone https://github.com/cheisner/deckyLoader-speech-to-text.git
cd deckyLoader-speech-to-text
bash install.sh
```

Then in the Steam Deck UI:
> Quick Access Menu (⋮) → Decky → ··· → Reload plugins

## Usage

1. The floating mic bubble appears on screen after the plugin loads.
2. **Tap** the bubble to start listening — it turns red with a pulsing glow.
3. Speak naturally — your words are typed at the current cursor position.
4. **Tap again** to stop recording.
5. Drag the bubble anywhere on screen to reposition it.

### Settings (QAM Panel)

Open the Quick Access Menu → Decky → SpeechToText:

| Setting | Description |
|---|---|
| Show microphone button | Toggle the floating mic bubble on/off |
| Icon size | Adjust the size of the mic bubble |
| Position | Move the bubble to a screen corner |
| Last Transcript | Shows the most recent speech recognition result |

## How It Works

- **Frontend** (TypeScript/React): Renders the floating bubble and uses the browser's [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) (`webkitSpeechRecognition`) for real-time speech recognition.
- **Backend** (Python): Receives the recognized transcript and uses `xdotool type` to inject the text at the OS level, into whatever window / input field is focused.

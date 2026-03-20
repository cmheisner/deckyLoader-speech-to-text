# Decky Loader Plugin Development — Issues & Resolutions

**Stack:** TypeScript, React, Rollup, @decky/ui, @decky/api, Python backend

---

## Issue 1: ESM output causes "unexpected token export" error in Decky

**Symptom:** After install, Steam alerts "syntax error unexpected token export"
**Cause:** `@decky/rollup` defaults to `format: 'esm'` but this Steam Deck's Decky Loader version expects IIFE format. Existing plugins in `~/homebrew/plugins/` confirmed they use IIFE.
**Fix:** Override rollup config output — the ONLY correct pattern is:

```js
// rollup.config.mjs
import deckyPlugin from "@decky/rollup";
const config = deckyPlugin();
config.output = {
  ...config.output,
  format: "iife",
  globals: { react: "SP_REACT", "react-dom": "SP_REACTDOM", "@decky/ui": "DFL" },
};
export default config;
```

**Why this exact pattern:** Passing options INTO `deckyPlugin(options)` does NOT work — internally it calls `mergeAndConcat(options, defaultOptions)` where `defaultOptions` is the second arg, so the defaults win and format stays `'esm'`. Must mutate `config.output` after the call. Also add `"type": "module"` to package.json.

**Confirmed working output:** ends with `return index;\n})();` — no `export` keyword, no variable assignment.

---

## Issue 2: "plugin is not a function" after switching to IIFE

**Symptom:** TypeError: plugin is not a function
**Cause:** IIFE output was assigning to a variable (`var deckyTimestamp = (function(){...})()`). Decky evaluates the script and expects the return value directly — not a variable assignment.
**Fix:** Remove the `name` field from the IIFE rollup output config so it produces `(function(){...})()` with no var assignment.

---

## Issue 3: "SP_REACTDOM.createRoot / render is not a function"

**Symptom:** TypeError when plugin tries to render overlay via ReactDOM
**Cause:** Decky's bundled `SP_REACTDOM` is minimal and doesn't expose `render` or `createRoot`.
**Fix:** Abandon ReactDOM entirely for the overlay. Use `routerHook.addGlobalComponent` instead (see Issue 4).

---

## Issue 4: Overlay not visible (DOM injection approach)

**Symptom:** `document.body.appendChild(overlayEl)` works but nothing shows on screen
**Cause:** Decky's panel runs in a sandboxed iframe/overlay context. `document.body` is the panel's document, not the main Steam UI.
**Fix:** Use `routerHook.addGlobalComponent("ComponentName", MyComponent)` from `@decky/api`. This injects a React component into Decky's global render tree.

---

## Issue 5: Global component disappears when QAM side panel closes

**Symptom:** Component visible when QAM is open, disappears when dismissed
**Cause:** `addGlobalComponent` renders inside the GamepadUI overlay container, which Steam hides when QAM is dismissed.
**Fix:** Call `useUIComposition(UIComposition.Notification)` inside the global component. The hook must be found at runtime via `findModuleChild`:

```ts
const useUIComposition = findModuleChild((m) => {
  if (typeof m !== "object") return undefined;
  for (const prop in m) {
    if (
      typeof m[prop] === "function" &&
      m[prop].toString().includes("AddMinimumCompositionStateRequest") &&
      m[prop].toString().includes("ChangeMinimumCompositionStateRequest") &&
      m[prop].toString().includes("RemoveMinimumCompositionStateRequest") &&
      !m[prop].toString().includes("m_mapCompositionStateRequests")
    ) return m[prop];
  }
});
```

UIComposition values: Hidden=0, Notification=1, Overlay=2, Opaque=3, OverlayKeyboard=4

---

## Issue 6: Settings reset when toggling off and back on

**Symptom:** Re-opening QAM after toggling resets all settings to defaults
**Cause:** `Content` component used `useState(initialValue)` captured at plugin load time. When QAM closes/reopens, Content remounts and re-initializes from the stale value.
**Fix:** Use a module-level mutable variable kept in sync on every change, and initialize state from it: `useState(() => globalValue)`.

---

## Issue 7: routerHook import location

**Symptom:** "Cannot read properties of undefined (reading 'addGlobalComponent')"
**Cause:** `routerHook` is in `@decky/api`, not `@decky/ui`.
**Fix:**
```ts
import { callable, toaster, routerHook } from "@decky/api";
```

---

## Issue 8: SpeechRecognition "not-allowed" in Steam's CEF

**Symptom:** Web Speech API fires `onerror` with `e.error === "not-allowed"` immediately
**Cause:** Steam's custom CEF build does not have Google's Speech API key embedded. `SpeechRecognition` always fails regardless of microphone permissions. `getUserMedia` may succeed but SpeechRecognition will still be blocked.
**Fix:** Move audio capture and transcription to the Python backend entirely:
- Use `parecord --raw --channels=1 --rate=16000 --format=s16le` (PipeWire/PulseAudio) to capture audio
- Use the `SpeechRecognition` Python library (`pip install SpeechRecognition`) with `sr.AudioData` + `recognize_google()`
- Add `SpeechRecognition` to `requirements.txt` — Decky installs it into the plugin's venv automatically

---

## Node.js on Steam Deck

Steam Deck's root filesystem is read-only — `pacman` installs don't persist across OS updates. Use **nvm** installed to `~/.nvm`. VSCode runs as a Flatpak so `sudo` and `passwd` are unavailable in its integrated terminal — use Konsole for those commands.

---

## Install script needs sudo

The `~/homebrew/plugins/` directory is owned by `nfsnobody`. The install script must use `/usr/bin/sudo` explicitly (not just `sudo`) and must be run from Konsole, not VSCode's terminal.

---

## Debugging JS errors in Decky plugins

Plugin backend Python logs are in `~/homebrew/logs/<plugin-name>/`. These do NOT capture frontend JS errors.

For JS errors, use Steam's CEF remote debugger:

```bash
# Get the SharedJSContext devtools URL
curl http://localhost:8080/json 2>/dev/null | python3 -c \
  "import json,sys; pages=json.load(sys.stdin); \
   [print(p.get('devtoolsFrontendUrl','')) for p in pages if p.get('title')=='SharedJSContext']"
```

Open the resulting URL in a browser (replace `localhost` with deck IP if accessing from PC). Go to the **Console** tab — all Decky plugin JS errors appear here with full stack traces.

---

## Store submission checklist

- `plugin.json`: name, author (GitHub handle), flags, license, publish.tags, publish.description, publish.image (raw GitHub URL to assets/logo.png)
- `LICENSE` file required (CC0-1.0 is fine)
- `assets/logo.png` — 256×256px PNG for store listing
- Submit via PR to Decky Plugin Database repo as a git submodule under `/plugins`

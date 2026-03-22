import {
  definePlugin,
  ToggleField,
  SliderField,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  staticClasses,
} from "@decky/ui";
import { callable, toaster, routerHook } from "@decky/api";
import React, { useState, useEffect, useRef, FC } from "react";
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";

// ── Backend callables ─────────────────────────────────────────────────────────
// start_recording / type_text return '' on success, or an error string.
// stop_and_transcribe returns the transcript, '' if nothing heard, or 'ERROR: …'.
// check_tools returns a diagnostic string.
const startRecording    = callable<[], string>("start_recording");
const stopAndTranscribe = callable<[], string>("stop_and_transcribe");
const cancelRecording   = callable<[], void>("cancel_recording");
const typeText          = callable<[text: string], string>("type_text");
const checkTools        = callable<[], string>("check_tools");

// ── Settings ──────────────────────────────────────────────────────────────────
interface MicSettings {
  visible: boolean;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  iconSize: number;
}

const POSITIONS: MicSettings["position"][] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const POSITION_STYLES: Record<MicSettings["position"], React.CSSProperties> = {
  "top-left":     { top: 16, left: 16 },
  "top-right":    { top: 16, right: 16 },
  "bottom-left":  { bottom: 16, left: 16 },
  "bottom-right": { bottom: 80, right: 16 },
};

const STORAGE_KEY = "decky-stt-settings";

function defaultSettings(): MicSettings {
  return {
    visible: true,
    position: "bottom-right",
    iconSize: 56,
  };
}

function loadSettings(): MicSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {}
  return defaultSettings();
}

function saveSettings(s: MicSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ── Module-level shared state ─────────────────────────────────────────────────
let globalSettings = loadSettings();
const listeners: Array<(s: MicSettings) => void> = [];

function notifyListeners(s: MicSettings) {
  listeners.forEach((fn) => fn(s));
}

// Recording state lives at module level so a component remount restores the
// real current state instead of always resetting to false.
let _isListening = false;

// Last transcript — persisted in localStorage so it survives module re-evaluation
const TRANSCRIPT_KEY = "decky-stt-transcript";

function loadTranscript(): string {
  try { return localStorage.getItem(TRANSCRIPT_KEY) ?? ""; } catch { return ""; }
}

let _lastTranscript = loadTranscript();
const transcriptListeners: Array<(t: string) => void> = [];

function setGlobalTranscript(t: string) {
  _lastTranscript = t;
  try { localStorage.setItem(TRANSCRIPT_KEY, t); } catch {}
  transcriptListeners.forEach((fn) => fn(t));
}

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  const [settings, setSettings] = useState<MicSettings>(globalSettings);
  const [isListening, setIsListening] = useState(() => _isListening);

  const isListeningRef = useRef(_isListening);

  // Subscribe to settings changes pushed from the QAM panel
  useEffect(() => {
    const listener = (s: MicSettings) => setSettings(s);
    listeners.push(listener);
    return () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  }, []);

  // Cleanup on unmount — only cancel if still actively recording
  useEffect(() => () => {
    if (isListeningRef.current) {
      isListeningRef.current = false;
      cancelRecording();
    }
  }, []);

  // ── Recording helpers ────────────────────────────────────────────────────────
  const stopListening = async () => {
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    _isListening = false;
    setIsListening(false);

    toaster.toast({ title: "SpeechToText", body: "Stopped — transcribing…" });

    let transcript: string;
    try {
      transcript = await stopAndTranscribe();
    } catch (e: any) {
      const msg = `Call failed: ${e?.message ?? e}`;
      toaster.toast({ title: "SpeechToText", body: msg });
      setGlobalTranscript(`⚠ ${msg}`);
      return;
    }

    // Backend signals errors with the 'ERROR: ' prefix
    if (transcript.startsWith("ERROR:")) {
      const msg = transcript.replace(/^ERROR:\s*/, "");
      toaster.toast({ title: "SpeechToText", body: msg });
      setGlobalTranscript(`⚠ ${msg}`);
      return;
    }

    if (!transcript) {
      toaster.toast({ title: "SpeechToText", body: "Nothing heard — try speaking louder" });
      setGlobalTranscript("(nothing heard)");
      return;
    }

    setGlobalTranscript(transcript);

    let typeResult: string;
    try {
      typeResult = await typeText(transcript + " ");
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Type call failed: ${e?.message ?? e}` });
      return;
    }

    if (typeResult === "CLIPBOARD") {
      toaster.toast({
        title: "SpeechToText",
        body: `Copied to clipboard! Paste with Ctrl+V\n"${transcript}"`,
      });
    } else if (typeResult.startsWith("ERROR:")) {
      toaster.toast({ title: "SpeechToText", body: typeResult.replace(/^ERROR:\s*/, "") });
    }
    // Empty string = success — already shown "Heard: …" toast above
  };

  const startListening = async () => {
    _isListening = true;
    isListeningRef.current = true;
    setIsListening(true);

    toaster.toast({ title: "SpeechToText", body: "Starting mic…" });

    let errMsg: string;
    try {
      errMsg = await startRecording();
    } catch (e: any) {
      _isListening = false;
      isListeningRef.current = false;
      setIsListening(false);
      toaster.toast({ title: "SpeechToText", body: `Mic call failed: ${e?.message ?? e}` });
      return;
    }

    if (errMsg) {
      _isListening = false;
      isListeningRef.current = false;
      setIsListening(false);
      toaster.toast({ title: "SpeechToText", body: `Mic error: ${errMsg}` });
      return;
    }

    toaster.toast({ title: "SpeechToText", body: "Listening… tap to stop" });
    setGlobalTranscript("🎙 Listening…");
  };

  // ── Tap handler ──────────────────────────────────────────────────────────────
  // onPointerUp + touchAction:none is more reliable than onClick in Decky's
  // global component context — Steam's input layer can swallow click events.
  const onPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isListeningRef.current) {
      stopListening();
    } else {
      startListening();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  if (!settings.visible) return null;

  const { iconSize, position } = settings;
  const iconInnerSize = Math.round(iconSize * 0.39);
  const bgColor = isListening ? "#e74c3c" : "#1a9fff";

  // Wrap in a full-screen pointer-events:none shell so the overlay container
  // doesn't swallow mouse/touch input meant for games or other apps.
  // Only the button itself has pointer-events:auto.
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999 }}>
      <div
        onPointerUp={onPointerUp}
        style={{
          position: "absolute",
          pointerEvents: "auto",
          width: iconSize,
          height: iconSize,
          borderRadius: "50%",
          background: bgColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          boxShadow: isListening
            ? "0 0 0 8px rgba(231,76,60,0.30), 0 3px 16px rgba(0,0,0,0.6)"
            : "0 3px 16px rgba(0,0,0,0.55)",
          transition: "background 0.15s, box-shadow 0.2s",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          ...POSITION_STYLES[position as MicSettings["position"]],
        }}
      >
        {isListening ? (
          <FaMicrophone color="white" size={iconInnerSize} />
        ) : (
          <FaMicrophoneSlash color="white" size={iconInnerSize} />
        )}
      </div>
    </div>
  );
};

// ── QAM settings panel ────────────────────────────────────────────────────────
const Content: FC<{ onUpdate: (s: MicSettings) => void }> = ({ onUpdate }) => {
  const [settings, setSettings] = useState<MicSettings>(() => globalSettings);
  const [diagRunning, setDiagRunning] = useState(false);
  const [transcript, setTranscript] = useState(() => _lastTranscript);
  const [copied, setCopied] = useState(false);

  // Keep transcript display in sync with the floating button
  useEffect(() => {
    transcriptListeners.push(setTranscript);
    return () => {
      const i = transcriptListeners.indexOf(setTranscript);
      if (i >= 0) transcriptListeners.splice(i, 1);
    };
  }, []);

  const update = (patch: Partial<MicSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    globalSettings = next;
    onUpdate(next);
  };

  const runDiagnostics = async () => {
    setDiagRunning(true);
    toaster.toast({ title: "SpeechToText", body: "Running diagnostics…" });
    try {
      const result = await checkTools();
      // Split the pipe-delimited result into individual toasts so each line is readable
      const parts = result.split(" | ");
      for (const part of parts) {
        toaster.toast({ title: "STT Diagnostics", body: part });
      }
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Diagnostics failed: ${e?.message ?? e}` });
    } finally {
      setDiagRunning(false);
    }
  };

  const posIdx = Math.max(0, POSITIONS.indexOf(settings.position));

  return (
    <>
    <PanelSection title="Last Transcript">
      <PanelSectionRow>
        <div style={{
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 6,
          padding: "10px 12px",
          minHeight: 56,
          fontSize: 14,
          lineHeight: 1.5,
          wordBreak: "break-word",
          color: transcript ? "#ffffff" : "rgba(255,255,255,0.35)",
          width: "100%",
        }}>
          {transcript || "Tap the mic button — text appears here"}
        </div>
      </PanelSectionRow>
      {transcript ? (
        <>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                // execCommand is synchronous and works in the Steam overlay
                // Chromium context without needing clipboard permissions.
                const el = document.createElement("textarea");
                el.value = transcript;
                el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
                document.body.appendChild(el);
                el.focus();
                el.select();
                const ok = document.execCommand("copy");
                document.body.removeChild(el);

                if (ok) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } else {
                  // execCommand failed — try async API
                  navigator.clipboard?.writeText(transcript).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }).catch(() => {
                    toaster.toast({ title: "SpeechToText", body: "Copy failed — try the Clear button and retype" });
                  });
                }
              }}
            >
              {copied ? "Copied!" : "Copy to Clipboard"}
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => { setGlobalTranscript(""); }}
            >
              Clear
            </ButtonItem>
          </PanelSectionRow>
        </>
      ) : null}
    </PanelSection>

    <PanelSection title="Settings">
      <PanelSectionRow>
        <ToggleField
          label="Show microphone button"
          description={settings.visible ? "Visible" : "Hidden"}
          checked={settings.visible}
          onChange={(v: boolean) => update({ visible: v })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <SliderField
          label={`Icon Size: ${settings.iconSize}px`}
          value={settings.iconSize}
          min={32}
          max={80}
          step={4}
          onChange={(v: number) => update({ iconSize: v })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <SliderField
          label={`Position: ${settings.position}`}
          value={posIdx}
          min={0}
          max={POSITIONS.length - 1}
          step={1}
          onChange={(v: number) => update({ position: POSITIONS[v] })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={runDiagnostics}
          disabled={diagRunning}
        >
          {diagRunning ? "Running…" : "Run Diagnostics"}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
    </>
  );
};

// ── Plugin entry point ────────────────────────────────────────────────────────
export default definePlugin(() => {
  globalSettings = loadSettings();
  routerHook.addGlobalComponent("SpeechToTextBubble", FloatingMicButton);

  return {
    title: <div className={staticClasses.Title}>SpeechToText</div>,
    content: <Content onUpdate={notifyListeners} />,
    icon: <FaMicrophone />,
    onDismount() {
      routerHook.removeGlobalComponent("SpeechToTextBubble");
    },
  };
});

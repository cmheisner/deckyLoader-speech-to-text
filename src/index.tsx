import {
  definePlugin,
  findModuleChild,
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

// ── UIComposition — keeps overlay click-through in gaming mode ────────────────
enum UIComposition {
  Overlay = 2,
}

const useUIComposition: ((mode: UIComposition) => void) | undefined =
  findModuleChild((m: Record<string, unknown>) => {
    if (typeof m !== "object" || m === null) return undefined;
    for (const prop in m) {
      if (
        typeof m[prop] === "function" &&
        (m[prop] as Function).toString().includes("AddMinimumCompositionStateRequest") &&
        (m[prop] as Function).toString().includes("ChangeMinimumCompositionStateRequest") &&
        (m[prop] as Function).toString().includes("RemoveMinimumCompositionStateRequest") &&
        !(m[prop] as Function).toString().includes("m_mapCompositionStateRequests")
      ) {
        return m[prop] as (mode: UIComposition) => void;
      }
    }
  });

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
  timeoutEnabled: boolean;
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
    timeoutEnabled: true,
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

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  useUIComposition?.(UIComposition.Overlay);

  const [settings, setSettings] = useState<MicSettings>(globalSettings);
  const [isListening, setIsListening] = useState(() => _isListening);

  const isListeningRef = useRef(_isListening);
  const autoStopRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    if (isListeningRef.current) {
      isListeningRef.current = false;
      cancelRecording();
    }
  }, []);

  // ── Recording helpers ────────────────────────────────────────────────────────
  const clearAutoStop = () => {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  };

  const stopListening = async () => {
    clearAutoStop();
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    _isListening = false;
    setIsListening(false);

    toaster.toast({ title: "SpeechToText", body: "Stopped — transcribing…" });

    let transcript: string;
    try {
      transcript = await stopAndTranscribe();
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Transcription call failed: ${e?.message ?? e}` });
      return;
    }

    // Backend signals errors with the 'ERROR: ' prefix
    if (transcript.startsWith("ERROR:")) {
      toaster.toast({ title: "SpeechToText", body: transcript.replace(/^ERROR:\s*/, "") });
      return;
    }

    if (!transcript) {
      toaster.toast({ title: "SpeechToText", body: "Nothing heard — try speaking louder" });
      return;
    }

    toaster.toast({ title: "SpeechToText", body: `Heard: "${transcript}"` });

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

    if (globalSettings.timeoutEnabled) {
      autoStopRef.current = setTimeout(() => stopListening(), 5000);
    }
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

  return (
    <div
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        zIndex: 9999,
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
  );
};

// ── QAM settings panel ────────────────────────────────────────────────────────
const Content: FC<{ onUpdate: (s: MicSettings) => void }> = ({ onUpdate }) => {
  const [settings, setSettings] = useState<MicSettings>(() => globalSettings);
  const [diagRunning, setDiagRunning] = useState(false);

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
    <PanelSection title="SpeechToText">
      <PanelSectionRow>
        <ToggleField
          label="Show microphone button"
          description={settings.visible ? "Visible" : "Hidden"}
          checked={settings.visible}
          onChange={(v: boolean) => update({ visible: v })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <ToggleField
          label="Auto-stop after 5 seconds"
          description={
            settings.timeoutEnabled
              ? "Mic turns off automatically after 5 s"
              : "Mic stays on until you tap the bubble again"
          }
          checked={settings.timeoutEnabled}
          onChange={(v: boolean) => update({ timeoutEnabled: v })}
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

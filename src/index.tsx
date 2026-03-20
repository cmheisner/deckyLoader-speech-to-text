import {
  definePlugin,
  findModuleChild,
  ToggleField,
  SliderField,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, toaster, routerHook } from "@decky/api";
import React, { useState, useEffect, useRef, FC } from "react";

// ── UIComposition (keeps overlay visible when QAM is closed — Issue 5) ────────
enum UIComposition {
  Hidden = 0,
  Notification = 1,
  Overlay = 2,
  Opaque = 3,
  OverlayKeyboard = 4,
}

const useUIComposition: ((mode: UIComposition) => void) | undefined =
  findModuleChild((m: Record<string, unknown>) => {
    if (typeof m !== "object") return undefined;
    for (const prop in m) {
      if (
        typeof m[prop] === "function" &&
        m[prop].toString().includes("AddMinimumCompositionStateRequest") &&
        m[prop].toString().includes("ChangeMinimumCompositionStateRequest") &&
        m[prop].toString().includes("RemoveMinimumCompositionStateRequest") &&
        !m[prop].toString().includes("m_mapCompositionStateRequests")
      ) {
        return m[prop];
      }
    }
  });
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";

// ── Backend callables ─────────────────────────────────────────────────────────
const typeText          = callable<[text: string], boolean>("type_text");
const startRecording    = callable<[], boolean>("start_recording");
const stopAndTranscribe = callable<[], string>("stop_and_transcribe");
const cancelRecording   = callable<[], void>("cancel_recording");

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

function loadSettings(): MicSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {}
  return defaultSettings();
}

function defaultSettings(): MicSettings {
  return {
    visible: true,
    timeoutEnabled: true,
    position: "bottom-right",
    iconSize: 56,
  };
}

function saveSettings(s: MicSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ── Module-level shared state (listeners pattern, like timestamp repo) ────────
let globalSettings = loadSettings();
const listeners: Array<(s: MicSettings) => void> = [];

function notifyListeners(s: MicSettings) {
  listeners.forEach((fn) => fn(s));
}

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  useUIComposition?.(UIComposition.Notification);
  const [settings, setSettings] = useState<MicSettings>(globalSettings);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Ref mirrors isListening so callbacks (setTimeout, etc.) never see stale state
  const isListeningRef = useRef(false);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to settings changes from the QAM panel
  useEffect(() => {
    const listener = (s: MicSettings) => setSettings(s);
    listeners.push(listener);
    return () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  }, []);

  // If the button is hidden while recording, cancel cleanly
  useEffect(() => {
    if (!settings.visible && isListeningRef.current) {
      cancelListening();
    }
  }, [settings.visible]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    cancelRecording();
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
    setIsListening(false);
    setIsTranscribing(true);
    try {
      const transcript = await stopAndTranscribe();
      if (transcript) {
        const ok = await typeText(transcript + " ");
        if (!ok) {
          toaster.toast({ title: "SpeechToText", body: "Failed to type text. Is xdotool installed?" });
        }
      }
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Transcription error: ${e?.message ?? e}` });
    } finally {
      setIsTranscribing(false);
    }
  };

  const cancelListening = async () => {
    clearAutoStop();
    isListeningRef.current = false;
    setIsListening(false);
    setIsTranscribing(false);
    await cancelRecording();
  };

  const startListening = async () => {
    const ok = await startRecording();
    if (!ok) {
      toaster.toast({ title: "SpeechToText", body: "Failed to start recording. Check mic is connected." });
      return;
    }
    isListeningRef.current = true;
    setIsListening(true);
    if (globalSettings.timeoutEnabled) {
      autoStopRef.current = setTimeout(() => stopListening(), 5000);
    }
  };

  // ── Click handler (no drag) ──────────────────────────────────────────────────
  const onClick = () => {
    if (isTranscribing) return;
    isListeningRef.current ? stopListening() : startListening();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!settings.visible) return null;

  const { iconSize, position } = settings;
  const iconInnerSize = Math.round(iconSize * 0.39);
  const bgColor = isTranscribing ? "#f39c12" : isListening ? "#e74c3c" : "#1a9fff";

  return (
    <div
      onClick={onClick}
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
        cursor: isTranscribing ? "wait" : "pointer",
        boxShadow: isListening
          ? "0 0 0 8px rgba(231,76,60,0.30), 0 3px 16px rgba(0,0,0,0.6)"
          : "0 3px 16px rgba(0,0,0,0.55)",
        transition: "background 0.15s, box-shadow 0.2s",
        userSelect: "none",
        WebkitUserSelect: "none",
        ...POSITION_STYLES[position as MicSettings["position"]],
      }}
    >
      {isListening || isTranscribing ? (
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

  const update = (patch: Partial<MicSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    globalSettings = next;
    onUpdate(next);
  };

  const posIdx = Math.max(0, POSITIONS.indexOf(settings.position));

  return (
    <PanelSection title="SpeechToText">
      <PanelSectionRow>
        <ToggleField
          label="Show microphone button"
          description={settings.visible ? "Floating mic button is visible" : "Floating mic button is hidden"}
          checked={settings.visible}
          onChange={(v) => update({ visible: v })}
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
          onChange={(v) => update({ timeoutEnabled: v })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <SliderField
          label={`Icon Size: ${settings.iconSize}px`}
          value={settings.iconSize}
          min={32}
          max={80}
          step={4}
          onChange={(v) => update({ iconSize: v })}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <SliderField
          label={`Position: ${settings.position}`}
          value={posIdx}
          min={0}
          max={POSITIONS.length - 1}
          step={1}
          onChange={(v) => update({ position: POSITIONS[v] })}
        />
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

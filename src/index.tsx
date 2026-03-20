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
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";

// ── UIComposition — keeps overlay visible when QAM panel is closed ─────────────
// (Issue 5 in decky-plugin-lessons.md)
enum UIComposition {
  Notification = 1,
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

// Recording state lives at module level so a component remount (which resets
// useState to its initial value) re-reads the real current state instead of
// always starting at false.
let _isListening = false;

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  useUIComposition?.(UIComposition.Notification);

  const [settings, setSettings]             = useState<MicSettings>(globalSettings);
  // Initialize from module-level so a remount restores the real current state
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
    _isListening = false;
    setIsListening(false);
    toaster.toast({ title: "SpeechToText", body: "Recording stopped" });
    try {
      const transcript = await stopAndTranscribe();
      if (transcript) {
        toaster.toast({ title: "SpeechToText", body: `Heard: "${transcript}"` });
        const ok = await typeText(transcript + " ");
        if (!ok) {
          toaster.toast({ title: "SpeechToText", body: "Failed to type text. Is xdotool installed?" });
        }
      } else {
        toaster.toast({ title: "SpeechToText", body: "Nothing heard" });
      }
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Transcription error: ${e?.message ?? e}` });
    }
  };

  const startListening = async () => {
    // Set state synchronously before the await so the button turns red
    // immediately, and a remount during the async call re-reads _isListening=true
    _isListening = true;
    isListeningRef.current = true;
    setIsListening(true);
    try {
      const ok = await startRecording();
      if (!ok) {
        _isListening = false;
        isListeningRef.current = false;
        setIsListening(false);
        toaster.toast({ title: "SpeechToText", body: "Failed to start recording. Check mic is connected." });
        return;
      }
    } catch (e: any) {
      _isListening = false;
      isListeningRef.current = false;
      setIsListening(false);
      toaster.toast({ title: "SpeechToText", body: `Recording error: ${e?.message ?? e}` });
      return;
    }
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

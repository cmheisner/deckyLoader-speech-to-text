import {
  definePlugin,
  ToggleField,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, toaster, routerHook } from "@decky/api";
import React, { useState, useEffect, useRef, FC } from "react";
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";

// ── Backend callables ─────────────────────────────────────────────────────────
const typeText         = callable<[text: string], boolean>("type_text");
const startRecording   = callable<[], boolean>("start_recording");
const stopAndTranscribe = callable<[], string>("stop_and_transcribe");
const cancelRecording  = callable<[], void>("cancel_recording");

// ── Module-level shared state (QAM panel ↔ floating button) ──────────────────
let _timeoutEnabled = true;
let _setTimeoutEnabledRef: ((v: boolean) => void) | null = null;
let _visible = true;
let _setVisibleRef: ((v: boolean) => void) | null = null;

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [timeoutEnabled, setTimeoutEnabled] = useState(_timeoutEnabled);
  const [visible, setVisible] = useState(_visible);
  const [pos, setPos] = useState({ x: 24, y: Math.round(window.innerHeight * 0.55) });

  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasMoved = useRef(false);
  const pointerOrigin = useRef({ x: 0, y: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;

  // Keep module-level setters in sync so the QAM panel can update us
  useEffect(() => {
    _setTimeoutEnabledRef = setTimeoutEnabled;
    _setVisibleRef = setVisible;
    return () => { _setTimeoutEnabledRef = null; _setVisibleRef = null; };
  }, []);

  useEffect(() => { _timeoutEnabled = timeoutEnabled; }, [timeoutEnabled]);

  useEffect(() => {
    _visible = visible;
    if (!visible) stopListening();
  }, [visible]);

  // ── Recording helpers ────────────────────────────────────────────────────────
  const clearAutoStop = () => {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  };

  const stopListening = async () => {
    clearAutoStop();
    if (!isListening) return;
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
    setIsListening(true);
    if (_timeoutEnabled) {
      autoStopRef.current = setTimeout(() => stopListening(), 5000);
    }
  };

  // Cleanup on unmount
  useEffect(() => () => { clearAutoStop(); cancelRecording(); }, []);

  // ── Drag / tap handlers ─────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    hasMoved.current = false;
    pointerOrigin.current = {
      x: e.clientX - posRef.current.x,
      y: e.clientY - posRef.current.y,
    };
    containerRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons === 0) return;
    hasMoved.current = true;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 60, e.clientX - pointerOrigin.current.x)),
      y: Math.max(0, Math.min(window.innerHeight - 60, e.clientY - pointerOrigin.current.y)),
    });
  };

  const onPointerUp = () => {
    if (!hasMoved.current && !isTranscribing) {
      isListening ? stopListening() : startListening();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!visible) return null;

  const bgColor = isTranscribing ? "#f39c12" : isListening ? "#e74c3c" : "#1a9fff";

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: 56,
        height: 56,
        borderRadius: "50%",
        background: bgColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: isTranscribing ? "wait" : "grab",
        zIndex: 9999,
        boxShadow: isListening
          ? "0 0 0 8px rgba(231,76,60,0.30), 0 3px 16px rgba(0,0,0,0.6)"
          : "0 3px 16px rgba(0,0,0,0.55)",
        transition: "background 0.15s, box-shadow 0.2s",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {isListening || isTranscribing ? (
        <FaMicrophone color="white" size={22} />
      ) : (
        <FaMicrophoneSlash color="white" size={22} />
      )}
    </div>
  );
};

// ── QAM settings panel ────────────────────────────────────────────────────────
const Content: FC = () => {
  const [timeoutEnabled, setTimeoutEnabled] = useState(_timeoutEnabled);
  const [visible, setVisible] = useState(_visible);

  const handleTimeoutChange = (val: boolean) => {
    setTimeoutEnabled(val);
    _timeoutEnabled = val;
    if (_setTimeoutEnabledRef) _setTimeoutEnabledRef(val);
  };

  const handleVisibleChange = (val: boolean) => {
    setVisible(val);
    _visible = val;
    if (_setVisibleRef) _setVisibleRef(val);
  };

  return (
    <PanelSection title="SpeechToText">
      <PanelSectionRow>
        <ToggleField
          label="Show microphone button"
          description={visible ? "Floating mic button is visible" : "Floating mic button is hidden"}
          checked={visible}
          onChange={handleVisibleChange}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Auto-stop after 5 seconds"
          description={
            timeoutEnabled
              ? "Mic turns off automatically after 5 s of silence"
              : "Mic stays on until you tap the bubble again"
          }
          checked={timeoutEnabled}
          onChange={handleTimeoutChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
};

// ── Plugin entry point ────────────────────────────────────────────────────────
export default definePlugin(() => {
  routerHook.addGlobalComponent("SpeechToTextBubble", FloatingMicButton);

  return {
    title: <div className={staticClasses.Title}>SpeechToText</div>,
    content: <Content />,
    icon: <FaMicrophone />,
    onDismount() {
      routerHook.removeGlobalComponent("SpeechToTextBubble");
    },
  };
});

import {
  definePlugin,
  ToggleField,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, toaster } from "@decky/api";
import React, { useState, useEffect, useRef, FC } from "react";
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";

// ── Backend callable ──────────────────────────────────────────────────────────
const typeText = callable<[text: string], boolean>("type_text");

// ── Module-level shared state (QAM panel ↔ floating button) ──────────────────
let _timeoutEnabled = true;
let _setTimeoutEnabledRef: ((v: boolean) => void) | null = null;

// ── Floating mic button ───────────────────────────────────────────────────────
const FloatingMicButton: FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [timeoutEnabled, setTimeoutEnabled] = useState(_timeoutEnabled);
  const [pos, setPos] = useState({ x: 24, y: Math.round(window.innerHeight * 0.55) });

  const recognitionRef = useRef<any>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasMoved = useRef(false);
  const pointerOrigin = useRef({ x: 0, y: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;

  // Keep module-level setter in sync so the QAM panel can update us
  useEffect(() => {
    _setTimeoutEnabledRef = setTimeoutEnabled;
    return () => { _setTimeoutEnabledRef = null; };
  }, []);

  useEffect(() => { _timeoutEnabled = timeoutEnabled; }, [timeoutEnabled]);

  // ── Speech recognition helpers ──────────────────────────────────────────────
  const clearAutoStop = () => {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  };

  const stopListening = () => {
    clearAutoStop();
    if (recognitionRef.current) {
      recognitionRef.current._stopping = true;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const resetAutoStop = () => {
    clearAutoStop();
    if (_timeoutEnabled) {
      autoStopRef.current = setTimeout(stopListening, 5000);
    }
  };

  const startListening = () => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      toaster.toast({
        title: "SpeechToText",
        body: "Speech recognition is not supported in this browser.",
      });
      return;
    }

    const rec = new SpeechRecognitionCtor() as any;
    rec.continuous = true;       // keep mic open until we call .stop()
    rec.interimResults = false;
    rec.lang = "en-US";
    rec._stopping = false;

    rec.onresult = async (event: any) => {
      const last = event.results.length - 1;
      const transcript: string = event.results[last][0].transcript.trim();
      if (transcript) {
        const ok = await typeText(transcript + " ");
        if (!ok) {
          toaster.toast({ title: "SpeechToText", body: "Failed to type text. Is xdotool installed?" });
        }
      }
      // Reset the 5-second auto-stop window on each new result
      resetAutoStop();
    };

    rec.onerror = (e: any) => {
      if (e.error !== "aborted") {
        toaster.toast({ title: "SpeechToText", body: `Mic error: ${e.error}` });
      }
      stopListening();
    };

    rec.onend = () => {
      if (!rec._stopping) {
        // Unexpected end — treat as stopped
        clearAutoStop();
        setIsListening(false);
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = rec;
    rec.start();
    setIsListening(true);
    resetAutoStop();
  };

  // Cleanup on unmount
  useEffect(() => () => stopListening(), []);

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
    if (!hasMoved.current) {
      isListening ? stopListening() : startListening();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
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
        background: isListening ? "#e74c3c" : "#1a9fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "grab",
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
      {isListening ? (
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

  const handleChange = (val: boolean) => {
    setTimeoutEnabled(val);
    _timeoutEnabled = val;
    if (_setTimeoutEnabledRef) _setTimeoutEnabledRef(val);
  };

  return (
    <PanelSection title="SpeechToText">
      <PanelSectionRow>
        <ToggleField
          label="Auto-stop after 5 seconds"
          description={
            timeoutEnabled
              ? "Mic turns off automatically after 5 s of silence"
              : "Mic stays on until you tap the bubble again"
          }
          checked={timeoutEnabled}
          onChange={handleChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
};

// ── Plugin entry point ────────────────────────────────────────────────────────
export default definePlugin(() => {
  // Inject the floating bubble into the page DOM outside of the QAM panel
  const container = document.createElement("div");
  container.id = "speech-to-text-floating-root";
  document.body.appendChild(container);

  // Use Steam's bundled React / ReactDOM to avoid dual-React issues
  const React = (window as any).SP_REACT as typeof import("react");
  const ReactDOM = (window as any).SP_REACTDOM as typeof import("react-dom");
  ReactDOM.render(React.createElement(FloatingMicButton), container);

  return {
    title: <div className={staticClasses.Title}>SpeechToText</div>,
    content: <Content />,
    icon: <FaMicrophone />,
    onDismount() {
      ReactDOM.unmountComponentAtNode(container);
      container.remove();
    },
  };
});

import {
  definePlugin,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  staticClasses,
} from "@decky/ui";
import { callable, toaster } from "@decky/api";
import { useState, useEffect, useRef, FC } from "react";
import { FaMicrophone } from "react-icons/fa";

// ── Backend callables ─────────────────────────────────────────────────────────
// start_recording / type_text return '' on success, or an error string.
// stop_and_transcribe returns the transcript, '' if nothing heard, or 'ERROR: …'.
const startRecording    = callable<[], string>("start_recording");
const stopAndTranscribe = callable<[], string>("stop_and_transcribe");
const cancelRecording   = callable<[], void>("cancel_recording");
const typeText          = callable<[text: string], string>("type_text");

// ── Module-level recording state ──────────────────────────────────────────────
// Lives at module level so a QAM panel remount restores the real current state
// instead of always resetting to idle.
let _isListening = false;

// ── Module-level auto-paste scheduler ─────────────────────────────────────────
// Must live outside the component — the Content component unmounts when QAM
// closes, so any useEffect / ref approach dies before it can fire.
let _pendingPasteTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePaste(text: string) {
  if (_pendingPasteTimer !== null) {
    clearTimeout(_pendingPasteTimer);
    _pendingPasteTimer = null;
  }
  // 4 s gives the user time to close the QAM and Gamescope time to shift
  // input focus back to the game window before we simulate Ctrl+V.
  _pendingPasteTimer = setTimeout(async () => {
    _pendingPasteTimer = null;
    let result: string;
    try {
      result = await typeText(text);
    } catch (e: any) {
      toaster.toast({ title: "SpeechToText", body: `Auto-paste failed — use Ctrl+V` });
      return;
    }
    if (result === "CLIPBOARD") {
      toaster.toast({ title: "SpeechToText", body: "Auto-paste failed — use Ctrl+V" });
    } else if (result.startsWith("ERROR:")) {
      toaster.toast({ title: "SpeechToText", body: "Auto-paste failed — use Ctrl+V" });
    }
    // on success no toast needed — text appeared in the game
  }, 2500);
}

// ── Last transcript — persisted across module re-evaluations ──────────────────
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

// ── QAM panel ─────────────────────────────────────────────────────────────────
const Content: FC = () => {
  const [isListening, setIsListening]       = useState(() => _isListening);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript]         = useState(() => _lastTranscript);
  const [copied, setCopied]                 = useState(false);

  const isListeningRef = useRef(_isListening);

  // Keep transcript display in sync with recording results
  useEffect(() => {
    transcriptListeners.push(setTranscript);
    return () => {
      const i = transcriptListeners.indexOf(setTranscript);
      if (i >= 0) transcriptListeners.splice(i, 1);
    };
  }, []);

  // NOTE: do NOT cancel recording on unmount — the QAM panel opens and closes
  // frequently and recording must survive those cycles. Cancellation only happens
  // via the Stop button (stopListening) or plugin unload (onDismount below).

  // ── Recording helpers ────────────────────────────────────────────────────────
  const stopListening = async () => {
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    _isListening = false;
    setIsListening(false);
    setIsTranscribing(true);

    let transcript: string;
    try {
      transcript = await stopAndTranscribe();
    } catch (e: any) {
      setIsTranscribing(false);
      const msg = `Call failed: ${e?.message ?? e}`;
      toaster.toast({ title: "SpeechToText", body: msg });
      setGlobalTranscript(`⚠ ${msg}`);
      return;
    }
    setIsTranscribing(false);

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

    // Copy to browser clipboard immediately as a reliable fallback —
    // user can always Ctrl+V even if auto-paste misses.
    try {
      const el = document.createElement("textarea");
      el.value = transcript + " ";
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(el);
      el.focus(); el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    } catch {}

    // Schedule auto-paste 4 s from now — module-level so it survives
    // component unmount when the user closes the QAM.
    schedulePaste(transcript + " ");
    toaster.toast({ title: "SpeechToText", body: "Close menu now — auto-paste in ~2.5s" });
  };

  const startListening = async () => {
    _isListening = true;
    isListeningRef.current = true;
    setIsListening(true);

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

    setGlobalTranscript("🎙 Listening…");
  };

  const onRecordPress = () => {
    if (isListeningRef.current) {
      stopListening();
    } else {
      startListening();
    }
  };

  // ── Button label / description / status color ────────────────────────────────
  const buttonLabel = isTranscribing
    ? "Transcribing…"
    : isListening
    ? "Stop Recording"
    : "Start Recording";

  const buttonDescription = isTranscribing
    ? "Processing audio…"
    : isListening
    ? "Listening… tap to transcribe"
    : "Tap to begin";

  // Match the old floating button's color scheme: blue → red → orange
  const statusColor = isTranscribing ? "#f39c12" : isListening ? "#e74c3c" : "#1a9fff";

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <PanelSection title="Microphone">
        {/* Colored status bar — mirrors the floating button's blue/red/orange states */}
        <PanelSectionRow>
          <div style={{
            height: 4,
            borderRadius: 2,
            background: statusColor,
            width: "100%",
            transition: "background 0.2s",
            marginBottom: 4,
          }} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={isTranscribing}
            description={buttonDescription}
            onClick={isTranscribing ? undefined : onRecordPress}
          >
            {buttonLabel}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

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
            {transcript || "Press Start Recording to begin"}
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
    </>
  );
};

// ── Plugin entry point ────────────────────────────────────────────────────────
export default definePlugin(() => ({
  title: <div className={staticClasses.Title}>SpeechToText</div>,
  content: <Content />,
  icon: <FaMicrophone />,
  onDismount() {
    // Cancel any active recording when the plugin is unloaded (not on QAM close —
    // recording intentionally survives QAM open/close cycles).
    if (_isListening) {
      _isListening = false;
      cancelRecording();
    }
  },
}));

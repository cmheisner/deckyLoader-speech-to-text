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

  // Cancel any active recording when the panel unmounts
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

  // ── Button label / description ───────────────────────────────────────────────
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

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <PanelSection title="Microphone">
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
}));

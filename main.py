import decky
import subprocess
import speech_recognition as sr


class Plugin:
    _recording_process = None

    async def _main(self):
        decky.logger.info("VoiceType plugin loaded")

    async def _unload(self):
        await Plugin.cancel_recording(self)
        decky.logger.info("VoiceType plugin unloaded")

    async def start_recording(self) -> bool:
        """Start capturing audio from the default microphone via parecord."""
        try:
            if self._recording_process:
                self._recording_process.terminate()
                self._recording_process = None

            self._recording_process = subprocess.Popen(
                ["parecord", "--raw", "--channels=1", "--rate=16000", "--format=s16le"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            decky.logger.info("Recording started")
            return True
        except Exception as e:
            decky.logger.error(f"Failed to start recording: {e}")
            return False

    async def stop_and_transcribe(self) -> str:
        """Stop recording and return transcribed text (empty string on failure)."""
        proc = self._recording_process
        self._recording_process = None

        if not proc:
            decky.logger.warning("stop_and_transcribe called but no recording in progress")
            return ""

        try:
            proc.terminate()
            raw_data, _ = proc.communicate(timeout=3)
        except Exception as e:
            decky.logger.error(f"Error stopping recording: {e}")
            proc.kill()
            return ""

        if not raw_data:
            decky.logger.warning("No audio data captured")
            return ""

        try:
            recognizer = sr.Recognizer()
            audio = sr.AudioData(raw_data, sample_rate=16000, sample_width=2)
            text = recognizer.recognize_google(audio)
            decky.logger.info(f"Transcribed: {text!r}")
            return text
        except sr.UnknownValueError:
            decky.logger.info("Speech not understood")
            return ""
        except sr.RequestError as e:
            decky.logger.error(f"Google Speech API error: {e}")
            return ""
        except Exception as e:
            decky.logger.error(f"Transcription error: {e}")
            return ""

    async def cancel_recording(self) -> None:
        """Cancel an in-progress recording without transcribing."""
        if self._recording_process:
            self._recording_process.terminate()
            try:
                self._recording_process.communicate(timeout=2)
            except Exception:
                self._recording_process.kill()
            self._recording_process = None

    async def type_text(self, text: str) -> bool:
        """Type text at the current cursor position using xdotool."""
        try:
            decky.logger.info(f"VoiceType typing: {text!r}")
            subprocess.run(
                ["xdotool", "type", "--clearmodifiers", "--delay", "12", "--", text],
                check=True,
                timeout=15,
            )
            return True
        except FileNotFoundError:
            decky.logger.error("xdotool not found. Install with: sudo pacman -S xdotool")
            return False
        except subprocess.TimeoutExpired:
            decky.logger.error("xdotool timed out")
            return False
        except subprocess.CalledProcessError as e:
            decky.logger.error(f"xdotool exited with error: {e}")
            return False
        except Exception as e:
            decky.logger.error(f"Unexpected error in type_text: {e}")
            return False

import decky
import logging
import os
import sys
import socket
import subprocess

# Bundle SpeechRecognition with the plugin (Decky's embedded Python won't have it)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
import speech_recognition as sr

# Persistent backend log (survives session restarts)
_backend_log_path = os.path.join(os.path.dirname(__file__), "backend.log")
_file_handler = logging.FileHandler(_backend_log_path)
_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
decky.logger.addHandler(_file_handler)


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

        decky.logger.info(f"Audio captured: {len(raw_data)} bytes — sending to Google")
        try:
            recognizer = sr.Recognizer()
            audio = sr.AudioData(raw_data, sample_rate=16000, sample_width=2)
            # Set a 10-second socket timeout so the Google API can't hang forever
            old_timeout = socket.getdefaulttimeout()
            socket.setdefaulttimeout(10)
            try:
                text = recognizer.recognize_google(audio)
            finally:
                socket.setdefaulttimeout(old_timeout)
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

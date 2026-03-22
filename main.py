import decky
import asyncio
import os
import sys
import socket
import subprocess

# Bundle SpeechRecognition with the plugin (Decky's embedded Python won't have it)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
import speech_recognition as sr

# Decky captures all plugin output to ~/homebrew/logs/decky-speech-to-text/


def _find_user_uid() -> int:
    """Return the UID of the logged-in user that owns a PulseAudio socket."""
    try:
        for uid_dir in os.listdir("/run/user"):
            try:
                uid = int(uid_dir)
                if os.path.exists(f"/run/user/{uid}/pulse/native"):
                    return uid
            except ValueError:
                continue
    except Exception:
        pass
    return 1000  # Steam Deck default


def _user_env() -> dict:
    """
    Build an environment dict with the user session's audio/display variables.
    DeckyLoader runs as root, but PulseAudio/PipeWire and X11 live in the user
    session, so we must pass the right paths explicitly.
    """
    uid = _find_user_uid()
    xdg = f"/run/user/{uid}"
    env = os.environ.copy()
    env["XDG_RUNTIME_DIR"]    = xdg
    env["PULSE_RUNTIME_PATH"] = f"{xdg}/pulse"
    # X11 display — XWayland is always :0 in both gaming and desktop mode
    env.setdefault("DISPLAY", ":0")
    # Wayland display — gamescope-0 in gaming mode, wayland-0 in desktop mode
    # Try to detect by looking for the socket; default to gamescope-0.
    if "WAYLAND_DISPLAY" not in env:
        for candidate in ("gamescope-0", "wayland-1", "wayland-0"):
            if os.path.exists(f"{xdg}/{candidate}"):
                env["WAYLAND_DISPLAY"] = candidate
                break
        else:
            env["WAYLAND_DISPLAY"] = "gamescope-0"
    # HOME may not be set when running as root under some configurations
    env.setdefault("HOME", f"/home/deck")
    decky.logger.debug(
        f"_user_env: uid={uid} XDG={xdg} DISPLAY={env['DISPLAY']} "
        f"WAYLAND={env['WAYLAND_DISPLAY']}"
    )
    return env


class Plugin:
    _recording_process = None

    async def _main(self):
        decky.logger.info("SpeechToText plugin loaded")

    async def _unload(self):
        await Plugin.cancel_recording(self)
        decky.logger.info("SpeechToText plugin unloaded")

    # ── Recording ─────────────────────────────────────────────────────────────

    async def start_recording(self) -> str:
        """
        Start capturing audio from the microphone via parecord.
        Returns '' on success, or a human-readable error string on failure.
        """
        try:
            if self._recording_process:
                self._recording_process.terminate()
                self._recording_process = None

            env = _user_env()
            decky.logger.info(
                f"start_recording: PULSE_RUNTIME_PATH={env['PULSE_RUNTIME_PATH']} "
                f"XDG_RUNTIME_DIR={env['XDG_RUNTIME_DIR']}"
            )

            self._recording_process = subprocess.Popen(
                ["parecord", "--raw", "--channels=1", "--rate=16000", "--format=s16le"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,   # capture stderr so errors are visible
                env=env,
            )

            # Give parecord a moment to either open the device or crash
            await asyncio.sleep(0.25)
            if self._recording_process.poll() is not None:
                _, err = self._recording_process.communicate()
                self._recording_process = None
                msg = err.decode(errors="replace").strip() or "parecord exited immediately"
                decky.logger.error(f"parecord failed on startup: {msg}")
                return f"parecord failed: {msg}"

            decky.logger.info("Recording started (parecord running)")
            return ""

        except FileNotFoundError:
            decky.logger.error("parecord not found")
            return "parecord not found — run: sudo pacman -S pulseaudio-utils"
        except Exception as e:
            decky.logger.error(f"start_recording exception: {e}")
            return str(e)

    async def stop_and_transcribe(self) -> str:
        """
        Stop recording and return the transcript.
        Returns '' if nothing was heard, 'ERROR: ...' on failure.
        """
        proc = self._recording_process
        self._recording_process = None

        if not proc:
            decky.logger.warning("stop_and_transcribe: no recording in progress")
            return "ERROR: No recording in progress"

        try:
            proc.terminate()
            raw_data, stderr_data = proc.communicate(timeout=3)
        except Exception as e:
            decky.logger.error(f"Error stopping recording: {e}")
            try:
                proc.kill()
            except Exception:
                pass
            return f"ERROR: Failed to stop recording: {e}"

        if stderr_data:
            stderr_str = stderr_data.decode(errors="replace").strip()
            if stderr_str:
                decky.logger.info(f"parecord stderr: {stderr_str}")

        if not raw_data:
            decky.logger.warning("No audio data captured")
            return "ERROR: No audio captured — check mic permissions and PulseAudio"

        bytes_captured = len(raw_data)
        decky.logger.info(f"Audio captured: {bytes_captured} bytes — sending to Google")

        try:
            recognizer = sr.Recognizer()
            audio = sr.AudioData(raw_data, sample_rate=16000, sample_width=2)
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
            return f"ERROR: Google API error: {e}"
        except Exception as e:
            decky.logger.error(f"Transcription error: {e}")
            return f"ERROR: {e}"

    async def cancel_recording(self) -> None:
        """Cancel an in-progress recording without transcribing."""
        if self._recording_process:
            self._recording_process.terminate()
            try:
                self._recording_process.communicate(timeout=2)
            except Exception:
                self._recording_process.kill()
            self._recording_process = None

    # ── Text injection ────────────────────────────────────────────────────────

    async def type_text(self, text: str) -> str:
        """
        Type text at the current cursor position.
        Returns:
          ''          — success (typed via ydotool or xdotool)
          'CLIPBOARD' — text was copied to clipboard; user should paste with Ctrl+V
          'ERROR: …'  — all methods failed
        """
        env = _user_env()
        decky.logger.info(f"type_text: {text!r}")

        # ── 1. ydotool (kernel uinput — works on Gamescope/Wayland) ──────────
        try:
            result = subprocess.run(
                ["ydotool", "type", "--key-delay", "12", "--", text],
                env=env,
                capture_output=True,
                timeout=15,
            )
            if result.returncode == 0:
                decky.logger.info("type_text: ydotool succeeded")
                return ""
            stderr = result.stderr.decode(errors="replace").strip()
            decky.logger.warning(f"ydotool failed (rc={result.returncode}): {stderr}")
        except FileNotFoundError:
            decky.logger.info("ydotool not found, trying xdotool")
        except subprocess.TimeoutExpired:
            decky.logger.error("ydotool timed out")

        # ── 2. xdotool with explicit DISPLAY=:0 ──────────────────────────────
        try:
            xenv = env.copy()
            xenv["DISPLAY"] = ":0"
            result = subprocess.run(
                ["xdotool", "type", "--clearmodifiers", "--delay", "12", "--", text],
                env=xenv,
                capture_output=True,
                timeout=15,
            )
            if result.returncode == 0:
                decky.logger.info("type_text: xdotool succeeded")
                return ""
            stderr = result.stderr.decode(errors="replace").strip()
            decky.logger.warning(f"xdotool failed (rc={result.returncode}): {stderr}")
        except FileNotFoundError:
            decky.logger.info("xdotool not found, trying clipboard fallback")
        except subprocess.TimeoutExpired:
            decky.logger.error("xdotool timed out")

        # ── 3. Clipboard fallback (wl-copy → xclip) ──────────────────────────
        # wl-copy reads from stdin
        for clip_tool, build_cmd in [
            ("wl-copy", lambda t: (["wl-copy", "--", t], None)),
            ("xclip",   lambda t: (["xclip", "-selection", "clipboard"], t.encode())),
        ]:
            cmd, stdin_data = build_cmd(text)
            try:
                result = subprocess.run(
                    cmd,
                    input=stdin_data,
                    env=env,
                    capture_output=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    decky.logger.info(f"type_text: {clip_tool} clipboard copy succeeded")
                    return "CLIPBOARD"
                stderr = result.stderr.decode(errors="replace").strip()
                decky.logger.warning(f"{clip_tool} failed (rc={result.returncode}): {stderr}")
            except FileNotFoundError:
                decky.logger.info(f"{clip_tool} not found")
            except subprocess.TimeoutExpired:
                decky.logger.warning(f"{clip_tool} timed out")
            except Exception as e:
                decky.logger.warning(f"{clip_tool} error: {e}")

        decky.logger.error("type_text: all methods failed")
        return "ERROR: No input tool worked. Install ydotool or xdotool."

    # ── Diagnostics ───────────────────────────────────────────────────────────

    async def check_tools(self) -> str:
        """
        Return a diagnostic string listing tool availability and audio devices.
        Called from the QAM settings panel's 'Run Diagnostics' button.
        """
        lines = []

        # Which tools are installed?
        for tool in ["parecord", "xdotool", "ydotool", "wl-copy", "xclip"]:
            try:
                r = subprocess.run(["which", tool], capture_output=True, timeout=3)
                if r.returncode == 0:
                    lines.append(f"✓ {tool}")
                else:
                    lines.append(f"✗ {tool}")
            except Exception:
                lines.append(f"✗ {tool}")

        # Check ydotoold daemon
        try:
            r = subprocess.run(["pgrep", "ydotoold"], capture_output=True, timeout=3)
            lines.append("✓ ydotoold running" if r.returncode == 0 else "✗ ydotoold NOT running")
        except Exception:
            lines.append("✗ ydotoold check failed")

        # Audio sources
        env = _user_env()
        try:
            r = subprocess.run(
                ["pactl", "list", "sources", "short"],
                env=env,
                capture_output=True,
                timeout=5,
                text=True,
            )
            if r.returncode == 0 and r.stdout.strip():
                sources = r.stdout.strip().replace("\n", "; ")
                lines.append(f"Audio sources: {sources}")
            else:
                lines.append(f"pactl failed (rc={r.returncode}): {r.stderr.strip()}")
        except FileNotFoundError:
            lines.append("pactl not found")
        except Exception as e:
            lines.append(f"pactl error: {e}")

        # DISPLAY / WAYLAND_DISPLAY
        lines.append(f"DISPLAY={env.get('DISPLAY')} WAYLAND={env.get('WAYLAND_DISPLAY')}")
        lines.append(f"XDG_RUNTIME_DIR={env.get('XDG_RUNTIME_DIR')}")
        lines.append(f"PULSE={env.get('PULSE_RUNTIME_PATH')}")

        diag = " | ".join(lines)
        decky.logger.info(f"Diagnostics: {diag}")
        return diag

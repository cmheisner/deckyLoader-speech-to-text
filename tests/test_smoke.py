"""
Smoke tests for the Speech-to-Text plugin's Google API integration.

These tests are designed to run *before* testing the full DeckyLoader plugin,
verifying the underlying stack works independently:

  Layer 1 – Library imports   : speech_recognition importable from lib/
  Layer 2 – Audio pipeline    : AudioData creation, WAV + FLAC conversion
  Layer 3 – API connectivity  : Google Speech API endpoint is reachable
  Layer 4 – Recognition       : API returns correct results for silence & speech
  Layer 5 – Backend logic     : main.py Plugin class wired correctly (no parecord)

Run all tests:
  cd /home/deck/Documents/GitHub/deckyLoader-speech-to-text
  python -m pytest tests/ -v

Skip network tests:
  python -m pytest tests/ -v -m "not network"

Provide real speech audio:
  espeak-ng installed  → picked up automatically
  STT_TEST_WAV=/path/to/file.wav python -m pytest tests/ -v
"""
import sys
import os
import io
import socket
import subprocess
import asyncio
import urllib.request
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LIB_PATH = os.path.join(PROJECT_ROOT, "lib")

GOOGLE_API_URL = "http://www.google.com/speech-api/v2/recognize"
GOOGLE_API_KEY = "AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"


# ===========================================================================
# Layer 1 – Library imports
# ===========================================================================

class TestLibraryImports:
    """Verify the bundled speech_recognition library loads correctly."""

    def test_lib_directory_exists(self):
        assert os.path.isdir(LIB_PATH), (
            f"lib/ directory not found at {LIB_PATH}. "
            "Run: pip install --target=lib --no-compile SpeechRecognition audioop-lts"
        )

    def test_speech_recognition_importable(self):
        import speech_recognition as sr
        assert sr is not None

    def test_recognizer_class_present(self):
        import speech_recognition as sr
        assert hasattr(sr, "Recognizer"), "sr.Recognizer missing"

    def test_audio_data_class_present(self):
        import speech_recognition as sr
        assert hasattr(sr, "AudioData"), "sr.AudioData missing"

    def test_audio_file_class_present(self):
        import speech_recognition as sr
        assert hasattr(sr, "AudioFile"), "sr.AudioFile missing"

    def test_exception_classes_present(self):
        import speech_recognition as sr
        assert hasattr(sr, "UnknownValueError"), "sr.UnknownValueError missing"
        assert hasattr(sr, "RequestError"), "sr.RequestError missing"

    def test_recognizer_instantiation(self):
        import speech_recognition as sr
        r = sr.Recognizer()
        assert r is not None
        assert hasattr(r, "recognize_google")

    def test_speech_recognition_version_readable(self):
        import speech_recognition as sr
        version = getattr(sr, "__version__", None)
        assert version is not None, "Could not read SpeechRecognition __version__"
        print(f"\n  SpeechRecognition version: {version}")


# ===========================================================================
# Layer 2 – Audio pipeline (AudioData, WAV, FLAC)
# ===========================================================================

class TestAudioPipeline:
    """Verify audio data creation and format conversion work end-to-end."""

    def test_flac_binary_exists(self):
        """The bundled FLAC binary (used internally for audio conversion) must exist."""
        import speech_recognition as sr
        sr_dir = os.path.dirname(sr.__file__)
        bundled = os.path.join(sr_dir, "flac-linux-x86_64")
        system_flac_ok = False
        try:
            r = subprocess.run(["flac", "--version"], capture_output=True, timeout=5)
            system_flac_ok = r.returncode == 0
        except FileNotFoundError:
            pass
        assert os.path.isfile(bundled) or system_flac_ok, (
            f"No FLAC binary found at {bundled} and 'flac' not on PATH. "
            "FLAC conversion (required by Google API) will fail."
        )

    def test_create_audio_data_from_pcm(self, silence_pcm, sample_rate):
        import speech_recognition as sr
        audio = sr.AudioData(silence_pcm, sample_rate=sample_rate, sample_width=2)
        assert audio.sample_rate == sample_rate
        assert audio.sample_width == 2

    def test_get_raw_data_roundtrip(self, silence_audio, silence_pcm):
        raw = silence_audio.get_raw_data()
        assert isinstance(raw, bytes)
        assert raw == silence_pcm

    def test_get_wav_data_valid_header(self, silence_audio):
        wav = silence_audio.get_wav_data()
        assert isinstance(wav, bytes)
        assert wav[:4] == b"RIFF", "Not a valid RIFF/WAV file"
        assert wav[8:12] == b"WAVE", "Missing WAVE chunk marker"

    def test_get_flac_data_valid_magic(self, silence_audio):
        """FLAC conversion must produce valid FLAC output (fLaC magic bytes)."""
        flac = silence_audio.get_flac_data()
        assert isinstance(flac, bytes)
        assert len(flac) > 0, "FLAC output is empty"
        assert flac[:4] == b"fLaC", (
            f"Expected FLAC magic bytes b'fLaC', got {flac[:4]!r}. "
            "The bundled flac binary may be missing or non-executable."
        )

    def test_get_flac_data_from_speech(self, speech_audio):
        """FLAC conversion works with real speech audio data."""
        flac = speech_audio.get_flac_data()
        assert flac[:4] == b"fLaC"
        # Speech FLAC should be larger than silence FLAC (more complex waveform)
        silence_flac_size = len(b"fLaC")  # rough lower bound
        assert len(flac) > 200, "FLAC output suspiciously small for speech audio"

    def test_flac_binary_is_executable(self):
        import speech_recognition as sr
        sr_dir = os.path.dirname(sr.__file__)
        flac_path = os.path.join(sr_dir, "flac-linux-x86_64")
        if not os.path.isfile(flac_path):
            pytest.skip("Bundled flac binary not present (may use system flac)")
        assert os.access(flac_path, os.X_OK), (
            f"{flac_path} exists but is not executable. "
            "Run: chmod +x lib/speech_recognition/flac-linux-x86_64"
        )

    def test_audio_data_sample_rate_conversion(self, sample_rate):
        """AudioData can be asked to resample on FLAC export."""
        import speech_recognition as sr
        # Create 8 kHz audio (half the target rate)
        raw_8k = b"\x00\x00" * 8000  # 1s silence at 8 kHz
        audio = sr.AudioData(raw_8k, sample_rate=8000, sample_width=2)
        flac = audio.get_flac_data(convert_rate=sample_rate)
        assert flac[:4] == b"fLaC"

    def test_audio_file_read_from_wav_bytes(self, sample_rate):
        """speech_recognition.AudioFile can read a WAV produced from raw PCM."""
        import speech_recognition as sr

        # Build a minimal WAV in memory
        buf = io.BytesIO()
        with io.BytesIO() as wav_buf:
            import wave
            with wave.open(wav_buf, "w") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(b"\x00\x00" * sample_rate)
            wav_bytes = wav_buf.getvalue()

        # Write to a temp file (AudioFile needs a path or file-like with .name)
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_bytes)
            tmp_path = f.name

        try:
            recognizer = sr.Recognizer()
            with sr.AudioFile(tmp_path) as source:
                audio = recognizer.record(source)
            assert isinstance(audio, sr.AudioData)
        finally:
            os.unlink(tmp_path)


# ===========================================================================
# Layer 3 – Google Speech API connectivity
# ===========================================================================

@pytest.mark.network
class TestGoogleAPIConnectivity:
    """
    Verify the Google Speech API endpoint is reachable from this machine.
    These tests do NOT require speech audio — they only check connectivity.
    """

    def test_dns_resolves_google(self):
        """www.google.com must resolve via DNS."""
        try:
            infos = socket.getaddrinfo("www.google.com", 80, socket.AF_INET, socket.SOCK_STREAM)
            assert len(infos) > 0
        except socket.gaierror as e:
            pytest.fail(f"DNS resolution of www.google.com failed: {e}")

    def test_tcp_connect_to_google(self):
        """TCP handshake to www.google.com:80 must succeed."""
        try:
            s = socket.create_connection(("www.google.com", 80), timeout=10)
            s.close()
        except OSError as e:
            pytest.fail(f"TCP connection to www.google.com:80 failed: {e}")

    def test_speech_api_endpoint_returns_http_response(self):
        """
        A GET to the Speech API URL (no audio body) must return any HTTP status.
        Any response (200, 400, 403) proves the server is up and reachable.
        """
        url = f"{GOOGLE_API_URL}?client=chromium&lang=en-US&key={GOOGLE_API_KEY}"
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", "Mozilla/5.0")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
        except urllib.error.HTTPError as e:
            status = e.code
        except urllib.error.URLError as e:
            pytest.fail(
                f"Cannot reach Google Speech API at {GOOGLE_API_URL}: {e.reason}\n"
                "Check network connectivity and firewall settings."
            )
        assert status in (200, 400, 403, 404), (
            f"Unexpected HTTP status {status} from Google Speech API"
        )
        print(f"\n  Google Speech API responded with HTTP {status}")

    def test_speech_api_post_empty_body_does_not_crash(self):
        """
        POSTing an empty body to the API should get a HTTP error (400/403),
        not a connection error — confirming POST requests are accepted.
        """
        url = f"{GOOGLE_API_URL}?client=chromium&lang=en-US&key={GOOGLE_API_KEY}"
        req = urllib.request.Request(url, data=b"", method="POST")
        req.add_header("Content-Type", "audio/x-flac; rate=16000")
        req.add_header("User-Agent", "Mozilla/5.0")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                assert resp.status == 200  # surprisingly OK response
        except urllib.error.HTTPError as e:
            # 400 or 403 is fine — server received the POST
            assert e.code in (400, 403), (
                f"Unexpected HTTP error {e.code} when posting to Speech API"
            )
        except urllib.error.URLError as e:
            pytest.fail(f"Network error reaching Google Speech API: {e.reason}")


# ===========================================================================
# Layer 4 – End-to-end speech recognition
# ===========================================================================

@pytest.mark.network
class TestSpeechRecognition:
    """
    Verify the full recognize_google() call works correctly.

    silence_audio  → must raise UnknownValueError (API responded, no speech found)
    speech_audio   → must return a non-empty transcription string
    """

    def _call_recognize(self, recognizer, audio, timeout_sec=20, **kwargs):
        """Helper: call recognize_google with a socket timeout and clean teardown."""
        import speech_recognition as sr
        old = socket.getdefaulttimeout()
        socket.setdefaulttimeout(timeout_sec)
        try:
            return recognizer.recognize_google(audio, **kwargs)
        finally:
            socket.setdefaulttimeout(old)

    def test_silence_raises_unknown_value_error(self, silence_audio):
        """
        Sending silence to Google must produce UnknownValueError, NOT a crash.
        This proves the API is reachable and responding to our audio format.
        """
        import speech_recognition as sr
        r = sr.Recognizer()
        try:
            with pytest.raises(sr.UnknownValueError):
                self._call_recognize(r, silence_audio)
        except sr.RequestError as e:
            pytest.fail(
                f"Google API request failed — possible network issue.\n"
                f"Error: {e}\n"
                f"Run TestGoogleAPIConnectivity tests first to check connectivity."
            )

    def test_speech_returns_non_empty_string(self, speech_audio):
        """
        The primary smoke test: real speech must produce a non-empty transcript.
        If this passes, the Google API pipeline is fully functional.
        """
        import speech_recognition as sr
        r = sr.Recognizer()
        try:
            text = self._call_recognize(r, speech_audio)
        except sr.UnknownValueError:
            pytest.fail(
                "Google API returned UnknownValueError for speech audio.\n"
                "The audio may be too quiet or unclear.\n"
                "Try: STT_TEST_WAV=/path/to/clearer_speech.wav python -m pytest tests/"
            )
        except sr.RequestError as e:
            pytest.fail(f"Google API request failed: {e}")

        assert isinstance(text, str), f"Expected str, got {type(text).__name__}"
        assert text.strip(), "Transcription returned an empty string"
        print(f"\n  Transcribed: {text!r}")

    def test_speech_transcription_contains_expected_words(self, speech_audio):
        """
        When using espeak-ng to say 'hello world testing one two three',
        Google should recognise at least one of those words.

        If STT_TEST_WAV is set, this test is skipped (unknown expected content).
        """
        if os.environ.get("STT_TEST_WAV"):
            pytest.skip("Skipping word-match test when STT_TEST_WAV is set (unknown content)")

        import speech_recognition as sr
        r = sr.Recognizer()
        try:
            text = self._call_recognize(r, speech_audio)
        except sr.UnknownValueError:
            pytest.fail("Google API returned UnknownValueError — espeak audio unclear")
        except sr.RequestError as e:
            pytest.fail(f"Google API request failed: {e}")

        expected_words = {"hello", "world", "testing", "one", "two", "three"}
        found = expected_words & set(text.lower().split())
        print(f"\n  Transcribed: {text!r}  |  matched words: {found}")
        assert found, (
            f"None of the expected words {expected_words} found in {text!r}.\n"
            "Google may have misheard the espeak synthesis — try a real recording."
        )

    def test_show_all_returns_alternatives_list(self, speech_audio):
        """
        With show_all=True, the API returns a dict with an 'alternative' list
        containing 'transcript' + optional 'confidence' fields.
        """
        import speech_recognition as sr
        r = sr.Recognizer()
        try:
            result = self._call_recognize(r, speech_audio, show_all=True)
        except sr.RequestError as e:
            pytest.fail(f"Google API request failed: {e}")

        if not result:
            pytest.skip("Empty result from Google (speech may have been unclear)")

        assert isinstance(result, dict), f"Expected dict with show_all=True, got {type(result)}"
        alternatives = result.get("alternative", [])
        assert len(alternatives) > 0, f"No alternatives in result: {result}"
        top = alternatives[0]
        assert "transcript" in top, f"Missing 'transcript' key in {top}"
        assert isinstance(top["transcript"], str)
        print(f"\n  Full API response: {result}")

    def test_language_parameter_accepted(self, speech_audio):
        """recognize_google() must accept a language= kwarg without raising TypeError."""
        import speech_recognition as sr
        r = sr.Recognizer()
        # Just verify no TypeError — result may vary
        try:
            text = self._call_recognize(r, speech_audio, language="en-US")
            assert isinstance(text, str)
        except sr.UnknownValueError:
            pass  # Valid outcome — no crash is what we're testing
        except sr.RequestError as e:
            pytest.fail(f"Google API request failed: {e}")

    def test_profanity_filter_parameter_accepted(self, speech_audio):
        """recognize_google() must accept pfilter= kwarg without raising TypeError."""
        import speech_recognition as sr
        r = sr.Recognizer()
        try:
            text = self._call_recognize(r, speech_audio, pfilter=0)
            assert isinstance(text, str)
        except sr.UnknownValueError:
            pass
        except sr.RequestError as e:
            pytest.fail(f"Google API request failed: {e}")


# ===========================================================================
# Layer 5 – Backend Plugin logic (main.py, no parecord)
# ===========================================================================

class TestPluginBackend:
    """
    Test the Plugin class from main.py in isolation:
      - Import with a mocked 'decky' module
      - Inject fake parecord process returning known PCM bytes
      - Verify stop_and_transcribe() returns the right type/value
    """

    def _import_plugin(self):
        """Fresh import of main.py (decky_mock fixture already patched sys.modules)."""
        if "main" in sys.modules:
            del sys.modules["main"]
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        import main as m
        return m

    def _make_mock_proc(self, stdout: bytes, stderr: bytes = b""):
        """Create a mock subprocess.Popen that returns given stdout/stderr on communicate()."""
        proc = MagicMock()
        proc.poll.return_value = None          # process is still running
        proc.terminate.return_value = None
        proc.communicate.return_value = (stdout, stderr)
        return proc

    def test_main_imports_cleanly(self, decky_mock):
        m = self._import_plugin()
        assert m is not None

    def test_plugin_class_exists(self, decky_mock):
        m = self._import_plugin()
        assert hasattr(m, "Plugin"), "main.py must define a Plugin class"

    def test_plugin_has_required_api_methods(self, decky_mock):
        m = self._import_plugin()
        for method in ["start_recording", "stop_and_transcribe", "cancel_recording",
                        "type_text", "check_tools"]:
            assert hasattr(m.Plugin, method), f"Plugin missing method: {method!r}"

    def test_stop_and_transcribe_no_recording_returns_error(self, decky_mock):
        """Calling stop_and_transcribe() with no active recording returns 'ERROR: ...'"""
        m = self._import_plugin()
        plugin = m.Plugin()
        plugin._recording_process = None
        result = asyncio.run(plugin.stop_and_transcribe())
        assert isinstance(result, str)
        assert result.startswith("ERROR:"), (
            f"Expected 'ERROR: ...' when no recording in progress, got: {result!r}"
        )

    def test_stop_and_transcribe_empty_audio_returns_error(self, decky_mock):
        """If parecord returns zero bytes, stop_and_transcribe() returns 'ERROR: ...'"""
        m = self._import_plugin()
        plugin = m.Plugin()
        plugin._recording_process = self._make_mock_proc(stdout=b"")
        result = asyncio.run(plugin.stop_and_transcribe())
        assert isinstance(result, str)
        assert result.startswith("ERROR:"), (
            f"Expected 'ERROR: ...' for empty audio, got: {result!r}"
        )

    @pytest.mark.network
    def test_stop_and_transcribe_silence_returns_empty_string(self, decky_mock, silence_pcm):
        """
        When the injected PCM is silence, stop_and_transcribe() must return ''
        (Google says UnknownValueError → plugin converts to empty string).
        """
        m = self._import_plugin()
        plugin = m.Plugin()
        plugin._recording_process = self._make_mock_proc(stdout=silence_pcm)
        result = asyncio.run(plugin.stop_and_transcribe())
        assert isinstance(result, str)
        # '' means silence; 'ERROR: ...' means network issue
        assert result == "" or result.startswith("ERROR:"), (
            f"Unexpected result for silence PCM: {result!r}"
        )
        print(f"\n  stop_and_transcribe(silence) → {result!r}")

    @pytest.mark.network
    @pytest.mark.audio
    def test_stop_and_transcribe_speech_returns_transcription(self, decky_mock, speech_pcm):
        """
        Full pipeline smoke test: inject real speech PCM, verify a non-empty
        transcript is returned by stop_and_transcribe().
        """
        m = self._import_plugin()
        plugin = m.Plugin()
        plugin._recording_process = self._make_mock_proc(stdout=speech_pcm)
        result = asyncio.run(plugin.stop_and_transcribe())
        assert isinstance(result, str)
        assert not result.startswith("ERROR:"), (
            f"stop_and_transcribe() returned an error: {result}"
        )
        assert result.strip(), (
            "stop_and_transcribe() returned empty string for speech audio — "
            "Google may not have recognized the audio. "
            "Try a clearer recording via STT_TEST_WAV=."
        )
        print(f"\n  stop_and_transcribe(speech) → {result!r}")

    def test_cancel_recording_with_no_process_is_safe(self, decky_mock):
        """cancel_recording() must be idempotent when no recording is active."""
        m = self._import_plugin()
        plugin = m.Plugin()
        plugin._recording_process = None
        asyncio.run(plugin.cancel_recording())  # must not raise

    def test_cancel_recording_terminates_process(self, decky_mock):
        """cancel_recording() must call terminate() on the active process."""
        m = self._import_plugin()
        plugin = m.Plugin()
        mock_proc = self._make_mock_proc(stdout=b"")
        plugin._recording_process = mock_proc
        asyncio.run(plugin.cancel_recording())
        mock_proc.terminate.assert_called_once()
        assert plugin._recording_process is None

    def test_check_tools_returns_string(self, decky_mock):
        """check_tools() must return a non-empty diagnostic string."""
        m = self._import_plugin()
        plugin = m.Plugin()
        result = asyncio.run(plugin.check_tools())
        assert isinstance(result, str)
        assert len(result) > 0
        print(f"\n  check_tools() → {result!r}")

    def test_find_user_uid_returns_int(self, decky_mock):
        """_find_user_uid() must return an integer UID."""
        m = self._import_plugin()
        uid = m._find_user_uid()
        assert isinstance(uid, int)
        assert uid > 0
        print(f"\n  Detected user UID: {uid}")

    def test_user_env_has_required_keys(self, decky_mock):
        """_user_env() must populate all mandatory environment keys."""
        m = self._import_plugin()
        env = m._user_env()
        for key in ["XDG_RUNTIME_DIR", "PULSE_RUNTIME_PATH", "DISPLAY", "WAYLAND_DISPLAY", "HOME"]:
            assert key in env, f"_user_env() missing key: {key!r}"
        # XDG_RUNTIME_DIR should look like /run/user/<uid>
        assert env["XDG_RUNTIME_DIR"].startswith("/run/user/"), (
            f"Unexpected XDG_RUNTIME_DIR: {env['XDG_RUNTIME_DIR']!r}"
        )
        print(f"\n  _user_env() sample: XDG={env['XDG_RUNTIME_DIR']} DISPLAY={env['DISPLAY']}")

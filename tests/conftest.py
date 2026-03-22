"""
Shared fixtures for the speech-to-text smoke test suite.

Audio fixtures (in priority order):
  1. STT_TEST_WAV=/path/to/speech.wav  — user-supplied WAV file
  2. espeak-ng synthesis of "hello world testing one two three"
  3. pytest.skip() if neither is available

Quick start:
  python -m pytest tests/ -v
  STT_TEST_WAV=my_voice.wav python -m pytest tests/ -v
"""
import sys
import os
import io
import wave
import subprocess
import tempfile
import types
from unittest.mock import MagicMock

import pytest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LIB_PATH = os.path.join(PROJECT_ROOT, "lib")

# Add lib/ to path so tests can import speech_recognition directly
if LIB_PATH not in sys.path:
    sys.path.insert(0, LIB_PATH)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_silence_pcm(sample_rate: int = 16000, duration_sec: float = 1.0) -> bytes:
    """Return raw 16-bit mono PCM silence bytes."""
    num_samples = int(sample_rate * duration_sec)
    return b"\x00\x00" * num_samples


def _make_decky_mock() -> types.ModuleType:
    """Return a minimal fake 'decky' module so main.py can be imported standalone."""
    fake = types.ModuleType("decky")
    fake.logger = MagicMock()
    fake.logger.info    = lambda *a, **k: None
    fake.logger.warning = lambda *a, **k: None
    fake.logger.error   = lambda *a, **k: None
    fake.logger.debug   = lambda *a, **k: None
    fake.logger.addHandler = lambda *a, **k: None
    fake.DECKY_PLUGIN_LOG = "/tmp/stt_test_backend.log"
    fake.DECKY_PLUGIN_DIR = PROJECT_ROOT
    return fake


# ---------------------------------------------------------------------------
# Session-scoped fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def sample_rate() -> int:
    return 16000


@pytest.fixture(scope="session")
def silence_pcm(sample_rate) -> bytes:
    """1 second of silence as raw 16-bit mono PCM bytes."""
    return _make_silence_pcm(sample_rate, duration_sec=1.0)


@pytest.fixture(scope="session")
def silence_audio(sample_rate, silence_pcm):
    """speech_recognition.AudioData wrapping 1 s of silence."""
    import speech_recognition as sr
    return sr.AudioData(silence_pcm, sample_rate=sample_rate, sample_width=2)


@pytest.fixture(scope="session")
def speech_audio(sample_rate):
    """
    speech_recognition.AudioData containing real intelligible speech.

    Sources tried in order:
      1. Path in STT_TEST_WAV environment variable
      2. espeak-ng synthesis (install: sudo pacman -S espeak-ng)

    Skips all tests that depend on this fixture if no source is available.
    """
    import speech_recognition as sr

    # ── 1. User-supplied WAV ──────────────────────────────────────────────────
    test_wav = os.environ.get("STT_TEST_WAV", "").strip()
    if test_wav:
        if not os.path.exists(test_wav):
            pytest.fail(f"STT_TEST_WAV is set but file not found: {test_wav!r}")
        recognizer = sr.Recognizer()
        with sr.AudioFile(test_wav) as source:
            return recognizer.record(source)

    # ── 2. espeak-ng synthesis ────────────────────────────────────────────────
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name

    try:
        result = subprocess.run(
            [
                "espeak-ng",
                "-w", wav_path,
                "-s", "130",      # words per minute (slower = clearer)
                "--",
                "hello world testing one two three",
            ],
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 0 and os.path.getsize(wav_path) > 100:
            recognizer = sr.Recognizer()
            with sr.AudioFile(wav_path) as source:
                return recognizer.record(source)
        # espeak-ng failed silently
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        pass
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)

    pytest.skip(
        "No speech audio available for recognition tests.\n"
        "  Option A: sudo pacman -S espeak-ng   (then re-run)\n"
        "  Option B: STT_TEST_WAV=/path/to/speech.wav python -m pytest tests/"
    )


@pytest.fixture(scope="session")
def speech_pcm(speech_audio) -> bytes:
    """Raw 16-bit mono PCM bytes extracted from the speech AudioData fixture."""
    return speech_audio.get_raw_data(
        convert_rate=16000, convert_width=2
    )


# ---------------------------------------------------------------------------
# Per-test fixture: mock 'decky' in sys.modules
# ---------------------------------------------------------------------------

@pytest.fixture()
def decky_mock(monkeypatch):
    """
    Install a fake 'decky' module into sys.modules for the duration of a test.
    Removes it (and the cached 'main' module) on teardown.
    """
    fake = _make_decky_mock()
    monkeypatch.setitem(sys.modules, "decky", fake)
    # Ensure main.py is re-imported fresh each time so it picks up our mock
    monkeypatch.delitem(sys.modules, "main", raising=False)
    return fake

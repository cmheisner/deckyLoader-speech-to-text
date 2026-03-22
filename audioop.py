"""
Pure-Python audioop shim for Decky Loader's PyInstaller-bundled Python.

Decky's embedded Python 3.11 is bundled with PyInstaller and does not include
the audioop stdlib module. This shim implements the subset used by
SpeechRecognition so the plugin can import and run correctly.

Functions implemented: rms, bias, lin2lin, ratecv, add, tomono, byteswap.
The 'error' attribute is a dummy exception class (matches audioop.error API).
"""
import struct
import math


class error(Exception):
    pass


def _fmt(width):
    if width == 1:
        return "b"
    elif width == 2:
        return "h"
    elif width == 4:
        return "i"
    raise error(f"Unsupported sample width: {width}")


def _unpack(fragment, width):
    fmt = _fmt(width)
    count = len(fragment) // width
    return list(struct.unpack_from(f"<{count}{fmt}", fragment))


def _pack(samples, width):
    fmt = _fmt(width)
    clamp_max = (1 << (8 * width - 1)) - 1
    clamp_min = -(1 << (8 * width - 1))
    clamped = [max(clamp_min, min(clamp_max, int(s))) for s in samples]
    return struct.pack(f"<{len(clamped)}{fmt}", *clamped)


def rms(fragment, width):
    """Return the RMS (root-mean-square) of the audio fragment."""
    if not fragment:
        return 0
    samples = _unpack(fragment, width)
    if not samples:
        return 0
    return int(math.sqrt(sum(s * s for s in samples) / len(samples)))


def bias(fragment, width, bias_val):
    """Add a constant to each sample (used for DC bias removal)."""
    samples = _unpack(fragment, width)
    return _pack([s + bias_val for s in samples], width)


def add(fragment1, fragment2, width):
    """Add two audio fragments sample-by-sample."""
    s1 = _unpack(fragment1, width)
    s2 = _unpack(fragment2, width)
    length = min(len(s1), len(s2))
    return _pack([s1[i] + s2[i] for i in range(length)], width)


def tomono(fragment, width, fac_l, fac_r):
    """Convert stereo to mono by mixing left and right channels."""
    samples = _unpack(fragment, width)
    mono = []
    for i in range(0, len(samples) - 1, 2):
        mono.append(samples[i] * fac_l + samples[i + 1] * fac_r)
    return _pack(mono, width)


def lin2lin(fragment, width, newwidth):
    """Convert samples between 1-, 2-, and 4-byte widths."""
    if width == newwidth:
        return fragment
    samples = _unpack(fragment, width)
    scale = (1 << (8 * newwidth - 1)) / (1 << (8 * width - 1))
    return _pack([s * scale for s in samples], newwidth)


def ratecv(fragment, width, nchannels, inrate, outrate, state,
           weightA=1, weightB=0):
    """Resample fragment from inrate to outrate using linear interpolation."""
    if inrate == outrate:
        return fragment, state

    samples = _unpack(fragment, width)

    if nchannels > 1:
        # de-interleave, resample each channel, re-interleave
        channels = [samples[ch::nchannels] for ch in range(nchannels)]
        resampled = [_resample_channel(ch, inrate, outrate) for ch in channels]
        out_len = min(len(r) for r in resampled)
        interleaved = []
        for i in range(out_len):
            for ch in resampled:
                interleaved.append(ch[i])
        return _pack(interleaved, width), None
    else:
        resampled = _resample_channel(samples, inrate, outrate)
        return _pack(resampled, width), None


def _resample_channel(samples, inrate, outrate):
    count = len(samples)
    if count == 0:
        return []
    ratio = outrate / inrate
    out_count = max(1, int(count * ratio))
    result = []
    for i in range(out_count):
        src = i / ratio
        idx = int(src)
        frac = src - idx
        if idx + 1 < count:
            result.append(samples[idx] * (1.0 - frac) + samples[idx + 1] * frac)
        else:
            result.append(float(samples[min(idx, count - 1)]))
    return result


def byteswap(fragment, width):
    """Swap bytes in each sample (endianness conversion)."""
    result = bytearray(fragment)
    for i in range(0, len(result), width):
        result[i:i + width] = result[i:i + width][::-1]
    return bytes(result)

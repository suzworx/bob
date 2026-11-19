"""Generate immutable flash PCM from the measured cabin-chime recipe, not recordings.

The CC0 Airbus A320 reference by Shamrock132 (Freesound 245851) has dominant
587/494 Hz notes about 1.05 seconds apart, each with an exponential tail.
Only this analytical recipe is committed; generated audio stays in build output.
"""
import math
from pathlib import Path

RATE = 4000
# name: (total milliseconds, (onset milliseconds, Hz, duration milliseconds)...)
CLIPS = {
    "Ready": (130, [(0, 587, 130)]),
    "Sent": (300, [(0, 494, 140), (160, 587, 140)]),
    "Error": (400, [(0, 392, 400)]),
    "Disconnect": (540, [(0, 392, 180), (240, 330, 300)]),
    "Reminder": (2100, [(0, 587, 1050), (1050, 494, 1050)]),
    "Notice": (480, [(0, 494, 480)]),
    "FollowupClose": (180, [(0, 440, 180)]),
    "Timer": (550, [(0, 587, 250), (300, 494, 250)]),
    "Alarm": (550, [(0, 494, 250), (300, 659, 250)]),
    "Volume": (65, [(0, 659, 65)]),
    "RingLow": (1050, [(0, 494, 1050)]),
    "RingMid": (1050, [(0, 587, 1050)]),
    "RingHigh": (1050, [(0, 659, 1050)]),
}


def render(duration_ms, notes):
    samples = [0.0] * (duration_ms * RATE // 1000)
    for onset_ms, hz, note_ms in notes:
        count = note_ms * RATE // 1000
        offset = onset_ms * RATE // 1000
        tau = min(0.270, note_ms / 3000)
        for i in range(count):
            t = i / RATE
            attack = math.sin(min(1, t / .008) * math.pi / 2) ** 2
            tail = min(1, (count - 1 - i) / (RATE * .080))
            samples[offset + i] += 100 * attack * math.exp(-t / tau) * tail * math.sin(2 * math.pi * hz * t)
    return [128 + max(-127, min(127, int(x))) for x in samples]


def write_header(output):
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["// Generated from scripts/earcons_wave.py. Do not edit.", "#pragma once", "namespace bob {"]
    for name, (duration, notes) in CLIPS.items():
        samples = render(duration, notes)
        lines.append(f"static const uint8_t kCabin{name}[] = {{")
        for start in range(0, len(samples), 32):
            lines.append("  " + ",".join(map(str, samples[start:start + 32])) + ",")
        lines.append("};")
    lines.append("}  // namespace bob\n")
    content = "\n".join(lines)
    if not path.exists() or path.read_text() != content:
        path.write_text(content)


if __name__ == "__main__":
    import sys
    write_header(sys.argv[1])

#!/usr/bin/env python3
"""Self-test for bob_model_check.py: the curated static poses pass, and each planted defect fails its own invariant
(a mirror, a blank box, a crack, the raw thoughtful button, stair-stepped and light-haloed outlines).

  py -3.11 apps/cardputer/scripts/bob_model_check_test.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
import bob_model_check as mc  # noqa: E402

ORIG = mc.ROOT / "docs/waveshare/assets"


def main() -> int:
    bad = []
    for pose in ("helper", "curious", "thoughtful", "playful"):
        r = mc.check(mc.STATIC / f"{pose}.png", rest=True)
        if not r["pass"]:
            bad.append(f"static {pose} should pass: {[k for k, c in r['checks'].items() if not c['pass']]}")
    front = Image.open(mc.STATIC / "playful.png").convert("RGBA")
    box = front.copy()
    ImageDraw.Draw(box).rectangle((300, 300, 360, 360), fill=(255, 253, 246, 255))  # an <img> that never loaded
    crack = front.copy()
    ImageDraw.Draw(crack).rectangle((150, 290, 330, 296), fill=(23, 62, 87, 255))  # a gap between head and belly
    a = front.split()[3]
    hard = front.copy()
    hard.putalpha(a.point(lambda v: 255 if v > 127 else 0).resize((a.width // 3, a.height // 3), Image.NEAREST).resize(a.size, Image.NEAREST))
    px = np.array(front)
    rim = (px[..., 3] > 8) & (px[..., 3] < 250)
    px[rim, :3] = (255, 253, 246)  # a light rim on the outline, its antialiased alpha kept: only the fringe is wrong
    halo = Image.fromarray(px)
    planted = {
        "stair-steps": (hard, "M9", False),
        "light-halo": (halo, "M9", False),
        "raw-front": (Image.open(ORIG / "slimmer-bob-playful-v1.webp"), "M9", False),  # the original cutout's light halo
        "mirror": (ImageOps.mirror(front), "M1", False),  # the owner's "ɿoob"
        "box": (box, "M7", False),
        "crack": (crack, "M8", False),
        "upside-down": (front.rotate(180), "M1", True),  # a backflip frame still reads "bob"
        "raw-thoughtful": (Image.open(ORIG / "slimmer-bob-thoughtful-v1.webp"), "M2", True),  # its bigger button
    }
    with tempfile.TemporaryDirectory() as tmp:
        for name, (im, cid, rest) in planted.items():
            path = Path(tmp) / f"{name}.png"
            im.save(path)
            r = mc.check(path, rest=rest)
            want_fail = name not in ("upside-down",)
            got_fail = not r["checks"][cid]["pass"]
            if got_fail != want_fail:
                bad.append(f"{name}: {cid} {'passed' if not got_fail else 'failed'} ({r['checks'][cid]['detail']})")
    for line in bad:
        print("FAIL", line)
    print("bob_model_check self-test:", "ok" if not bad else f"{len(bad)} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

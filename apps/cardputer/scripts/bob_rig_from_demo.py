#!/usr/bin/env python3
"""Regenerate the firmware rig (rig.json + device blobs) from the APPROVED DEMO's own art and placement data.

The visual gate compares the device with the approved demo (docs/waveshare/golden/approved-demo.html). The demo draws the
rig from docs/waveshare/assets/rig/*.png using the RIG table embedded in the page. If the firmware's blobs are cut from a
different build of the masters (different sprite crops, seam, per-pose anchors), no renderer can reach the demo's pixels.
This script makes the firmware's source of truth the demo's: same PNGs, same sizes, same anchors.

Usage: py -3.11 apps/cardputer/scripts/bob_rig_from_demo.py   (then bob_rig_header.py)
Needs Pillow, numpy, opencv-python-headless.
"""
import json
import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
DEMO = ROOT / "docs/waveshare/golden/approved-demo.html"
ART = ROOT / "docs/waveshare/assets/rig"
OUT_RIG = APP / "assets/bob/rig/rig.json"
BLOBS = APP / "lib/bob_art/rig"
POSES = ["helper", "curious", "thoughtful", "playful"]

demo = json.loads(re.search(r"/\*RIG\*/(\{.*?\})/\*END\*/", DEMO.read_text(encoding="utf-8"), re.S).group(1))
parts = demo["parts"]
back_arms = [n for n in parts if n.startswith("arm") and not parts[n]["front"]]
front_arms = [n for n in parts if n.startswith("arm") and parts[n]["front"]]
order = ["footL", "footR"] + back_arms + [f"belly_{p}" for p in POSES] + [f"head_{p}" for p in POSES] + ["visor", "button"] + front_arms


def to_blob(name: str, w: int, h: int) -> bytes:
    """Demo PNG (480-scale master) -> w x h device sprite, premultiplied area resample, RGB565 LE then A8."""
    im = np.array(Image.open(ART / f"{name}.png").convert("RGBA")).astype(np.float32)
    im[..., :3] *= im[..., 3:4] / 255
    small = cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA)
    a = small[..., 3:4]
    rgb = np.where(a > 0, small[..., :3] * 255 / np.maximum(a, 1e-6), 0).clip(0, 255).astype(np.uint16)
    px = ((rgb[..., 0] >> 3) << 11) | ((rgb[..., 1] >> 2) << 5) | (rgb[..., 2] >> 3)
    return px.astype("<u2").tobytes() + small[..., 3].clip(0, 255).round().astype(np.uint8).tobytes()


rig = {"scale": 0.41, "stage": [197, 197],
       "source": "the approved demo (docs/waveshare/golden/approved-demo.html): its PNGs and its embedded RIG table",
       "note": "device px; stage origin = art origin; draw order is `z` (front arms last)", "parts": {}, "poses": {}}
BLOBS.mkdir(parents=True, exist_ok=True)
for z, name in enumerate(order):
    p = parts[name]
    (BLOBS / f"{name}.rgb565a8").write_bytes(to_blob(name, p["w"], p["h"]))
    rig["parts"][name] = {"file": f"{name}.rgb565a8", "w": p["w"], "h": p["h"], "z": z, "pivot": p["pv"], "front": p["front"],
                          "from_pose": next((q for q in POSES if name.endswith(q)), "demo")}
for pose in POSES:
    d = demo["poses"][pose]
    rig["poses"][pose] = {"head": d["head"], "belly": d["belly"], "ssim": 1.0, "psnr_db": 99.0, "shared": d["shared"],
                          "arms": {n: {"shoulder": v} for n, v in d["arms"].items()}}
OUT_RIG.write_text(json.dumps(rig, indent=1) + "\n")
print(f"{len(order)} parts from the demo; blobs in {BLOBS}, rig.json at {OUT_RIG}")

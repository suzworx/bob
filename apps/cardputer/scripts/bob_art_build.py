"""Bob's four poses as raw RGB565 for the Waveshare round screen (src/bob_art.cpp).

assets/bob/static/<pose>.png  ->  lib/bob_art/bob_<pose>.rgb565

The source is the curated static pose (the rig's own pixels at rest, written by bob_rig_build.py; see
docs/waveshare/bob-model-sheet.md), placed back on its original's canvas so Bob keeps his size and spot. The raw
originals differ from each other (belly, logo, button); the static poses are the same Bob in all four.

Each image is fitted into 192x192 (aspect kept, centred), alpha-composited onto the
ground colour #173E57, and written as big-endian RGB565 (73,728 B), the byte order
M5GFX pushImage(rgb565_t) sends to the panel. Output is deterministic (LANCZOS).

  py -3.11 scripts/bob_art_build.py          regenerate lib/bob_art/*.rgb565
  py -3.11 scripts/bob_art_build.py --check  fail if a committed file differs

It also writes include/bob_visor_poses.h: each pose's visor geometry for bob_visor.h (centre, tilt, search region) and
the visor box test_bob_visor.cpp expects, measured from these exact images, so new art can never leave the eyes
outside the visor (the escaped defect of 2026-10-16). The centre and tilt come from the rig (exact even where a hand
covers one end of the visor); the region and box come from the same flood fill the firmware runs.
"""
import json
from pathlib import Path
import sys

from PIL import Image

SIZE = 192
GROUND = (0x17, 0x3E, 0x57)
POSES = ("welcome", "curious", "thoughtful", "playful")
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "bob"
OUT = ROOT / "lib" / "bob_art"


STATIC = {"welcome": "helper", "curious": "curious", "thoughtful": "thoughtful", "playful": "playful"}
MODEL = json.loads((SRC / "static" / "model.json").read_text())


def render(pose: str) -> bytes:
    art = Image.open(SRC / f"{pose}.webp")  # only its canvas size: the art itself comes from the curated static pose
    img = Image.new("RGBA", art.size, (0, 0, 0, 0))
    img.alpha_composite(Image.open(SRC / "static" / f"{STATIC[pose]}.png").convert("RGBA"), tuple(MODEL["origin"][STATIC[pose]]))
    scale = min(SIZE / img.width, SIZE / img.height)
    w, h = round(img.width * scale), round(img.height * scale)
    img = img.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), GROUND + (255,))
    canvas.alpha_composite(img, ((SIZE - w) // 2, (SIZE - h) // 2))
    out = bytearray()
    rgb = canvas.convert("RGB").tobytes()
    for i in range(0, len(rgb), 3):
        v = ((rgb[i] & 0xF8) << 8) | ((rgb[i + 1] & 0xFC) << 3) | (rgb[i + 2] >> 3)
        out += v.to_bytes(2, "big")
    return bytes(out)


RIG = SRC / "rig" / "rig.json"
VISOR_H = ROOT / "include" / "bob_visor_poses.h"
RIG_POSE = {"welcome": "helper", "curious": "curious", "thoughtful": "thoughtful", "playful": "playful"}


def visor_pixel(v: int) -> bool:
    """bob_visor.h isVisorPixel, bit for bit."""
    r, g, b = ((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31
    lum = (r * 30 + g * 59 + b * 11) // 100
    return lum < 100 or (r > 170 and g > 100 and r - b > 70)


def visor_geometry(pose: str, data: bytes):
    """(cx, cy, deg, rx, ry, rw, rh) and the visor box (x0, y0, x1, y1) of one 192 px pose image."""
    import numpy as np  # noqa: PLC0415

    rig = json.loads(RIG.read_text())
    sc_dev = rig["scale"]
    shared = rig["poses"][RIG_POSE[pose]]["shared"]["visor"]
    art = Image.open(SRC / f"{pose}.webp")
    k = min(SIZE / art.width, SIZE / art.height)
    w, h = round(art.width * k), round(art.height * k)
    ox, oy = (SIZE - w) // 2, (SIZE - h) // 2
    cx = shared["pivot_at"][0] / sc_dev * k + ox
    cy = shared["pivot_at"][1] / sc_dev * k + oy
    # the visor bar's own slant (front original), from the visor part's dark pixels, plus the pose's turn of the visor
    vp = np.asarray(Image.open(SRC / "rig" / "visor.png").convert("RGBA")).astype(int)
    ys, xs = np.where((vp[..., :3].sum(2) / 3 < 60) & (vp[..., 3] > 200))
    cov = np.cov(np.stack([xs - xs.mean(), ys - ys.mean()]))
    evals, evecs = np.linalg.eigh(cov)
    vx, vy = evecs[:, int(np.argmax(evals))]
    if vx < 0:
        vx, vy = -vx, -vy
    deg = float(np.degrees(np.arctan2(vy, vx))) + shared["rot"]
    # the firmware's flood fill (visor pixels connected to the centre, holes filled) inside a generous window
    px = np.frombuffer(data, ">u2").reshape(SIZE, SIZE)
    vis = np.vectorize(visor_pixel)(px)
    sx, sy = int(round(cx)), int(round(cy))
    win = (max(0, sx - 40), max(0, sy - 22), min(SIZE, sx + 40), min(SIZE, sy + 22))
    seen = np.zeros_like(vis)
    stack = [(x, y) for r in range(9) for y in range(sy - r, sy + r + 1) for x in range(sx - r, sx + r + 1)
             if win[0] <= x < win[2] and win[1] <= y < win[3] and vis[y, x]][:1]
    while stack:
        x, y = stack.pop()
        if seen[y, x]:
            continue
        seen[y, x] = True
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if win[0] <= nx < win[2] and win[1] <= ny < win[3] and vis[ny, nx] and not seen[ny, nx]:
                stack.append((nx, ny))
    ys, xs = np.where(seen)
    box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    rx, ry = box[0] - 3, box[1] - 3
    rw, rh = min(72, box[2] - box[0] + 7), min(40, box[3] - box[1] + 7)
    return (round(cx, 1), round(cy, 1), round(deg, 1), rx, ry, rw, rh), box


def visor_header(datas: dict) -> str:
    rows, boxes = [], []
    for pose in POSES:
        g, box = visor_geometry(pose, datas[pose])
        rows.append(f"    {{{g[0]:.1f}f, {g[1]:.1f}f, {g[2]:.1f}f, {g[3]}, {g[4]}, {g[5]}, {g[6]}}},  // {pose}")
        boxes.append(f"    {{{box[0]}, {box[1]}, {box[2]}, {box[3]}}},  // {pose}")
    return "\n".join([
        "// GENERATED by scripts/bob_art_build.py from lib/bob_art/bob_<pose>.rgb565 and assets/bob/rig/rig.json. Do not edit.",
        "// Included by bob_visor.h after struct Pose. Per pose: the visor centre and tilt (from the rig, exact even where a hand",
        "// covers one end), the region its mask is built in, and the box of visor pixels the host test expects.",
        "#pragma once",
        "",
        "constexpr Pose kPoses[4] = {",
        *rows,
        "};",
        "",
        "// Bounding box (x0, y0, x1, y1) of each pose's visor mask, measured from the images by the same flood fill.",
        "constexpr int kVisorBox[4][4] = {",
        *boxes,
        "};",
        "",
    ])


def main() -> int:
    check = "--check" in sys.argv[1:]
    bad = 0
    for pose in POSES:
        data = render(pose)
        path = OUT / f"bob_{pose}.rgb565"
        if check:
            if not path.is_file() or path.read_bytes() != data:
                print(f"DIFFERS: {path.name}")
                bad += 1
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            print(f"wrote {path.name} ({len(data)} B)")
    header = visor_header({pose: render(pose) for pose in POSES})
    if check:
        if not VISOR_H.is_file() or VISOR_H.read_text() != header:
            print(f"DIFFERS: {VISOR_H.name}")
            bad += 1
    else:
        VISOR_H.write_text(header, newline="\n")
        print(f"wrote {VISOR_H.name}")
    if check:
        print("bob art: ok" if not bad else f"bob art: {bad} file(s) differ, rerun without --check")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

"""Side-by-side demo | device images per state, plus numeric layout checks against design/bob/tokens.json.

  node design/bob/consistency/shoot-demo.mjs <dir>                       demo-<state>.png
  node tools/bob-sim/run.mjs render --state <name> --out <dir>           <name>.png (device, bob-sim)
  py -3.11 design/bob/consistency/compare.py <demoDir> <deviceDir> <outDir>

Writes <outDir>/consistency-<state>.png (demo left, device right, outside the glass circle blacked out) and prints, per state,
the status-arc disc centres of each side and the largest offset. Exit 1 if any disc is more than 2 px from its partner.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
TOK = json.loads((ROOT / "design/bob/tokens.json").read_text(encoding="utf-8"))
DISC = tuple(int(TOK["palette"]["chipDisc"][i:i + 2], 16) for i in (1, 3, 5))
# demo state -> device sim scene
PAIRS = {"boot": "hello", "connecting": "hello", "pairing": "pairing", "ready": "ready", "listening": "listening", "thinking": "thinking",
         "speaking": "speaking", "reply": "reply", "announce": "announce", "offline": "offline", "error": "error", "updating": "updating",
         "dnd": "sleeping", "field": "field"}
TOL = 2.0
# no numeric check: the demo dims the whole glass in DND, covers it with a view on the field screen, and the device pairing card hides the arc
INFO_ONLY = {"dnd", "field", "pairing", "reply"}


def circle_mask(img: Image.Image) -> Image.Image:
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).ellipse((0, 0, img.width - 1, img.height - 1), fill=255)
    out = Image.new("RGB", img.size, (0, 0, 0))
    out.paste(img.convert("RGB"), (0, 0), m)
    return out


def q565(c: tuple[int, int, int]) -> tuple[int, int, int]:
    """The colour as the device framebuffer stores it (RGB565, low bits dropped), as the sim reads it back."""
    return ((c[0] >> 3) << 3, (c[1] >> 2) << 2, (c[2] >> 3) << 3)


def disc_centres(img: Image.Image) -> list[tuple[float, float]]:
    """Centres of the status-arc discs: pixels within a few levels of the disc colour in the top band, clustered along x."""
    a = np.asarray(img.convert("RGB")).astype(int)[:72]
    d = (np.abs(a - np.array(DISC)).sum(axis=2) <= 12) | (np.abs(a - np.array(q565(DISC))).sum(axis=2) <= 6)
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    d &= np.hypot(xx - 180, yy - 180) < 164  # keep the ring out of it
    cols = np.where(d.any(axis=0))[0]
    clusters: list[list[int]] = []
    for c in cols:
        if clusters and c - clusters[-1][-1] <= 2:
            clusters[-1].append(int(c))
        else:
            clusters.append([int(c)])
    out = []
    for cl in clusters:
        sub = d[:, cl[0]:cl[-1] + 1]
        ys, xs = np.nonzero(sub)
        if len(ys) < 60:
            continue
        # the disc's bounding box centre is robust to the glyph cut-out in the middle
        out.append(((xs.min() + xs.max()) / 2 + cl[0], (ys.min() + ys.max()) / 2))
    return out


def main(argv: list[str]) -> int:
    demo_dir, dev_dir, out_dir = (Path(p) for p in argv[:3])
    out_dir.mkdir(parents=True, exist_ok=True)
    bad = 0
    for demo_name, dev_name in PAIRS.items():
        dp, vp = demo_dir / f"demo-{demo_name}.png", dev_dir / f"{dev_name}.png"
        if not dp.exists() or not vp.exists():
            print(f"{demo_name}: missing {'demo' if not dp.exists() else 'device'} image")
            continue
        d_img, v_img = Image.open(dp), Image.open(vp)
        dc, vc = disc_centres(d_img), disc_centres(v_img)
        worst = 0.0
        if len(dc) == len(vc):
            for (x1, y1), (x2, y2) in zip(dc, vc):
                worst = max(worst, ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5)
        note = "" if len(dc) == len(vc) else f" (icon count demo {len(dc)} vs device {len(vc)})"
        flag = "OK " if len(dc) == len(vc) and worst <= TOL else "DIFF"
        if demo_name in INFO_ONLY:
            flag = "INFO"
        bad += flag == "DIFF"
        print(f"{flag} {demo_name:<10} discs demo={len(dc)} device={len(vc)} worst_offset={worst:.1f}px{note}")
        w = Image.new("RGB", (360 * 2 + 12, 360 + 22), (30, 30, 34))
        w.paste(circle_mask(d_img), (0, 22))
        w.paste(circle_mask(v_img), (372, 22))
        dr = ImageDraw.Draw(w)
        dr.text((6, 5), f"demo: {demo_name}", fill=(230, 230, 230))
        dr.text((378, 5), f"device (bob-sim): {dev_name}", fill=(230, 230, 230))
        w.save(out_dir / f"consistency-{demo_name}.png")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

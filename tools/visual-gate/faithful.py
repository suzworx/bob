"""The gate's measured ceiling: what a port that matches the demo exactly can score on the device.

  py -3.11 -I tools/visual-gate/faithful.py [--fw <checkout>] [--out <dir>] [--write]

A faithful candidate is the golden with each thing the device draws differently replaced by the device's own
drawing, and nothing else. Three stages are scored per case and per region with diff.py's own SSIM, and each stage's
ceiling is the lowest score over the cases:

  A  rgb565   the golden through the panel's RGB565 (truncated, widened by bit replication, as bob-sim and
              `T screenshot` read the framebuffer back) and the 360 px circle mask.
  B  + text   every text line of the golden (text-runs.json: its string, line box, size and colour) erased to its
              background and redrawn by the device: the firmware's Nunito VLW fonts through LovyanGFX's smooth-font
              path (sim/textprobe.cpp, built in the bob-sim image), at the role the firmware uses for that size
              (the nearest of caption 15, body 17, title 24, hero 40 px: font_build.py ROLES) and centred on the
              golden's line box, as round_ui textCentered() centres it. This includes the pairing code, which the
              demo sets in Consolas and the device in Nunito.
  C  + art    Bob drawn from device art: every pinned rig part through the device blob pipeline (bob_rig_build.py
              device_part: premultiplied area resample to 0.41, then RGB565 and 8-bit alpha) and placed by the demo
              at device size, so each part is drawn 1:1 at the golden's exact geometry.

Each threshold is per case and region: that case's ceiling(C) - margin. It comes from what the device can show at the
golden's geometry, never from a candidate's scores, and the hardest case does not loosen the others. --write records all three stages and the derivation in the golden manifest (`gate` block, with
the sha256 of every golden it used; diff.py refuses a stale block). --out writes the stage-C renders as <id>.png for a
proof run of diff.py.

Still not modelled: the device's compositor (a rotated part is drawn by the firmware's rotate, not the browser's;
parts sit on whole pixels on the device). In REST mode most parts are unrotated, and the gate registers +-1 px.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir; diff.py is the sibling module

import numpy as np
from PIL import Image

import diff

KEYS = ("circle", *diff.REGIONS)
SCORED = (*KEYS, "eyes")  # eyes: the visor box, where the golden shows one
STAGES = ("rgb565", "text", "art")
# apps/cardputer/scripts/font_build.py ROLES: the pixel size of each device font role.
ROLE_PX = {"caption": 15, "body": 17, "title": 24, "hero": 40}
DEV_SCALE = 0.41  # apps/cardputer/scripts/bob_rig_build.py DEV_SCALE
NODE = "node"


def rgb565(rgb: np.ndarray) -> np.ndarray:
    px = rgb.astype(np.uint16)
    r, g, b = px[..., 0] >> 3, px[..., 1] >> 2, px[..., 2] >> 3
    return np.stack([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)], axis=-1).astype(np.float64)


def role_for(px: float) -> str:
    """The device font role the firmware uses for a CSS size: the nearest role size (smaller on a tie)."""
    return min(ROLE_PX, key=lambda r: (abs(ROLE_PX[r] - px), ROLE_PX[r]))


def parse_color(css: str) -> np.ndarray:
    m = re.match(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)", css)
    if not m:
        raise ValueError(f"unparsed text colour {css!r}")
    return np.array([float(m.group(i)) for i in (1, 2, 3)])


def device_part(rgba: np.ndarray) -> np.ndarray:
    """A rig part as the device stores it: premultiplied area resample to DEV_SCALE, then RGB565 and 8-bit alpha."""
    h, w = rgba.shape[:2]
    nw, nh = max(1, round(w * DEV_SCALE)), max(1, round(h * DEV_SCALE))
    pre = rgba.astype(np.float32)
    pre[..., :3] *= pre[..., 3:4] / 255
    small = np.stack([np.asarray(Image.fromarray(pre[..., k], mode="F").resize((nw, nh), Image.BOX)) for k in range(4)], axis=-1)
    a = small[..., 3:4]
    rgb = np.where(a > 0, small[..., :3] / np.maximum(a / 255, 1e-6), 0).clip(0, 255)
    rgb = rgb565(rgb.astype(np.uint8))
    return np.concatenate([rgb, a.clip(0, 255)], axis=2).round().astype(np.uint8)


def device_art_renders(work: Path) -> Path:
    parts = work / "device-rig"
    parts.mkdir(parents=True, exist_ok=True)
    for f in sorted((diff.ROOT / "docs/waveshare/golden/assets/rig").glob("*.png")):
        Image.fromarray(device_part(np.asarray(Image.open(f).convert("RGBA"))), "RGBA").save(parts / f.name)
    out = work / "device-art"
    subprocess.run([NODE, str(diff.HERE / "golden.mjs"), "--out", str(out), "--rig-dir", str(parts)], check=True)
    return out


def device_text(fw: Path, runs: dict, work: Path) -> dict:
    """Coverage of every text line as the device draws it: {case id: [coverage 360x360 in 0..1, ...]}."""
    jobs, index = [], []
    for cid, lines in runs.items():
        for k, run in enumerate(lines):
            jobs.append({"role": role_for(run["size"]), "x": (run["x0"] + run["x1"]) / 2, "y": (run["y0"] + run["y1"]) / 2,
                         "text": run["text"]})
            index.append((cid, k))
    jobs_file = work / "text-jobs.json"
    jobs_file.write_text(json.dumps(jobs), encoding="utf8")
    out = work / "device-text"
    subprocess.run([NODE, str(diff.HERE / "candidate.mjs"), "--text-jobs", str(jobs_file), "--out", str(out), "--fw", str(fw)], check=True)
    cover: dict = {cid: [None] * len(lines) for cid, lines in runs.items()}
    for i, (cid, k) in enumerate(index):
        cover[cid][k] = np.asarray(Image.open(out / f"text-{i:03d}.png").convert("RGB"))[..., 0].astype(np.float64) / 255
    return cover


def with_device_text(img: np.ndarray, runs: list, covers: list) -> np.ndarray:
    """Each golden text line erased to its background (the median of a ring just outside its line box) and redrawn
    by the device: background * (1 - coverage) + colour * coverage, as a smooth font blends on the panel."""
    out = img.copy()
    for run, cov in zip(runs, covers):
        x0, x1 = int(np.floor(run["x0"])) - 2, int(np.ceil(run["x1"])) + 2
        y0, y1 = int(np.floor(run["y0"])) - 2, int(np.ceil(run["y1"])) + 2
        ys, xs = np.nonzero(cov > 0)
        if len(xs):
            x0, x1 = min(x0, int(xs.min())), max(x1, int(xs.max()) + 1)
            y0, y1 = min(y0, int(ys.min())), max(y1, int(ys.max()) + 1)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, diff.SIZE), min(y1, diff.SIZE)
        ring = np.concatenate([img[max(y0 - 3, 0):y0, x0:x1].reshape(-1, 3), img[y1:y1 + 3, x0:x1].reshape(-1, 3),
                               img[y0:y1, max(x0 - 3, 0):x0].reshape(-1, 3), img[y0:y1, x1:x1 + 3].reshape(-1, 3)])
        bg = np.median(ring, axis=0) if len(ring) else np.array(diff.pc.GROUND_COLOR, dtype=np.float64)
        a = cov[y0:y1, x0:x1, None]
        out[y0:y1, x0:x1] = bg * (1 - a) + parse_color(run["color"]) * a
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--golden", type=Path, default=diff.ROOT / "docs/waveshare/golden")
    ap.add_argument("--fw", type=Path, default=diff.ROOT, help="the checkout whose fonts and bob-sim draw the device text")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)

    spec = json.loads((diff.HERE / "cases.json").read_text(encoding="utf8"))
    margin = spec["margin"]
    manifest_path = args.golden / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    runs = json.loads((args.golden / "text-runs.json").read_text(encoding="utf8"))
    tpl = diff.logo_template(args.golden)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="bob-faithful-") as tmp:
        work = Path(tmp)
        covers = device_text(args.fw, runs, work)
        art = device_art_renders(work)
        scores = {s: {} for s in STAGES}
        for case in spec["cases"]:
            cid = case["id"]
            golden = diff.load(args.golden / f"{cid}.png")
            golden[~diff.CIRCLE] = 0
            dev_art = diff.load(art / f"{cid}.png")
            dev_art[~diff.CIRCLE] = 0
            stages = {
                "rgb565": rgb565(golden),
                "text": rgb565(with_device_text(golden, runs[cid], covers[cid])),
                "art": rgb565(with_device_text(dev_art, runs[cid], covers[cid])),
            }
            for name, img in stages.items():
                img[~diff.CIRCLE] = 0
                res, _ = diff.judge(case, golden, img, tpl, {k: 0.0 for k in KEYS})
                scores[name][cid] = {k: res["scores"][f"ssim_{k}"] for k in SCORED if f"ssim_{k}" in res["scores"]}
            if args.out:
                Image.fromarray(stages["art"].astype(np.uint8)).save(args.out / f"{cid}.png")
            print(f"{cid:<28} " + "  ".join(f"{k} {scores['art'][cid][k]:.4f}" for k in KEYS))

    # Per case: each case's own device ceiling, so the hardest case (the pairing code in Consolas, the reply text)
    # never loosens the others. The lowest over the cases is kept as a summary.
    ceilings = {s: {k: round(min(c[k] for c in scores[s].values() if k in c), 4) for k in SCORED} for s in STAGES}
    thresholds = {cid: {k: round(v - margin, 3) for k, v in sc.items()} for cid, sc in scores["art"].items()}
    for s in STAGES:
        print(f"lowest ceiling {s:<7} " + "  ".join(f"{k} {ceilings[s][k]:.4f}" for k in SCORED))
    for k in SCORED:
        vals = [t[k] for t in thresholds.values() if k in t]
        print(f"threshold {k:<8} min {min(vals):.3f}  median {sorted(vals)[len(vals) // 2]:.3f}  max {max(vals):.3f}")
    if args.write:
        manifest["gate"] = {
            "derivation": "threshold[case][region] = that case's ceiling(art) - margin. A ceiling is the score of the golden "
                          "with what the device draws differently replaced by the device's own drawing "
                          "(tools/visual-gate/faithful.py): rgb565 = the panel's colour depth and the circle mask; text = + every "
                          "text line redrawn by the firmware's Nunito VLW fonts through LovyanGFX at the firmware's role for that "
                          "size; art = + Bob drawn from device-pipeline rig parts (premultiplied area resample to 0.41, RGB565 + A8). "
                          "Not modelled: the device compositor's own rotate and whole-pixel placement.",
            "margin": margin,
            "lowest_ceilings": ceilings,
            "ceilings_by_case": {s: {cid: {k: round(v, 4) for k, v in sc.items()} for cid, sc in scores[s].items()} for s in STAGES},
            "thresholds": thresholds,
            "goldens": {i: g["sha256"] for i, g in manifest["goldens"].items()},
        }
        with open(manifest_path, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(manifest, indent=2) + "\n")
        print(f"gate block written to {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

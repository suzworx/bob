#!/usr/bin/env python3
"""Cut Bob into rig parts from the owner's original art and prove the cut is faithful.

Source art (owner's own, never redrawn): docs/waveshare/assets/slimmer-bob-{helper,curious,thoughtful,playful}-v1.webp
Outputs (all derived, deterministic):
  apps/cardputer/assets/bob/rig/*.png          part masters (480 px art scale)
  apps/cardputer/assets/bob/rig/rig.json       part sizes, pivots, per-pose placement, draw order (device px)
  apps/cardputer/lib/bob_art/rig/*.rgb565a8    device blobs (RGB565 then A8), only with --device-blobs; not committed
                                               (BOB-RIG-FW generates them on the firmware branch, which gets HIL'd)
  docs/waveshare/screenshots/rig-compare-*.png original | recomposite | diff
  docs/waveshare/screenshots/rig-move-*.png    12-frame preview strips (see bob_rig_moves.py)

Usage: py -3.11 apps/cardputer/scripts/bob_rig_build.py [--check] [--no-previews] [--device-blobs]
  --check  rebuild into a temp dir and compare masters + rig.json with the committed files; exit 1 on drift or SSIM < 0.9
  --device-blobs  also write (or, with --check, compare) the device blobs
Needs: Pillow, numpy, opencv-python-headless.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "docs/waveshare/assets"
POSES = ["helper", "curious", "thoughtful", "playful"]
NAVY = (23, 62, 87)
DEV_SCALE = 0.41  # 480 px art -> Bob about 192 px tall on the 360 px glass
SSIM_TARGET = 0.9

# ---- hand-placed cut outlines, in 480 px art coordinates, read off the originals.
# Arms are cut with a lobe that reaches ~20 px into the body so the shoulder end is hidden
# when the arm is drawn behind the body shell.
ARMS: dict[str, tuple[str, list[tuple[int, int]], tuple[int, int]]] = {
    # variant: (pose, outline, shoulder pivot)
    "armL_down": ("helper", [(96, 236), (62, 226), (36, 232), (14, 252), (2, 282), (0, 312), (12, 342), (38, 358), (64, 352), (80, 326), (82, 292), (80, 266), (98, 266)], (80, 250)),
    "armR_wave": ("helper", [(380, 214), (410, 232), (440, 222), (466, 192), (478, 148), (472, 104), (452, 90), (428, 96), (408, 130), (396, 172), (378, 176)], (392, 214)),
    "armL_up": ("playful", [(112, 246), (84, 240), (50, 222), (22, 192), (4, 164), (2, 138), (20, 118), (46, 116), (74, 128), (96, 156), (112, 186)], (100, 222)),
    "armR_up": ("playful", [(380, 246), (410, 240), (446, 216), (470, 180), (478, 148), (466, 118), (442, 112), (416, 124), (394, 156), (382, 186)], (392, 224)),
    "armL_ear": ("curious", [(46, 131), (73, 129), (78, 141), (77, 161), (73, 185), (75, 198), (87, 215), (93, 235), (93, 258), (90, 266), (67, 265), (47, 253), (28, 233), (23, 211), (23, 185), (27, 155), (33, 140)], (80, 246)),
    "armR_down": ("curious", [(384, 206), (412, 214), (440, 252), (456, 290), (456, 322), (434, 336), (410, 326), (394, 296), (384, 262), (372, 240)], (394, 216)),
    # front arm: traced tight to the arm's own shadow line (a loose outline painted the original's face and logo groove over Bob)
    "armL_chin": ("thoughtful", [(136, 148), (163, 147), (183, 155), (190, 171), (188, 188), (178, 199), (168, 205), (156, 218), (148, 235), (136, 258), (121, 275), (93, 280), (69, 273), (53, 255), (49, 235), (56, 215), (69, 201), (86, 188), (113, 165)], (110, 262)),
    "armR_down2": ("thoughtful", [(372, 232), (394, 238), (418, 272), (430, 316), (430, 350), (410, 362), (390, 346), (378, 308), (372, 268)], (382, 244)),
}
FEET_ELL = {"footL": (177, 446, 50, 30), "footR": (316, 446, 50, 30)}  # cx, cy, rx, ry on the playful art
BODY_POSE = "playful"
# Head tilt baked into a pose (degrees about the seam). All 0 on purpose: the firmware and the demo tilt the head at run
# time (curious tilt, listening), and a baked tilt stacked with theirs opened a crack at the seam on the device (2026-10-16).
HEAD_TILT = {"helper": 0.0, "curious": 0.0, "thoughtful": 0.0, "playful": 0.0}
SHOULDER_R = 24  # art px: the round joint a back arm keeps inside the body
# Curated arm rest angle (degrees about the shoulder, + = clockwise): the thoughtful hand rests on the cheek, never on the logo.
ARM_TILT = {"armL_chin": -14.0}


# ----------------------------------------------------------------------------- helpers
def load(pose: str) -> np.ndarray:
    """480x480 RGBA canvas; the helper original is 480x470, so it is top-aligned on the canvas."""
    im = Image.open(SRC / f"slimmer-bob-{pose}-v1.webp").convert("RGBA")
    canvas = Image.new("RGBA", (480, 480), (0, 0, 0, 0))
    canvas.paste(im, (0, 0))
    return np.array(canvas)


def largest_cc(m: np.ndarray) -> np.ndarray:
    n, lab, st, _ = cv2.connectedComponentsWithStats((m > 0).astype(np.uint8))
    if n < 2:
        return m
    return ((lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))) * 255).astype(np.uint8)


def poly_mask(pts, shape=(480, 480)) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 255)
    return m


def ell_mask(cx, cy, rx, ry, shape=(480, 480)) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.ellipse(m, (cx, cy), (rx, ry), 0, 0, 360, 255, -1)
    return m


def over_navy(rgba: np.ndarray) -> np.ndarray:
    a = rgba[..., 3:4].astype(np.float32) / 255
    bg = np.array(NAVY, np.float32)
    return (rgba[..., :3].astype(np.float32) * a + bg * (1 - a)).clip(0, 255).astype(np.uint8)


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Mean SSIM (Wang et al., 11x11 gaussian, sigma 1.5) of two RGB images, averaged over channels."""
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    vals = []
    for ch in range(3):
        x, y = a[..., ch].astype(np.float64), b[..., ch].astype(np.float64)
        f = lambda im: cv2.GaussianBlur(im, (11, 11), 1.5)  # noqa: E731
        mx, my = f(x), f(y)
        sxx, syy, sxy = f(x * x) - mx * mx, f(y * y) - my * my, f(x * y) - mx * my
        s = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))
        vals.append(s.mean())
    return float(np.mean(vals))


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else float(10 * np.log10(255**2 / mse))


def fill_bg_color(rgba: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """RGB where `keep` is False is replaced by the nearest kept pixel's colour (so inpainting never sees navy/black)."""
    src = (~keep).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.where(keep)
    lab_at = np.zeros(labels.max() + 1, np.int64)
    lab_at[labels[ys, xs]] = ys * 480 + xs
    idx = lab_at[labels]
    return rgba[..., :3].reshape(-1, 3)[idx.ravel()].reshape(480, 480, 3)


def bridge_profile(alpha: np.ndarray, axis: str, side: str, gap: tuple[int, int], span: tuple[int, int], deg=4) -> np.ndarray:
    """Return a filled silhouette strip for rows (axis 'row') / columns ('col') in `gap` by fitting the
    body outline from the visible rows just outside the gap. side: 'min' or 'max' edge."""
    h, w = alpha.shape
    out = np.zeros_like(alpha)
    a = alpha > 127
    coords, edge = [], []
    lo, hi = span
    for i in range(lo, hi):
        if gap[0] <= i <= gap[1]:
            continue
        line = a[i, :] if axis == "row" else a[:, i]
        nz = np.where(line)[0]
        if len(nz):
            coords.append(i)
            edge.append(nz.min() if side == "min" else nz.max())
    p = np.polyfit(coords, edge, deg)
    for i in range(gap[0], gap[1] + 1):
        e = int(round(np.polyval(p, i)))
        line = a[i, :] if axis == "row" else a[:, i]
        nz = np.where(line)[0]
        other = (nz.max() if side == "min" else nz.min()) if len(nz) else (w // 2)
        s, t = (e, other) if side == "min" else (other, e)
        if axis == "row":
            out[i, min(s, t):max(s, t) + 1] = 255
        else:
            out[min(s, t):max(s, t) + 1, i] = 255
    return out


def known_body(img: np.ndarray, pose: str) -> np.ndarray:
    """Body pixels of a pose with every movable part (arms, feet, button, visor plate) cut away."""
    a = (img[..., 3] > 127).astype(np.uint8) * 255
    cut = np.zeros_like(a)
    for n, (p, outline, _) in ARMS.items():
        if p == pose:
            cut = cv2.bitwise_or(cut, cv2.dilate(poly_mask(outline), np.ones((25, 25), np.uint8)))
    cut = cv2.bitwise_or(cut, cv2.dilate(yellow_mask(img), np.ones((5, 5), np.uint8)))
    cut = cv2.bitwise_or(cut, cv2.dilate(visor_mask(img), np.ones((5, 5), np.uint8)))
    ys = np.where(a > 0)[0]
    y_cut = int(ys.max()) - 48
    row = a[int(ys.max()) - 4] > 0  # the two feet at the bottom row; the belly bottom between them is kept
    xs = np.where(row)[0]
    lobes = np.where(np.diff(xs) > 6)[0]
    keep_cols = np.zeros(a.shape[1], bool)
    if len(lobes):
        keep_cols[xs[lobes[0]] + 8: xs[lobes[0] + 1] - 8] = True
    cut[y_cut:, :] = np.where(keep_cols[None, :], cut[y_cut:, :], 255)
    known = cv2.bitwise_and(a, cv2.bitwise_not(cut))
    known = cv2.morphologyEx(known, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(known)
    return ((lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))) * 255).astype(np.uint8)


def hull_sil(known: np.ndarray) -> np.ndarray:
    """Bob's body is convex: the hull of what is visible restores the hidden outline."""
    ys, xs = np.where(known > 0)
    hull = cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32))
    out = np.zeros_like(known)
    cv2.fillConvexPoly(out, hull, 255)
    # the belly bottom behind the feet is a straight hull chord; where a sane ellipse fits the real lower outline, round it
    ymax = int(ys.max())
    cnts, _ = cv2.findContours(known, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    pts = max(cnts, key=cv2.contourArea).reshape(-1, 2)
    rows, counts = np.unique(pts[:, 1], return_counts=True)
    flat = rows[counts >= 25]  # the straight cuts left by removing feet
    lower = pts[(pts[:, 1] > ymax - 90) & ~np.isin(pts[:, 1], flat)]
    if len(lower) >= 60:
        el = np.zeros_like(known)
        cv2.ellipse(el, cv2.fitEllipse(lower.astype(np.float32)), 255, -1)
        low = np.zeros_like(known)
        low[ymax - 60:] = 255
        hull_low = cv2.bitwise_and(out, low)
        ell_low = cv2.bitwise_and(el, low)
        ratio = (ell_low > 0).sum() / max((hull_low > 0).sum(), 1)
        if 0.85 < ratio < 1.25:
            out = cv2.bitwise_or(cv2.bitwise_and(out, cv2.bitwise_not(low)), cv2.bitwise_and(cv2.bitwise_or(ell_low, known), low))
    return out


# ----------------------------------------------------------------------------- part extraction
def yellow_mask(img: np.ndarray) -> np.ndarray:
    r, g, b = [img[..., k].astype(int) for k in range(3)]
    m = ((r > 200) & (g > 140) & (b < 120) & (r - b > 110)).astype(np.uint8) * 255
    m[100:] = 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return ((lab == k) * 255).astype(np.uint8)


def visor_mask(img: np.ndarray) -> np.ndarray:
    lum = img[..., :3].astype(int).sum(axis=2) / 3
    dark = ((lum < 75) & (img[..., 3] > 200)).astype(np.uint8) * 255
    dark[:70] = 0
    dark[190:] = 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark)
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    m = ((lab == k) * 255).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))  # swallow the amber eyes
    return m


def crop(rgba: np.ndarray, mask: np.ndarray, pad=2):
    ys, xs = np.where(mask > 0)
    y0, y1, x0, x1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, 480), max(xs.min() - pad, 0), min(xs.max() + pad + 1, 480)
    out = rgba[y0:y1, x0:x1].copy()
    out[..., 3] = np.minimum(out[..., 3], cv2.dilate(mask, np.ones((3, 3), np.uint8))[y0:y1, x0:x1])
    return out, (x0, y0)


def eye_mask(img: np.ndarray) -> np.ndarray:
    """The painted amber eyes inside the visor of a pose (eyes are drawn procedurally on device, so they are not a rig part)."""
    vis = visor_mask(img)
    r, g, b = [img[..., k].astype(int) for k in range(3)]
    amber = ((r > 150) & (g > 100) & (b < 150) & (vis > 0)).astype(np.uint8) * 255
    return cv2.dilate(amber, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))


def transplant_weave(inp: np.ndarray, rgb: np.ndarray, known: np.ndarray, hole: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """Telea leaves the woven belly smooth where an arm covered it. Every hole pixel below the seam gets real weave copied from the
    intact belly on the far side (56 px inward, rows follow the seam slope), colour-matched to the inpainted low frequencies and feathered."""
    out = inp.astype(np.float32)
    yy, xx = np.mgrid[0:480, 0:480]
    below = (hole > 0) & (yy >= sy[xx] + 3)
    for left in (True, False):
        m = below & ((xx < 240) if left else (xx >= 240))
        if not m.any():
            continue
        dx = 56 if left else -56
        sx = np.clip(xx + dx, 0, 479)
        sy_src = np.clip(yy + (sy[sx] - sy[xx]), 0, 479)
        mapx, mapy = sx.astype(np.float32), sy_src.astype(np.float32)
        src = cv2.remap(rgb, mapx, mapy, cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        ok = cv2.remap(known, mapx, mapy, cv2.INTER_NEAREST) > 0
        low_src = cv2.GaussianBlur(src, (0, 0), 7)
        low_dst = cv2.GaussianBlur(out, (0, 0), 7)
        patch = src - low_src + low_dst
        w = cv2.GaussianBlur(((m > 0) & ok).astype(np.float32), (0, 0), 2.5) * m
        w = np.clip(w * 1.4, 0, 1)[..., None]
        out = out * (1 - w) + patch * w
    return out.clip(0, 255).astype(np.uint8)


def transplant_clay(inp: np.ndarray, rgb: np.ndarray, known: np.ndarray, hole: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """Like transplant_weave, above the seam: hidden ivory clay gets the real clay grain from 48 px inboard, same row, on top of the
    inpainted shading, so a reconstructed shoulder never reads as a smooth smudge."""
    out = inp.astype(np.float32)
    yy, xx = np.mgrid[0:480, 0:480]
    above = (hole > 0) & (yy < sy[xx] - 3)
    for left in (True, False):
        m = above & ((xx < 240) if left else (xx >= 240))
        if not m.any():
            continue
        sx = np.clip(xx + (48 if left else -48), 0, 479)
        mapx, mapy = sx.astype(np.float32), yy.astype(np.float32)
        src = cv2.remap(rgb, mapx, mapy, cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        ok = (cv2.remap(known, mapx, mapy, cv2.INTER_NEAREST) > 0) & (sy[sx] - 3 > yy)
        grain = src - cv2.GaussianBlur(src, (0, 0), 4)
        w = cv2.GaussianBlur((m & ok).astype(np.float32), (0, 0), 2.0) * m
        out = out + grain * np.clip(w * 1.3, 0, 1)[..., None]
    return out.clip(0, 255).astype(np.uint8)


def fit_hidden_edges(sil: np.ndarray, known: np.ndarray, reach: int = 60) -> np.ndarray:
    """Where an arm hid the body's side, the hull rebuilds it as a straight chord (wider than the real curve, stair-stepped).
    Replace those rows with a smooth curve fitted to the real edge just above and below the gap."""
    out = sil.copy()
    ys = np.where(sil.any(1))[0]
    for side in ("min", "max"):
        ke = np.full(480, np.nan)
        se = np.full(480, np.nan)
        for y in ys:
            k, h = np.where(known[y] > 0)[0], np.where(sil[y] > 0)[0]
            if len(h):
                se[y] = h.min() if side == "min" else h.max()
            if len(k):
                ke[y] = k.min() if side == "min" else k.max()
        gap = ~np.isnan(se) & (np.isnan(ke) | (np.abs(ke - se) > 2))
        y = 0
        while y < 480:
            if not gap[y]:
                y += 1
                continue
            y1 = y
            while y1 + 1 < 480 and gap[y1 + 1]:
                y1 += 1
            rows = np.array([r for r in range(max(0, y - reach), min(480, y1 + reach + 1)) if not gap[r] and not np.isnan(ke[r])])
            if len(rows) >= 12 and (rows < y).any() and (rows > y1).any():
                c = np.polyfit(rows, ke[rows], 2)
                for r in range(y, y1 + 1):
                    e = int(round(np.polyval(c, r)))
                    line = np.where(sil[r] > 0)[0]
                    if not len(line):
                        continue
                    out[r] = 0
                    lo, hi = (e, line.max()) if side == "min" else (line.min(), e)
                    out[r, max(0, lo):min(480, hi + 1)] = 255
            y = y1 + 1
    return out


EDGE_SMOOTH, EDGE_RAMP = 3.0, 1.5  # art px: outline smoothing (stair-steps) and the antialiased alpha ramp width


def finish_edges(rgba: np.ndarray) -> np.ndarray:
    """Every outline: smoothed (no stair-steps), a ~1.5 px antialiased alpha ramp, and the colour of any pixel that was not
    opaque taken from inside the part, so no light fringe shows against the ground (model sheet M9). Opaque pixels keep
    the owner's colour (the visor rim, the clay shading)."""
    h, w = rgba.shape[:2]
    pad = 8
    a = np.pad(rgba[..., 3].astype(np.float32) / 255, pad)
    g = cv2.GaussianBlur((a > 0.5).astype(np.float32), (0, 0), EDGE_SMOOTH)
    slope = 1.0 / (EDGE_SMOOTH * np.sqrt(2 * np.pi))  # of the blurred step at the edge, per px
    ramp = np.clip((g - 0.5) / (slope * EDGE_RAMP) + 0.5, 0, 1)
    deep = cv2.erode((g > 0.5).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    alpha = np.where(deep, np.maximum(a, ramp), ramp)  # soft interiors (none today) stay as they were
    rgb = np.pad(rgba[..., :3], ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    solid = a >= 0.98
    if solid.any():
        _, lab = cv2.distanceTransformWithLabels((~solid).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
        cy, cx = np.where(solid)
        at = np.zeros(lab.max() + 1, np.int64)
        at[lab[cy, cx]] = cy * rgb.shape[1] + cx
        src = rgb.reshape(-1, 3)[at[lab].ravel()].reshape(rgb.shape)
        rgb = np.where(solid[..., None], rgb, src)
    # defringe: the originals were cut with a light halo; an outline pixel is never lighter than the clay just inside it
    inside = cv2.distanceTransform((alpha > 0.02).astype(np.uint8), cv2.DIST_L2, 5)  # every visible pixel, the faint ones too
    band = (inside > 0) & (inside < 5.5)
    core = (inside >= 5.5) & (inside < 9.5)
    if core.any():
        lum = rgb.astype(np.float32).mean(2)
        num = cv2.blur(np.where(core, lum, 0).astype(np.float32), (15, 15))
        den = cv2.blur(core.astype(np.float32), (15, 15))
        ref = num / np.maximum(den, 1e-3)
        over = band & (den > 1e-3) & (lum > ref)
        k = np.where(over, ref / np.maximum(lum, 1), 1.0)[..., None]
        rgb = (rgb.astype(np.float32) * k).clip(0, 255).astype(np.uint8)
    return np.dstack([rgb, (alpha * 255).round().astype(np.uint8)])[pad:pad + h, pad:pad + w]


def make_body(pose: str) -> tuple[np.ndarray, tuple[int, int]]:
    """Body shell of one pose: arms, feet, button and visor cut away, hidden outline rebuilt from the hull, clay inpainted."""
    img = load(pose)
    known = known_body(img, pose)
    sil = fit_hidden_edges(hull_sil(known), known)
    # A back arm emerges from behind the body edge: inside the body outline its cut lobe is the owner's visible body pixels,
    # so take them back instead of inventing them (never the visor, button or feet)
    back = np.zeros_like(known)
    for n, (p_, outline, _) in ARMS.items():
        if p_ == pose and n not in FRONT_ARMS:
            back = cv2.bitwise_or(back, cv2.dilate(poly_mask(outline), np.ones((25, 25), np.uint8)))
    keep_out = cv2.dilate(cv2.bitwise_or(visor_mask(img), yellow_mask(img)), np.ones((9, 9), np.uint8))
    # (12 px in: the arm's own root crease at the edge belongs to that arm, not to the shared body)
    restore = (back > 0) & (cv2.erode(sil, np.ones((25, 25), np.uint8)) > 0) & (img[..., 3] > 250) & (keep_out == 0)
    restore[int(np.where(img[..., 3] > 127)[0].max()) - 48:] = False
    known = np.where(restore, 255, known).astype(np.uint8)
    rgb = fill_bg_color(img, known > 0)
    hole = cv2.dilate(cv2.bitwise_and(sil, cv2.bitwise_not(known)), np.ones((3, 3), np.uint8))
    body_rgb = cv2.inpaint(np.ascontiguousarray(rgb), hole, 7, cv2.INPAINT_TELEA)
    sy_full, _, _ = seam_curve(rgb, known > 0)
    # above the seam the hidden clay is ivory only: inpaint it from ivory pixels (the weave is masked out) and give it real texture
    yy, xx = np.mgrid[0:480, 0:480]
    above = yy < sy_full[xx] - 2
    ivory_src = cv2.inpaint(np.ascontiguousarray(rgb), np.where((hole > 0) | ~above, 255, 0).astype(np.uint8), 7, cv2.INPAINT_TELEA)
    body_rgb = np.where(((hole > 0) & above)[..., None], ivory_src, body_rgb)
    body_rgb = transplant_weave(body_rgb, rgb, known, hole, sy_full)
    body_rgb = transplant_clay(body_rgb, rgb, known, hole, sy_full)
    alpha = np.where(known > 0, np.where(cv2.erode(known, np.ones((5, 5), np.uint8)) > 0, 255, img[..., 3]), 0).astype(np.uint8)
    alpha = np.where((sil > 0) & (known == 0), 255, alpha).astype(np.uint8)
    body = np.dstack([body_rgb, alpha])
    edge_new = cv2.bitwise_and(cv2.dilate(sil, np.ones((3, 3), np.uint8)), cv2.bitwise_not(cv2.erode(sil, np.ones((3, 3), np.uint8))))
    soft = cv2.GaussianBlur(sil, (3, 3), 0.9)
    body[..., 3] = np.where((edge_new > 0) & (known == 0), soft, body[..., 3]).astype(np.uint8)
    return crop(body, sil, pad=0)


SEAM_RUN = 24  # rows of unbroken weave that mark the seam (the logo strokes are ~12 rows)


def seam_curve(rgb: np.ndarray, inside: np.ndarray):
    """Head/belly seam y for every column: first tan (woven) row below the logo, fitted as a parabola over the central columns and
    continued with the end slopes (the tilted curious body bends the seam sharply at the edge)."""
    h, w = inside.shape
    f = cv2.GaussianBlur(rgb[..., 0].astype(np.float32) - rgb[..., 2].astype(np.float32), (0, 0), 3)  # tan weave: large R-B
    seam = np.full(w, np.nan)
    tan = ((f > 50) & inside).astype(np.float32)
    run = cv2.blur(tan, (1, SEAM_RUN), anchor=(0, 0), borderType=cv2.BORDER_CONSTANT)  # share of tan in the SEAM_RUN rows below
    for x in range(w):
        # the weave starts the seam and goes on down; the debossed logo grooves are also tan but only a few rows deep
        col = np.where((run[:, x] > 0.85) & inside[:, x])[0]
        col = col[col > h * 0.42]
        if len(col):
            seam[x] = col.min()
    xs = np.where(~np.isnan(seam))[0]
    lo, hi = xs.min() + int(len(xs) * .12), xs.max() - int(len(xs) * .12)
    sel = (xs >= lo) & (xs <= hi)
    coef = np.polyfit(xs[sel], seam[xs[sel]], 2)
    cols = np.arange(w)
    sy = np.polyval(coef, cols)
    for edge, left in ((lo, True), (hi, False)):
        m = (cols < edge) if left else (cols > edge)
        sy[m] = np.polyval(coef, edge) + np.polyval(np.polyder(coef), edge) * (cols[m] - edge)
    return sy, lo, hi


CORNER_INSET, CORNER_RISE = 16.0, 44  # head corner inset (art px) at the seam, ramping in over this many rows (< SEAM_EXT)
STAGE_CX = 240  # art px: the stage centre (480 px art canvas)
HEAD_LIFT = 5  # art px between the head's lower edge and the seam groove
SEAM_EXT = 46  # the belly top runs this far under the head: the firmware tilts the head ~15 deg, and +-16 shows no gap


def split_head_belly(body: np.ndarray, org: tuple[int, int]):
    """Cut a body shell at the seam above the woven belly. Returns (head, head_org, belly, belly_org, seam_centre_art_px)."""
    h, w = body.shape[:2]
    sy, _, _ = seam_curve(body[..., :3], body[..., 3] > 200)
    yy = np.arange(h)[:, None]
    above = (yy < sy[None, :] - 1).astype(np.uint8)  # head
    head = body.copy()
    # the head stops HEAD_LIFT px above the seam: the seam groove stays on the belly, so a tilting head shows ivory over ivory
    head[..., 3] = (body[..., 3].astype(np.float32) * np.clip((sy[None, :] - HEAD_LIFT - yy + 1.5) / 3.0, 0, 1)).astype(np.uint8)
    # Round the head's bottom corners inward (up to CORNER_INSET px at the seam): the belly's clay band carries the true outline
    # there, so a head tilt of +-8 deg never pokes a corner out of the body or leaves a step.
    sil = (body[..., 3] > 127).astype(np.uint8)
    dist = cv2.distanceTransform(sil, cv2.DIST_L2, 5)
    k = CORNER_INSET * np.clip((yy - (sy[None, :] - CORNER_RISE)) / CORNER_RISE, 0, 1)
    head[..., 3] = (head[..., 3].astype(np.float32) * np.clip((dist - k) / 1.5, 0, 1)).astype(np.uint8)
    _n, lab_, st_, _ = cv2.connectedComponentsWithStats((head[..., 3] > 40).astype(np.uint8))
    head[..., 3] = np.where(lab_ == 1 + int(np.argmax(st_[1:, cv2.CC_STAT_AREA])), head[..., 3], 0).astype(np.uint8)
    belly = body.copy()
    keep = (yy >= sy[None, :] - SEAM_EXT).astype(np.uint8)
    belly[..., 3] = np.where(keep > 0, body[..., 3], 0)
    # the band above the seam keeps the owner's ivory clay: under a tilted head it reads as the head's own lower edge
    hys, hxs = np.where(head[..., 3] > 0)
    bys, bxs = np.where(belly[..., 3] > 0)
    hy0, hy1, hx0, hx1 = hys.min(), hys.max() + 1, hxs.min(), hxs.max() + 1
    by0, by1, bx0, bx1 = bys.min(), bys.max() + 1, bxs.min(), bxs.max() + 1
    cx = (hxs.min() + hxs.max()) / 2
    centre = (org[0] + cx, org[1] + float(sy[int(round(cx))]))
    return (head[hy0:hy1, hx0:hx1], (org[0] + hx0, org[1] + hy0), belly[by0:by1, bx0:bx1], (org[0] + bx0, org[1] + by0), centre)


def make_logo(pose: str):
    """The debossed 'bob' as a soft glow mask: amber with alpha from how much darker the groove is than its surroundings.
    Cut from the original pixels' shading; the colour is the palette yellow."""
    img = load(pose)
    vis = visor_mask(img)
    vy, vx = np.where(vis > 0)
    cx, cy = int(vx.mean()), int(vy.mean())
    y0, y1, x0, x1 = cy + int((vy.max() - vy.min()) / 2) + 14, cy + 120, cx - 112, cx + 112
    gray = cv2.cvtColor(img[..., :3], cv2.COLOR_RGB2GRAY).astype(np.float32)
    local = gray - cv2.GaussianBlur(gray, (0, 0), 7)
    groove = np.clip((-local - 5.0) / 9.0, 0, 1)
    win = np.zeros_like(groove)
    win[y0:y1, x0:x1] = 1
    a = cv2.GaussianBlur(groove * win, (0, 0), 1.2)
    a = np.clip(a * 1.6, 0, 1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats((a > 0.15).astype(np.uint8))
    keep = np.zeros_like(a)
    for k in range(1, n):
        if stats[k, cv2.CC_STAT_AREA] >= 60:  # letters, not the fine clay texture
            keep[lab == k] = 1
    a = a * cv2.dilate(keep, np.ones((5, 5), np.uint8))
    rgba = np.zeros((480, 480, 4), np.uint8)
    rgba[..., :3] = (240, 199, 94)
    rgba[..., 3] = (a * 255).astype(np.uint8)
    spr, org = crop(rgba, (a > 0.04).astype(np.uint8) * 255, pad=3)
    return spr, org


def tilt_part(part: np.ndarray, origin, deg: float, pivot) -> tuple[np.ndarray, tuple[int, int]]:
    """A part moved to `origin` and turned `deg` about `pivot` (art px). 0 deg = the same pixels, only shifted."""
    if abs(deg) < 1e-6:
        return part, (int(origin[0]), int(origin[1]))
    c = canvas_with(part, origin).astype(np.float32)
    c[..., :3] *= c[..., 3:4] / 255  # premultiplied: no dark fringe at the turned edge
    fwd = similarity_matrix(deg, 1.0, pivot, pivot)
    w = cv2.warpAffine(c, fwd, (480, 480), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = w[..., 3:4]
    rgb = np.where(a > 0, w[..., :3] / np.maximum(a / 255, 1e-6), 0)
    out = np.concatenate([rgb, a], axis=2).clip(0, 255).astype(np.uint8)
    return crop(out, (out[..., 3] > 0).astype(np.uint8) * 255, pad=1)


def build_parts():
    """Returns (parts, meta). parts: name -> RGBA sprite; meta: name -> dict(origin in the source art, pivot, source pose)."""
    parts: dict[str, np.ndarray] = {}
    meta: dict[str, dict] = {}
    img = load(BODY_POSE)
    alpha = img[..., 3]
    btn, vis = yellow_mask(img), visor_mask(img)
    cy_b, cx_b = np.where(btn > 0)
    spr, org = crop(img, cv2.bitwise_and(btn, alpha))
    parts["button"], meta["button"] = spr, {"origin": org, "pivot_src": (int(cx_b.mean()), int(cy_b.max()) - 4), "pose": BODY_POSE}
    plate = img.copy()
    plate[..., :3] = cv2.inpaint(np.ascontiguousarray(plate[..., :3]), cv2.dilate(eye_mask(img), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))), 6, cv2.INPAINT_TELEA)
    spr, org = crop(plate, cv2.bitwise_and(vis, alpha))
    cy_v, cx_v = np.where(vis > 0)
    parts["visor"], meta["visor"] = spr, {"origin": org, "pivot_src": (int(cx_v.mean()), int(cy_v.mean())), "pose": BODY_POSE}
    # One canonical body (model sheet, docs/waveshare/bob-model-sheet.md): head shell + logo and belly are cut once from the
    # front pose and reused by every pose, so the logo, the weave, the seam and the outline are the same pixels everywhere.
    # A pose only moves the canonical body by whole pixels to the stage centre (no resampling) and tilts the head about
    # the seam by its HEAD_TILT.
    spr, org = make_body(BODY_POSE)
    spr = finish_edges(spr)  # Bob's real outline only: the head/belly cut inside the body is never edge-finished
    c_hd, c_ho, c_bl, c_bo, c_centre = split_head_belly(spr, org)
    c_lg, c_lo = make_logo(BODY_POSE)
    # The pebble feet: below the canonical belly's bottom edge they are the owner's pixels; the top the belly hides is filled
    # with foot clay (opaque), so a squash or a foot tap never opens a gap or shows a fade.
    belly_a = canvas_with(c_bl, c_bo)[..., 3]
    under = np.zeros((480, 480), bool)
    for x in range(480):
        ys_ = np.where(belly_a[:, x] > 200)[0]
        if len(ys_):
            under[: ys_.max() - 2, x] = True
    for n, (cx, cy, rx, ry) in FEET_ELL.items():
        ell = ell_mask(cx, cy, rx, ry)
        seen = cv2.bitwise_and(cv2.bitwise_and(ell, alpha), np.where(under, 0, 255).astype(np.uint8))
        hidden = cv2.bitwise_and(ell, np.where(under, 255, 0).astype(np.uint8))
        hidden[cy:] = 0
        foot = img.copy()
        foot[..., :3] = cv2.inpaint(np.ascontiguousarray(fill_bg_color(img, seen > 0)), hidden, 9, cv2.INPAINT_TELEA)
        foot[..., 3] = np.where(hidden > 0, 255, foot[..., 3])
        spr, org = crop(foot, cv2.bitwise_or(seen, hidden))
        parts[n], meta[n] = spr, {"origin": org, "pivot_src": (cx, cy - 8), "pose": BODY_POSE}
    for pose in POSES:
        # every pose puts the same body at the same spot, centred on the stage (Bob is centred by body on the glass)
        d = (int(round(STAGE_CX - c_centre[0])), 0)
        seam = (c_centre[0] + d[0], c_centre[1] + d[1])
        tilt = HEAD_TILT[pose]
        hd, ho = tilt_part(c_hd, (c_ho[0] + d[0], c_ho[1] + d[1]), tilt, seam)
        lg, lo_ = tilt_part(c_lg, (c_lo[0] + d[0], c_lo[1] + d[1]), tilt, seam)
        bo = (c_bo[0] + d[0], c_bo[1] + d[1])
        parts[f"logo_{pose}"], meta[f"logo_{pose}"] = lg, {"origin": lo_, "pivot_src": (lo_[0] + lg.shape[1] // 2, lo_[1] + lg.shape[0] // 2), "pose": BODY_POSE}
        parts[f"head_{pose}"], meta[f"head_{pose}"] = hd, {"origin": ho, "pivot_src": (int(round(seam[0])), int(round(seam[1]))), "pose": BODY_POSE}
        parts[f"belly_{pose}"], meta[f"belly_{pose}"] = c_bl, {"origin": bo, "pivot_src": (int(round(seam[0])), int(bo[1] + c_bl.shape[0] - 6)), "pose": BODY_POSE}
        meta[f"body_{pose}"] = {"shift": d, "seam": seam, "tilt": tilt}
    for name, (pose, outline, pivot) in ARMS.items():
        a_img = load(pose)
        if name in FRONT_ARMS:  # a front arm lies on the face: cut 2 px inside its shadow line, no face or dark crease
            m = cv2.bitwise_and(cv2.erode(poly_mask(outline), np.ones((5, 5), np.uint8)), a_img[..., 3])
        else:
            m = cv2.bitwise_and(cv2.dilate(poly_mask(outline), np.ones((7, 7), np.uint8)), a_img[..., 3])
        # only the arm itself: a cut can catch a sliver of its original's logo groove (the thoughtful hand carried the "b"
        # ascender, which read as a mirrored stroke next to the logo)
        main = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        main = cv2.dilate(largest_cc(main), np.ones((5, 5), np.uint8))
        m = cv2.bitwise_and(m, main)
        if name not in FRONT_ARMS:
            # The shoulder lobe reaches into the original's body to hide the joint; those pixels are body (clay, the weave band).
            # Refill them with the arm's own clay, so a move that brings the arm in front (clap) shows an arm, never a patch of body.
            body = cv2.dilate(hull_sil(known_body(a_img, pose)), np.ones((5, 5), np.uint8))  # its edge strip too
            joint = np.zeros_like(m)
            cv2.circle(joint, (int(pivot[0]), int(pivot[1])), SHOULDER_R, 255, -1, cv2.LINE_AA)
            # inside the body only a round joint stays (a ball at the shoulder, never a flat-cut flap)
            m = cv2.bitwise_or(cv2.bitwise_and(m, cv2.bitwise_not(body)), cv2.bitwise_and(m, joint))
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
            lobe = cv2.bitwise_and(m, body)
            if lobe.any():
                keep = cv2.bitwise_and(m, cv2.bitwise_not(lobe)) > 0
                rgb = cv2.inpaint(np.ascontiguousarray(fill_bg_color(a_img, keep)), lobe, 9, cv2.INPAINT_TELEA)
                a_img = a_img.copy()
                a_img[..., :3] = np.where((lobe > 0)[..., None], rgb, a_img[..., :3])
        spr, org = crop(a_img, cv2.GaussianBlur(m, (3, 3), 0.7), pad=1)
        if ARM_TILT.get(name):
            spr, org = tilt_part(spr, org, ARM_TILT[name], pivot)
        parts[name], meta[name] = spr, {"origin": org, "pivot_src": pivot, "pose": pose, "shoulder": shoulder_on_canon(pose, name, pivot, meta)}
    for name in parts:
        if not name.startswith(("logo_", "head_", "belly_")):  # glow masks are not outlines; the body was finished whole
            parts[name] = finish_edges(parts[name])
    return parts, meta


def _edges(sil: np.ndarray, y: int) -> tuple[int, int]:
    xs = np.where(sil[y] > 0)[0]
    return int(xs.min()), int(xs.max())


def shoulder_on_canon(pose: str, name: str, pivot, meta) -> tuple[float, float]:
    """Where an arm's shoulder goes on the canonical body: the same inset from the body edge it had on its own original."""
    own = hull_sil(known_body(load(pose), pose))
    canon = hull_sil(known_body(load(BODY_POSE), BODY_POSE))
    d = meta[f"body_{pose}"]["shift"]
    canon = np.roll(np.roll(canon, d[1], axis=0), d[0], axis=1)
    px, py = pivot
    (ol, orr), (cl, cr) = _edges(own, py), _edges(canon, py)
    x = cl + (px - ol) if name.startswith("armL") else cr - (orr - px)
    return (float(x), float(py))


# ----------------------------------------------------------------------------- placement + recomposite
SHARED = ("footL", "footR", "visor", "button")
FRONT_ARMS = ("armL_ear", "armL_chin")  # drawn over the body; every other arm sits behind it


def similarity_matrix(rot, scale, pivot_src, pivot_dst) -> np.ndarray:
    """Forward 2x3 map: rotate/scale about pivot_src, land the pivot at pivot_dst."""
    c, s = np.cos(np.radians(rot)) * scale, np.sin(np.radians(rot)) * scale
    r = np.array([[c, -s], [s, c]], np.float32)
    t = np.array(pivot_dst, np.float32) - r @ np.array(pivot_src, np.float32)
    return np.concatenate([r, t[:, None]], axis=1)


def canvas_with(part: np.ndarray, origin, fwd=None) -> np.ndarray:
    c = np.zeros((480, 480, 4), np.uint8)
    h, w = part.shape[:2]
    x0, y0 = origin
    c[y0:y0 + h, x0:x0 + w] = part
    if fwd is not None:
        c = cv2.warpAffine(c, fwd.astype(np.float32), (480, 480), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    return c


def alpha_over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    sa = src[..., 3:4].astype(np.float32) / 255
    da = dst[..., 3:4].astype(np.float32) / 255
    oa = sa + da * (1 - sa)
    rgb = (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
    return np.concatenate([rgb, oa * 255], axis=2).clip(0, 255).astype(np.uint8)


def foot_lobes(img: np.ndarray):
    """(left x-range, right x-range, belly-bottom y) read off a pose's bottom rows: two feet with the belly bottom between them."""
    a = img[..., 3] > 128
    ymax = int(np.where(a.any(axis=1))[0].max())
    xs = np.where(a[ymax - 5])[0]
    br = np.where(np.diff(xs) > 6)[0]
    if not len(br):
        return None
    l = (xs[0], xs[br[0]])
    r = (xs[br[0] + 1], xs[-1])
    gx = (l[1] + r[0]) // 2
    yb = int(np.where(a[:, gx])[0].max())
    return l, r, yb


_REF_LOBES: list = []


def _ref_lobes():
    """Foot lobes of the pose the shared parts were cut from, measured once."""
    if not _REF_LOBES:
        _REF_LOBES.append(foot_lobes(load(BODY_POSE)))
    return _REF_LOBES[0]


def foot_regions(img: np.ndarray, name: str, sprite_canvas: np.ndarray):
    """Registration masks for a foot: the part of each foot below the belly bottom, in the pose and in the playful sprite."""
    pa = img[..., 3]
    lobes = foot_lobes(img)
    ref = _ref_lobes()
    region = np.zeros_like(pa)
    ca = sprite_canvas.copy()
    if lobes is None or ref is None:
        cx, cy, rx, ry = FEET_ELL[name]
        region = cv2.bitwise_and(ell_mask(cx, cy, rx + 14, ry + 8), pa)
        region[: cy - ry + 14] = 0
        return region, ca
    yb = lobes[2]
    x0, x1 = (lobes[0] if name == "footL" else lobes[1])
    region[yb - 3:, max(x0 - 4, 0):x1 + 5] = pa[yb - 3:, max(x0 - 4, 0):x1 + 5]
    ca[: ref[2] - 3] = 0
    return region, ca


def place_shared(parts, meta, pose):
    """Where the shared parts (feet, visor, button, all cut from the playful art) sit in `pose`, as similarities."""
    img = load(pose)
    pa = img[..., 3]
    out = {}
    body = meta.get(f"body_{pose}")
    if body is not None:  # canonical body: the shared parts ride it unscaled; visor and button turn with the head
        d, seam, tilt = body["shift"], body["seam"], body["tilt"]
        for name in SHARED:
            px, py = meta[name]["pivot_src"]
            at = np.array([px + d[0], py + d[1]], np.float64)
            rot = 0.0
            if name in ("visor", "button"):
                rot = tilt
                at = similarity_matrix(tilt, 1.0, seam, seam).astype(np.float64) @ np.array([at[0], at[1], 1.0])
            out[name] = {"rot": rot, "scale": 1.0, "pivot_at": [round(float(at[0]), 1), round(float(at[1]), 1)]}
        return out
    for name in SHARED:
        if pose == BODY_POSE:  # the parts were cut from this pose: identity
            px, py = meta[name]["pivot_src"]
            out[name] = {"rot": 0.0, "scale": 1.0, "pivot_at": [float(px), float(py)]}
            continue
        c = canvas_with(parts[name], meta[name]["origin"])
        ca = c[..., 3]
        if name == "visor":
            region = visor_mask(img)
        elif name == "button":
            region = yellow_mask(img)
        else:
            region, ca = foot_regions(img, name, ca)
        ys, xs = np.where(ca > 128)
        pys, pxs = np.where(region > 128)
        s = float(np.clip(np.sqrt(max(np.ptp(pys), 1) * max(np.ptp(pxs), 1) / (max(np.ptp(ys), 1) * max(np.ptp(xs), 1))), 0.85, 1.2))
        init = np.array([[s, 0, pxs.mean() - s * xs.mean()], [0, s, pys.mean() - s * ys.mean()]], np.float32)
        dst = cv2.GaussianBlur(region.astype(np.float32), (0, 0), 2.5)
        src = cv2.GaussianBlur(ca.astype(np.float32), (0, 0), 2.5)
        try:
            _, w = cv2.findTransformECC(dst, src, cv2.invertAffineTransform(init), cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
            fwd = cv2.invertAffineTransform(w)
        except cv2.error:
            fwd = init
        rot = float(np.degrees(np.arctan2(fwd[1, 0], fwd[0, 0])))
        scale = float(np.sqrt(abs(np.linalg.det(fwd[:, :2]))))
        px, py = meta[name]["pivot_src"]
        land = fwd @ np.array([px, py, 1], np.float32)
        out[name] = {"rot": round(rot, 2), "scale": round(scale, 4), "pivot_at": [round(float(land[0]), 1), round(float(land[1]), 1)]}
    return out


def recomposite(parts, meta, pose, placed):
    """Rebuild one original pose from the rig parts (+ the painted eyes, which are procedural on device)."""
    img = load(pose)
    layers = {}
    for name in SHARED:
        pl = placed[name]
        px, py = meta[name]["pivot_src"]
        fwd = similarity_matrix(pl["rot"], pl["scale"], (px, py), pl["pivot_at"])
        layers[name] = canvas_with(parts[name], meta[name]["origin"], fwd)
    layers["belly"] = canvas_with(parts[f"belly_{pose}"], meta[f"belly_{pose}"]["origin"])
    layers["head"] = canvas_with(parts[f"head_{pose}"], meta[f"head_{pose}"]["origin"])
    for n, (p, _, pv) in ARMS.items():
        if p == pose:
            sx, sy = meta[n]["shoulder"]
            layers[n] = canvas_with(parts[n], meta[n]["origin"], similarity_matrix(0, 1.0, pv, (sx, sy)))
    layers["eyes"] = static_eyes(placed["visor"]["pivot_at"], placed["visor"]["rot"])
    arms_back = [k for k in layers if k.startswith("arm") and k not in FRONT_ARMS]
    arms_front = [k for k in layers if k in FRONT_ARMS]
    order = ["footL", "footR"] + arms_back + ["belly", "head", "visor", "eyes", "button"] + arms_front
    out = np.zeros((480, 480, 4), np.uint8)
    for k in order:
        out = alpha_over(out, layers[k])
    return out


EYES_POSE = "helper"  # the owner's round amber eyes; on device the eyes are procedural, this is the static rest face


def static_eyes(visor_at, rot) -> np.ndarray:
    """The helper original's painted eyes, centred on a pose's visor and turned with it (every static pose has the same face)."""
    img = load(EYES_POSE)
    eyes = img.copy()
    eyes[..., 3] = cv2.bitwise_and(eye_mask(img), img[..., 3])
    vy, vx = np.where(visor_mask(img) > 0)
    fwd = similarity_matrix(rot, 1.0, (float(vx.mean()), float(vy.mean())), visor_at)
    pre = eyes.astype(np.float32)
    pre[..., :3] *= pre[..., 3:4] / 255
    w = cv2.warpAffine(pre, fwd, (480, 480), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = w[..., 3:4]
    return np.concatenate([np.where(a > 0, w[..., :3] / np.maximum(a / 255, 1e-6), 0), a], axis=2).clip(0, 255).astype(np.uint8)


def fidelity(parts, meta, outdir):
    report = {}
    for pose in POSES:
        img = load(pose)
        placed = place_shared(parts, meta, pose)
        out = recomposite(parts, meta, pose, placed)
        dx, dy = meta[f"body_{pose}"]["shift"]  # compared where the original stands: the body is only moved by whole pixels
        out = cv2.warpAffine(out, np.float32([[1, 0, -dx], [0, 1, -dy]]), (480, 480), flags=cv2.INTER_NEAREST, borderValue=(0, 0, 0, 0))
        a, b = over_navy(img), over_navy(out)
        s, p = ssim(a, b), psnr(a, b)
        report[pose] = {"ssim": round(s, 4), "psnr_db": round(p, 2), "placed": placed}
        if outdir is not None:
            diff = (255 - np.minimum(np.abs(a.astype(int) - b.astype(int)) * 3, 255)).astype(np.uint8)
            Image.fromarray(np.concatenate([a, b, diff], axis=1)).save(outdir / f"rig-compare-{pose}.png", optimize=True)
    return report


# ----------------------------------------------------------------------------- outputs
def to_rgb565a8(rgba: np.ndarray) -> bytes:
    r, g, b = [rgba[..., k].astype(np.uint16) for k in range(3)]
    px = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    return px.astype("<u2").tobytes() + rgba[..., 3].tobytes()


def device_part(rgba: np.ndarray) -> np.ndarray:
    h, w = rgba.shape[:2]
    nw, nh = max(1, round(w * DEV_SCALE)), max(1, round(h * DEV_SCALE))
    pre = rgba.astype(np.float32)
    pre[..., :3] *= pre[..., 3:4] / 255
    small = cv2.resize(pre, (nw, nh), interpolation=cv2.INTER_AREA)
    a = small[..., 3:4]
    rgb = np.where(a > 0, small[..., :3] / np.maximum(a / 255, 1e-6), 0)
    return np.concatenate([rgb, a], axis=2).clip(0, 255).astype(np.uint8)


def write_outputs(root: Path, parts, meta, report, device_blobs: bool = False):
    master = root / "apps/cardputer/assets/bob/rig"
    blobs = root / "apps/cardputer/lib/bob_art/rig"
    master.mkdir(parents=True, exist_ok=True)
    if device_blobs:
        blobs.mkdir(parents=True, exist_ok=True)
    sc = DEV_SCALE
    order = ["footL", "footR"] + [n for n in ARMS if n not in FRONT_ARMS] + [f"belly_{p}" for p in POSES] + [f"head_{p}" for p in POSES] + [f"logo_{p}" for p in POSES] + ["visor", "button"] + list(FRONT_ARMS)
    rig = {"scale": sc, "stage": [round(480 * sc), round(480 * sc)],
           "source": "owner art slimmer-bob-{helper,curious,thoughtful,playful}-v1 (heybob-landing-page@2318b01), cut not redrawn",
           "note": "device px; stage origin = art origin; draw order is `z` (front arms last); one head and one belly per pose carry the lean; the belly top runs 22 art px under the head",
           "parts": {}, "poses": {}}
    for z, name in enumerate(order):
        part = parts[name]
        Image.fromarray(part).save(master / f"{name}.png", optimize=True)
        dev = device_part(part)
        if device_blobs:
            (blobs / f"{name}.rgb565a8").write_bytes(to_rgb565a8(dev))
        ox, oy = meta[name]["origin"]
        px, py = meta[name]["pivot_src"]
        rig["parts"][name] = {"file": f"{name}.rgb565a8", "w": dev.shape[1], "h": dev.shape[0], "z": z,
                              "pivot": [round((px - ox) * sc, 1), round((py - oy) * sc, 1)],
                              "front": name in FRONT_ARMS, "from_pose": meta[name]["pose"]}
    for pose in POSES:
        hd, bl = meta[f"head_{pose}"], meta[f"belly_{pose}"]
        entry = {"head": {"part": f"head_{pose}", "at": [round(hd["origin"][0] * sc, 1), round(hd["origin"][1] * sc, 1)], "seam_pivot": [round(hd["pivot_src"][0] * sc, 1), round(hd["pivot_src"][1] * sc, 1)]},
                 "belly": {"part": f"belly_{pose}", "at": [round(bl["origin"][0] * sc, 1), round(bl["origin"][1] * sc, 1)]},
                 "logo": {"part": f"logo_{pose}", "at": [round(meta[f"logo_{pose}"]["origin"][0] * sc, 1), round(meta[f"logo_{pose}"]["origin"][1] * sc, 1)]},
                 "ssim": report[pose]["ssim"], "psnr_db": report[pose]["psnr_db"], "shared": {}, "arms": {}}
        for n, v in report[pose]["placed"].items():
            entry["shared"][n] = {"rot": v["rot"], "scale": v["scale"], "pivot_at": [round(v["pivot_at"][0] * sc, 1), round(v["pivot_at"][1] * sc, 1)]}
        for n, (p, _, _) in ARMS.items():
            if p == pose:
                sh = meta[n]["shoulder"]
                entry["arms"][n] = {"shoulder": [round(sh[0] * sc, 1), round(sh[1] * sc, 1)]}
        rig["poses"][pose] = entry
    (master / "rig.json").write_text(json.dumps(rig, indent=1) + "\n", newline="\n")
    # The static poses and the model sheet's reference (bob_model_check.py): the canonical rig at rest, the rig's own pixels.
    static = root / "apps/cardputer/assets/bob/static"
    static.mkdir(parents=True, exist_ok=True)
    static_at, origins = {}, {}
    for pose in POSES:
        out = recomposite(parts, meta, pose, report[pose]["placed"])
        spr, org = crop(out, (out[..., 3] > 0).astype(np.uint8) * 255, pad=4)
        Image.fromarray(spr).save(static / f"{pose}.png", optimize=True)
        static_at[pose] = {"at": [round(org[0] * sc, 1), round(org[1] * sc, 1)], "w": round(spr.shape[1] * sc, 1), "h": round(spr.shape[0] * sc, 1)}
        origins[pose] = [int(org[0]), int(org[1])]
        if pose == BODY_POSE:
            lo, lg = meta[f"logo_{pose}"]["origin"], parts[f"logo_{pose}"]
            model = {"front": f"{pose}.png", "logo_box": [int(lo[0] - org[0]), int(lo[1] - org[1]), int(lg.shape[1]), int(lg.shape[0])],
                     "head_tilt": HEAD_TILT}
    model["origin"] = origins  # art px of each static PNG on the 480 px original canvas (the device fits that canvas)
    (static / "model.json").write_text(json.dumps(model, indent=1) + "\n", newline="\n")
    sync_demo(root, master, static, rig, static_at)
    return master, blobs


DEMO = "docs/waveshare/device-ux-prototype.html"


def visor_clip(path: Path, sc: float) -> str:
    """The visor glass outline from the art (its dark area), as an SVG path in device px: the demo clips the eyes to it, the
    way the device clips them to the art's own visor mask (bob_visor.h), so an eye never shows past the glass."""
    v = np.array(Image.open(path).convert("RGBA")).astype(int)
    dark = (((v[..., :3].sum(2) / 3) < 60) & (v[..., 3] > 200)).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    cnts, _ = cv2.findContours(largest_cc(dark * 255), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    pts = cv2.approxPolyDP(max(cnts, key=cv2.contourArea), 1.0, True).reshape(-1, 2)
    return "M" + "L".join(f"{x * sc:.1f} {y * sc:.1f}" for x, y in pts) + "Z"


def sync_demo(root: Path, master: Path, static: Path, rig: dict, static_at: dict) -> None:
    """The demo page draws the same rig: copy the masters and static poses next to it and rewrite its inline rig table, so it
    can never drift from the device (the drift is what left stale heads and bellies in the demo)."""
    page = root / DEMO
    src_page = ROOT / DEMO
    if not src_page.exists():
        return
    rdir, sdir = root / "docs/waveshare/assets/rig", root / "docs/waveshare/assets/static"
    rdir.mkdir(parents=True, exist_ok=True)
    sdir.mkdir(parents=True, exist_ok=True)
    for name in rig["parts"]:
        if not name.startswith("logo_"):
            shutil.copyfile(master / f"{name}.png", rdir / f"{name}.png")
    for pose in POSES:
        shutil.copyfile(static / f"{pose}.png", sdir / f"{pose}.png")
    table = {"parts": {n: {"w": p["w"], "h": p["h"], "pv": p["pivot"], "front": p["front"]} for n, p in rig["parts"].items() if not n.startswith("logo_")},
             "poses": {pose: {"head": e["head"], "belly": e["belly"], "shared": e["shared"], "arms": {n: a["shoulder"] for n, a in e["arms"].items()}}
                       for pose, e in rig["poses"].items()},
             "static": static_at, "visorClip": visor_clip(master / "visor.png", rig["scale"])}
    html = src_page.read_text(encoding="utf-8")
    a, b = html.index("/*RIG*/") + len("/*RIG*/"), html.index("/*END*/")
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(html[:a] + json.dumps(table, separators=(",", ":")) + html[b:], encoding="utf-8", newline="\n")


def compare_dirs(a: Path, b: Path, label: str) -> list[str]:
    bad = []
    for f in sorted(a.rglob("*")):
        if f.is_dir():
            continue
        g = b / f.relative_to(a)
        if not g.exists():
            bad.append(f"missing {label}/{f.relative_to(a)}")
            continue
        if f.suffix == ".png":
            x, y = np.array(Image.open(f).convert("RGBA")).astype(int), np.array(Image.open(g).convert("RGBA")).astype(int)
            if x.shape != y.shape or np.abs(x - y).mean() > 0.5:
                bad.append(f"drift {label}/{f.relative_to(a)}")
        elif f.suffix == ".json":
            if not _json_close(json.loads(f.read_text()), json.loads(g.read_text())):
                bad.append(f"drift {label}/{f.relative_to(a)}")
        else:
            x, y = np.frombuffer(f.read_bytes(), np.uint8), np.frombuffer(g.read_bytes(), np.uint8)
            if x.shape != y.shape or np.abs(x.astype(int) - y.astype(int)).mean() > 0.5:
                bad.append(f"drift {label}/{f.relative_to(a)}")
    return bad


def _json_close(a, b, tol=0.02):
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_json_close(a[k], b[k], tol) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_json_close(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tol * max(1.0, abs(a))
    return a == b


def build(root: Path, previews: bool, device_blobs: bool = False):
    parts, meta = build_parts()
    shots = root / "docs/waveshare/screenshots"
    shots.mkdir(parents=True, exist_ok=True)
    report = fidelity(parts, meta, shots if previews else None)
    write_outputs(root, parts, meta, report, device_blobs)
    if previews:
        sys.path.insert(0, str(Path(__file__).parent))
        import bob_rig_moves  # noqa: PLC0415

        bob_rig_moves.render_all(parts, meta, report, shots)
    return report


def main(argv: list[str]) -> int:
    check = "--check" in argv
    previews = "--no-previews" not in argv
    if check:
        tmp = Path(tempfile.mkdtemp(prefix="bob-rig-"))
        try:
            blobs = "--device-blobs" in argv
            report = build(tmp, previews=False, device_blobs=blobs)
            bad = []
            bad += compare_dirs(tmp / "apps/cardputer/assets/bob/rig", ROOT / "apps/cardputer/assets/bob/rig", "assets")
            if blobs:  # the blobs are generated on the firmware branch (BOB-RIG-FW); check them only there
                bad += compare_dirs(tmp / "apps/cardputer/lib/bob_art/rig", ROOT / "apps/cardputer/lib/bob_art/rig", "blobs")
            for sub in ("apps/cardputer/assets/bob/static", "docs/waveshare/assets/rig", "docs/waveshare/assets/static"):
                bad += compare_dirs(tmp / sub, ROOT / sub, sub)
            if (tmp / DEMO).exists() and (tmp / DEMO).read_text(encoding="utf-8") != (ROOT / DEMO).read_text(encoding="utf-8"):
                bad.append(f"drift {DEMO} (inline rig table)")
            # Fidelity: the canonical pose must still be the owner's front original; the other poses are the same body with their
            # own arms, judged by the model sheet (bob_model_check.py) instead of by likeness to their differing originals.
            low = [f"{p} ssim {v['ssim']} < {SSIM_TARGET}" for p, v in report.items() if p == BODY_POSE and v["ssim"] < SSIM_TARGET]
            sys.path.insert(0, str(Path(__file__).parent))
            import bob_model_check  # noqa: PLC0415

            for pose in POSES:
                r = bob_model_check.check(tmp / "apps/cardputer/assets/bob/static" / f"{pose}.png", rest=True)
                low += [f"{pose} model {cid}: {c['detail']}" for cid, c in r["checks"].items() if not c["pass"]]
            for p, v in report.items():
                print(f"{p:11s} SSIM {v['ssim']:.4f}  PSNR {v['psnr_db']:.2f} dB")
            for line in bad + low:
                print("FAIL", line)
            return 1 if bad or low else 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    report = build(ROOT, previews, device_blobs="--device-blobs" in argv)
    for p, v in report.items():
        print(f"{p:11s} SSIM {v['ssim']:.4f}  PSNR {v['psnr_db']:.2f} dB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

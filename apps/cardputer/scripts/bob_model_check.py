#!/usr/bin/env python3
"""Check one rendered Bob image against the model sheet (docs/waveshare/bob-model-sheet.md).

The reference is the canonical Bob at rest, apps/cardputer/assets/bob/static/playful.png (written by bob_rig_build.py from
the owner's front original). Every check compares the image with that reference measured the same way at the image's own
scale (found from the visor), so a demo screenshot, a bob-sim frame, a static pose and a rig part sheet are all judged alike.

  py -3.11 apps/cardputer/scripts/bob_model_check.py IMAGE [IMAGE ...] [--json] [--rest]
  py -3.11 apps/cardputer/scripts/bob_model_check.py --sheet docs/waveshare/bob-model-sheet.png   the model sheet itself

--rest also enforces the rest-pose invariants (button area and seam position), which moves legitimately bend (a button
spin, a squash). Exit 1 when any invariant fails. Needs Pillow, numpy, opencv-python-headless.

Invariants (ids match the model sheet):
  M1 logo   the debossed "bob" reads left to right at any rotation (a mirrored "dod" scores lower)
  M2 button one yellow button, its colour, its size (rest) and on top of the head
  M3 visor  one dark rounded visor with the reference aspect; the eyes stay inside it
  M4 seam   the head/belly seam at the reference fraction of the body height (rest)
  M5 weave  the belly weave has the reference texture energy (no smooth, smeared or resampled patches)
  M6 sharp  the clay grain is as sharp as the reference at the same scale (no blurry resampling)
  M7 boxes  no flat placeholder rectangle anywhere in Bob's box (a missing part never shows)
  M8 gaps   no ground colour inside Bob's body (no visible seam or crack between parts)
  M9 edges  every outline is smooth and antialiased: a 1-2 px alpha ramp (images with alpha), no fringe lighter than the
            clay against the ground, and an edge-roughness score (art with alpha: <= ROUGH_ART; renders: <= 1.25x the reference)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
STATIC = ROOT / "apps/cardputer/assets/bob/static"
INK = np.array((23, 62, 87), np.float32)
ROUGH_ART = 0.14  # M9 roughness for art with alpha (art px): curated 0.12, the owner's original 0.13, the hard hull cut 0.15
FRINGE_MAX = 0.05  # M9 share of outline pixels lighter than the clay inside them (the originals' light halo: 10%)


def load_rgb(path: Path) -> np.ndarray:
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    al = a[..., 3:4] / 255
    return (a[..., :3] * al + INK * (1 - al)).clip(0, 255).astype(np.uint8)


def yellow(rgb: np.ndarray) -> np.ndarray:
    r, g, b = [rgb[..., k].astype(int) for k in range(3)]
    return ((r > 190) & (g > 130) & (b < 120) & (r - b > 100)).astype(np.uint8)


def visor(rgb: np.ndarray):
    """(mask, stats) of the visor: a near-black rounded bar ringed by light clay (not the bezel, not the ground), filled as its
    convex hull. Small renders split it around the eyes, so a few closing sizes are tried and the biggest good bar wins."""
    lum = rgb.astype(int).sum(2) / 3
    ink_d = np.abs(rgb.astype(np.float32) - INK).sum(2)
    dark = ((lum < 60) & (ink_d > 40)).astype(np.uint8)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    best = None
    for r in (3, 5, 9, 15, 25):
        closed = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r)))
        n, lab, st, _ = cv2.connectedComponentsWithStats(closed)
        for k in range(1, n):
            if st[k, cv2.CC_STAT_AREA] < 40:
                continue
            ys, xs = np.where(lab == k)
            hull = cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32))
            m = np.zeros_like(dark)
            cv2.fillConvexPoly(m, hull, 1)
            (_, _), (w_, h_), _ = cv2.minAreaRect(hull)
            asp = max(w_, h_) / max(1.0, min(w_, h_))
            rr = max(3, int(min(w_, h_) * 0.4)) | 1
            ring = (cv2.dilate(m, np.ones((rr, rr), np.uint8)) > 0) & (m == 0)
            if not (1.7 <= asp <= 3.6) or not ring.sum() or (gray[ring] > 140).mean() < 0.6:
                continue
            if (dark[m > 0] > 0).mean() < 0.55:  # mostly dark inside (eyes allowed)
                continue
            if best is None or m.sum() > best[0].sum():
                best = (m, st[k].copy())
    if best is None:
        return None, None
    m, stats = best
    stats[cv2.CC_STAT_AREA] = int(m.sum())
    return m, stats


def largest(m: np.ndarray) -> np.ndarray:
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2:
        return m
    return (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)


def texture(gray: np.ndarray, s: float) -> np.ndarray:
    """Local high-frequency energy: the weave bumps score 16-33, smooth clay and shadows stay under 10 at any scale."""
    g = gray.astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), max(1.0, 4 * s))
    return np.sqrt(cv2.GaussianBlur(hp * hp, (0, 0), max(1.5, 6 * s)))


def weave(rgb: np.ndarray, s: float, colour_only: bool = False) -> np.ndarray:
    """The woven belly: warm tan (large R-B) AND bumpy, as one blob (the logo grooves and warm arm shadows are excluded)."""
    f = cv2.GaussianBlur(rgb[..., 0].astype(np.float32) - rgb[..., 2].astype(np.float32), (0, 0), max(1.0, 3 * s))
    m = ((f > 58) & (np.abs(rgb.astype(np.float32) - INK).sum(2) > 60)).astype(np.uint8)  # weave 66-85, warm clay shadows <= 52
    if colour_only:
        return m
    m &= (texture(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), s) > 10).astype(np.uint8)
    k = max(3, int(15 * s)) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    k = max(3, int(17 * s)) | 1  # breaks the thin bridges into warm, grainy arm undersides
    return largest(cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))))


def body(rgb: np.ndarray) -> np.ndarray:
    """Everything that is not the ground (Bob plus whatever else is on screen; callers crop to Bob's box)."""
    return (np.abs(rgb.astype(np.float32) - INK).sum(2) > 45).astype(np.uint8)


def highpass(gray: np.ndarray, s: float) -> np.ndarray:
    g = gray.astype(np.float32)
    return g - cv2.GaussianBlur(g, (0, 0), max(1.2, 6 * s))


class Ref:
    """The canonical Bob, measured once; `at(s)` gives the same numbers at scale s (image px per art px)."""

    def __init__(self):
        meta = json.loads((STATIC / "model.json").read_text())
        self.art = load_rgb(STATIC / meta["front"])
        x, y, w, h = meta["logo_box"]
        self.logo_box = (x, y, w, h)
        m, st = visor(self.art)
        self.visor_area = float(st[cv2.CC_STAT_AREA])
        self._cache: dict[float, dict] = {}

    def at(self, s: float) -> dict:
        key = round(s, 3)
        if key not in self._cache:
            h, w = self.art.shape[:2]
            img = cv2.resize(self.art, (max(8, round(w * s)), max(8, round(h * s))), interpolation=cv2.INTER_AREA) if abs(s - 1) > 1e-3 else self.art
            x, y, lw, lh = self.logo_box
            tpl = highpass(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), s)[round(y * s):round((y + lh) * s), round(x * s):round((x + lw) * s)]
            self._cache[key] = {"img": img, "tpl": tpl, **measure(img, s, None),
                                "edges": edges(None, img, s, (0, 0, img.shape[1], img.shape[0]))}
        return self._cache[key]


def measure(rgb: np.ndarray, s: float, box) -> dict:
    """Numbers the invariants compare; box = Bob's (x0, y0, x1, y1) in rgb or None for all of it."""
    if box is not None:
        x0, y0, x1, y1 = box
        rgb = rgb[y0:y1, x0:x1]
    out: dict = {}
    vm, vst = visor(rgb)
    wm = weave(rgb, s)
    out["weave_area"] = float(wm.sum())
    if wm.sum():
        ys, xs = np.where(wm > 0)
        out["belly_c"] = [float(xs.mean()), float(ys.mean())]
    ym = yellow(rgb)
    if vm is not None:
        ym[cv2.dilate(vm, np.ones((max(3, int(12 * s)) | 1,) * 2, np.uint8)) > 0] = 0
    ym = cv2.morphologyEx(ym, cv2.MORPH_CLOSE, np.ones((max(3, int(8 * s)) | 1,) * 2, np.uint8))  # one button even when a chip crosses it
    n, lab, st, cen = cv2.connectedComponentsWithStats(ym)
    # the button sits on Bob; yellow props ("?", notes, sparkles) float on the ground around him and are not buttons
    blob = cv2.dilate(largest((body(rgb) & (ym == 0)).astype(np.uint8)), np.ones((5, 5), np.uint8)) > 0
    big = [k for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= max(6, 40 * s * s) and blob[lab == k].any()]
    if vm is not None and "belly_c" in out:  # only yellow on top of the head is a button (a "!" can touch a raised arm)
        vc = np.array(np.where(vm > 0)[::-1]).mean(1)
        up = vc - np.array(out["belly_c"])
        up /= max(1e-6, float(np.linalg.norm(up)))
        big = [k for k in big if float((cen[k] - vc) @ up) > 40 * s and abs(float((cen[k] - vc) @ np.array([up[1], -up[0]]))) < 110 * s]
    # pieces of one button (a status chip can cross it at a hop's apex) count once; the button is a wide disc, a heart is not
    groups: list[list[int]] = []
    for k in big:
        for gr in groups:
            if any(np.hypot(*(cen[k] - cen[j])) < 70 * s for j in gr):
                gr.append(k)
                break
        else:
            groups.append([k])

    def wide(gr):  # a disc seen edge-on, at any rotation (its rotated box is long and thin; a heart is not)
        ys_, xs_ = np.where(np.isin(lab, gr))
        if len(xs_) < 5:
            return False
        (_, _), (a_, b_), _ = cv2.minAreaRect(np.stack([xs_, ys_], 1).astype(np.float32))
        return max(a_, b_) >= 1.6 * max(1.0, min(a_, b_))

    groups = [gr for gr in groups if wide(gr)]
    big = [max(gr, key=lambda k: st[k, cv2.CC_STAT_AREA]) for gr in groups]
    out["button_n"] = len(big)
    if big:
        k = max(big, key=lambda k: st[k, cv2.CC_STAT_AREA])
        out["button_area"] = float(st[k, cv2.CC_STAT_AREA])
        out["button_rgb"] = rgb[lab == k].mean(0).tolist()
        out["button_c"] = cen[k].tolist()
    if vm is not None:
        out["visor_area"] = float(vst[cv2.CC_STAT_AREA])
        cnts, _ = cv2.findContours(vm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        rect = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
        (vcx, vcy), (a, b), _ = rect
        out["visor_aspect"] = float(max(a, b) / max(1.0, min(a, b)))
        out["visor_c"] = [float(vcx), float(vcy)]
        r, g, b_ = [rgb[..., k].astype(int) for k in range(3)]
        amber = (r > 170) & (g > 175) & (b_ < 140) & (r - b_ > 60)  # eye amber (g ~199), not the coral blush over clay (g <= 170)
        near = cv2.dilate(vm, np.ones((max(3, int(30 * s)) | 1,) * 2, np.uint8)) > 0
        # inside = the visor's bar (its fitted rectangle): an eye clipped at the rim eats into the dark area but stays in the bar
        bar = np.zeros_like(vm)
        cv2.fillConvexPoly(bar, cv2.boxPoints(rect).astype(np.int32), 1)
        inside = cv2.dilate(bar, np.ones((3, 3), np.uint8)) > 0
        out["eyes_outside"] = int((amber & near & ~inside & (cv2.dilate(ym, np.ones((5, 5), np.uint8)) == 0)).sum())
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hp = highpass(gray, s)
    core = cv2.erode(wm, np.ones((max(3, int(14 * s)) | 1,) * 2, np.uint8)) > 0
    out["weave_energy"] = float(hp[core].std()) if core.sum() > 20 else 0.0
    if wm.sum() > 20:
        ys, xs = np.where(wm > 0)
        hull = np.zeros_like(wm)
        cv2.fillConvexPoly(hull, cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32)), 1)
        inner = (cv2.erode(hull, np.ones((max(3, int(14 * s)) | 1,) * 2, np.uint8)) > 0) & (weave(rgb, s, colour_only=True) > 0)
        out["weave_smooth"] = float((texture(gray, s)[inner] < 8).mean()) if inner.sum() else 0.0
    bm = body(rgb)
    ivory = (bm > 0) & (wm == 0) & (gray > 170) & (ym == 0)
    ivory = cv2.erode(ivory.astype(np.uint8), np.ones((max(3, int(10 * s)) | 1,) * 2, np.uint8)) > 0
    lap = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F)
    out["clay_sharp"] = float(lap[ivory].var()) if ivory.sum() > 50 else 0.0
    # seam: per column in the middle third of the body, the first weave row; as a fraction of head top..belly bottom
    if wm.sum() > 50 and vm is not None:
        cols = np.where(wm.any(0))[0]
        mid = cols[len(cols) // 3: 2 * len(cols) // 3]
        tops = [np.where(wm[:, c])[0].min() for c in mid]
        bots = [np.where(wm[:, c])[0].max() for c in mid]
        seam, bot = float(np.median(tops)), float(np.median(bots))
        head_top = float(np.where((bm[:, mid] > 0) & (ym[:, mid] == 0))[0].min()) if mid.size else 0.0
        out["seam_frac"] = (seam - head_top) / max(1.0, bot - head_top)
    return out


def bob_box(rgb: np.ndarray, s: float, vc) -> tuple[int, int, int, int]:
    """Bob's box around the visor centre (canonical extents at scale s, with room for the arms)."""
    h, w = rgb.shape[:2]
    cx, cy = vc
    r = 340 * s  # the visor is ~110 art px below the top of a 460 px Bob; any rotation stays inside this square
    return (max(0, int(cx - r)), max(0, int(cy - r)), min(w, int(cx + r)), min(h, int(cy + r)))


def logo_score(rgb: np.ndarray, s: float, box, tpl: np.ndarray) -> tuple[float, float]:
    """Best normalised match of the logo and of its mirror image over every rotation (the backflip turns him upside down)."""
    x0, y0, x1, y1 = box
    g = highpass(cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2GRAY), s)
    g = g + np.random.default_rng(0).normal(0, 0.5, g.shape).astype(np.float32)  # flat ground would score a perfect 1.0
    h, w = g.shape
    if h < tpl.shape[0] + 2 or w < tpl.shape[1] + 2:
        return 0.0, 0.0
    best, best_m = -1.0, -1.0
    mir = np.ascontiguousarray(tpl[:, ::-1])
    for ang in range(0, 360, 6):
        R = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
        rg = cv2.warpAffine(g, R, (w, h), flags=cv2.INTER_LINEAR)
        for sc in (0.92, 1.0, 1.08):
            t = cv2.resize(tpl, None, fx=sc, fy=sc) if sc != 1.0 else tpl
            m = cv2.resize(mir, None, fx=sc, fy=sc) if sc != 1.0 else mir
            if rg.shape[0] <= t.shape[0] or rg.shape[1] <= t.shape[1]:
                continue
            best = max(best, float(cv2.matchTemplate(rg, t, cv2.TM_CCOEFF_NORMED).max()))
            best_m = max(best_m, float(cv2.matchTemplate(rg, m, cv2.TM_CCOEFF_NORMED).max()))
    return best, best_m


def placeholder_boxes(rgb: np.ndarray, box, s: float) -> int:
    """Flat, light, rectangular patches (an <img> that never loaded, a blank sprite) bigger than a few px."""
    x0, y0, x1, y1 = box
    g = cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2GRAY).astype(np.float32)
    mu = cv2.blur(g, (5, 5))
    sd = np.sqrt(np.maximum(cv2.blur(g * g, (5, 5)) - mu * mu, 0))
    on_bob = cv2.dilate(largest(body(rgb[y0:y1, x0:x1])), np.ones((5, 5), np.uint8)) > 0  # props ("!", "?") float apart
    flat = ((sd < 0.6) & (g > 150) & on_bob).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(flat)
    bad = 0
    for k in range(1, n):
        a, bw, bh = st[k, cv2.CC_STAT_AREA], st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
        if a >= max(60, 300 * s * s) and a / max(1, bw * bh) > 0.85:
            bad += 1
    return bad


def gaps(rgb: np.ndarray, box, s: float) -> int:
    """Ground-coloured pixels inside the hull of the belly + visor + button (always solid body)."""
    x0, y0, x1, y1 = box
    sub = rgb[y0:y1, x0:x1]
    core = weave(sub, s).copy()
    vm, _ = visor(sub)
    if vm is not None:
        core |= vm
    ys, xs = np.where(core > 0)
    if len(xs) < 20:
        return 0
    hull = np.zeros(core.shape, np.uint8)
    cv2.fillConvexPoly(hull, cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32)), 1)
    deep = cv2.distanceTransform(hull, cv2.DIST_L2, 5) > max(2.0, 10 * s)  # the bay between the feet sits on the hull's edge
    ground = (np.abs(sub.astype(np.float32) - INK).sum(2) < 30).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(ground)
    h, w = ground.shape
    open_ = [k for k in range(1, n) if st[k, cv2.CC_STAT_LEFT] == 0 or st[k, cv2.CC_STAT_TOP] == 0
             or st[k, cv2.CC_STAT_LEFT] + st[k, cv2.CC_STAT_WIDTH] == w or st[k, cv2.CC_STAT_TOP] + st[k, cv2.CC_STAT_HEIGHT] == h]
    enclosed = (ground > 0) & ~np.isin(lab, open_)  # ground open to the outside (between the feet, past the frame) is not a gap
    return int((enclosed & deep).sum())


def roughness(cover: np.ndarray, s: float) -> float:
    """Raggedness of Bob's outline in art px. The outline is traced at sub-pixel precision (4x) from the coverage (alpha,
    or for a flat render the colour distance from the ground), then compared with itself smoothed over ~1 art px; the 90th
    percentile is high for hard stair-steps and ragged cuts and low for a clean antialiased edge (the junctions where parts
    meet are real shape and stay under it)."""
    up = cv2.resize(cover.astype(np.float32), None, fx=4, fy=4, interpolation=cv2.INTER_LINEAR)
    cnts, _ = cv2.findContours((up > 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return 0.0
    c = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float32) / 4
    if len(c) < 80:
        return 0.0
    k = 4 * max(1.0, 1.0 * s)  # contour points are 1/4 px apart
    sm = np.stack([cv2.GaussianBlur(np.tile(c[:, i], 3)[None, :], (0, 0), k).ravel()[len(c):2 * len(c)] for i in (0, 1)], 1)
    return float(np.percentile(np.linalg.norm(c - sm, axis=1), 90) / s)


def edges(rgba: np.ndarray | None, rgb: np.ndarray, s: float, box) -> dict:
    """M9 numbers: roughness of Bob's outline, the share of outline pixels lighter than the clay inside (fringe), and for
    images with alpha the share of the outline that has a soft (antialiased) step."""
    x0, y0, x1, y1 = box
    sub = rgb[y0:y1, x0:x1]
    out = {}
    if rgba is not None:
        a = rgba[y0:y1, x0:x1, 3]
        solid = a > 127
        ring = (cv2.dilate(solid.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~(cv2.erode(solid.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        soft = cv2.dilate(((a > 8) & (a < 247)).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        out["ramp"] = float((soft & ring).sum() / max(1, ring.sum()))
        edge_px = (a > 8) & (a < 247)
    else:
        solid = largest(body(sub)) > 0
        edge_px = solid & ~(cv2.erode(solid.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    if rgba is not None:
        cover = a.astype(np.float32) / 255
    else:  # flat render: coverage from how far each pixel is from the ground colour, only around Bob
        dist = np.abs(sub.astype(np.float32) - INK).sum(2)
        cover = np.clip(dist / 300.0, 0, 1) * (cv2.dilate(solid.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    out["rough"] = roughness(cover, s)
    g = cv2.cvtColor(sub, cv2.COLOR_RGB2GRAY).astype(np.float32)
    inner = cv2.erode(solid.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    ref_lum = cv2.dilate(np.where(inner, g, 0), np.ones((9, 9), np.uint8))  # the brightest clay next to it (rims included)
    flat = rgba[y0:y1, x0:x1, :3] if rgba is not None else sub
    lum = cv2.cvtColor(np.ascontiguousarray(flat), cv2.COLOR_RGB2GRAY).astype(np.float32)
    fr = edge_px & (lum > ref_lum + 8) & (ref_lum > 0)
    out["fringe"] = float(fr.sum() / max(1, edge_px.sum()))
    return out


REF: Ref | None = None


def check(path: Path, rest: bool = False) -> dict:
    global REF
    REF = REF or Ref()
    rgb = load_rgb(path)
    im = Image.open(path)
    rgba = np.asarray(im.convert("RGBA")) if ("A" in im.getbands() and np.asarray(im.convert("RGBA"))[..., 3].min() < 255) else None
    vm, vst = visor(rgb)
    res: dict = {"image": str(path), "pass": True, "checks": {}}

    def put(cid, ok, detail):
        res["checks"][cid] = {"pass": bool(ok), "detail": detail}
        res["pass"] &= bool(ok)

    if vm is None:
        put("M3", False, "no visor found")
        return res
    s = float(np.sqrt(vst[cv2.CC_STAT_AREA] / REF.visor_area))
    res["scale"] = round(s, 3)
    vy, vx = np.where(vm > 0)
    box = bob_box(rgb, s, (vx.mean(), vy.mean()))
    ref = REF.at(s)
    m = measure(rgb, s, box)
    fwd, mir = logo_score(rgb, s, box, ref["tpl"])
    put("M1", fwd >= 0.45 and fwd - mir >= 0.06, f"logo {fwd:.2f} vs mirrored {mir:.2f}")
    tiny = s < 0.3  # Bob under 0.3x (the reply view at 1x): the button and the weave are a few px, too small to measure
    bok = m.get("button_n") == 1
    det = f"{m.get('button_n', 0)} button(s)"
    if bok:
        dc = float(np.abs(np.array(m["button_rgb"]) - np.array(ref["button_rgb"])).max())
        bok &= dc < 30
        det += f", colour diff {dc:.0f}"
        bc, vc, bel = np.array(m["button_c"]), np.array(m["visor_c"]), np.array(m.get("belly_c", m["visor_c"]))
        up = (vc - bel) / max(1e-6, float(np.linalg.norm(vc - bel)))
        above = float((bc - vc) @ up) / s
        bok &= above > 60
        det += f", {above:.0f} art px above the visor"
        if rest:
            ar = m["button_area"] / ref["button_area"]
            bok &= 0.85 <= ar <= 1.15
            det += f", area x{ar:.2f}"
    if not tiny:
        put("M2", bok, det)
    asp = m["visor_aspect"] / ref["visor_aspect"]
    put("M3", 0.85 <= asp <= 1.18 and m["eyes_outside"] <= max(2, 8 * s * s), f"aspect x{asp:.2f}, {m['eyes_outside']} amber px outside")
    if rest and "seam_frac" in m and "seam_frac" in ref:
        dfr = m["seam_frac"] - ref["seam_frac"]
        put("M4", abs(dfr) <= 0.04, f"seam at {m['seam_frac']:.3f} of the body (ref {ref['seam_frac']:.3f})")
    if tiny:
        pass
    elif ref["weave_energy"] > 0 and m["weave_area"] > 0.3 * ref["weave_area"]:
        er = m["weave_energy"] / ref["weave_energy"]
        put("M5", 0.7 <= er <= 1.4 and m.get("weave_smooth", 0) <= 0.12, f"weave energy x{er:.2f}, smooth {m.get('weave_smooth', 0):.2f}")
    else:
        put("M5", m["weave_area"] > 0.3 * ref["weave_area"], f"weave area x{m['weave_area'] / max(1, ref['weave_area']):.2f}")
    if ref["clay_sharp"] > 0 and s >= 0.5:  # below half scale the grain is sub-pixel and the browser's resampling decides
        sr = m["clay_sharp"] / ref["clay_sharp"]
        put("M6", sr >= 0.5, f"clay grain x{sr:.2f}")  # browser/device resampling of good art: 0.56-1.0; an upscaled blob: 0.2-0.3
    nb = placeholder_boxes(rgb, box, s)
    put("M7", nb == 0, f"{nb} flat box(es)")
    ng = gaps(rgb, box, s)
    put("M8", ng <= max(4, 12 * s * s), f"{ng} ground px inside the body")
    e = edges(rgba, rgb, s, box)
    er = ref["edges"]["rough"]
    ok9 = e["fringe"] <= FRINGE_MAX and (e["rough"] <= ROUGH_ART if rgba is not None else e["rough"] <= 1.25 * er + 0.03)
    det = f"roughness {e['rough']:.2f} art px (ref {er:.2f}), fringe {e['fringe']:.1%}"
    if rgba is not None:
        ok9 &= e["ramp"] >= 0.6
        det += f", antialiased {e['ramp']:.0%} of the outline"
    put("M9", ok9, det)
    return res


def sheet(out: Path) -> None:
    """The model sheet PNG: the canonical Bob with every invariant drawn on it, and the reference numbers."""
    from PIL import ImageDraw, ImageFont  # noqa: PLC0415

    ref = Ref()
    m = ref.at(1.0)
    art = ref.art
    h, w = art.shape[:2]
    W, H = w + 560, max(h, 620) + 40
    im = Image.new("RGB", (W, H), tuple(int(v) for v in INK))
    im.paste(Image.fromarray(art), (20, 20))
    d = ImageDraw.Draw(im)
    big, small = ImageFont.load_default(size=18), ImageFont.load_default(size=14)
    Y, C, S_, G = (240, 199, 94), (240, 122, 106), (187, 221, 240), (114, 150, 91)
    ox, oy = 20, 20
    x, y, lw, lh = ref.logo_box
    d.rectangle((ox + x, oy + y, ox + x + lw, oy + y + lh), outline=Y, width=2)
    d.line((ox + x, oy + y + lh + 8, ox + x + lw, oy + y + lh + 8), fill=Y, width=2)
    d.polygon([(ox + x + lw, oy + y + lh + 8), (ox + x + lw - 10, oy + y + lh + 3), (ox + x + lw - 10, oy + y + lh + 13)], fill=Y)
    vm, _ = visor(art)
    cnts, _ = cv2.findContours(vm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    d.line([(ox + int(p[0][0]), oy + int(p[0][1])) for p in max(cnts, key=cv2.contourArea)] + [(ox + int(cnts[0][0][0][0]), oy + int(cnts[0][0][0][1]))], fill=S_, width=2)
    ym = yellow(art)
    ym[cv2.dilate(vm, np.ones((13, 13), np.uint8)) > 0] = 0
    cnts, _ = cv2.findContours(largest(ym), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    d.line([(ox + int(p[0][0]), oy + int(p[0][1])) for p in cnts[0]] + [(ox + int(cnts[0][0][0][0]), oy + int(cnts[0][0][0][1]))], fill=C, width=2)
    wm = weave(art, 1.0)
    cols = np.where(wm.any(0))[0]
    seam_y = int(np.median([np.where(wm[:, c_])[0].min() for c_ in cols[len(cols) // 3: 2 * len(cols) // 3]]))
    d.line((ox + cols.min() - 10, oy + seam_y, ox + cols.max() + 10, oy + seam_y), fill=G, width=2)
    zx, zy = int(m["belly_c"][0]) - 30, int(m["belly_c"][1]) - 20
    zoom = Image.fromarray(art[zy:zy + 40, zx:zx + 60]).resize((180, 120), Image.NEAREST)
    tx = w + 50
    im.paste(zoom, (tx, H - 150))
    d.rectangle((ox + zx, oy + zy, ox + zx + 60, oy + zy + 40), outline=G, width=1)
    d.text((tx, H - 172), "M5 weave, 3x: never smooth or blurred", fill=G, font=small)
    lines = [
        ("Bob model sheet", S_, big), ("the canonical Bob = the owner's front original, cut once", S_, small), ("", S_, small),
        ("M1  logo 'bob' reads left to right (yellow box + arrow)", Y, small),
        ("     at every rotation; a mirror ('dod') scores lower", Y, small),
        (f"M2  one button, rgb {tuple(int(v) for v in m['button_rgb'])}, area {m['button_area']:.0f} px", C, small),
        ("     on the head axis, same pixels in every pose, turns", C, small), ("     only with the head, never scaled", C, small),
        (f"M3  visor aspect {m['visor_aspect']:.2f}:1 (blue); eyes stay inside", S_, small),
        (f"M4  seam (green) at {m['seam_frac']:.3f} of head-top..belly-bottom", G, small),
        (f"M5  weave energy {m['weave_energy']:.1f}, no smooth patches", G, small),
        ("M6  clay grain as sharp as this sheet at the same scale", S_, small),
        ("M7  never a flat placeholder box (missing part = static pose)", S_, small),
        ("M8  no ground colour inside the body (no seam gaps)", S_, small),
        ("M9  clean outlines: antialiased, no stair-steps, no halo", S_, small),
        ("", S_, small), ("Per pose only: its own arms (never flipped)", S_, small),
        ("one body, centred; head tilt is motion's job (0 baked)", S_, small),
        ("Check: bob_model_check.py IMAGE [--rest]", S_, small),
    ]
    yy = 30
    for t, col, f in lines:
        d.text((tx, yy), t, fill=col, font=f)
        yy += 26 if f is big else 21
    im.save(out, optimize=True)


def main(argv: list[str]) -> int:
    if "--sheet" in argv:
        sheet(Path(argv[argv.index("--sheet") + 1]))
        return 0
    rest = "--rest" in argv
    as_json = "--json" in argv
    paths = [Path(a) for a in argv if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return 2
    results = [check(p, rest) for p in paths]
    if as_json:
        print(json.dumps(results, indent=1))
    else:
        for r in results:
            print(("PASS" if r["pass"] else "FAIL"), r["image"], f"(scale {r.get('scale', '?')})")
            for cid, c in r["checks"].items():
                print(f"  {cid} {'ok  ' if c['pass'] else 'FAIL'} {c['detail']}")
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

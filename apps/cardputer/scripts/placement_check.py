"""Flags placement bugs in Bob's 360x360 round-UI screenshots (device `T screenshot`
captures and tools/bob-sim renders): an off-centre body, a drifted/overlapping status
icon row, eyes that have escaped the visor, content clipped by the round screen, and
more than one caption line. See docs/waveshare/placement-check.md for the checks,
thresholds and how the colour/shape heuristics were calibrated against real captures.

  py -3.11 scripts/placement_check.py shot1.png shot2.png   human-readable report
  py -3.11 scripts/placement_check.py shot1.png --json       machine-readable report

Exits 1 if any file has a violation (or fails to load), 0 otherwise.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# ---- placement grid (docs/waveshare/placement-check.md, bob-character skill) ----
# The grid comes from design/bob/tokens.json via the generated bob_tokens.json next to this file.
_TOK = json.loads((Path(__file__).with_name("bob_tokens.json")).read_text(encoding="utf-8"))
SCREEN = _TOK["screen"]
CENTER = tuple(_TOK["center"])  # screen centre; radius checks and the safe-chord formula use this
BODY_CENTER = tuple(_TOK["bodyCenter"])  # Bob's body centre
BODY_CENTER_X_TOL = 3
BODY_CENTER_Y_TOL = 12

GROUND_COLOR = (16, 60, 82)  # measured navy ground (device RGB565 rendering of ink #173E57)
GROUND_DIST_MIN = 30  # euclidean RGB distance above which a pixel counts as "not ground"

RING_INNER_R = _TOK["ringInner"]  # the ring annulus starts here; excluded from the body/status/caption masks
RING_OUTER_R = 178  # nominal outer edge of the ring
# The true glass edge is r=180 (360x360, centred at (180,180), touches all 4 sides). A lit
# ring's glow/blur legitimately bleeds a couple of px past its nominal r=178 outer edge -
# measured up to ~180 on real captures - so the clip check uses the physical edge, not the
# ring's nominal radius, to avoid flagging the ring's own glow as clipped content.
CLIP_RADIUS = CENTER[1]
CLIP_TOLERANCE_PX = 3  # a few stray anti-aliased px beyond the radius is not a clip bug

STATUS_ICON_BAND_Y = 52  # icons cluster at y~28-48; Bob's head/button can poke into y 52-69
STATUS_CENTER_X = _TOK["center"][0]
STATUS_CENTER_TOL = 4
STATUS_MIN_BLOB_PX = 4
STATUS_LAYOUT_ROW_SPREAD = 8  # icon-centre y spread <= this px counts as a straight "row"

# Clear space between Bob (the top button included) and the status-icon discs, at rest and at every move's apex.
# Owner, 2026-10-17: the yellow button must never touch the arc. The discs are ground-coloured on the device, so they are
# placed from the tokens (arc radius, disc diameter) along the arc the detected glyphs span.
TOP_GAP_MIN = _TOK.get("topGapMin", 6)
ARC_RADIUS = _TOK["statusArc"]["radius"]
DISC_RADIUS = _TOK["statusArc"]["discDiameter"] / 2

VISOR_DARK_MAX = 70  # near-black visor: every channel below this
VISOR_MIN_PX = 50  # below this, no visor was found (a text "card", not a Bob pose)
VISOR_ROI_MARGIN = 10  # eye search window around the visor bbox; keeps the amber top
                        # button (which sits ~15-25px above the visor) out of the search
VISOR_DILATE_PX = 1

EYE_R_MIN = 180
EYE_G_MIN = 120
EYE_B_MAX = 130
EYE_GB_GAP_MIN = 55  # amber eyes have a much bigger G-B gap than the warm ivory body tones

CAPTION_Y = int(_TOK["feetY"]) + 4  # the caption band starts just below the token feet line (design/bob/tokens.json)
CAPTION_MIN_BLOB_PX = 3
CAPTION_MIN_BLOB_HEIGHT = 5  # drops the 1px-tall page-dot row from the text-line count
CAPTION_LINE_GAP_PX = 10  # vertical gap that separates two caption lines
CAPTION_MAX_LINES = 1  # only enforced in "normal" (Bob-visible) mode
CHORD_MARGIN = 12  # usable half-width at height y = sqrt(180^2-(y-180)^2) - CHORD_MARGIN


def load_rgb(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (SCREEN, SCREEN):
        raise ValueError(f"expected a {SCREEN}x{SCREEN} image, got {img.size[0]}x{img.size[1]}")
    return np.array(img)


def radius_grid(h: int, w: int) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w]
    return np.sqrt((xs - CENTER[0]) ** 2 + (ys - CENTER[1]) ** 2)


def foreground_mask(arr: np.ndarray) -> np.ndarray:
    diff = arr.astype(np.int32) - np.array(GROUND_COLOR, dtype=np.int32)
    return np.sqrt((diff ** 2).sum(axis=-1)) > GROUND_DIST_MIN


def chord_half_width(y: float) -> float:
    v = CENTER[1] ** 2 - (y - CENTER[1]) ** 2
    return math.sqrt(v) - CHORD_MARGIN if v > 0 else -CHORD_MARGIN


def label_components(mask: np.ndarray) -> list[np.ndarray]:
    """8-connected components as a list of Nx2 (y,x) arrays, largest first."""
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    deltas = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    comps = []
    ys, xs = np.where(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if visited[sy, sx]:
            continue
        visited[sy, sx] = True
        stack = [(sy, sx)]
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for dy, dx in deltas:
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        comps.append(np.array(comp, dtype=np.int32))
    comps.sort(key=len, reverse=True)
    return comps


def dilate(mask: np.ndarray, iters: int = 1) -> np.ndarray:
    h, w = mask.shape
    m = mask
    for _ in range(iters):
        p = np.pad(m, 1, constant_values=False)
        out = np.zeros_like(m)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                out |= p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        m = out
    return m


def bbox_of(comp: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = comp[:, 0], comp[:, 1]
    return int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())


def bboxes_overlap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    ax0, ax1, ay0, ay1 = a
    bx0, bx1, by0, by1 = b
    return ax0 <= bx1 and bx0 <= ax1 and ay0 <= by1 and by0 <= ay1


def check_body_centroid(fg: np.ndarray, radius: np.ndarray) -> list[dict]:
    body_mask = fg & (radius < RING_INNER_R)
    comps = [c for c in label_components(body_mask) if len(c) >= VISOR_MIN_PX]
    if not comps:
        return [{"check": "body-centroid", "message": "no Bob body pixels found inside the ring"}]
    largest = comps[0]
    cy, cx = float(largest[:, 0].mean()), float(largest[:, 1].mean())
    if abs(cx - BODY_CENTER[0]) > BODY_CENTER_X_TOL or abs(cy - BODY_CENTER[1]) > BODY_CENTER_Y_TOL:
        return [{
            "check": "body-centroid",
            "message": f"Bob body centroid ({cx:.1f},{cy:.1f}) is outside "
                       f"{BODY_CENTER} +/-({BODY_CENTER_X_TOL},{BODY_CENTER_Y_TOL})",
            "centroid": [round(cx, 1), round(cy, 1)],
        }]
    return []


def find_visor(arr: np.ndarray) -> np.ndarray | None:
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    dark = (r < VISOR_DARK_MAX) & (g < VISOR_DARK_MAX) & (b < VISOR_DARK_MAX)
    comps = [c for c in label_components(dark) if len(c) >= VISOR_MIN_PX]
    return comps[0] if comps else None


def fill_row_spans(comp: np.ndarray, h: int, w: int) -> np.ndarray:
    """Fills each row of a component between its leftmost and rightmost pixel, so
    interior holes (the eyes, punched into the visor silhouette) count as "inside"."""
    mask = np.zeros((h, w), dtype=bool)
    ys, xs = comp[:, 0], comp[:, 1]
    for y in np.unique(ys):
        row_xs = xs[ys == y]
        mask[y, row_xs.min():row_xs.max() + 1] = True
    return mask


def check_eyes_in_visor(arr: np.ndarray, visor: np.ndarray) -> list[dict]:
    h, w = arr.shape[:2]
    x0, x1, y0, y1 = bbox_of(visor)
    visor_mask = fill_row_spans(visor, h, w)
    visor_dilated = dilate(visor_mask, VISOR_DILATE_PX)

    roi = np.zeros((h, w), dtype=bool)
    ry0, ry1 = max(0, y0 - VISOR_ROI_MARGIN), min(h, y1 + VISOR_ROI_MARGIN + 1)
    rx0, rx1 = max(0, x0 - VISOR_ROI_MARGIN), min(w, x1 + VISOR_ROI_MARGIN + 1)
    roi[ry0:ry1, rx0:rx1] = True

    r, g, b = arr[..., 0].astype(np.int32), arr[..., 1].astype(np.int32), arr[..., 2].astype(np.int32)
    eye_mask = (r >= EYE_R_MIN) & (g >= EYE_G_MIN) & (b <= EYE_B_MAX) & ((g - b) >= EYE_GB_GAP_MIN) & roi

    outside = eye_mask & ~visor_dilated
    if not outside.any():
        return []
    ys, xs = np.where(outside)
    return [{
        "check": "eyes-in-visor",
        "message": f"{len(xs)} amber eye px fall outside the visor (dilated {VISOR_DILATE_PX}px)",
        "bbox": [int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())],
    }]


def classify_status_layout(bboxes: list[tuple[int, int, int, int]]) -> str:
    y_centers = [(y0 + y1) / 2 for _, _, y0, y1 in bboxes]
    return "row" if max(y_centers) - min(y_centers) <= STATUS_LAYOUT_ROW_SPREAD else "arc"


def check_status_row(fg: np.ndarray, radius: np.ndarray) -> tuple[list[dict], str | None]:
    h, w = fg.shape
    band = np.zeros((h, w), dtype=bool)
    band[:STATUS_ICON_BAND_Y, :] = True
    mask = fg & band & (radius < RING_INNER_R)
    comps = [c for c in label_components(mask) if len(c) >= STATUS_MIN_BLOB_PX]
    if not comps:
        return [], None

    bboxes = [bbox_of(c) for c in comps]
    total_px = sum(len(c) for c in comps)
    weighted_x = sum(float(c[:, 1].mean()) * len(c) for c in comps) / total_px

    violations = []
    if abs(weighted_x - STATUS_CENTER_X) > STATUS_CENTER_TOL:
        violations.append({
            "check": "status-row-centre",
            "message": f"status icon row centroid x={weighted_x:.1f} is outside "
                       f"{STATUS_CENTER_X}+/-{STATUS_CENTER_TOL}",
            "centroid_x": round(weighted_x, 1),
        })

    for (x0, x1, y0, y1) in bboxes:
        half_top, half_bottom = chord_half_width(y0), chord_half_width(y1)
        half = min(half_top, half_bottom)
        if x0 < CENTER[0] - half or x1 > CENTER[0] + half:
            violations.append({
                "check": "status-row-chord",
                "message": f"status icon bbox x=({x0},{x1}) y=({y0},{y1}) exceeds the safe chord",
                "bbox": [x0, x1, y0, y1],
            })

    for i in range(len(bboxes)):
        for j in range(i + 1, len(bboxes)):
            if bboxes_overlap(bboxes[i], bboxes[j]):
                violations.append({
                    "check": "status-row-overlap",
                    "message": f"status icon blobs {i} and {j} overlap",
                    "bboxes": [list(bboxes[i]), list(bboxes[j])],
                })

    return violations, classify_status_layout(bboxes)


def check_top_gap(fg: np.ndarray, radius: np.ndarray) -> list[dict]:
    """Bob (the largest thing inside the ring) keeps TOP_GAP_MIN px clear of every status-icon disc."""
    comps = [c for c in label_components(fg & (radius < RING_INNER_R)) if len(c) >= STATUS_MIN_BLOB_PX]
    if not comps:
        return []
    bob = comps[0]
    angles = []
    for c in comps:
        if c is bob:
            continue
        cy, cx = float(c[:, 0].mean()), float(c[:, 1].mean())
        if cy < STATUS_ICON_BAND_Y:
            angles.append(math.atan2(cx - CENTER[0], CENTER[1] - cy))
    if not angles:
        return []
    # every disc lies on the arc segment the glyphs span (a glyph Bob already swallowed stays inside the span)
    a = np.linspace(min(angles), max(angles), max(2, int(math.degrees(max(angles) - min(angles))) * 2 + 1))
    centres = np.stack([CENTER[0] + ARC_RADIUS * np.sin(a), CENTER[1] - ARC_RADIUS * np.cos(a)], 1)
    top = bob[bob[:, 0] < CENTER[1]]
    pts = np.stack([top[:, 1], top[:, 0]], 1).astype(np.float32)
    d = np.sqrt(((pts[:, None, :] - centres[None, :, :]) ** 2).sum(-1)).min()
    gap = float(d - DISC_RADIUS)
    if gap >= TOP_GAP_MIN:
        return []
    return [{
        "check": "top-gap",
        "message": f"Bob comes {gap:.1f} px from a status-icon disc (needs >= {TOP_GAP_MIN} px clear)",
        "gap": round(gap, 1),
    }]


def caption_text_components(fg: np.ndarray, radius: np.ndarray) -> list[np.ndarray]:
    h, w = fg.shape
    band = np.zeros((h, w), dtype=bool)
    band[CAPTION_Y:, :] = True
    mask = fg & band & (radius < RING_INNER_R)  # keep the ring's glow out of the caption blobs
    comps = [c for c in label_components(mask) if len(c) >= CAPTION_MIN_BLOB_PX]
    return [c for c in comps if int(c[:, 0].max() - c[:, 0].min()) + 1 >= CAPTION_MIN_BLOB_HEIGHT]


def group_into_lines(comps: list[np.ndarray]) -> list[tuple[int, int]]:
    spans = sorted(((int(c[:, 0].min()), int(c[:, 0].max())) for c in comps))
    lines: list[tuple[int, int]] = []
    for y0, y1 in spans:
        if lines and y0 <= lines[-1][1] + CAPTION_LINE_GAP_PX:
            lines[-1] = (lines[-1][0], max(lines[-1][1], y1))
        else:
            lines.append((y0, y1))
    return lines


def check_clipping_and_caption(fg: np.ndarray, radius: np.ndarray, mode: str) -> list[dict]:
    violations = []
    outside = fg & (radius > CLIP_RADIUS)
    if int(outside.sum()) > CLIP_TOLERANCE_PX:
        ys, xs = np.where(outside)
        violations.append({
            "check": "clipped",
            "message": f"{int(outside.sum())} non-ground px lie outside r={CLIP_RADIUS}",
            "bbox": [int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())],
        })

    if mode != "normal":
        return violations

    text_comps = caption_text_components(fg, radius)
    for c in text_comps:
        ys, xs = c[:, 0], c[:, 1]
        halves = np.array([chord_half_width(float(y)) for y in ys])
        bad = (xs < CENTER[0] - halves) | (xs > CENTER[0] + halves)
        if bad.any():
            violations.append({
                "check": "caption-chord",
                "message": "a caption text blob extends past the safe chord",
                "bbox": list(bbox_of(c)),
            })

    lines = group_into_lines(text_comps)
    if len(lines) > CAPTION_MAX_LINES:
        violations.append({
            "check": "caption-lines",
            "message": f"{len(lines)} caption text lines found, max {CAPTION_MAX_LINES}",
            "lines": [list(span) for span in lines],
        })
    return violations


def analyze(path: Path) -> dict:
    arr = load_rgb(path)
    h, w = arr.shape[:2]
    fg = foreground_mask(arr)
    radius = radius_grid(h, w)

    violations: list[dict] = []
    visor = find_visor(arr)
    mode = "normal" if visor is not None else "card"

    if mode == "normal":
        violations += check_body_centroid(fg, radius)
        violations += check_eyes_in_visor(arr, visor)
        violations += check_top_gap(fg, radius)

    status_violations, layout = check_status_row(fg, radius)
    violations += status_violations
    violations += check_clipping_and_caption(fg, radius, mode)

    return {
        "path": str(path),
        "mode": mode,
        "status_layout": layout,
        "violations": violations,
        "ok": not violations,
    }


def format_human(result: dict) -> str:
    lines = [f"{result['path']}  mode={result['mode']}  status_layout={result['status_layout']}"]
    if result["ok"]:
        lines.append("  OK")
    else:
        for v in result["violations"]:
            lines.append(f"  - [{v['check']}] {v['message']}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    results = []
    had_error = False
    for path in args.images:
        try:
            results.append(analyze(path))
        except (OSError, ValueError) as exc:
            had_error = True
            results.append({"path": str(path), "error": str(exc), "ok": False})

    if args.json:
        print(json.dumps({"ok": all(r["ok"] for r in results), "files": results}, indent=2))
    else:
        for result in results:
            if "error" in result:
                print(f"{result['path']}  ERROR: {result['error']}")
            else:
                print(format_human(result))

    return 1 if had_error or not all(r["ok"] for r in results) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

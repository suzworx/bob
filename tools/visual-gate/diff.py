"""Numeric diff for the Waveshare flash gate: golden (approved demo) vs candidate (firmware) per case.

  py -3.11 -I tools/visual-gate/diff.py --golden docs/waveshare/golden --candidate <dir> --out <dir> [--json]

Per case (tools/visual-gate/cases.json), after registering the candidate to the golden within +-1 px, all on luma,
11 px Gaussian window (sigma 1.5), the Wang et al. SSIM over
the whole round glass (r < 180) and over four regions, each named in the failure so it says what to fix:
  bob      Bob's box in that view (scale, rise); plus eyes (the visor box) at the bob threshold
  status   the status arc band (statusArc in bob_tokens.json: r 138..162, +-36 deg)
  caption  everything else inside the ring: captions, reply text, props
  ring     the ring light, ringInner..ringOuter ("ring missing" when the demo lights it and the firmware does not)
The geometry comes from apps/cardputer/scripts/bob_tokens.json (generated from design/bob/tokens.json).
Thresholds come from the golden manifest's gate block: min(target, ceiling - 0.03), where the ceiling is what a
faithful port scores (faithful.py: each golden through the device's RGB565 and circle mask). Then the structure:
  seam         a thin dark line (valley), >= 12 px long, through Bob's body that the demo does not have
  status-arc   icons centred on x 180 within +-2 px, symmetric, and as many on the arc as the demo has
  bob-centre   Bob's body centroid x within +-3 px of the golden's (body = largest blob in Bob's box)
  clip         nothing drawn outside r 178 where the golden has nothing
  top-gap      Bob keeps topGapMin px (bob_tokens.json) clear of every status-icon disc (placement_check.py)
  caption-lines  at most one caption line (apps/cardputer/scripts/placement_check.py) in full-size Bob views
  logo         the "bob" head logo reads the right way round: the template beats its mirror image
A placement check applies to a case only where the golden itself passes it (a prop or a hop can enter the arc
in the approved design); the report lists the checks it skipped and why.
Writes <out>/<id>-sheet.png (golden | candidate | heatmap) for every case, <out>/<id>-heatmap.png for each
failure, and <out>/report.json. Exits 1 when any case fails. Deps are pinned (requirements.txt) and checked.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PINNED = {line.split("==")[0].lower(): line.split("==")[1].strip()
          for line in (HERE / "requirements.txt").read_text().splitlines() if "==" in line and not line.startswith("#")}

import numpy as np  # noqa: E402
import PIL  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

for name, have in (("numpy", np.__version__), ("pillow", PIL.__version__)):
    if PINNED.get(name) != have:
        sys.exit(f"diff.py: {name} {have} is not the pinned {PINNED.get(name)}; "
                 f"py -3.11 -m pip install -r tools/visual-gate/requirements.txt")

_spec = importlib.util.spec_from_file_location("placement_check", ROOT / "apps/cardputer/scripts/placement_check.py")
pc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pc)  # type: ignore[union-attr]

# The placement grid: design/bob/tokens.json, generated into apps/cardputer/scripts/bob_tokens.json (the file the
# placement checker reads too), so the gate's regions move with the design system.
TOK = json.loads((ROOT / "apps/cardputer/scripts/bob_tokens.json").read_text(encoding="utf8"))
SIZE = TOK["screen"]
C = TOK["center"][0] - 0.5  # pixel-centre of the glass
RING_INNER, GLASS_R = TOK["ringInner"], TOK["ringOuter"]
FEET_Y = TOK["feetY"]
_ARC = TOK["statusArc"]
YY, XX = np.mgrid[0:SIZE, 0:SIZE]
RADIUS = np.hypot(XX - C, YY - C)
ANGLE = np.degrees(np.arctan2(XX - C, C - YY))  # 0 = 12 o'clock, clockwise positive
CIRCLE = RADIUS < GLASS_R
# The status area: a disc's footprint (plus 1 px) at every place a chip can sit, up to seven icons stepDeg apart. Not the whole
# arc band: a large disc reaches far into the glass and the band would swallow the top of a small Bob.
def _status_area() -> np.ndarray:
    m = np.zeros((SIZE, SIZE), dtype=bool)
    for k in range(-6, 7):
        a = math.radians(k * _ARC["stepDeg"] / 2)
        cx, cy = C + _ARC["radius"] * math.sin(a), C - _ARC["radius"] * math.cos(a)
        m |= np.hypot(XX - cx, YY - cy) <= _ARC["discDiameter"] / 2 + 1
    return m & (RADIUS <= RING_INNER)


STATUS = _status_area()


def _chip_discs() -> np.ndarray:
    """Every place a status chip can sit (design/bob/tokens.json statusArc.symmetry): N icons at (i-(N-1)/2)*stepDeg about
    12 o'clock on the arc radius, so for any N up to 7 the centres lie on a half-step grid within 3 steps. Icons are
    counted only inside these discs (radius discDiameter/2, reaching r 163), never by a radius band: the ring starts at
    ringInner (r ~164.5) and must not count as an icon."""
    m = np.zeros((SIZE, SIZE), dtype=bool)
    for k in range(-6, 7):
        a = math.radians(k * _ARC["stepDeg"] / 2)
        cx, cy = C + _ARC["radius"] * math.sin(a), C - _ARC["radius"] * math.cos(a)
        m |= np.hypot(XX - cx, YY - cy) <= _ARC["discDiameter"] / 2
    return m


CHIP_DISCS = _chip_discs()
RIG_PX, RIG_PIVOT_Y = 197, 194  # the demo rig's stage and its pivot height above the feet line
# x0, y0, x1, y1 of the "bob" logo in the golden `ready`, measured 126..102 px above the feet line, so it moves with
# Bob when the token grid does.
LOGO_BOX = (154, FEET_Y - 126, 214, FEET_Y - 102)
LOGO_SEARCH = 24  # px the logo may sit from where the golden has it


def load(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (SIZE, SIZE):
        raise ValueError(f"{path} is {img.size[0]}x{img.size[1]}, expected {SIZE}x{SIZE}")
    return np.asarray(img).astype(np.float64)


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114])


def _gauss(img: np.ndarray, sigma: float = 1.5, radius: int = 5) -> np.ndarray:
    k = np.exp(-(np.arange(-radius, radius + 1) ** 2) / (2 * sigma * sigma))
    k /= k.sum()
    p = np.pad(img, radius, mode="reflect")
    rows = sum(k[i] * p[:, i:i + img.shape[1]] for i in range(len(k)))
    return sum(k[i] * rows[i:i + img.shape[0], :] for i in range(len(k)))


def ssim_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _gauss(a), _gauss(b)
    var_a = _gauss(a * a) - mu_a ** 2
    var_b = _gauss(b * b) - mu_b ** 2
    cov = _gauss(a * b) - mu_a * mu_b
    return ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2))


def bob_mask(case: dict) -> np.ndarray:
    """Bob's box in the demo's geometry: the 197 px rig pivots on the feet line (tokens feetY), scaled by case.scale and
    raised by rise."""
    s, rise, m = case.get("scale", 1), case.get("rise", 0), 6
    oy = FEET_Y - 0.5 + rise
    x0, x1 = C + 0.5 - RIG_PX / 2 * s - m, C + 0.5 + RIG_PX / 2 * s + m
    y0, y1 = oy - RIG_PIVOT_Y * s - m, oy + 3 * s + m
    return (XX >= x0) & (XX <= x1) & (YY >= y0) & (YY <= y1) & (RADIUS < RING_INNER) & ~STATUS


def foreground(rgb: np.ndarray) -> np.ndarray:
    return pc.foreground_mask(rgb.astype(np.uint8)) & CIRCLE


def drawn(rgb: np.ndarray) -> np.ndarray:
    """Pixels that carry content: neither the ink ground nor the near-black glass edge."""
    return pc.foreground_mask(rgb.astype(np.uint8)) & (rgb.max(axis=-1) > 48)


def glyphs(rgb: np.ndarray) -> np.ndarray:
    """The bright strokes of icons and text (luma > 100 on the ink ground): stable under RGB565, unlike the faint chip discs."""
    return (luma(rgb) > 100) & CIRCLE


def _icons(fg: np.ndarray) -> list[np.ndarray]:
    return [c for c in pc.label_components(pc.dilate(fg & CHIP_DISCS, 3)) if len(c) >= 12]


def icon_count(fg: np.ndarray) -> int:
    return len(_icons(fg))


def status_arc(fg: np.ndarray, expect: int | None = None) -> list[dict]:
    comps = _icons(fg)
    if not comps:
        return [{"check": "status-arc", "message": "no status icons on the top arc"}]
    if expect is not None and len(comps) != expect:
        return [{"check": "status-arc", "message": f"{len(comps)} icons on the top arc, the demo has {expect} (icons off the arc or stacked)"}]
    centres = sorted((float(c[:, 1].mean()), float(c[:, 0].mean())) for c in comps)
    xs = np.concatenate([c[:, 1] for c in comps])
    out = []
    mid = (float(xs.min()) + float(xs.max())) / 2
    if abs(mid - C) > 2:
        out.append({"check": "status-arc", "message": f"icon row centred at x {mid:.1f}, not 180 +-2"})
    for i in range(len(centres) // 2 + len(centres) % 2):
        (xa, ya), (xb, yb) = centres[i], centres[-1 - i]
        if abs((xa + xb) / 2 - C) > 2 or abs(ya - yb) > 2:
            out.append({"check": "status-arc", "message": f"icons at ({xa:.0f},{ya:.0f}) and ({xb:.0f},{yb:.0f}) are not mirror images about x 180"})
            break
    return out


def body_x(fg: np.ndarray, case: dict) -> float | None:
    comps = [c for c in pc.label_components(fg & bob_mask(case)) if len(c) >= 200]
    return float(comps[0][:, 1].mean()) if comps else None


def _ncc_best(img: np.ndarray, tpl: np.ndarray, cx: int, cy: int, reach: int) -> float:
    th, tw = tpl.shape
    t = tpl - tpl.mean()
    tn = math.sqrt(float((t * t).sum())) or 1.0
    best = -1.0
    for y in range(max(0, cy - reach), min(SIZE - th, cy + reach) + 1):
        for x in range(max(0, cx - reach), min(SIZE - tw, cx + reach) + 1):
            w = img[y:y + th, x:x + tw]
            w = w - w.mean()
            wn = math.sqrt(float((w * w).sum())) or 1.0
            best = max(best, float((w * t).sum()) / (wn * tn))
    return best


def logo_scores(gray: np.ndarray, tpl: np.ndarray, case: dict) -> tuple[float, float]:
    """Best NCC of the template and of its mirror image near where the golden's logo sits at this scale."""
    s, rise = case.get("scale", 1), case.get("rise", 0)
    if s != 1:
        h, w = tpl.shape
        tpl = np.asarray(Image.fromarray(tpl.astype(np.uint8)).resize((max(8, round(w * s)), max(4, round(h * s))), Image.BILINEAR)).astype(np.float64)
    x0, y0 = LOGO_BOX[0], LOGO_BOX[1]
    cx = round(180 + (x0 - 180) * s)
    cy = round(FEET_Y - 0.5 + rise + (y0 - (FEET_Y - 0.5)) * s)
    return _ncc_best(gray, tpl, cx, cy, LOGO_SEARCH), _ncc_best(gray, tpl[:, ::-1], cx, cy, LOGO_SEARCH)


def logo_template(golden_dir: Path) -> np.ndarray:
    x0, y0, x1, y1 = LOGO_BOX
    return luma(load(golden_dir / "ready.png"))[y0:y1, x0:x1]


def heatmap(cand: np.ndarray, smap: np.ndarray, masks: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """1 - SSIM in red over the dimmed candidate, with the judged regions outlined so a score maps to a place."""
    heat = np.clip((1 - smap) * 2, 0, 1)
    base = luma(cand)[..., None].repeat(3, -1) * 0.35
    out = base.copy()
    out[..., 0] = np.clip(base[..., 0] + heat * 255, 0, 255)
    out[..., 1] = base[..., 1] * (1 - heat)
    out[..., 2] = base[..., 2] * (1 - heat)
    for name, colour in (("bob", (240, 199, 94)), ("status", (187, 221, 240)), ("ring", (114, 150, 91))):
        if masks is not None:
            m = masks[name]
            out[m & pc.dilate(~m, 1)] = colour  # a 1 px outline on the region's inner edge
    out[~CIRCLE] = 0
    return out.astype(np.uint8)


def sheet(golden: np.ndarray, cand: np.ndarray, heat: np.ndarray, verdict: str, reasons: str, ok: bool) -> Image.Image:
    img = Image.new("RGB", (3 * SIZE + 40, SIZE + 60), (17, 19, 22))
    draw = ImageDraw.Draw(img)
    for i, (part, label) in enumerate(((golden, "golden (approved demo)"), (cand, "candidate (firmware)"),
                                       (heat, "1 - SSIM; outlines: Bob yellow, status arc blue, ring green"))):
        img.paste(Image.fromarray(part.astype(np.uint8)), (10 + i * (SIZE + 10), 50))
        draw.text((10 + i * (SIZE + 10), 34), label, fill=(154, 163, 173))
    draw.text((10, 3), verdict, fill=(114, 150, 91) if ok else (240, 122, 106))
    draw.text((10, 18), reasons[:180] + ("..." if len(reasons) > 180 else ""), fill=(233, 236, 239))
    return img


REGIONS = ("bob", "status", "caption", "ring")
REGION_WHAT = {"bob": "Bob differs", "status": "status chips differ", "caption": "caption/text/props differ", "ring": "ring differs"}


def region_masks(case: dict) -> dict[str, np.ndarray]:
    """The glass split into what the firmware sessions own: Bob's box, the status arc, the ring light (r 162..180),
    and everything else inside (captions, reply text, props)."""
    bob, ring = bob_mask(case), CIRCLE & (RADIUS >= RING_INNER)
    return {"bob": bob, "status": STATUS, "caption": CIRCLE & ~bob & ~STATUS & ~ring, "ring": ring}


def thresholds(manifest: dict) -> dict[str, dict[str, float]]:
    """The gate thresholds per case and region: that case's device ceiling - margin, derived by faithful.py (what the
    device can draw at the golden's geometry) and recorded in the manifest."""
    gate = manifest.get("gate")
    if not gate:
        sys.exit("diff.py: the golden manifest has no gate block; run: py -3.11 -I tools/visual-gate/faithful.py --write")
    stale = [i for i, sha in gate["goldens"].items() if manifest["goldens"].get(i, {}).get("sha256") != sha]
    if stale or set(gate["goldens"]) != set(manifest["goldens"]):
        sys.exit(f"diff.py: the gate ceiling was derived from other goldens ({', '.join(stale) or 'set changed'}); "
                 "run: py -3.11 -I tools/visual-gate/faithful.py --write")
    return gate["thresholds"]


def eyes_box(golden: np.ndarray, case: dict) -> np.ndarray | None:
    """The visor box: the largest near-black blob inside Bob's box. Searched there only, because the masked-off corners
    of the glass are black too and would otherwise win (they made this box the whole screen before 2026-10-20)."""
    inside = golden.copy()
    inside[~bob_mask(case)] = pc.GROUND_COLOR
    visor = pc.find_visor(inside.astype(np.uint8))
    if visor is None:
        return None
    x0, x1, y0, y1 = pc.bbox_of(visor)
    return (XX >= x0 - 3) & (XX <= x1 + 3) & (YY >= y0 - 3) & (YY <= y1 + 3)


def valleys(gray: np.ndarray, depth: float = 40) -> np.ndarray:
    """Pixels darker by `depth` than both pixels 2 px away, across or along: the trace a 1-3 px gap or line leaves."""
    p = np.pad(gray, 2, mode="edge")
    h = np.minimum(p[2:-2, :-4], p[2:-2, 4:])
    v = np.minimum(p[:-4, 2:-2], p[4:, 2:-2])
    return (gray < h - depth) | (gray < v - depth)


def seams(golden: np.ndarray, cand: np.ndarray, case: dict) -> list[dict]:
    """Part seams: thin dark lines (valleys) at least 12 px long through Bob's body (the golden body, eroded 3 px)
    that the demo does not have within 2 px. Edges of moved features are steps, not valleys, so they do not count."""
    comps = [c for c in pc.label_components(foreground(golden) & bob_mask(case)) if len(c) >= 200]
    if not comps:
        return []
    body = np.zeros((SIZE, SIZE), dtype=bool)
    body[comps[0][:, 0], comps[0][:, 1]] = True
    interior = ~pc.dilate(~body, 3)
    new = interior & valleys(luma(cand)) & ~pc.dilate(valleys(luma(golden)), 2)
    lines = []
    for c in pc.label_components(new):
        x0, x1, y0, y1 = pc.bbox_of(c)
        span = max(x1 - x0, y1 - y0) + 1
        if span >= 12 and len(c) <= 3 * span:
            lines.append((x0, y0, x1, y1))
    if not lines:
        return []
    x0, y0, x1, y1 = lines[0]
    return [{"check": "seam", "message": f"{len(lines)} part seam(s) through Bob, first at x {x0}..{x1}, y {y0}..{y1}"}]


def ring_reason(golden: np.ndarray, cand: np.ndarray, ring: np.ndarray) -> str:
    g, c = float(drawn(golden)[ring].mean()), float(drawn(cand)[ring].mean())
    if g > 0.2 and c < 0.5 * g:
        return f"ring missing (the demo lights {g:.0%} of the rim, the firmware {c:.0%})"
    if g < 0.05 and c > 0.2:
        return f"ring lit where the demo has none ({c:.0%} of the rim)"
    return "ring differs"


def register(gl: np.ndarray, cand: np.ndarray) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """The candidate moved by the +-1 px shift that scores best over the circle: a port one pixel off is not a visual
    defect (the placement checks still hold Bob and the arc to +-3 / +-2 px)."""
    best = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            moved = np.roll(cand, (dy, dx), axis=(0, 1))
            moved[~CIRCLE] = 0
            smap = ssim_map(gl, luma(moved))
            score = float(smap[CIRCLE].mean())
            if best is None or score > best[0]:
                best = (score, moved, smap, (dx, dy))
    return best[1], best[2], best[3]


_RUNS: dict | None = None


def text_boxes(case_id: str) -> list[tuple[float, float, float, float]]:
    """The golden's text line boxes (docs/waveshare/golden/text-runs.json): where the caption region may carry glyphs."""
    global _RUNS
    if _RUNS is None:
        _RUNS = json.loads((ROOT / "docs/waveshare/golden/text-runs.json").read_text(encoding="utf8"))
    return [(r["x0"], r["y0"], r["x1"], r["y1"]) for r in _RUNS.get(case_id, [])]


def extras(rgb: np.ndarray, region: np.ndarray, boxes: list[tuple[float, float, float, float]]) -> int:
    """Marks in the caption region that are not text: the reply card's page dots, sparkles, props. Text can differ in
    rendering between browser and device; whether a page dot or a sparkle exists cannot."""
    m = drawn(rgb) & region
    for x0, y0, x1, y1 in boxes:
        m[max(0, int(y0) - 8):int(y1) + 8, max(0, int(x0) - 8):int(x1) + 8] = False
    return sum(1 for c in pc.label_components(pc.dilate(m, 9)) if len(c) >= 10)


def judge(case: dict, golden: np.ndarray, cand: np.ndarray, tpl: np.ndarray, th: dict) -> tuple[dict, np.ndarray]:
    gl = luma(golden)
    cand, smap, shift = register(gl, cand)
    cl = luma(cand)
    masks = region_masks(case)
    # The caption region is mostly empty ground; judge it where either image draws something, or a swapped caption
    # drowns in the background.
    masks["caption"] = masks["caption"] & pc.dilate(drawn(golden) | drawn(cand), 6)
    scores = {"shift": list(shift), "ssim_circle": float(smap[CIRCLE].mean()),
              **{f"ssim_{r}": float(smap[m].mean()) if m.any() else 1.0 for r, m in masks.items()}}
    fails = []
    if scores["ssim_circle"] < th["circle"]:
        fails.append({"check": "circle", "message": f"whole glass SSIM {scores['ssim_circle']:.3f} < {th['circle']}"})
    for r in REGIONS:
        if scores[f"ssim_{r}"] < th[r]:
            what = ring_reason(golden, cand, masks["ring"]) if r == "ring" else REGION_WHAT[r]
            fails.append({"check": r, "message": f"{what}: SSIM {scores[f'ssim_{r}']:.3f} < {th[r]}"})
    eyes = eyes_box(golden, case)
    if eyes is not None:
        scores["ssim_eyes"] = float(smap[eyes].mean())
        eyes_th = th.get("eyes", th["bob"])
        if scores["ssim_eyes"] < eyes_th:
            fails.append({"check": "eyes", "message": f"eyes differ: SSIM {scores['ssim_eyes']:.3f} < {eyes_th}"})
    fails += seams(golden, cand, case)
    boxes = text_boxes(case["id"])
    extra_region = CIRCLE & ~region_masks(case)["bob"] & ~STATUS & (RADIUS < RING_INNER - 4)
    ge, ce = extras(golden, extra_region, boxes), extras(cand, extra_region, boxes)
    # The text colour (white, coral for Oops): the brightest pixels of each golden text line, golden vs candidate.
    def text_rgb(img: np.ndarray, box) -> np.ndarray:
        x0, y0, x1, y1 = int(box[0]), int(box[1]), int(box[2]) + 1, int(box[3]) + 1
        sub = img[y0:y1, x0:x1].reshape(-1, 3).astype(float)
        top = sub[np.argsort(sub.sum(axis=1))[-12:]]
        return top.mean(axis=0)

    for box in boxes:
        gc, cc = text_rgb(golden, box), text_rgb(cand, box)
        if float(np.abs(gc - cc).max()) > 45:
            fails.append({"check": "text-colour", "message": f"a text line is rgb({int(cc[0])},{int(cc[1])},{int(cc[2])}), the golden's is rgb({int(gc[0])},{int(gc[1])},{int(gc[2])})"})
            break
    scores["extras"] = [ge, ce]
    if ge != ce:
        fails.append({"check": "extras", "message": f"{ce} non-text marks outside Bob and the chips (page dots, sparkles, props), the golden has {ge}"})

    gfg, cfg = foreground(golden), foreground(cand)
    skipped = []
    gg, cg = glyphs(golden), glyphs(cand)
    if status_arc(gg):
        skipped.append("status-arc (the golden has a prop or Bob on the arc)")
    else:
        fails += status_arc(cg, expect=icon_count(gg))
    # The owner's top-gap rule (2026-10-17): Bob keeps topGapMin px (bob_tokens.json) clear of every status-icon disc.
    if pc.check_top_gap(gfg, RADIUS):
        skipped.append("top-gap (the golden itself comes too close to the arc)")
    else:
        fails += pc.check_top_gap(cfg, RADIUS)
    gx, cx = body_x(gfg, case), body_x(cfg, case)
    scores["body_x"] = None if cx is None else round(cx, 1)
    if cx is None or gx is None or abs(cx - gx) > 3:
        fails.append({"check": "bob-centre", "message": f"body centroid x {cx and round(cx, 1)} vs golden {gx and round(gx, 1)} (+-3)"})
    # The glass rim is ground or the bezel's black edge; past r 178 the candidate may draw only where the golden does.
    stray = drawn(cand) & (RADIUS > 178) & CIRCLE & ~drawn(golden) & (np.abs(gl - cl) > 40)
    if int(stray.sum()) > 3:
        fails.append({"check": "clip", "message": f"{int(stray.sum())} px drawn outside r 178"})
    if case.get("scale", 1) != 1:
        skipped.append("caption-lines (a text view, not a caption)")
    else:
        # Text below Bob's feet line (tokens feetY, plus his shadow): placement_check's fixed CAPTION_Y band can reach
        # Bob himself when the token grid moves him down.
        below = [c for c in pc.caption_text_components(cfg, RADIUS) if int(c[:, 0].min()) > FEET_Y + 8]
        lines = pc.group_into_lines(below)
        scores["caption_lines"] = len(lines)
        if len(lines) > 1:
            fails.append({"check": "caption-lines", "message": f"{len(lines)} caption lines, max 1"})
    g_ok, g_flip = logo_scores(gl, tpl, case)
    if g_ok >= 0.6 and g_ok > g_flip:  # the logo is visible in this golden pose: the candidate must read it too
        c_ok, c_flip = logo_scores(cl, tpl, case)
        scores["logo"], scores["logo_mirrored"] = round(c_ok, 3), round(c_flip, 3)
        if c_flip >= c_ok:
            fails.append({"check": "logo", "message": f"the bob logo is mirrored (mirror {c_flip:.2f} >= upright {c_ok:.2f})"})
        elif c_ok < 0.4:
            fails.append({"check": "logo", "message": f"the bob logo is missing (best match {c_ok:.2f} < 0.40)"})
    else:
        skipped.append("logo (not upright in the golden pose)")
    return {"id": case["id"], "pass": not fails, "scores": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in scores.items()},
            "failures": fails, "skipped": skipped}, smap


def score_line(s: dict) -> str:
    return "  ".join(f"{k} {s[f'ssim_{k}']:.3f}" for k in ("circle", *REGIONS) if f"ssim_{k}" in s)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--golden", type=Path, default=ROOT / "docs/waveshare/golden")
    ap.add_argument("--candidate", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    spec = json.loads((HERE / "cases.json").read_text(encoding="utf8"))
    th = thresholds(json.loads((args.golden / "manifest.json").read_text(encoding="utf8")))
    tpl = logo_template(args.golden)
    args.out.mkdir(parents=True, exist_ok=True)

    results = []
    for case in spec["cases"]:
        cpath = args.candidate / f"{case['id']}.png"
        if not cpath.exists():
            results.append({"id": case["id"], "pass": False, "scores": {}, "failures": [{"check": "render", "message": "no candidate render"}], "skipped": []})
            continue
        golden, cand = load(args.golden / f"{case['id']}.png"), load(cpath)
        golden[~CIRCLE] = 0
        cand[~CIRCLE] = 0
        res, smap = judge(case, golden, cand, tpl, th[case["id"]])
        heat = heatmap(cand, smap, region_masks(case))
        if not res["pass"]:
            Image.fromarray(heat).save(args.out / f"{case['id']}-heatmap.png")
        verdict = f"{case['id']}: {'PASS' if res['pass'] else 'FAIL'}  {score_line(res['scores'])}"
        reasons = "; ".join(f["message"] for f in res["failures"])
        sheet(golden, cand, heat, verdict, reasons, res["pass"]).save(args.out / f"{case['id']}-sheet.png")
        results.append(res)

    report = {"pass": all(r["pass"] for r in results), "thresholds": th, "cases": results}
    with open(args.out / "report.json", "w", encoding="utf8", newline="\n") as f:
        f.write(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for r in results:
            line = f"{'PASS' if r['pass'] else 'FAIL'} {r['id']:<18} {score_line(r['scores']) if r['scores'] else ''}"
            print(line + "".join(f"\n       - [{f['check']}] {f['message']}" for f in r["failures"]))
        print(f"{sum(r['pass'] for r in results)}/{len(results)} cases pass")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

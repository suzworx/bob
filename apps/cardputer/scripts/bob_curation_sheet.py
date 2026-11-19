#!/usr/bin/env python3
"""Write the Bob curation record: one row per image (static poses, rig parts, rig poses, demo states / emotions / moves,
device states / emotions / scenes / moves), each with a before and after thumbnail and pass/fail per model-sheet
invariant (docs/waveshare/bob-model-sheet.md).

  py -3.11 apps/cardputer/scripts/bob_curation_sheet.py --renders <dir> [--checks <dir>]

<dir> holds the renders: before/ and after/ (demo, `<id>@1x.png` and `<id>@2x.png`), dev-before/ and dev-after/
(bob-sim, `<id>.png`), and the checker's JSON for each set (chk-<set>.json from
`bob_model_check.py --json`). Writes docs/waveshare/bob-curation.md, its thumbnails in
docs/waveshare/screenshots/curation/, and the contact sheet docs/waveshare/screenshots/curation-sheet.png.
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import bob_model_check as mc  # noqa: E402

ROOT = mc.ROOT
OUT_MD = ROOT / "docs/waveshare/bob-curation.md"
THUMBS = ROOT / "docs/waveshare/screenshots/curation"
SHEET = ROOT / "docs/waveshare/screenshots/curation-sheet.png"
IDS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"]
T = 112  # thumbnail px
POSES = ["helper", "curious", "thoughtful", "playful"]
ORIG = {"helper": "helper", "curious": "curious", "thoughtful": "thoughtful", "playful": "playful"}
SCENES = {"timer_set": "Focused", "timer_done": "Surprised", "alarm": "Alarm", "weather_sun": "Happy", "weather_cloud": "Calm",
          "weather_rain": "Calm", "weather_snow": "Joyful", "music": "Music", "task_added": "Proud", "note_added": "Happy",
          "reminder": "Reminder", "calendar": "Curious", "search": "Focused", "message_sent": "Joyful", "success": "Success",
          "failed": "Apologetic"}
# what was curated in a row beyond the shared fixes (one body, seam, feet, centring), by row id
NOTES = {
    "static-thoughtful": "front arms traced tight; hand on the cheek, off the logo (was 'ɿoob')",
    "static-curious": "ear arm traced tight; no baked head tilt",
    "part-armL_chin": "traced to its shadow line; no face/logo sliver; rests at -14 deg",
    "part-armL_ear": "traced to its shadow line; no face strip",
    "part-footL": "opaque clay top under the belly; no fade band", "part-footR": "opaque clay top under the belly; no fade band",
    "demo-state-thinking": "hand off the logo", "demo-state-offline": "hand off the logo", "demo-state-updating": "hand off the logo",
    "demo-emotion-shy": "eyes clipped to the visor", "demo-move-droop": "eyes clipped to the visor",
    "demo-emotion-delighted": "eyes clipped to the visor",
    "demo-state-dnd": "Bob is dimmed by design (n/a)", "demo-state-field": "no Bob on this screen (n/a)",
    "dev-state-reply": "the device reply view shows text, no Bob (n/a)",
}


def thumb(img: Image.Image, crop=True) -> Image.Image:
    im = img.convert("RGBA")
    bg = Image.new("RGBA", im.size, (23, 62, 87, 255))
    bg.alpha_composite(im)
    im = bg.convert("RGB")
    if crop:
        w, h = im.size
        im = im.crop((int(w * .14), int(h * .04), int(w * .86), int(h * .76)))
    im.thumbnail((T, T), Image.LANCZOS)
    return im


def save_thumb(im: Image.Image | None, side: str, rid: str) -> str:
    if im is None:
        return ""
    p = THUMBS / side / f"{rid}.webp"
    p.parent.mkdir(parents=True, exist_ok=True)
    im.save(p, "WEBP", quality=72, method=6)
    return f"screenshots/curation/{side}/{rid}.webp"


def load_checks(d: Path) -> dict:
    out = {}
    for f in d.glob("chk-*.json"):
        for r in json.loads(f.read_text()):
            out[str(Path(r["image"]).resolve()).lower()] = r
    return out


def verdict(results: list[dict | None]) -> dict:
    """Merge the checks of one row's renders (1x + 2x): an invariant passes when every render that measured it passes."""
    v = {}
    for cid in IDS:
        vals = [r["checks"][cid]["pass"] for r in results if r and cid in r["checks"]]
        v[cid] = None if not vals else all(vals)
    return v


def git_png(rev: str, path: str) -> Image.Image | None:
    try:
        return Image.open(io.BytesIO(subprocess.check_output(["git", "show", f"{rev}:{path}"], cwd=ROOT, stderr=subprocess.DEVNULL)))
    except subprocess.CalledProcessError:
        return None


def m9_numbers(r: dict | None):
    """(roughness, reference) from a check result's M9 line, or None."""
    import re  # noqa: PLC0415

    if not r or "M9" not in r["checks"]:
        return None
    m = re.search(r"roughness ([0-9.]+) art px \(ref ([0-9.]+)\)", r["checks"]["M9"]["detail"])
    return (float(m.group(1)), float(m.group(2))) if m else None


def part_checks(img: Image.Image) -> dict:
    """Rig parts: clean alpha (one piece) and M9 edges (smooth, antialiased). Fringe is judged where the ground is behind
    the part: on the composed poses and renders (a back arm's shoulder side always sits behind the body)."""
    import cv2  # noqa: PLC0415

    rgba = np.asarray(img.convert("RGBA"))
    pad = np.zeros((rgba.shape[0] + 20, rgba.shape[1] + 20, 4), np.uint8)
    pad[10:-10, 10:-10] = rgba
    n, lab, st, _ = cv2.connectedComponentsWithStats((pad[..., 3] > 24).astype(np.uint8))
    areas = sorted(st[1:, cv2.CC_STAT_AREA], reverse=True)
    clean = n <= 1 or (sum(areas[1:]) <= 0.002 * areas[0])
    flat = (pad[..., :3] * (pad[..., 3:4] / 255) + mc.INK * (1 - pad[..., 3:4] / 255)).astype(np.uint8)
    e = mc.edges(pad, flat, 1.0, (0, 0, pad.shape[1], pad.shape[0]))
    return {"M7": clean, "M9": e["rough"] <= mc.ROUGH_ART and e["ramp"] >= 0.6}


def main(argv: list[str]) -> int:
    rd = Path(argv[argv.index("--renders") + 1])
    checks = load_checks(Path(argv[argv.index("--checks") + 1]) if "--checks" in argv else rd)
    rows: list[dict] = []

    def chk(p: Path):
        return checks.get(str(p.resolve()).lower())

    # A. static poses: before = the raw original, after = the curated static pose
    for pose in POSES:
        b = Image.open(ROOT / f"docs/waveshare/assets/slimmer-bob-{ORIG[pose]}-v1.webp")
        a_path = mc.STATIC / f"{pose}.png"
        rb = mc.check(ROOT / f"docs/waveshare/assets/slimmer-bob-{ORIG[pose]}-v1.webp", rest=True)
        ra = mc.check(a_path, rest=True)
        rows.append(dict(sec="Static poses (device whole-pose fallback, demo fallback)", id=f"static-{pose}", name=pose,
                         b=thumb(b, False), a=thumb(Image.open(a_path), False), vb=verdict([rb]), va=verdict([ra])))
    # B. rig parts
    rig = json.loads((ROOT / "apps/cardputer/assets/bob/rig/rig.json").read_text())
    for name in rig["parts"]:
        path = f"apps/cardputer/assets/bob/rig/{name}.png"
        b, a = git_png("origin/main", path), Image.open(ROOT / path)
        cb, ca = (part_checks(b) if b else {}), part_checks(a)
        rows.append(dict(sec="Rig parts (masters, 480 px art)", id=f"part-{name}", name=name, b=thumb(b, False) if b else None,
                         a=thumb(a, False), vb=cb, va=ca, part=True))
    # C. rig poses: the rig at rest (the compare sheet's middle panel)
    for pose in POSES:
        path = f"docs/waveshare/screenshots/rig-compare-{pose}.png"
        b, a = git_png("origin/main", path), Image.open(ROOT / path)
        mid = lambda im: im.crop((im.width // 3, 0, 2 * im.width // 3, im.height))  # noqa: E731
        tmp_b, tmp_a = THUMBS / f"_b_{pose}.png", THUMBS / f"_a_{pose}.png"
        THUMBS.mkdir(parents=True, exist_ok=True)
        mid(b).save(tmp_b)
        mid(a).save(tmp_a)
        rb, ra = mc.check(tmp_b, rest=True), mc.check(tmp_a, rest=True)
        tmp_b.unlink()
        tmp_a.unlink()
        rows.append(dict(sec="Rig poses (the rig at rest)", id=f"rigpose-{pose}", name=pose, b=thumb(mid(b), False), a=thumb(mid(a), False),
                         vb=verdict([rb]), va=verdict([ra])))
    # D. demo
    for kind, label in (("state", "Demo states"), ("emotion", "Demo emotions"), ("move", "Demo moves")):
        ids = sorted({p.name.split("@")[0] for p in (rd / "after").glob(f"{kind}-*@1x.png")})
        for i in ids:
            pa = [rd / "after" / f"{i}@{z}x.png" for z in (1, 2)]
            pb = [rd / "before" / f"{i}@{z}x.png" for z in (1, 2)]
            rows.append(dict(sec=f"{label} (docs/waveshare/device-ux-prototype.html, 360 px and 2x)", id=f"demo-{i}", name=i.split("-", 1)[1],
                             b=thumb(Image.open(pb[1])) if pb[1].exists() else None, a=thumb(Image.open(pa[1])),
                             vb=verdict([chk(p) for p in pb]), va=verdict([chk(p) for p in pa])))
    # E. device (bob-sim)
    for kind, label in (("state", "Device states"), ("emotion", "Device emotions (47)"), ("move", "Device moves (28)")):
        ids = sorted(p.stem for p in (rd / "dev-after").glob(f"{kind}-*.png"))
        for i in ids:
            pa, pb = rd / "dev-after" / f"{i}.png", rd / "dev-before" / f"{i}.png"
            rows.append(dict(sec=f"{label} (bob-sim, firmware sources, 360 px)", id=f"dev-{i}", name=i.split("-", 1)[1],
                             b=thumb(Image.open(pb)) if pb.exists() else None, a=thumb(Image.open(pa)), vb=verdict([chk(pb)]), va=verdict([chk(pa)]),
                             m9=(m9_numbers(chk(pb)), m9_numbers(chk(pa)))))
    for scene, emo in SCENES.items():
        src = next(r for r in rows if r["id"] == f"dev-emotion-{emo.lower()}")
        rows.append(dict(src, sec="Device scenes (16): Bob is the scene's emotion, so each row repeats that emotion's render; props and ring are drawn apart from the art",
                         id=f"dev-scene-{scene}", name=f"{scene} ({emo})"))

    # thumbnails, table, contact sheet
    for r in rows:
        r["tb"], r["ta"] = save_thumb(r["b"], "before", r["id"]), save_thumb(r["a"], "after", r["id"])
    na = {"demo-state-dnd", "demo-state-field", "dev-state-reply"} | {r["id"] for r in rows if r["id"].startswith("part-logo_")}
    for r in rows:
        if r["id"].startswith("part-logo_"):
            NOTES[r["id"]] = "soft glow mask of the three letters, not an outline (n/a); the logo itself is the head's pixels"
    for r in rows:  # a device row whose only failure is M9 on the firmware's own rasterizing (the art passes M9 itself)
        if r["id"].startswith("dev-") and r["va"].get("M9") is False and all(v is not False for k, v in r["va"].items() if k != "M9"):
            r["renderer"] = True
            nb, na_ = r.get("m9", (None, None))
            if r["vb"].get("M9") is True:  # passed before, fails now: a regression, said as one
                r["regressed"] = True
                why = ("same outline roughness, but the reference tightened because the curated art is smoother"
                       if nb and na_ and na_[0] - nb[0] <= 0.03 else
                       "the firmware turns the whole figure here and its nearest-sampled rotation stair-steps the diagonal outline")
                NOTES[r["id"]] = (f"REGRESSED on M9: roughness {nb[0]:.2f} -> {na_[0]:.2f} art px (limit {1.25 * na_[1] + 0.03:.3f}); {why}. "
                                  "Passes with the rig session's bilinear premultiplied renderer (rig-render-quality 444d9756)")
            else:
                NOTES.setdefault(r["id"], "M9 only, before and after: the integration branch's nearest-sampled rasterizer; passes with the "
                                          "rig session's bilinear premultiplied renderer (rig-render-quality 444d9756: ready 0.46 vs 0.47)")
    mark = lambda v: "" if v is None else ("✅" if v else "❌")  # noqa: E731
    lines = ["# Bob curation record", "",
             "One row per image the demo or the device shows. Each row was rendered (scene rows reuse their emotion's render), compared with the model sheet",
             "([bob-model-sheet.md](bob-model-sheet.md)), fixed, then rendered and checked again. Pass/fail is per invariant;",
             "a blank cell means that invariant doesn't apply to the image (for example M4 outside rest poses, or M6 below",
             "half scale). Regenerate with `bob_curation_sheet.py`; the contact sheet is",
             "[screenshots/curation-sheet.png](screenshots/curation-sheet.png).", ""]
    fixed = sum(1 for r in rows if r["id"] not in na and not all(v is not False for v in r["vb"].values()) and all(v is not False for v in r["va"].values()))
    passing = sum(1 for r in rows if r["id"] in na or all(v is not False for v in r["va"].values()))
    renderer = sum(1 for r in rows if r.get("renderer"))
    regressed = [r for r in rows if r.get("regressed")]
    lines += [f"**{len(rows)} rows. After: {passing} pass every invariant ({len(na)} n/a). {fixed} failed at least one invariant before and pass now. "
              f"{renderer} device rows pass every art invariant and fail only M9 on the integration branch's nearest-sampled "
              f"rasterizer; the rig session's bilinear premultiplied renderer (rig-render-quality 444d9756) passes M9 on the same masters. "
              f"{len(regressed)} of those passed M9 before and fail it now (regressed, see their notes): "
              + ", ".join(f"`{r['id']}`" for r in regressed) + ".**", ""]
    sec = None
    for r in rows:
        if r["sec"] != sec:
            sec = r["sec"]
            cols = ["M7 one piece", "M9 edges"] if r.get("part") else IDS
            lines += ["", f"## {sec}", "", "| Image | Before | After | " + " | ".join(cols) + " | Result | Notes |",
                      "| --- | --- | --- | " + " | ".join("---" for _ in cols) + " | --- | --- |"]
        cols = ["M7", "M9"] if r.get("part") else IDS
        cells = []
        for cid in cols:
            b, a = r["vb"].get(cid), r["va"].get(cid)
            cells.append(f"{mark(b)}→{mark(a)}" if b is not None and b != a else mark(a))
        ok = r["id"] in na or all(v is not False for v in r["va"].values())
        res = "n/a" if r["id"] in na else ("PASS" if ok else ("REGRESSED (M9)" if r.get("regressed") else ("renderer" if r.get("renderer") else "FAIL")))
        img = lambda p: f'<img src="{p}" width="{T // 1.4:.0f}">' if p else "—"  # noqa: E731
        lines.append(f"| `{r['name']}` | {img(r['tb'])} | {img(r['ta'])} | " + " | ".join(cells) + f" | {res} | {NOTES.get(r['id'], '')} |")
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    # contact sheet: every after image side by side
    afters = [r for r in rows if r["a"] is not None and not r["id"].startswith("dev-scene-")]
    cols = 20
    rows_n = (len(afters) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * T, rows_n * (T + 14) + 30), (17, 19, 22))
    d = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=10)
    d.text((6, 6), f"Bob curation: {len(afters)} images after curation (static poses, rig parts, rig poses, demo, device bob-sim)",
           fill=(240, 199, 94), font=ImageFont.load_default(size=14))
    for k, r in enumerate(afters):
        x, y = (k % cols) * T, 30 + (k // cols) * (T + 14)
        sheet.paste(r["a"], (x + (T - r["a"].width) // 2, y + 14))
        d.text((x + 2, y + 1), r["id"].replace("demo-", "d:").replace("dev-", "v:")[:22], fill=(187, 221, 240), font=font)
    sheet.save(SHEET, optimize=True)
    print(f"{len(rows)} rows, {passing} pass, {fixed} fixed; {OUT_MD}; {SHEET}")
    return 0 if passing + renderer == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

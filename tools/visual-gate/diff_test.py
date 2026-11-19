"""Tests for diff.py: each check fires on the defect it names, starting from the committed goldens. The defects
include the ones the owner photographed on the device (2026-10-16): a mirrored "bob" logo, the icon arc
off-centre to the right, icons stacked down the right side, part seams through Bob, and a "Firmware x.y.z"
caption on READY.
Run with: py -3.11 -I tools/visual-gate/diff_test.py
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

# -I omits the script's own directory from sys.path; add it back for the sibling modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageDraw

import diff
import faithful

GOLDEN = diff.ROOT / "docs/waveshare/golden"
SPEC = json.loads((diff.HERE / "cases.json").read_text(encoding="utf8"))
TH = diff.thresholds(json.loads((GOLDEN / "manifest.json").read_text(encoding="utf8")))
TPL = diff.logo_template(GOLDEN)
GROUND = np.array(diff.pc.GROUND_COLOR, dtype=np.float64)


def case(cid: str) -> dict:
    return next(c for c in SPEC["cases"] if c["id"] == cid)


def golden(cid: str = "ready") -> np.ndarray:
    img = diff.load(GOLDEN / f"{cid}.png")
    img[~diff.CIRCLE] = 0
    return img


def judge(cand: np.ndarray, cid: str = "ready") -> dict:
    return diff.judge(case(cid), golden(cid), cand, TPL, TH[cid])[0]


def checks(result: dict) -> set[str]:
    return {f["check"] for f in result["failures"]}


def icons(img: np.ndarray) -> list[np.ndarray]:
    return diff._icons(diff.glyphs(img))


class GoodCandidates(unittest.TestCase):
    def test_identical_passes(self) -> None:
        r = judge(golden())
        self.assertTrue(r["pass"], r["failures"])
        self.assertAlmostEqual(r["scores"]["ssim_circle"], 1.0, places=6)

    def test_faithful_port_passes_every_case(self) -> None:
        for c in SPEC["cases"]:
            g = golden(c["id"])
            f = faithful.rgb565(g)
            f[~diff.CIRCLE] = 0
            r = judge(f, c["id"])
            self.assertTrue(r["pass"], (c["id"], r["failures"]))


    def test_faithful_port_one_pixel_off_passes(self) -> None:
        for cid, shift in (("ready", (1, 0)), ("reply", (0, -1)), ("listening", (-1, 1)), ("scene-hop-apex", (1, 1))):
            f = faithful.rgb565(np.roll(golden(cid), shift, axis=(0, 1)))
            f[~diff.CIRCLE] = 0
            r = judge(f, cid)
            self.assertTrue(r["pass"], (cid, r["failures"]))


class OwnerPhotographedDefects(unittest.TestCase):
    def test_mirrored_logo_fails_as_logo(self) -> None:
        cand = golden()
        x0, y0, x1, y1 = diff.LOGO_BOX
        cand[y0:y1, x0:x1] = cand[y0:y1, x0:x1][:, ::-1]
        r = judge(cand)
        self.assertIn("logo", checks(r))
        self.assertGreater(r["scores"]["logo_mirrored"], r["scores"]["logo"])

    def test_arc_off_centre_right_fails_as_status_arc(self) -> None:
        cand = golden()
        cand = np.where(diff.STATUS[..., None], np.roll(cand, 6, axis=1), cand)
        self.assertIn("status-arc", checks(judge(cand)))

    def test_icons_stacked_down_the_right_fails_as_status_arc(self) -> None:
        g = golden()
        cand = np.where(diff.STATUS[..., None], GROUND, g)
        for i, comp in enumerate(icons(g)):
            ys, xs = comp[:, 0], comp[:, 1]
            dy, dx = 90 + 26 * i - ys.min(), 300 - xs.min()
            cand[ys + dy, xs + dx] = g[ys, xs]
        r = judge(cand)
        self.assertIn("status-arc", checks(r))
        self.assertTrue(any("icons on the top arc" in f["message"] or "no status icons" in f["message"] for f in r["failures"]))

    def test_part_seam_fails_as_seam(self) -> None:
        cand = golden()
        cand[diff.FEET_Y - 140, 135:225] = GROUND  # a 1 px gap between two rig parts, across the smooth forehead
        r = judge(cand)
        self.assertIn("seam", checks(r))

    def test_firmware_caption_on_ready_fails_as_caption(self) -> None:
        cand = golden()
        cand[diff.region_masks(case("ready"))["caption"]] = GROUND  # the demo's "Hi, I'm Bob" is gone
        img = Image.fromarray(cand.astype(np.uint8))
        ImageDraw.Draw(img).text((128, 312), "Firmware 0.144.0", fill=(255, 253, 246))
        r = judge(np.asarray(img).astype(np.float64))
        self.assertIn("caption", checks(r))


class StructureChecks(unittest.TestCase):
    def test_top_button_near_the_arc_fails_as_top_gap(self) -> None:
        cand = golden()
        # the top button stretched up toward the chips: still one blob with Bob, 3 px from the middle disc
        disc_bottom = int(diff.C + 0.5 - diff.TOK["statusArc"]["radius"] + diff.TOK["statusArc"]["discDiameter"] / 2)
        cand[disc_bottom + 3:diff.FEET_Y - 150, 176:184] = (240, 199, 94)
        r = judge(cand)
        self.assertIn("top-gap", checks(r), r["failures"])

    def test_a_ring_touching_r164_is_not_an_icon(self) -> None:
        # The ring starts at ringInner (r ~164.5). A radius band reaching r 165 counted its glow as icons, so no ring
        # setting satisfied both the ring and the icon count. Icons are counted inside the chip discs only.
        g = golden()
        cand = g.copy()
        cand[(diff.RADIUS >= 164) & (diff.RADIUS < 167) & diff.CIRCLE] = (187, 221, 240)  # a lit sky ring from r 164
        self.assertEqual(diff.icon_count(diff.glyphs(cand)), diff.icon_count(diff.glyphs(g)))
        self.assertGreater(diff.icon_count(diff.glyphs(g)), 0)
        self.assertNotIn("status-arc", checks(judge(cand)))
        self.assertLess(float(diff.RADIUS[diff.CHIP_DISCS].max()), 164.0)

    def test_cases_place_bob_as_the_design_tokens_do(self) -> None:
        tok = json.loads((diff.ROOT / "design/bob/tokens.json").read_text(encoding="utf8"))
        for c in SPEC["cases"]:
            want = tok["states"].get(c["state"], {}).get("bob", {"scale": 1, "rise": 0}) if c["kind"] == "state" else {"scale": 1, "rise": 0}
            self.assertEqual((c.get("scale", 1), c.get("rise", 0)), (want.get("scale", 1), want.get("rise", 0)), c["id"])

    def test_bob_moved_off_centre_fails(self) -> None:
        cand = golden()
        bob = diff.bob_mask(case("ready"))[..., None]
        cand = np.where(bob, np.roll(np.where(bob, cand, GROUND), 8, axis=1), cand)
        r = judge(cand)
        self.assertIn("bob-centre", checks(r))
        self.assertIn("bob", checks(r))

    def test_second_caption_line_fails(self) -> None:
        # The check counts text rows below the token feet line (y 298 now, the caption at 316): ten free rows are too few for two
        # lines apart, so it is exercised with the feet line and the caption band raised, where the room exists.
        cand = golden("scene-hop-apex")
        cand[285:293, 150:210] = 250  # a second line of "text" above the caption
        feet, band = diff.FEET_Y, diff.pc.CAPTION_Y
        diff.FEET_Y, diff.pc.CAPTION_Y = 270, 270
        try:
            self.assertIn("caption-lines", checks(judge(cand, "scene-hop-apex")))
        finally:
            diff.FEET_Y, diff.pc.CAPTION_Y = feet, band

    def test_missing_page_dots_fail(self) -> None:
        # The reply card's three page dots erased: a non-text mark the golden has and the candidate lacks.
        cand = golden("reply")
        cand[255:272, 150:210] = GROUND
        self.assertIn("extras", checks(judge(cand, "reply")))

    def test_an_extra_mark_fails(self) -> None:
        # A bright dot where the golden draws only ground (a stray prop).
        cand = golden("ready")
        cand[118:128, 280:290] = 250
        self.assertIn("extras", checks(judge(cand, "ready")))

    def test_caption_in_the_wrong_colour_fails(self) -> None:
        # "Hi, I'm Bob" drawn yellow instead of paper white.
        cand = golden("ready")
        box = diff.text_boxes("ready")[0]
        x0, y0, x1, y1 = int(box[0]), int(box[1]), int(box[2]) + 1, int(box[3]) + 1
        region = cand[y0:y1, x0:x1]
        bright = region.sum(axis=-1) > 600
        region[bright] = (240, 199, 94)
        self.assertIn("text-colour", checks(judge(cand, "ready")))

    def test_content_outside_r178_fails(self) -> None:
        cand = golden()
        cand[(diff.RADIUS > 178) & diff.CIRCLE & (diff.YY > 200) & (diff.XX > 300)] = 250
        self.assertIn("clip", checks(judge(cand)))

    def test_missing_ring_is_named(self) -> None:
        cand = golden("listening")
        cand[diff.region_masks(case("listening"))["ring"]] = GROUND
        r = judge(cand, "listening")
        self.assertTrue(any(f["check"] == "ring" and "ring missing" in f["message"] for f in r["failures"]), r["failures"])

    def test_different_eyes_are_named(self) -> None:
        cand = golden()
        box = diff.eyes_box(golden(), case("ready"))
        ys, xs = np.nonzero(box)
        self.assertLess(int(box.sum()), 4000)  # the visor, not the screen
        self.assertTrue(diff.bob_mask(case("ready"))[ys, xs].all())
        cand[box] = np.roll(cand, 4, axis=0)[box]
        self.assertIn("eyes", checks(judge(cand)))

    def test_stale_ceiling_is_refused(self) -> None:
        manifest = json.loads((GOLDEN / "manifest.json").read_text(encoding="utf8"))
        manifest["gate"]["goldens"]["ready"] = "0" * 64
        with self.assertRaises(SystemExit):
            diff.thresholds(manifest)


if __name__ == "__main__":
    unittest.main()

"""Tests for placement_check.py: synthetic pass/fail cases for each check, plus a
few real screenshots (apps/cardputer/scripts/placement_fixtures/) as regression
fixtures. Run with: py -3.11 -I apps/cardputer/scripts/placement_check_test.py
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

# -I omits the script's own directory from sys.path; add it back explicitly so the
# sibling placement_check module (not an untrusted/downloaded file) can be imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw

import placement_check as pc

FIXTURES = Path(__file__).resolve().parent / "placement_fixtures"
IVORY = (238, 218, 205)
VISOR = (41, 40, 41)
EYE = (246, 186, 57)
ICON = (230, 220, 210)
DOT = (230, 100, 90)
TEXT = (230, 230, 230)


def blank_canvas() -> Image.Image:
    return Image.new("RGB", (pc.SCREEN, pc.SCREEN), pc.GROUND_COLOR)


def draw_status_icons(draw: ImageDraw.ImageDraw, center_x: int = 180, y: int = 38) -> None:
    xs = [center_x - 53, center_x - 33, center_x - 13, center_x + 13, center_x + 33]
    for x in xs[:3]:
        draw.ellipse([x - 5, y - 5, x + 5, y + 5], fill=DOT)
    draw.rectangle([xs[3] - 6, y - 8, xs[3] + 6, y + 8], fill=ICON)
    draw.rectangle([xs[4] - 11, y - 5, xs[4] + 11, y + 5], fill=ICON)


BODY_CY = pc.BODY_CENTER[1] + 7  # the drawn shape's mass centroid lands ~2 px above its centre: inside the tolerance
VISOR_CY = BODY_CY - 55


def draw_body(draw: ImageDraw.ImageDraw, cx: int = 180, cy: int = BODY_CY, with_arm: bool = True) -> None:
    # A symmetric ellipse's mass centroid is its own centre, so this lands exactly on (cx, cy).
    draw.ellipse([cx - 80, cy - 78, cx + 80, cy + 78], fill=IVORY)
    if with_arm:
        # A small, roughly-symmetric raised arm either side keeps the net centroid close to (cx, cy).
        draw.ellipse([cx + 68, cy - 45, cx + 98, cy - 15], fill=IVORY)
        draw.ellipse([cx - 98, cy - 45, cx - 68, cy - 15], fill=IVORY)


def draw_visor(draw: ImageDraw.ImageDraw, cx: int = 180, cy: int = VISOR_CY) -> tuple[int, int]:
    draw.rounded_rectangle([cx - 35, cy - 15, cx + 35, cy + 15], radius=12, fill=VISOR)
    return cx, cy


def draw_eyes(draw: ImageDraw.ImageDraw, cx: int, cy: int, dx: int = 15) -> None:
    draw.ellipse([cx - dx - 6, cy - 6, cx - dx + 6, cy + 6], fill=EYE)
    draw.ellipse([cx + dx - 6, cy - 6, cx + dx + 6, cy + 6], fill=EYE)


def draw_caption_line(draw: ImageDraw.ImageDraw, y: int = 286, n_chars: int = 18, cx: int = 180) -> None:
    total_w = n_chars * 12
    x0 = cx - total_w // 2
    for i in range(n_chars):
        x = x0 + i * 12
        draw.rectangle([x, y - 7, x + 8, y + 7], fill=TEXT)


def save(img: Image.Image) -> Path:
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    img.save(tmp.name)
    return Path(tmp.name)


def good_image(caption: bool = True) -> Image.Image:
    img = blank_canvas()
    draw = ImageDraw.Draw(img)
    draw_status_icons(draw)
    draw_body(draw)
    vx, vy = draw_visor(draw)
    draw_eyes(draw, vx, vy)
    if caption:
        draw_caption_line(draw)
    return img


def violations_of(result: dict) -> set[str]:
    return {v["check"] for v in result["violations"]}


class PlacementCheckTest(unittest.TestCase):
    def analyze(self, img: Image.Image) -> dict:
        path = save(img)
        try:
            return pc.analyze(path)
        finally:
            path.unlink(missing_ok=True)

    def checks_of(self, img: Image.Image) -> list[str]:
        return [v["check"] for v in self.analyze(img)["violations"]]

    def test_good_image_passes(self):
        result = self.analyze(good_image())
        self.assertTrue(result["ok"], result["violations"])
        self.assertEqual(result["mode"], "normal")

    def test_off_centre_body_fails_centroid_only(self):
        img = blank_canvas()
        draw = ImageDraw.Draw(img)
        draw_status_icons(draw)
        shift = 30
        draw_body(draw, cx=180 + shift, with_arm=False)
        vx, vy = draw_visor(draw, cx=180 + shift)
        draw_eyes(draw, vx, vy)
        draw_caption_line(draw, cx=180 + shift)
        result = self.analyze(img)
        self.assertFalse(result["ok"])
        self.assertEqual(violations_of(result), {"body-centroid"})

    def test_diagonal_status_icons_fail_status_row_only(self):
        img = blank_canvas()
        draw = ImageDraw.Draw(img)
        draw_status_icons(draw, center_x=230)
        draw_body(draw)
        vx, vy = draw_visor(draw)
        draw_eyes(draw, vx, vy)
        draw_caption_line(draw)
        result = self.analyze(img)
        self.assertFalse(result["ok"])
        self.assertIn("status-row-centre", violations_of(result))
        self.assertNotIn("body-centroid", violations_of(result))
        self.assertNotIn("eyes-in-visor", violations_of(result))

    def test_eye_outside_visor_fails_eyes_check_only(self):
        img = blank_canvas()
        draw = ImageDraw.Draw(img)
        draw_status_icons(draw)
        draw_body(draw, with_arm=False)
        vx, vy = draw_visor(draw)
        draw.ellipse([vx - 29, vy - 6, vx - 17, vy + 6], fill=EYE)  # inside visor
        draw.ellipse([vx + 45, vy - 6, vx + 57, vy + 6], fill=EYE)  # well outside the visor
        draw_caption_line(draw)
        result = self.analyze(img)
        self.assertFalse(result["ok"])
        self.assertIn("eyes-in-visor", violations_of(result))
        self.assertNotIn("body-centroid", violations_of(result))

    def test_clipped_content_fails_clipped_only(self):
        img = good_image()
        draw = ImageDraw.Draw(img)
        draw.rectangle([5, 5, 25, 25], fill=IVORY)  # corner blob, well outside r=180
        result = self.analyze(img)
        self.assertFalse(result["ok"])
        self.assertIn("clipped", violations_of(result))
        self.assertNotIn("body-centroid", violations_of(result))

    def test_two_caption_lines_fail_caption_lines_only(self):
        img = blank_canvas()
        draw = ImageDraw.Draw(img)
        draw_status_icons(draw)
        draw_body(draw, with_arm=False)
        vx, vy = draw_visor(draw)
        draw_eyes(draw, vx, vy)
        draw_caption_line(draw, y=280)
        draw_caption_line(draw, y=306)
        result = self.analyze(img)
        self.assertFalse(result["ok"])
        self.assertEqual(violations_of(result), {"caption-lines"})

    def test_card_mode_skips_body_and_caption_checks(self):
        img = blank_canvas()
        draw = ImageDraw.Draw(img)
        draw_status_icons(draw)
        for row in range(6):
            draw_caption_line(draw, y=120 + row * 24)  # six lines, no visor anywhere
        result = self.analyze(img)
        self.assertEqual(result["mode"], "card")
        self.assertTrue(result["ok"], result["violations"])

    def test_button_near_status_discs_fails_top_gap_only(self):
        # owner 2026-10-17: the yellow top button never touches the status-icon arc (>= TOP_GAP_MIN px clear)
        img = good_image()
        draw = ImageDraw.Draw(img)
        top = int(180 - pc.ARC_RADIUS + pc.DISC_RADIUS + 2)  # 2 px below the centre disc: too close
        draw.rectangle([168, top, 192, top + 12], fill=(240, 199, 94))  # a button reaching up from the head
        draw.rectangle([176, top + 12, 184, BODY_CY - 70], fill=IVORY)  # joined to the body, clear of the visor's eye window
        checks = self.checks_of(img)
        self.assertIn("top-gap", checks)
        self.assertNotIn("eyes-in-visor", checks)

    def test_button_clear_of_status_discs_passes_top_gap(self):
        img = good_image()
        draw = ImageDraw.Draw(img)
        top = int(180 - pc.ARC_RADIUS + pc.DISC_RADIUS + pc.TOP_GAP_MIN + 3)
        draw.rectangle([168, top, 192, top + 12], fill=(240, 199, 94))
        draw.rectangle([176, top + 12, 184, BODY_CY - 70], fill=IVORY)
        self.assertNotIn("top-gap", self.checks_of(img))

    def test_rejects_wrong_size_image(self):
        img = Image.new("RGB", (100, 100), pc.GROUND_COLOR)
        path = save(img)
        try:
            with self.assertRaises(ValueError):
                pc.analyze(path)
        finally:
            path.unlink(missing_ok=True)


class RealFixtureTest(unittest.TestCase):
    """Regression fixtures: real device/sim 360x360 screenshots with the verdicts
    this tool currently gives them (docs/waveshare/placement-check.md explains why
    ready/help pass cleanly and listening does not)."""

    def test_ready_png_flags_only_the_old_body_height(self):
        # A device capture from before Bob moved 29 px down (tokens, 2026-10-20: the top button clears the status
        # arc). Everything else on it still passes; refresh it from the next device capture.
        result = pc.analyze(FIXTURES / "ready.png")
        self.assertEqual(result["mode"], "normal")
        self.assertEqual({v["check"] for v in result["violations"]}, {"body-centroid"})

    def test_help_card_passes(self):
        result = pc.analyze(FIXTURES / "help.png")
        self.assertEqual(result["mode"], "card")
        self.assertTrue(result["ok"], result["violations"])

    def test_listening_png_flags_body_centroid(self):
        result = pc.analyze(FIXTURES / "listening.png")
        self.assertEqual(result["mode"], "normal")
        self.assertEqual(violations_of(result), {"body-centroid"})


if __name__ == "__main__":
    unittest.main()

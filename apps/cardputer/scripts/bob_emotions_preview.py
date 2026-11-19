#!/usr/bin/env python3
"""Contact sheet of Bob's emotions: docs/cardputer/bob-emotions.png.

The emotion table is parsed from libs/bob-device/src/bob_emotion_table.h (one source of truth) and every
shape uses the same primitives and geometry as src/bob_face.cpp and src/bob_emotions.cpp
(filled circles, triangles, thick lines, arcs; no anti-aliasing). The poses are the real
images from lib/bob_art. `--check` re-renders and fails when the committed sheet differs.
"""
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
HEADER = ROOT.parent.parent / "libs" / "bob-device" / "src" / "bob_emotion_table.h"
SHEET = ROOT.parent.parent / "docs" / "cardputer" / "bob-emotions.png"
POSES = ["welcome", "curious", "thoughtful", "playful"]
FRAME_W, FRAME_H, POSE_X, POSE_Y, TILE_PHASE = 232, 240, 20, 24, 0.37


def rgb(h):
    return ((h >> 16) & 255, (h >> 8) & 255, h & 255)


def rgb565(v):
    return (((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31)


GROUND, VISOR, AMBER = rgb565(0x11EA), rgb565(0x2945), rgb(0xF5B83A)
INK, PAPER, YELLOW, SKY, GRASS, CORAL = (rgb(c) for c in (0x173E57, 0xFFFDF6, 0xF0C75E, 0xBBDDF0, 0x72965B, 0xF07A6A))
SHADES = rgb565(0x0841)
# Visor centre (art px) and tilt (degrees) per pose, measured from the images' eye centres.
VISORS = {"welcome": (92, 50, -7.1), "curious": (83, 50.5, -12.3), "thoughtful": (88, 47.5, 12.3), "playful": (98, 50, -5.0)}
EYE_X = 16


def parse_table():
    text = HEADER.read_text(encoding="utf-8")
    rows = re.findall(r"X\((\w+),\s*k(\w+),\s*k(\w+),\s*k(\w+),\s*k(\w+),\s*(\d+)\)", text)
    return [dict(name=r[0], pose=r[1].lower(), eyes=r[2], gesture=r[3], accent=r[4], loop=int(r[5])) for r in rows]


class Canvas:
    """The shape primitives shared with the firmware (M5GFX fillCircle/fillTriangle/...)."""

    def __init__(self, img):
        self.d = ImageDraw.Draw(img)

    def circle(self, x, y, r, c):
        x, y = round(x), round(y)
        self.d.ellipse([x - r, y - r, x + r, y + r], fill=c)

    def rect(self, x, y, w, h, c):
        self.d.rectangle([round(x), round(y), round(x) + w - 1, round(y) + h - 1], fill=c)

    def tri(self, a, b, c3, c):
        self.d.polygon([(round(p[0]), round(p[1])) for p in (a, b, c3)], fill=c)

    def line(self, x0, y0, x1, y1, w, c):
        """Thick line: two triangles plus a disc at each end."""
        dx, dy = x1 - x0, y1 - y0
        n = math.hypot(dx, dy) or 1.0
        ox, oy = -dy / n * w / 2, dx / n * w / 2
        self.tri((x0 + ox, y0 + oy), (x0 - ox, y0 - oy), (x1 + ox, y1 + oy), c)
        self.tri((x1 + ox, y1 + oy), (x1 - ox, y1 - oy), (x0 - ox, y0 - oy), c)
        if w > 2:
            self.circle(x0, y0, w / 2 - 0.5, c)
            self.circle(x1, y1, w / 2 - 0.5, c)

    def arc(self, x, y, r, a0, a1, w, c, steps=10):
        """Arc from a0 to a1 degrees (0 = right, 90 = down) as a chain of thick lines."""
        pts = [(x + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)), y + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
        for p, q in zip(pts, pts[1:]):
            self.line(p[0], p[1], q[0], q[1], w, c)


def load_pose(name):
    d = (ROOT / "lib" / "bob_art" / f"bob_{name}.rgb565").read_bytes()
    img = Image.new("RGB", (192, 192))
    img.putdata([rgb565((d[2 * i] << 8) | d[2 * i + 1]) for i in range(192 * 192)])
    return img


# Per pose search region (x, y, w, h) for the visor, as in include/bob_visor.h kPoses.
REGIONS = {"welcome": (56, 32, 72, 34), "curious": (48, 31, 70, 38), "thoughtful": (54, 30, 70, 34), "playful": (63, 33, 70, 34)}
_MASKS = {}


def is_visor_pixel(rgb):
    r, g, b = rgb
    return (r * 30 + g * 59 + b * 11) // 100 < 100 or (r > 170 and g > 100 and r - b > 70)


def visor_mask(art, pose):
    """The art's visor: the connected dark/yellow region around the visor centre, enclosed holes filled (bob_visor.h)."""
    if pose in _MASKS:
        return _MASKS[pose]
    cx, cy, _ = VISORS[pose]
    rx, ry, rw, rh = REGIONS[pose]
    inside = lambda x, y: rx <= x < rx + rw and ry <= y < ry + rh
    seed = None
    for r in range(9):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                x, y = round(cx) + dx, round(cy) + dy
                if seed is None and inside(x, y) and is_visor_pixel(art.getpixel((x, y))):
                    seed = (x, y)
    mask = set()
    if seed:
        todo = [seed]
        mask.add(seed)
        while todo:
            x, y = todo.pop()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if inside(*n) and n not in mask and is_visor_pixel(art.getpixel(n)):
                    mask.add(n)
                    todo.append(n)
        outside = set()
        todo = []
        for x in range(rx, rx + rw):
            for y in (ry, ry + rh - 1):
                if (x, y) not in mask and (x, y) not in outside:
                    outside.add((x, y))
                    todo.append((x, y))
        for y in range(ry, ry + rh):
            for x in (rx, rx + rw - 1):
                if (x, y) not in mask and (x, y) not in outside:
                    outside.add((x, y))
                    todo.append((x, y))
        while todo:
            x, y = todo.pop()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if inside(*n) and n not in mask and n not in outside:
                    outside.add(n)
                    todo.append(n)
        for x in range(rx, rx + rw):
            for y in range(ry, ry + rh):
                if (x, y) not in mask and (x, y) not in outside:
                    mask.add((x, y))
    _MASKS[pose] = mask
    return mask


def face(cv, pose, eyes, pose_img, art):
    """The face into the pose image: fill exactly the visor mask, draw the eyes, put the art back outside the mask."""
    mask = visor_mask(art, pose)
    base = SHADES if eyes == "Shades" else VISOR
    for xy in mask:
        pose_img.putpixel(xy, base)
    draw_face(cv, pose, eyes)
    rx, ry, rw, rh = REGIONS[pose]
    for y in range(ry, ry + rh):
        for x in range(rx, rx + rw):
            if (x, y) not in mask:
                pose_img.putpixel((x, y), art.getpixel((x, y)))


def draw_face(cv, pose, eyes):
    """Draws the eye expression in visor-local coordinates (u along the visor, v down)."""
    cx, cy, deg = VISORS[pose]
    ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))

    def P(u, v):
        return (cx + u * ca - v * sa, cy + u * sa + v * ca)

    def disc(u, v, r, c=AMBER):
        cv.circle(*P(u, v), r, c)

    def glint(u, v):  # the white catch-light in each amber eye (bob_face.cpp does the same)
        cv.circle(*P(u - 1.5, v - 1.5), 1, PAPER)

    def seg(u0, v0, u1, v1, w=3, c=AMBER):
        cv.line(*P(u0, v0), *P(u1, v1), w, c)

    def tri(a, b, c3, c=VISOR):
        cv.tri(P(*a), P(*b), P(*c3), c)

    def arc(u, v, r, a0, a1, w=3, c=AMBER):
        pts = [P(u + r * math.cos(math.radians(a0 + (a1 - a0) * i / 8)), v + r * math.sin(math.radians(a0 + (a1 - a0) * i / 8))) for i in range(9)]
        for p, q in zip(pts, pts[1:]):
            cv.line(p[0], p[1], q[0], q[1], w, c)

    if eyes == "Shades":
        for s in (-1, 1):
            seg(s * EYE_X - 6, -3, s * EYE_X - 2, -6, 2, SKY)
        return
    for s in (-1, 1):  # s = -1 left eye, +1 right eye; inner side is -s
        ex, inn = s * EYE_X, -s
        if eyes == "Dot": disc(ex, 0, 4); glint(ex, 0)
        elif eyes == "Wide": disc(ex, 0, 6); disc(ex - 2, -2, 1.5, PAPER)
        elif eyes == "Narrow": seg(ex - 5, 0, ex + 5, 0, 4)
        elif eyes == "HappyArc": arc(ex, 3, 5, 180, 360)
        elif eyes == "Closed": arc(ex, -3, 5, 0, 180)
        elif eyes in ("HalfLid", "Angry", "Sad"):
            disc(ex, 0 if eyes != "Sad" else 1, 4.5)
            glint(ex, 0 if eyes != "Sad" else 1)
            if eyes == "HalfLid": cover = [(ex - 7, -8), (ex + 7, -8), (ex + 7, -0.5)], [(ex - 7, -8), (ex + 7, -0.5), (ex - 7, -0.5)]
            elif eyes == "Angry": cover = [(ex + inn * 7, 1), (ex + inn * 7, -8), (ex - inn * 7, -8)], None
            else: cover = [(ex - inn * 7, 2), (ex - inn * 7, -8), (ex + inn * 7, -8)], None
            tri(*cover[0])
            if cover[1]: tri(*cover[1])
        elif eyes == "Heart":
            disc(ex - 2.6, -1.5, 3, CORAL); disc(ex + 2.6, -1.5, 3, CORAL)
            tri((ex - 5.4, -0.2), (ex + 5.4, -0.2), (ex, 5.5), CORAL)
        elif eyes == "Star":
            pts = [(0, -7), (1.6, -1.6), (7, 0), (1.6, 1.6), (0, 7), (-1.6, 1.6), (-7, 0), (-1.6, -1.6)]
            for a, b in zip(pts, pts[1:] + pts[:1]):
                tri((ex, 0), (ex + a[0], a[1]), (ex + b[0], b[1]), AMBER)
        elif eyes == "X": seg(ex - 4, -4, ex + 4, 4, 3); seg(ex - 4, 4, ex + 4, -4, 3)
        elif eyes == "Spiral":
            pts = [(ex + (1 + 5 * i / 24) * math.cos(i * 0.5 * s), (1 + 5 * i / 24) * math.sin(i * 0.5 * s)) for i in range(25)]
            for a, b in zip(pts, pts[1:]): seg(a[0], a[1], b[0], b[1], 2)
        elif eyes == "BigSmall":
            disc(ex, 0, 6 if s > 0 else 3)
            if s > 0: glint(ex, 0)
        elif eyes == "Wink":
            (disc(ex, 0, 4), glint(ex, 0)) if s < 0 else arc(ex, 3, 5, 180, 360)
        elif eyes == "LookLeft": disc(ex - 3.5, 0, 4); glint(ex - 3.5, 0)
        elif eyes == "LookRight": disc(ex + 3.5, 0, 4); glint(ex + 3.5, 0)
        elif eyes == "LookUp": disc(ex - 2, -3.5, 4); glint(ex - 2, -3.5)
        elif eyes == "Laugh": seg(ex - inn * 4, -4, ex + inn * 3, 0, 3); seg(ex + inn * 3, 0, ex - inn * 4, 4, 3)
        elif eyes == "Roll": disc(ex + 2, -4, 3.5); glint(ex + 2, -4)
        elif eyes == "Wavy":
            pts = [(ex - 6 + 12 * i / 12, 2.2 * math.sin(i * 1.05)) for i in range(13)]
            for a, b in zip(pts, pts[1:]): seg(a[0], a[1], b[0], b[1], 2)
        elif eyes == "Skeptic": seg(ex - 5, 0, ex + 5, 0, 4) if s < 0 else (disc(ex, 0, 4.5), glint(ex, 0))


def eye_pos(pose, s, u=0, v=0):
    """Frame-space position of a visor-local point on eye s (-1 left, +1 right)."""
    cx, cy, deg = VISORS[pose]
    ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    uu = s * EYE_X + u
    return (POSE_X + cx + uu * ca - v * sa, POSE_Y + cy + uu * sa + v * ca)


def mix(a, b, k):
    return tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))


def heart(cv, x, y, s, c):
    cv.circle(x - s * 0.5, y - s * 0.3, s * 0.55, c)
    cv.circle(x + s * 0.5, y - s * 0.3, s * 0.55, c)
    cv.tri((x - s * 1.02, y - s * 0.1), (x + s * 1.02, y - s * 0.1), (x, y + s * 1.1), c)


def spark(cv, x, y, s, c):
    q = s * 0.25
    pts = [(0, -s), (q, -q), (s, 0), (q, q), (0, s), (-q, q), (-s, 0), (-q, -q)]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        cv.tri((x, y), (x + a[0], y + a[1]), (x + b[0], y + b[1]), c)


def drop(cv, x, y, r, c):
    cv.circle(x, y + r, r, c)
    cv.tri((x - r, y + r - 1), (x + r, y + r - 1), (x, y - r * 1.6), c)


def zed(cv, x, y, s, c):
    cv.line(x - s, y - s, x + s, y - s, 2, c); cv.line(x + s, y - s, x - s, y + s, 2, c); cv.line(x - s, y + s, x + s, y + s, 2, c)


def bubble(cv, x, y, w, h, c):
    cv.rect(x + 6, y, w - 12, h, c); cv.rect(x, y + 6, w, h - 12, c)
    for dx in (6, w - 7):
        for dy in (6, h - 7):
            cv.circle(x + dx, y + dy, 6, c)
    cv.tri((x + 8, y + h - 2), (x + 18, y + h - 2), (x + 4, y + h + 9), c)


def accent(cv, kind, t, pose):
    f = lambda i, n: (t + i / n) % 1.0
    if kind == "Hearts":
        for i in range(3):
            p = f(i, 3); heart(cv, 200 + 9 * math.sin(p * 6.28 + i * 2), 96 - p * 84, 5 * (1 - p * 0.5), CORAL)
    elif kind == "Zzz":
        for i in range(3):
            p = f(i, 3); zed(cv, 168 + p * 38, 78 - p * 56, 4 + p * 6, mix(SKY, GROUND, p * p))
    elif kind == "Question":
        x, y = 200, 34 + 3 * math.sin(t * 6.28)
        cv.arc(x, y, 8, 200, 450, 4, YELLOW); cv.line(x, y + 8, x, y + 14, 4, YELLOW); cv.circle(x, y + 23, 3, YELLOW)
    elif kind == "Exclaim":
        k = 1 + 0.12 * math.sin(t * 6.28)
        cv.line(200, 16, 200, 16 + 22 * k, 6, YELLOW); cv.circle(200, 52 * k - 4, 4, YELLOW)
    elif kind == "Sweat":
        drop(cv, 190, 38 + t * 16, 4, SKY)
    elif kind == "Tears":
        for s in (-1, 1):
            p = f(0 if s < 0 else 1, 2); x, y = eye_pos(pose, s, 0, 9); drop(cv, x + s * 3, y + p * 30, 3, mix(SKY, GROUND, p * p))
    elif kind == "Sparkles":
        for i, (x, y) in enumerate(((34, 50), (204, 36), (192, 104), (24, 112))):
            spark(cv, x, y, 3 + 6 * abs(math.sin((t + i * 0.25) * 3.14)), YELLOW if i % 2 == 0 else PAPER)
    elif kind == "Confetti":
        for i in range(16):
            cv.rect(8 + (i * 53) % 212, (t * FRAME_H + i * 37) % FRAME_H, 6, 9, (YELLOW, SKY, GRASS, CORAL)[i % 4])
    elif kind == "Notes":
        for i in range(2):
            p = f(i, 2); x, y = 30 + i * 168, 90 - p * 60
            cv.circle(x, y, 4, SKY); cv.line(x + 4, y, x + 4, y - 14, 2, SKY); cv.line(x + 4, y - 14, x + 10, y - 9, 2, SKY)
    elif kind == "Bulb":
        k = 1 + 0.1 * math.sin(t * 6.28)
        cv.circle(200, 38, 10 * k, YELLOW); cv.rect(194, 47, 12, 6, SKY)
        for a in (210, 270, 330):
            cv.line(200 + 15 * math.cos(math.radians(a)), 38 + 15 * math.sin(math.radians(a)), 200 + 21 * math.cos(math.radians(a)), 38 + 21 * math.sin(math.radians(a)), 2, YELLOW)
    elif kind in ("Check", "Cross"):
        cv.circle(200, 40, 17, GRASS if kind == "Check" else CORAL)
        if kind == "Check": cv.line(191, 41, 197, 48, 4, PAPER); cv.line(197, 48, 210, 32, 4, PAPER)
        else: cv.line(192, 32, 208, 48, 4, PAPER); cv.line(192, 48, 208, 32, 4, PAPER)
    elif kind == "Bell":
        sw = 6 * math.sin(t * 6.28 * 3)
        cv.circle(200 + sw * 0.3, 38, 11, YELLOW); cv.rect(189 + sw * 0.3, 38, 22, 10, YELLOW); cv.circle(200 + sw, 55, 3, YELLOW)
        cv.arc(200, 40, 24, 200, 240, 2, SKY); cv.arc(200, 40, 24, 300, 340, 2, SKY)
    elif kind == "NoSignal":
        for r in (7, 14, 21): cv.arc(200, 66, r, 225, 315, 3, SKY)
        cv.circle(200, 66, 2, SKY); cv.line(184, 30, 216, 68, 4, CORAL)
    elif kind == "Spinner":
        for i in range(8):
            a = i * 0.785; cv.circle(200 + 15 * math.cos(a), 40 + 15 * math.sin(a), 3, mix(GROUND, SKY, ((i / 8 - t) % 1.0)))
    elif kind == "Blush":
        for s in (-1, 1): cv.circle(*eye_pos(pose, s, s * 9, 14), 4, CORAL)
    elif kind == "Dots":
        for i in range(3): cv.circle(180 + i * 15, 44 - (4 if int(t * 3) == i else 0), 3, YELLOW)
    elif kind == "Waves":
        for i in range(3): cv.arc(176, 60, 12 + i * 9, -45, 45, 3, mix(GROUND, SKY, 1 if int(t * 4) >= i else 0.35))
    elif kind == "Stars":
        for i in range(3):
            a = t * 6.28 + i * 2.09; spark(cv, 116 + 52 * math.cos(a), 36 + 10 * math.sin(a), 5, YELLOW)
    elif kind == "Warn":
        cv.tri((200, 22), (182, 56), (218, 56), YELLOW); cv.line(200, 33, 200, 45, 3, INK); cv.circle(200, 50, 2, INK)
    elif kind == "ShiverLines":
        for i in range(3):
            for x in (12, 220): cv.line(x + (2 if int(t * 6) % 2 else -2), 90 + i * 22, x + (2 if int(t * 6) % 2 else -2), 102 + i * 22, 3, SKY)
    elif kind == "Anger":
        k = 1 + 0.15 * math.sin(t * 12.56)
        for dx, dy, a in ((-1, -1, 0), (1, -1, 90), (-1, 1, 270), (1, 1, 180)): cv.arc(200 + dx * 6 * k, 38 + dy * 6 * k, 5, a, a + 90, 3, CORAL)
    elif kind == "Sick":
        for i in range(3):
            p = f(i, 3); cv.circle(190 + 12 * math.sin(p * 9 + i), 90 - p * 70, 4, mix(GRASS, GROUND, p * p))
    elif kind == "Bubble":
        k = 1 + 0.06 * math.sin(t * 6.28); bubble(cv, 184, 12, 38, 34, YELLOW)
        cv.line(203, 20, 203, 33 * k - 4, 4, INK); cv.circle(203, 37, 2, INK)


def render_tile(e, poses):
    tile = Image.new("RGB", (FRAME_W, FRAME_H), GROUND)
    tile.paste(poses[e["pose"]], (POSE_X, POSE_Y))
    cv = Canvas(tile)
    # Face is drawn in pose coordinates: draw on a pose copy, then paste (as the firmware does).
    pose_img = poses[e["pose"]].copy()
    face(Canvas(pose_img), e["pose"], e["eyes"], pose_img, poses[e["pose"]])
    tile.paste(pose_img, (POSE_X, POSE_Y))
    accent(cv, e["accent"], TILE_PHASE, e["pose"])
    return tile


def render_sheet():
    table = parse_table()
    poses = {n: load_pose(n) for n in POSES}
    cols, label_h = 6, 44
    rows = (len(table) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * FRAME_W, rows * (FRAME_H + label_h)), GROUND)
    title, small = ImageFont.load_default(18), ImageFont.load_default(12)
    d = ImageDraw.Draw(sheet)
    for i, e in enumerate(table):
        x, y = (i % cols) * FRAME_W, (i // cols) * (FRAME_H + label_h)
        sheet.paste(render_tile(e, poses), (x, y))
        d.text((x + FRAME_W // 2, y + FRAME_H + 4), f"{i + 1}. {e['name']}", font=title, fill=PAPER, anchor="mt")
        d.text((x + FRAME_W // 2, y + FRAME_H + 26), f"{e['eyes']} / {e['gesture']} / {e['accent']}", font=small, fill=SKY, anchor="mt")
    return sheet, table


def main():
    sheet, table = render_sheet()
    if "--check" in sys.argv:
        if not SHEET.exists():
            sys.exit(f"missing {SHEET}")
        old = Image.open(SHEET).convert("RGB")
        if old.size != sheet.size or ImageChops.difference(old, sheet).getbbox():
            sys.exit(f"{SHEET} is stale: run py -3.11 apps/cardputer/scripts/bob_emotions_preview.py")
        print(f"ok: {len(table)} emotions, sheet in sync")
        return
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET, optimize=True)
    print(f"wrote {SHEET} ({len(table)} emotions)")


if __name__ == "__main__":
    main()

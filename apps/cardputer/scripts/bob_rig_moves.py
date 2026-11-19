"""Part-level move library for the Bob rig, rendered as 12-frame preview strips.

The same keyframes feed docs/waveshare/bob-motion-design.md. Everything here is derived from the rig parts
(never redrawn art); eyes are drawn procedurally, as they will be on device.
Imported by bob_rig_build.py (render_all).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

NAVY = (23, 62, 87)
AMBER = (240, 199, 94)
CORAL = (240, 122, 106)
FRAMES = 12
TILE = 170
CANVAS = 660  # room above Bob for hops, and at the sides for arm swings
BODY_PIVOT = (240.0, 430.0)  # art px, bottom centre of the body: squash and lean pivot (Bob's site: 50% x, 90% y)


# ----------------------------------------------------------------------------- easing
def cubic_bezier(x1, y1, x2, y2):
    """CSS cubic-bezier easing. The house curve is (.45, 0, .55, 1) at 650 ms for gestures."""
    def f(t):
        lo, hi = 0.0, 1.0
        for _ in range(30):
            m = (lo + hi) / 2
            x = 3 * (1 - m) ** 2 * m * x1 + 3 * (1 - m) * m * m * x2 + m**3
            lo, hi = (m, hi) if x < t else (lo, m)
        m = (lo + hi) / 2
        return 3 * (1 - m) ** 2 * m * y1 + 3 * (1 - m) * m * m * y2 + m**3
    return f


EASE = cubic_bezier(0.45, 0, 0.55, 1)


def spring(t, freq=2.2, damp=5.5):
    """0 -> 1 with overshoot and settle (damped cosine), t in 0..1."""
    return 1 - np.exp(-damp * t) * np.cos(2 * np.pi * freq * t)


def lag(f, t, delay):
    """Follow-through: the same curve, `delay` (fraction of the move) later."""
    return f(max(0.0, t - delay))


def seg(t, a, b):
    return float(np.clip((t - a) / (b - a), 0, 1))


PAD = np.array([[1, 0, 90], [0, 1, 150], [0, 0, 1]], np.float64)


# ----------------------------------------------------------------------------- matrices
def mat(rot=0.0, sx=1.0, sy=1.0, tx=0.0, ty=0.0, pivot=(0.0, 0.0)):
    """3x3 forward map: scale then rotate about `pivot`, then translate."""
    c, s = np.cos(np.radians(rot)), np.sin(np.radians(rot))
    r = np.array([[c * sx, -s * sy, 0], [s * sx, c * sy, 0], [0, 0, 1]], np.float64)
    p = np.array(pivot, np.float64)
    r[:2, 2] = p - r[:2, :2] @ p + np.array([tx, ty])
    return r


def sim(rot, scale, pivot_src, pivot_dst):
    c, s = np.cos(np.radians(rot)) * scale, np.sin(np.radians(rot)) * scale
    r = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], np.float64)
    r[:2, 2] = np.array(pivot_dst) - r[:2, :2] @ np.array(pivot_src)
    return r


def warp_pm(part, origin, m3):
    """Premultiplied warp of an RGBA sprite onto the 480 canvas (no halo on rotated edges)."""
    c = np.zeros((480, 480, 4), np.float32)
    h, w = part.shape[:2]
    c[origin[1]:origin[1] + h, origin[0]:origin[0] + w] = part
    c[..., :3] *= c[..., 3:4] / 255
    out = cv2.warpAffine(c, (PAD @ m3)[:2].astype(np.float32), (CANVAS, CANVAS), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = out[..., 3:4]
    rgb = np.where(a > 0, out[..., :3] / np.maximum(a / 255, 1e-6), 0)
    return np.concatenate([rgb, a], axis=2).clip(0, 255).astype(np.uint8)


def over(dst, src):
    sa = src[..., 3:4].astype(np.float32) / 255
    da = dst[..., 3:4].astype(np.float32) / 255
    oa = sa + da * (1 - sa)
    rgb = (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
    return np.concatenate([rgb, oa * 255], axis=2).clip(0, 255).astype(np.uint8)


def blink(t, at, width=.16):
    """Slow blink: eye height 1 -> .12 -> 1 over `width` (a gentle squish, never a snap)."""
    q = (t - at) / width
    return 1.0 if q <= 0 or q >= 1 else 1 - .88 * np.sin(np.pi * q) ** 2


# ----------------------------------------------------------------------------- the moves
# Each move: dict(pose, arms=(left variant, right variant), front=bool, eyes=str, fn=f(t)->params)
# params: body(rot, sx, sy, dx, dy), armL/armR (rot about the shoulder), footL/footR (dy), button (rot, sx), visor (dx, dy, rot),
#         look (dx, dy) for the eyes, eyes (style override)
def p(**k):
    return k


def m_wave(t):
    ant = -6 * seg(t, 0, .12) * (1 - seg(t, .12, .2))  # anticipation: lean back, then go
    sw = 16 * np.sin(2 * np.pi * 2 * seg(t, .12, .92)) * (1 - 0.5 * seg(t, .5, 1))
    return p(body=dict(rot=1.5 * np.sin(2 * np.pi * t), dy=-2 * abs(np.sin(2 * np.pi * t))), armR=-6 + ant + sw, armL=2 * np.sin(2 * np.pi * t),
             button=dict(rot=-8 * np.sin(2 * np.pi * (t - .1) * 2)), look=(0, 0))


def m_ear(t):
    e = spring(seg(t, .05, .6))
    return p(armL=(1 - e) * -52, body=dict(rot=-4 * EASE(seg(t, 0, .5)), dy=-1 * np.sin(np.pi * seg(t, 0, .4))), button=dict(rot=-6 * (1 - EASE(seg(t, .3, 1)))),
             look=(-3 * EASE(seg(t, 0, .6)), 0), eyes="wide")


def m_chin(t):
    e = spring(seg(t, .0, .45))
    rub = 4 * np.sin(2 * np.pi * 3 * seg(t, .45, .95))
    return p(armL=(1 - e) * -40 + rub, body=dict(rot=2.5 * np.sin(2 * np.pi * t)), button=dict(rot=7 * np.sin(2 * np.pi * (t - .15))), look=(2, -2))


def m_arms_up(t):
    up = spring(seg(t, .1, .55), 2.0, 6.0)
    pump = 5 * np.sin(2 * np.pi * 2 * seg(t, .55, 1))
    j = np.sin(np.pi * seg(t, .08, .5))
    return p(armL=(1 - up) * 38 + pump, armR=-(1 - up) * 38 - pump, body=dict(dy=-10 * j, sy=1 + .05 * j, sx=1 - .03 * j), footL=-10 * j, footR=-10 * j,
             button=dict(rot=10 * np.sin(2 * np.pi * (t - .12) * 2)), eyes="happy")


def m_clap(t):
    k = 0.5 + 0.5 * np.cos(2 * np.pi * 3 * t)  # three claps
    return p(armL=-52 * k, armR=52 * k, body=dict(dy=-1.5 * (1 - k), sy=1 + .015 * (1 - k)), eyes="happy", button=dict(rot=6 * np.sin(2 * np.pi * 3 * (t - .08))))


def m_point(t):
    a = EASE(seg(t, .15, .45))
    return p(armR=-30 * a + 3 * np.sin(2 * np.pi * 3 * seg(t, .5, 1)) * (1 - seg(t, .7, 1)), body=dict(rot=3 * a, dy=-2 * np.sin(np.pi * seg(t, .1, .4))), look=(6 * a, -5 * a), armL=-3 * a)


def m_shrug(t):
    s = np.sin(np.pi * EASE(seg(t, .1, .85)))
    return p(armL=26 * s, armR=-26 * s, body=dict(dy=-5 * s, sy=1 + .02 * s), button=dict(rot=-6 * s), eyes="half", visor=dict(dy=2 * s), footL=0, footR=0)


def m_foot_tap(t):
    tap = np.abs(np.sin(np.pi * 3 * seg(t, .1, .95)))
    return p(footR=-12 * tap, body=dict(dy=-1.2 * tap, rot=1.2 * np.sin(2 * np.pi * 3 * t)), armL=2 * np.sin(2 * np.pi * 3 * t), armR=-2 * np.sin(2 * np.pi * 3 * t),
             button=dict(rot=5 * np.sin(2 * np.pi * (3 * t - .2))), eyes="happy")


def m_hop(t):
    crouch = EASE(seg(t, 0, .22))
    air = np.sin(np.pi * seg(t, .22, .72))
    land = seg(t, .72, .82) * (1 - seg(t, .82, 1))
    sy = 1 - .12 * crouch * (1 - seg(t, .22, .3)) + .08 * air - .1 * land + .02 * (1 - spring(seg(t, .82, 1)))
    sx = 1 + .08 * crouch * (1 - seg(t, .22, .3)) - .05 * air + .08 * land
    return p(body=dict(sx=sx, sy=sy, dy=-46 * air + 3 * crouch * (1 - seg(t, .22, .3))), footL=-46 * air, footR=-46 * air,
             armL=-34 * air + 20 * crouch, armR=34 * air - 20 * crouch, button=dict(rot=-18 * (air - land)), eyes="happy")


def m_sway(t):
    s = np.sin(2 * np.pi * t)
    c = np.cos(2 * np.pi * t)
    return p(body=dict(rot=6 * s, dx=7 * s, dy=-2 * abs(c)), footL=-5 * max(0, s), footR=-5 * max(0, -s), armL=-16 * c, armR=16 * c,
             button=dict(rot=-12 * np.sin(2 * np.pi * (t - .12))), eyes="happy")


def m_bow(t):
    b = np.sin(np.pi * EASE(seg(t, .08, .9)))
    return p(body=dict(rot=7 * b, sy=1 - .05 * b, dy=2 * b), visor=dict(dy=4 * b, rot=3 * b), armL=10 * b, armR=-10 * b, button=dict(rot=14 * lag(lambda x: np.sin(np.pi * x), seg(t, .08, .9), .08)), eyes="closed" if b > .55 else "open")


def m_look(t):
    sweep = np.sin(2 * np.pi * t * 1.0)
    return p(look=(9 * sweep, -1), body=dict(rot=2.5 * sweep), visor=dict(dx=7 * sweep, rot=2 * sweep), button=dict(rot=-5 * lag(lambda x: np.sin(2 * np.pi * x), t, .06)))


def m_button_spin(t):
    sp = np.cos(2 * np.pi * 2 * seg(t, .1, .9))
    j = np.sin(np.pi * seg(t, .1, .5))
    return p(button=dict(sx=sp, rot=6 * np.sin(2 * np.pi * t * 2)), body=dict(dy=-3 * j, sy=1 + .02 * j), armL=-20 * j, armR=20 * j, eyes="happy")


def m_shiver(t):
    j = np.sin(2 * np.pi * 9 * t) * (1 - .4 * t)
    return p(body=dict(dx=2.2 * j, rot=.8 * j), armL=5 * j, armR=-5 * j, footL=0, footR=0, button=dict(rot=9 * np.sin(2 * np.pi * 9 * (t - .05))), eyes="wide", look=(1.5 * j, 0))


def m_droop(t):
    d = EASE(seg(t, 0, .75))
    return p(body=dict(sy=1 - .06 * d, sx=1 + .02 * d, dy=5 * d, rot=-3 * d), armL=14 * lag(EASE, d, .1), armR=-14 * lag(EASE, d, .1), button=dict(rot=-26 * lag(EASE, d, .2)),
             visor=dict(dy=3 * d), eyes="half", look=(0, 3 * d))



# ----- adorable set: small amplitudes, soft springs (overshoot ~10%), eyes do most of the work
def m_tap_giggle(t):
    k = seg(t, 0, .85)
    dec = 1 - k
    return p(body=dict(rot=3.2 * np.sin(2 * np.pi * 3 * k) * dec, dy=-4 * abs(np.sin(np.pi * 3 * k)) * dec, sy=1 + .03 * np.sin(np.pi * 6 * k) * dec),
             armL=8 * np.sin(2 * np.pi * 3 * (k - .08)) * dec, armR=-8 * np.sin(2 * np.pi * 3 * (k - .08)) * dec, button=dict(rot=12 * np.sin(2 * np.pi * 3 * (k - .15)) * dec),
             eyes="squint", heart=seg(t, .12, .95), blush=.6 * (1 - seg(t, .7, 1)))


def m_happy_wiggle(t):
    s = np.sin(2 * np.pi * 2.5 * seg(t, .05, .9))
    env = np.sin(np.pi * seg(t, .05, .9)) ** .6
    return p(body=dict(dx=4 * s * env, rot=3 * s * env, dy=-1.5 * abs(s) * env), footL=-3 * max(0, s) * env, footR=-3 * max(0, -s) * env,
             armL=10 * s * env, armR=10 * s * env, button=dict(rot=-14 * np.sin(2 * np.pi * 2.5 * (seg(t, .05, .9) - .1)) * env), eyes="squint", blush=.4 * env)


def m_sleepy_yawn(t):
    sway = 2 * np.sin(2 * np.pi * t)
    y = np.sin(np.pi * EASE(seg(t, .3, .75)))  # the yawn: stretch up, arms lift, eyes squeeze shut
    sq = min(1.0, 1 - .88 * EASE(seg(t, .25, .45)) + .88 * EASE(seg(t, .8, 1)))
    return p(body=dict(rot=sway - 1.5 * seg(t, .75, 1), sy=1 + .035 * y, sx=1 - .015 * y, dy=-2 * y + 2 * seg(t, .85, 1)), armL=-14 * y, armR=14 * y,
             button=dict(rot=-8 * lag(lambda x: np.sin(np.pi * x), seg(t, .3, .75), .1) + 3 * np.sin(2 * np.pi * t)), eyes="half", squish=max(.12, sq), look=(0, 2))


def m_curious_tilt(t):
    e = spring(seg(t, .05, .5), 2.0, 6.5)
    return p(head=dict(rot=-7.5 * e, dx=-2 * e), body=dict(dy=-1.5 * np.sin(np.pi * seg(t, .05, .4))), visor=dict(rot=-1 * e), button=dict(rot=7 * (1 - lag(lambda x: spring(x, 2.0, 6.5), seg(t, .05, .5), .12))),
             look=(-5 * e, -4 * e), armR=-3 * e, eyes="wide", squish=blink(t, .78))


def m_shy(t):
    e = EASE(seg(t, .05, .4))
    return p(body=dict(rot=3 * e, dy=1.5 * e, sx=1 - .015 * e), visor=dict(dx=-3 * e), look=(-9 * e, 4 * e), blush=e * (1 - seg(t, .85, 1)), armL=-4 * e + 4 * np.sin(2 * np.pi * 2 * seg(t, .4, .9)) * e, armR=2 * e,
             button=dict(rot=-5 * lag(EASE, e, .15)), eyes="open", squish=blink(t, .55, .2))


def m_press_squish(t):
    lean = EASE(seg(t, 0, .3)) * (1 - EASE(seg(t, .72, 1)))
    rel = spring(seg(t, .72, 1), 2.4, 6.0) - 1
    return p(body=dict(sy=1 - .07 * lean - .04 * rel, sx=1 + .045 * lean + .02 * rel, rot=-3 * lean, dy=3 * lean), button=dict(rot=-10 * lean + 10 * rel), armL=6 * lean, armR=-6 * lean,
             eyes="squint" if lean > .3 else "open", blush=.5 * lean)


def m_hum(t):
    return p(body=dict(rot=2 * np.sin(2 * np.pi * 1.5 * t), dy=-1.5 * abs(np.sin(2 * np.pi * 1.5 * t))), button=dict(rot=7 * np.sin(2 * np.pi * (1.5 * t - .15))),
             notes=seg(t, .05, 1.0), eyes="squint", armL=4 * np.sin(2 * np.pi * 1.5 * t), armR=-4 * np.sin(2 * np.pi * 1.5 * t))


def m_stretch(t):
    y = np.sin(np.pi * EASE(seg(t, .1, .85)))
    return p(body=dict(sy=1 + .05 * y, sx=1 - .025 * y, dy=-3 * y), armL=-26 * y, armR=26 * y, footL=-2 * y, footR=-2 * y, button=dict(rot=-6 * lag(lambda x: np.sin(np.pi * x), seg(t, .1, .85), .1)),
             eyes="closed" if y > .5 else "open", squish=blink(t, .08, .1))


def m_delight(t):
    j = np.sin(np.pi * seg(t, .1, .55))
    return p(body=dict(dy=-14 * j, sy=1 + .05 * j, sx=1 - .03 * j), footL=-14 * j, footR=-14 * j, armL=-30 * j, armR=30 * j, eyes="sparkle", button=dict(rot=14 * np.sin(2 * np.pi * (t - .1) * 2)),
             blush=.3, heart=None)


# ----- flips and head/belly showcases
def m_backflip(t):
    """~900 ms: crouch (anticipation squash) -> launch (stretch) -> 360 deg backward spin of the whole rig -> land squash -> wobble -> settle."""
    crouch = EASE(seg(t, 0, .18)) * (1 - seg(t, .18, .24))
    air = np.sin(np.pi * seg(t, .24, .74))
    k = EASE(seg(t, .27, .72))
    land = np.sin(np.pi * seg(t, .74, .84)) if t < .84 else 0.0
    settle = (1 - spring(seg(t, .84, 1.0), 2.2, 5.0)) if t >= .84 else 0.0
    sy = 1 - .15 * crouch + .10 * air * (1 - seg(t, .55, .74)) - .16 * land + .02 * settle
    sx = 1 + .10 * crouch - .06 * air * (1 - seg(t, .55, .74)) + .12 * land
    tuck = np.sin(np.pi * seg(t, .27, .72))
    return p(body=dict(sx=sx, sy=sy, dy=10 * crouch - 72 * air + 5 * land, spin=-360 * k, rot=-4 * settle * np.sin(2 * np.pi * 2.5 * seg(t, .84, 1))),
             armL=-30 * tuck + 20 * crouch, armR=30 * tuck - 20 * crouch, button=dict(rot=24 * tuck * np.cos(np.pi * seg(t, .27, .72)) - 10 * land + 12 * settle * np.sin(2 * np.pi * 3 * seg(t, .84, 1))),
             head=dict(rot=-4 * lag(lambda x: np.sin(np.pi * x), seg(t, .27, .72), .12) + 4 * settle * np.sin(2 * np.pi * 2.5 * seg(t, .84, 1))), footL=0, footR=0,
             eyes="squint" if (.3 < t < .7) else "sparkle" if t >= .8 else "open", blush=.4 * seg(t, .75, .9) * (1 - seg(t, .95, 1)))


def m_turn(t):
    """Mirror turn (cheap version): Bob turns toward a prop on the left, then the right: horizontal squash with eye/visor parallax, never through 0."""
    u = 2 * t if t < .5 else 2 * (1 - t)
    side = -1 if t < .5 else 1
    ant = np.sin(np.pi * seg(t % .5 * 2, 0, .25)) * .04
    e = EASE(min(1, u * 1.25))
    return p(body=dict(sx=1 - .07 * np.sin(np.pi * e) - ant, rot=2 * side * e), visor=dict(dx=10 * side * e), look=(8 * side * e, -2 * e), head=dict(rot=3 * side * e, dx=3 * side * e),
             armL=-5 * side * e, armR=-5 * side * e, button=dict(rot=-6 * side * lag(EASE, e, .15)), eyes="open")


def m_head_vs_belly(t):
    nod = np.sin(2 * np.pi * t)
    return p(head=dict(rot=8 * nod, dy=1.5 * abs(np.sin(2 * np.pi * t))), belly=dict(sy=1 - .012 * np.sin(2 * np.pi * (t - .15)), sx=1 + .008 * np.sin(2 * np.pi * (t - .15))),
             button=dict(rot=-10 * np.sin(2 * np.pi * (t - .12))), visor=dict(dx=2 * nod), look=(3 * nod, 0), eyes="open", squish=blink(t, .62))


def m_belly_speak(t):
    lvl = np.clip(.5 + .3 * np.sin(2 * np.pi * 5 * t) + .2 * np.sin(2 * np.pi * 8.3 * t + 1), 0, 1)  # stand-in for playbackLevel01
    return p(belly=dict(sy=1 + .035 * lvl, sx=1 + .02 * lvl), body=dict(dy=-.8 * lvl), head=dict(rot=1.2 * np.sin(2 * np.pi * 2 * t), dy=-.8 * lvl),
             button=dict(rot=5 * np.sin(2 * np.pi * (5 * t - .1))), eyes="squint", notes=seg(t, .1, 1.0))


def m_proud(t):
    """Success beat: the 'bob' deboss glows warm, a tiny hop, chest-out stretch, arms out; glow eases in, holds, fades."""
    g = EASE(seg(t, .12, .4)) * (1 - EASE(seg(t, .7, 1)))
    j = np.sin(np.pi * seg(t, .1, .5))
    return p(glow=g, body=dict(dy=-8 * j, sy=1 + .035 * g, sx=1 - .015 * g), head=dict(rot=-2 * g, dy=-1 * g), armL=-16 * g, armR=16 * g, eyes="squint", blush=.3 * g,
             button=dict(rot=-8 * lag(EASE, g, .15)))


MOVES = {
    "wave": dict(pose="helper", arms=("armL_down", "armR_wave"), fn=m_wave, eyes="open"),
    "hand-to-ear": dict(pose="curious", arms=("armL_ear", "armR_down"), fn=m_ear, eyes="open", front=True),
    "chin-rub": dict(pose="thoughtful", arms=("armL_chin", "armR_down2"), fn=m_chin, eyes="open", front=True),
    "arms-up": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_arms_up, eyes="open"),
    "clap": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_clap, eyes="open", front=True),
    "point": dict(pose="helper", arms=("armL_down", "armR_wave"), fn=m_point, eyes="open"),
    "shrug": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_shrug, eyes="open"),
    "foot-tap": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_foot_tap, eyes="open"),
    "hop": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_hop, eyes="open"),
    "sway": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_sway, eyes="open"),
    "bow": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_bow, eyes="open"),
    "look-around": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_look, eyes="open"),
    "button-spin": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_button_spin, eyes="open"),
    "shiver": dict(pose="thoughtful", arms=("armL_chin", "armR_down2"), fn=m_shiver, eyes="open", front=True),
    "droop": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_droop, eyes="open"),
    "backflip": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_backflip, eyes="open", lock=True, frames=24),
    "proud-glow": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_proud, eyes="open"),
    "mirror-turn": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_turn, eyes="open", frames=12),
    "head-vs-belly": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_head_vs_belly, eyes="open"),
    "belly-speaking-pulse": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_belly_speak, eyes="open"),
    # adorable set
    "tap-giggle": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_tap_giggle, eyes="open"),
    "happy-wiggle": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_happy_wiggle, eyes="open"),
    "sleepy-yawn": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_sleepy_yawn, eyes="open"),
    "curious-tilt": dict(pose="curious", arms=("armL_ear", "armR_down"), fn=m_curious_tilt, eyes="open", front=True),
    "shy-look-away": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_shy, eyes="open"),
    "press-squish": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_press_squish, eyes="open"),
    "hum": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_hum, eyes="open"),
    "stretch": dict(pose="helper", arms=("armL_down", "armR_down"), fn=m_stretch, eyes="open"),
    "delight": dict(pose="playful", arms=("armL_up", "armR_up"), fn=m_delight, eyes="open"),
}


# ----------------------------------------------------------------------------- renderer
WHITE = (255, 253, 246)


def draw_eyes(rgba, center, rot, style, look, squish=1.0, scale=1.0, tilt=0.0):
    """Procedural visor eyes (the device draws them in bob_face.cpp): soft rounded amber, a small white catch-light that
    shifts against the gaze, `squish` = vertical scale for slow blinks (1 open .. 0.12 shut)."""
    img = rgba[..., :3].copy()
    th = np.radians(rot)
    ux, uy = np.cos(th), np.sin(th)
    for sgn in (-1, 1):
        cx = center[0] + sgn * 44 * scale * ux + look[0]
        cy = center[1] + sgn * 44 * scale * uy + look[1]
        c = (int(cx), int(cy))
        r = {"open": 13, "wide": 17, "sparkle": 16, "half": 14}.get(style, 13) * scale
        if style in ("open", "wide", "sparkle", "half"):
            ry = max(2.0, r * squish * (0.55 if style == "half" else 1.0))
            ang = 0
            cv2.ellipse(img, c, (int(r), int(ry)), ang, 0, 360, AMBER, -1, cv2.LINE_AA)
            if style == "half":  # lower half-lid: flat top
                cv2.rectangle(img, (c[0] - int(r) - 2, c[1] - int(r) - 2), (c[0] + int(r) + 2, c[1] - int(ry * .1)), (18, 21, 26), -1)
            if squish > .35:
                dx = -0.34 * r - 0.28 * look[0] + 0.12 * tilt
                dy = -0.38 * ry - 0.28 * look[1]
                cv2.circle(img, (int(cx + dx), int(cy + dy)), max(2, int(r * .26)), WHITE, -1, cv2.LINE_AA)
                if style in ("wide", "sparkle"):
                    cv2.circle(img, (int(cx + 0.4 * r), int(cy + 0.4 * ry)), max(1, int(r * .12)), WHITE, -1, cv2.LINE_AA)
            if style == "sparkle":
                k = int(r * 1.3)
                cv2.line(img, (c[0] + k, c[1] - k - 4), (c[0] + k, c[1] - k + 4), WHITE, 2, cv2.LINE_AA)
                cv2.line(img, (c[0] + k - 4, c[1] - k), (c[0] + k + 4, c[1] - k), WHITE, 2, cv2.LINE_AA)
        elif style == "closed":
            cv2.ellipse(img, (c[0], c[1] - 3), (int(13 * scale), int(8 * scale)), 0, 20, 160, AMBER, 5, cv2.LINE_AA)
        elif style == "squint":  # happy ^ ^
            cv2.ellipse(img, (c[0], c[1] + 9), (int(14 * scale), int(14 * scale)), 0, 200, 340, AMBER, 6, cv2.LINE_AA)
        elif style == "happy":
            cv2.ellipse(img, (c[0], c[1] + 8), (int(14 * scale), int(14 * scale)), 0, 200, 340, AMBER, 6, cv2.LINE_AA)
    return img


def draw_heart(img, c, size, color=CORAL):
    x, y = c
    cv2.circle(img, (x - size // 2, y), size // 2, color, -1, cv2.LINE_AA)
    cv2.circle(img, (x + size // 2, y), size // 2, color, -1, cv2.LINE_AA)
    cv2.fillPoly(img, [np.array([(x - size, y + 1), (x + size, y + 1), (x, y + int(size * 1.7))], np.int32)], color, cv2.LINE_AA)


def draw_note(img, c, size, color=AMBER):
    x, y = c
    cv2.circle(img, (x, y), size // 2 + 1, color, -1, cv2.LINE_AA)
    cv2.line(img, (x + size // 2, y), (x + size // 2, y - size * 2), color, 3, cv2.LINE_AA)
    cv2.line(img, (x + size // 2, y - size * 2), (x + size // 2 + size // 2, y - size * 2 + size // 2), color, 3, cv2.LINE_AA)


def accents(canvas, prm, vis_c, body_m):
    """Overlays: blush on the cheeks, rising heart, floating notes. Alpha follows the fade."""
    out = canvas.copy()
    rgb = np.ascontiguousarray(out[..., :3])
    alpha = out[..., 3].copy()
    bl = prm.get("blush", 0)
    if bl > 0:
        cheek = np.zeros(alpha.shape, np.uint8)
        for sgn in (-1, 1):
            cv2.ellipse(cheek, (int(vis_c[0] + sgn * 70), int(vis_c[1] + 34)), (22, 11), 0, 0, 360, int(150 * bl), -1, cv2.LINE_AA)
        a = (cheek.astype(np.float32) / 255)[..., None] * (alpha[..., None] > 0)
        rgb = (np.array(CORAL, np.float32) * a + rgb * (1 - a)).astype(np.uint8)
    glyph = np.zeros(alpha.shape, np.uint8)
    h = prm.get("heart")
    if h is not None and 0 < h < 1:
        hc = (int(vis_c[0] + 70), int(vis_c[1] - 70 - 60 * h))
        sz = int(22 * (1 - .25 * h))
        tmp = np.ascontiguousarray(rgb)
        draw_heart(tmp, hc, sz)
        hm = np.zeros(alpha.shape, np.uint8)
        draw_heart(hm, hc, sz, 255)
        m = hm > 0
        rgb[m] = tmp[m]
        glyph = np.maximum(glyph, (hm * (1 - max(0.0, h - .6) * 2.5)).astype(np.uint8))
    nt = prm.get("notes")
    if nt is not None and 0 < nt < 1:
        for dx, ph in ((-30, 0.0), (36, 0.28)):
            q = nt - ph
            if 0 < q < .72:
                nc = (int(vis_c[0] + 40 + dx + 8 * np.sin(q * 9)), int(vis_c[1] - 60 - 110 * q))
                tmp = np.ascontiguousarray(rgb)
                draw_note(tmp, nc, 12)
                nm = np.zeros(alpha.shape, np.uint8)
                draw_note(nm, nc, 12, 255)
                m = nm > 0
                rgb[m] = tmp[m]
                glyph = np.maximum(glyph, (nm * (1 - q)).astype(np.uint8))
    out[..., :3] = rgb
    out[..., 3] = np.maximum(alpha, glyph)
    return out


def render_frame(parts, meta, report, mv, t):
    """Parts: root (everything), head (tilts about the seam), belly (breathes), visor/eyes/button ride the head,
    arms ride the root, feet are planted unless a move lifts them (or `lock` is set for flips)."""
    pose = mv["pose"]
    pl = report[pose]["placed"]
    prm = mv["fn"](t)
    b = prm.get("body", {})
    mb = mat(rot=b.get("rot", 0), sx=b.get("sx", 1), sy=b.get("sy", 1), tx=b.get("dx", 0), ty=b.get("dy", 0), pivot=BODY_PIVOT)
    spin = b.get("spin", 0)
    if spin:
        centre = (mb @ np.array([240.0, 290.0, 1.0]))[:2]
        mb = mat(rot=spin, pivot=tuple(centre)) @ mb
    hx = prm.get("head", {})
    seam = meta[f"head_{pose}"]["pivot_src"]
    mh = mb @ mat(rot=hx.get("rot", 0), tx=hx.get("dx", 0), ty=hx.get("dy", 0), pivot=seam)
    bel = prm.get("belly", {})
    bpiv = meta[f"belly_{pose}"]["pivot_src"]
    mbel = mb @ mat(sx=bel.get("sx", 1), sy=bel.get("sy", 1), pivot=(bpiv[0], bpiv[1]))
    canvas = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    lock = mv.get("lock", False)

    def shared(name, local=None, parent=None):
        px, py = meta[name]["pivot_src"]
        m = sim(pl[name]["rot"], pl[name]["scale"], (px, py), pl[name]["pivot_at"])
        if local is not None:
            m = mat(rot=local.get("rot", 0), sx=local.get("sx", 1), sy=local.get("sy", 1), tx=local.get("dx", 0), ty=local.get("dy", 0), pivot=pl[name]["pivot_at"]) @ m
        if parent is not None:
            m = parent @ m
        return warp_pm(parts[name], meta[name]["origin"], m), m

    # soft ground shadow: procedural ellipse that shrinks and fades with hop height
    lift_h = max(0.0, -b.get("dy", 0))
    sh = np.zeros((CANVAS, CANVAS), np.uint8)
    sw = int(120 * (1 - min(lift_h, 100) / 260))
    cv2.ellipse(sh, (int(240 + 90), int(448 + 150)), (max(sw, 20), 13), 0, 0, 360, int(70 * (1 - min(lift_h, 100) / 180)), -1, cv2.LINE_AA)
    sh = cv2.GaussianBlur(sh, (0, 0), 5)
    shadow = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    shadow[..., 3] = sh
    shadow[..., :3] = (10, 25, 36)
    canvas = over(canvas, shadow)

    for foot in ("footL", "footR"):
        layer, _ = shared(foot, dict(dy=prm.get(foot, 0)), parent=mb if lock else None)
        canvas = over(canvas, layer)

    def arm(name, rot, stretch=1.0):
        pose_of = meta[name]["pose"]
        shd = SHOULDERS[pose][name.startswith("armL") and "L" or "R"]
        px, py = meta[name]["pivot_src"]
        m = mb @ mat(rot=rot, sy=stretch, pivot=shd) @ sim(0, 1, (px, py), shd)
        return warp_pm(parts[name], meta[name]["origin"], m)

    front = mv.get("front", False)
    armL, armR = mv["arms"]
    arm_layers = [(armL, prm.get("armL", 0), prm.get("armLs", 1.0)), (armR, prm.get("armR", 0), prm.get("armRs", 1.0))]
    if not front:
        for n, r, st in arm_layers:
            canvas = over(canvas, arm(n, r, st))
    canvas = over(canvas, warp_pm(parts[f"belly_{pose}"], meta[f"belly_{pose}"]["origin"], mbel))
    canvas = over(canvas, warp_pm(parts[f"head_{pose}"], meta[f"head_{pose}"]["origin"], mh))
    glow = prm.get("glow", 0.0)
    if glow > 0:
        gl = warp_pm(parts[f"logo_{pose}"], meta[f"logo_{pose}"]["origin"], mh)
        gl[..., 3] = (gl[..., 3].astype(np.float32) * min(1.0, glow)).astype(np.uint8)
        canvas = over(canvas, gl)
    vis_local = prm.get("visor", {})
    layer, vm = shared("visor", dict(rot=vis_local.get("rot", 0), dx=vis_local.get("dx", 0), dy=vis_local.get("dy", 0)), parent=mh)
    canvas = over(canvas, layer)
    cx, cy = (PAD @ vm @ np.array([*meta["visor"]["pivot_src"], 1]))[:2]
    style = prm.get("eyes", mv["eyes"])
    look = prm.get("look", (0, 0))
    total_rot = pl["visor"]["rot"] + b.get("rot", 0) + b.get("spin", 0) + hx.get("rot", 0) + vis_local.get("rot", 0)
    eyes_rgb = draw_eyes(canvas, (cx, cy), total_rot, style, look, squish=prm.get("squish", 1.0), tilt=b.get("rot", 0) + hx.get("rot", 0))
    vis_alpha = layer[..., 3:4] > 128
    canvas[..., :3] = np.where(vis_alpha & (np.abs(eyes_rgb.astype(int) - canvas[..., :3].astype(int)).sum(2, keepdims=True) > 0), eyes_rgb, canvas[..., :3])
    bt = prm.get("button", {})
    layer, _ = shared("button", dict(rot=bt.get("rot", 0), sx=bt.get("sx", 1)), parent=mh)
    canvas = over(canvas, layer)
    if front:
        for n, r, st in arm_layers:
            canvas = over(canvas, arm(n, r, st))
    return accents(canvas, prm, (cx, cy), mb)


SHOULDERS: dict = {}


def tile(canvas):
    a = canvas[..., 3:4].astype(np.float32) / 255
    rgb = (canvas[..., :3] * a + np.array(NAVY, np.float32) * (1 - a)).clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgb).resize((TILE, TILE), Image.LANCZOS)


def render_all(parts, meta, report, shots: Path):
    for pose, entry in report.items():
        pass
    from PIL import ImageFont  # noqa: PLC0415

    # shoulder pivots per pose come from the cut outlines (art px)
    import bob_rig_build as rb  # noqa: PLC0415

    for pose in rb.POSES:
        SHOULDERS[pose] = {}
    for name, (pose, _, pv) in rb.ARMS.items():
        SHOULDERS[pose]["L" if name.startswith("armL") else "R"] = meta[name].get("shoulder", pv)
    # arms of another pose sit on this pose's shoulders; if a pose lacks the side, fall back to the playful one
    for pose in rb.POSES:
        for side in ("L", "R"):
            SHOULDERS[pose].setdefault(side, SHOULDERS["playful"][side])
    font = ImageFont.load_default()
    for name, mv in MOVES.items():
        n = mv.get("frames", FRAMES)
        rows = (n + 11) // 12
        per = min(n, 12)
        strip = Image.new("RGB", (TILE * per, (TILE + 18) * rows), NAVY)
        d = ImageDraw.Draw(strip)
        for i in range(n):
            t = i / (n - 1)
            x, y = (i % 12) * TILE, (i // 12) * (TILE + 18)
            strip.paste(tile(render_frame(parts, meta, report, mv, t)), (x, y + 18))
            d.text((x + 4, y + 3), f"{i + 1}", fill=(187, 221, 240), font=font)
        d.text((60, 3), f"{name}  ({mv['pose']} pose, {n} frames, house ease .45,0,.55,1)", fill=(240, 199, 94), font=font)
        strip.quantize(colors=160, method=Image.Quantize.MEDIANCUT).save(shots / f"rig-move-{name}.png", optimize=True)

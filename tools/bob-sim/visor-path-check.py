"""The visor-only redraw rules, checked on the real firmware through bob-sim renders.
An accent-free Bob (idle) blinks as small visor-sized changes; Bob with an accent (grateful) never does, so his accent is never erased.
usage: py -3.11 -I tools/bob-sim/visor-path-check.py   (run from the repo root; needs Docker for bob-sim)"""
import glob, os, shutil, subprocess, sys
from PIL import Image, ImageChops

OUT = 'tools/bob-sim/.visor-check'

def frames(emotion, n=330):
    shutil.rmtree(OUT, ignore_errors=True)
    subprocess.run(['node', 'tools/bob-sim/run.mjs', 'render', '--state', 'ready', '--emotion', emotion, '--frames', str(n), '--all-frames', '--out', OUT],
                   check=True, stdout=subprocess.DEVNULL)
    prev, small, wide = None, 0, 0
    for i, f in enumerate(sorted(glob.glob(OUT + '/*-[0-9][0-9][0-9].png'))):
        im = Image.open(f).convert('RGB')
        b = ImageChops.difference(im, prev).getbbox() if prev else None
        if b and (b[2] - b[0]) < 120 and (b[3] - b[1]) < 40 and b[1] > 60: small += 1
        if b and (b[2] - b[0]) >= 120 and i > 150: wide += 1
        prev = im
    return small, wide

(idle, _), (grateful, _) = frames('idle'), frames('grateful')
_, still_wide = frames('idle', 900)  # 30 s on Ready: after the entry burst, Bob never moves as a whole (no half-played hop frozen mid-air)
shutil.rmtree(OUT, ignore_errors=True)
print(f'visor-sized changes: idle={idle} grateful={grateful}, whole-Bob changes after the entry burst={still_wide}')
if idle < 3 or grateful != 0 or still_wide != 0:
    sys.exit('FAIL: expected blinks as visor-only redraws for idle and none for an accent emotion')
print('PASS')

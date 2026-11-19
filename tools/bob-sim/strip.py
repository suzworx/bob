#!/usr/bin/env python3
"""Tile bob-sim frames (render --all-frames) into one strip PNG: strip.py <frames dir> <out.png> [step] [cols]."""
import sys
from pathlib import Path

from PIL import Image

src, out = Path(sys.argv[1]), Path(sys.argv[2])
step = int(sys.argv[3]) if len(sys.argv) > 3 else 2
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 8
frames = sorted(p for p in src.glob("*-[0-9][0-9][0-9].png"))[::step]
box = (62, 46, 298, 264)  # the Bob zone on the 360 px glass
tiles = [Image.open(p).convert("RGB").crop(box) for p in frames]
w, h = tiles[0].size
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * h), (23, 62, 87))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols) * w, (i // cols) * h))
sheet.save(out, optimize=True)
print(out, len(tiles), "frames")

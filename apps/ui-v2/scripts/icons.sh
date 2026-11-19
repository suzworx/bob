#!/bin/sh
# Regenerates the raster web icons (apple-touch-icon.png, favicon.ico) from the two tiles in public/favicon.svg.
# macOS-only: sips rasterises the SVG; ImageMagick's own SVG renderer drops the strokes.
set -eu

cd "$(dirname "$0")/.."

src=public/favicon.svg
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# tile <light|dark>: that tile alone as a full-bleed SVG (rx="0"), so the gradient reaches the corners and iOS applies its own mask, rasterised once at 512px.
tile() {
  {
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    sed -n "/^<g class=\"$1\">\$/,/^<\/g>\$/p" "$src"
    echo '</svg>'
  } | sed 's/rx="112"/rx="0"/g' > "$tmp/$1.svg"
  sips -s format png "$tmp/$1.svg" --out "$tmp/$1.png" > /dev/null
}

# raster <tile> <px> <out.png>: the tile scaled to px x px, alpha flattened away.
raster() {
  magick "$tmp/$1.png" -resize "$2x$2" -alpha off "$3"
}

tile dark
tile light

raster dark 180 public/apple-touch-icon.png

for px in 16 32 48; do
  raster light "$px" "$tmp/favicon-$px.png"
done
magick "$tmp/favicon-16.png" "$tmp/favicon-32.png" "$tmp/favicon-48.png" public/favicon.ico

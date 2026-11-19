#!/bin/sh
# macOS-only: sips (CoreSVG) rasterises the Orbit tiles in ui-v2's favicon.svg because ImageMagick's own SVG
# renderer drops the strokes; ImageMagick then flattens and composes the PNGs (needs `magick`, e.g. brew install imagemagick).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../ui-v2/public/favicon.svg"
assets="$here/../ios/App/App/Assets.xcassets"
cream='#fff9ee'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# tile <light|dark> <rx> <px> [flat]: that tile of favicon.svg alone (corner radius rx), rasterised at px x px.
# "flat" also drops the tile's background rect, leaving only the rings, the glow and the dot.
tile() {
  drop='/^$/d'
  if [ "${4:-}" = flat ]; then drop="/fill=\"url(#bg-$1)\"/d"; fi
  {
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    sed -n "/^<g class=\"$1\">\$/,/^<\/g>\$/p" "$src"
    echo '</svg>'
  } | sed -e "s/rx=\"112\"/rx=\"$2\"/g" -e "$drop" > "$tmp/$1.svg"
  sips -s format png -Z "$3" "$tmp/$1.svg" --out "$tmp/$1.png" >/dev/null
}

# Icon: the dark tile, full-bleed (rx 0) so the gradient reaches the corners and iOS applies its own mask; NO alpha.
tile dark 0 1024
magick "$tmp/dark.png" -alpha off "$assets/AppIcon.appiconset/AppIcon-512@2x.png"

# Splash: every PNG the template ships, one flat 2732 px cream field with the light Orbit (no tile) centred at about 640 px.
tile light 0 640 flat
for png in "$assets"/Splash.imageset/*.png; do
  [ -e "$png" ] || continue
  magick -size 2732x2732 xc:"$cream" "$tmp/light.png" -gravity center -composite -alpha off "$png"
done

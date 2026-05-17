#!/bin/bash
# Turn any photo into the iPhone home-screen icons.
# Usage:  ./make-icon.sh /path/to/your-photo.jpg
# Then:   git add apple-touch-icon.png icon-192.png icon-512.png && git commit -m "App icon" && git push
set -e
SRC="$1"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "Usage: ./make-icon.sh /path/to/your-photo.jpg"
  exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$DIR/.icon-src.png"
W=$(sips -g pixelWidth  "$SRC" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
S=$(( W < H ? W : H ))                 # square size = shorter side
sips -c "$S" "$S" "$SRC" --out "$TMP" >/dev/null   # center-crop to square
sips -z 180 180 "$TMP" --out "$DIR/apple-touch-icon.png" >/dev/null
sips -z 192 192 "$TMP" --out "$DIR/icon-192.png"        >/dev/null
sips -z 512 512 "$TMP" --out "$DIR/icon-512.png"        >/dev/null
rm -f "$TMP"
echo "Done. Icons updated from: $SRC"
echo "Now run:  cd \"$DIR\" && git add apple-touch-icon.png icon-192.png icon-512.png && git commit -m 'Use family photo as app icon' && git push"

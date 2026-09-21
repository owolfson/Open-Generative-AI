#!/usr/bin/env bash
# Fetch a static ffmpeg into vendor/ffmpeg/ (git-ignored; copied into the image by the Dockerfile). Used only to turn sd.cpp's
# MJPEG .avi into an H.264 .mp4 that browsers can play. Static + runtime CPU dispatch, so it runs on the AVX-only host.
set -euo pipefail
cd "$(dirname "$0")"
DEST=vendor/ffmpeg
URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
[ -x "$DEST/ffmpeg" ] && { echo "ffmpeg already present: $("$DEST/ffmpeg" -version | head -1)"; exit 0; }
mkdir -p "$DEST"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/ffmpeg.tar.xz" "$URL"
EXPECT=$(curl -fsL "$URL.md5" | awk '{print $1}')
echo "$EXPECT  $TMP/ffmpeg.tar.xz" | md5sum -c -
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP" --wildcards '*/ffmpeg'
install -m 0755 "$TMP"/ffmpeg-*-static/ffmpeg "$DEST/ffmpeg"
echo "ffmpeg ready: $("$DEST/ffmpeg" -version | head -1)"

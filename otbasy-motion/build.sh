#!/bin/bash
# Полная сборка: события → звук → кадры (60 fps, 3 субкадра на кадр) → MP4 H.264 + AAC
set -e
cd "$(dirname "$0")"
node render.mjs events
python3 audio.py 1.78
OUT=frames Q="sub=3" node render.mjs frames 0 1320 1
ffmpeg -y -framerate 60 -i frames/f%05d.jpg -i mix.wav -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -r 60 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a aac -b:a 256k -t 22 -movflags +faststart otbasy-motion.mp4

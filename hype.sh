#!/usr/bin/env bash
# Build, serve, record the trailer's footage off the real game, and cut it. See tools/hype/README.md.
#
#   ./hype.sh                 # record every scene, then compose
#   ./hype.sh --compose       # re-cut from footage already recorded
#   ./hype.sh play crash      # re-record just these scenes, then compose
#
# Linux boxes want CHROME=/opt/pw-browsers/chromium (the default) and an ffmpeg with libx264 —
# `pip install imageio-ffmpeg` is the least painful way to get one.

set -euo pipefail

OUT="${HYPE_DIR:-./hype}"
PORT="${PORT:-4173}"

if [[ "${1:-}" != "--compose" ]]; then
  npm run build >/dev/null
  npx vite preview --port "$PORT" >/dev/null 2>&1 &
  preview_pid=$!
  trap 'kill $preview_pid 2>/dev/null || true' EXIT
  until curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; do sleep 0.3; done
  node tools/hype/record.mjs --url "http://localhost:$PORT" --out "$OUT/frames" "$@"
fi

node tools/hype/compose.mjs --frames "$OUT/frames" --out "$OUT/sim-taxi-trailer.mp4"

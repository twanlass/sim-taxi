#!/usr/bin/env bash
# Build, serve, and render the deterministic review shots.
#
#   ./shots.sh            # all shots
#   ./shots.sh 0 2        # just shots 0 and 2
#
# Screenshots go through tools/shoot.mjs (CDP), which waits for the page to signal that it has
# actually drawn. Rendering happens against the production bundle rather than the dev server —
# fewer requests, and nothing depends on module-load timing.

set -euo pipefail

OUT="${SHOT_DIR:-./shots}"
PORT="${PORT:-4173}"

shots="${*:-0 1 2 3}"
shots_csv="${shots// /,}"

npm run build >/dev/null

npx vite preview --port "$PORT" >/dev/null 2>&1 &
preview_pid=$!
trap 'kill $preview_pid 2>/dev/null || true' EXIT

until curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; do sleep 0.3; done

node tools/shoot.mjs --url "http://localhost:$PORT" --out "$OUT" --shots "$shots_csv"

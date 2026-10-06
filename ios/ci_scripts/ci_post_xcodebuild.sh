#!/bin/sh
# Xcode Cloud runs this after xcodebuild. Exiting non-zero fails the build, so nothing reaches
# TestFlight.
#
# The same bundle-layout assertion `tools/ios-push.mjs` makes before an install: `web/` has to land
# in the .app as a folder. Flattened, every asset path 404s at runtime on a build that went green —
# see docs/ios.md, "The bundle layout". Only an archive has a .app to look at.
set -eu

[ -n "${CI_ARCHIVE_PATH:-}" ] || exit 0

app="$CI_ARCHIVE_PATH/Products/Applications/SimTaxi.app"
if [ ! -f "$app/web/index.html" ]; then
  echo "error: $app has no web/index.html — BundleSchemeHandler will fatalError on launch." >&2
  if [ -f "$app/index.html" ]; then
    echo "error: the web bundle was flattened into the app root. See docs/ios.md, 'The bundle layout'." >&2
  fi
  exit 1
fi
echo "bundle layout ok: $app/web/index.html"

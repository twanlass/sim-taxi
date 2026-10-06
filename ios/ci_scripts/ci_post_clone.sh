#!/bin/sh
# Xcode Cloud runs this after cloning and before xcodebuild — see docs/ios.md, "Cloud builds".
#
# `ios/SimTaxi/web/` is gitignored, so a fresh clone has no game in it: the archive would build
# green and ship a shell that dies at BundleSchemeHandler's fatalError on launch. This puts the web
# bundle there the same way `npm run push:ios` does on the Mac. Xcode Cloud images carry Homebrew
# but not Node; 22 matches netlify.toml.
set -eu

brew install node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"

cd "$CI_PRIMARY_REPOSITORY_PATH"
npm ci
npm run build:ios

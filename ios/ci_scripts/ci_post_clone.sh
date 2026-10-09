#!/bin/sh
# Xcode Cloud runs this after cloning and before xcodebuild — see docs/ios.md, "Cloud builds".
#
# `ios/SimTaxi/web/` is gitignored, so a fresh clone has no game in it: the archive would build
# green and ship a shell that dies at BundleSchemeHandler's fatalError on launch. This puts the web
# bundle there the same way `npm run push:ios` does on the Mac.
#
# Xcode Cloud images carry no Node. The first version of this script ran `brew install node@22`,
# which also runs `brew update` against GitHub first, and build 46 died inside this script after
# 53 seconds on a commit whose `npm ci && npm run build:ios` passes everywhere else. So Node now
# comes straight from nodejs.org, checksum-verified, with Homebrew (minus its auto-update) only as
# the fallback. 22 matches netlify.toml. Each step announces itself, because Xcode Cloud reports
# only "ci_post_clone.sh exited with code 1" and the log is the one place that says which part.
set -eu

step() { echo "ci_post_clone: $*"; }

install_node_tarball() {
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) return 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v22.x"
  dir="${TMPDIR:-/tmp}/ci-node"
  mkdir -p "$dir"
  curl -fsSL --retry 3 --retry-delay 2 "$base/SHASUMS256.txt" -o "$dir/SHASUMS256.txt" || return 1
  line=$(grep "darwin-$arch.tar.gz\$" "$dir/SHASUMS256.txt") || return 1
  file=$(echo "$line" | awk '{print $2}')
  curl -fsSL --retry 3 --retry-delay 2 "$base/$file" -o "$dir/$file" || return 1
  (cd "$dir" && echo "$line" | shasum -a 256 -c -) || return 1
  tar -xzf "$dir/$file" -C "$dir" || return 1
  export PATH="$dir/${file%.tar.gz}/bin:$PATH"
}

if command -v node >/dev/null 2>&1; then
  step "using preinstalled node"
elif install_node_tarball; then
  step "installed node from nodejs.org"
else
  step "nodejs.org failed, falling back to Homebrew"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
step "node $(node -v), npm $(npm -v)"

cd "$CI_PRIMARY_REPOSITORY_PATH"
step "npm ci"
npm ci --no-audit --no-fund
step "npm run build:ios"
npm run build:ios
step "done"

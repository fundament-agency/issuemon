#!/bin/sh
# Checks the archives in dist/ for each architecture given, as the release uploads them: the .tar.xz, unpacked the way
# Homebrew does it, holds a signed IssueMon.app with a date (an archive without folder dates, like electron-builder's
# own tar.xz, unpacks as 1970), and the .dmg is LZMA-compressed.  Usage: scripts/verify-archives.sh arm64 x64
set -eu

version=$(node -p "require('./package.json').version")
for arch in "$@"; do
  base="dist/issuemon-$version-$arch"
  dir=$(mktemp -d)
  /usr/bin/tar --extract --no-same-owner --file "$base.tar.xz" --directory "$dir"
  codesign --verify --deep --strict "$dir/IssueMon.app"
  [ "$(stat -f %m "$dir/IssueMon.app")" -gt 0 ] || { echo "$base.tar.xz: IssueMon.app has no date" >&2; exit 1; }
  rm -rf "$dir"
  [ -f "$base.dmg" ] || { echo "$base.dmg is missing" >&2; exit 1; }
  hdiutil imageinfo "$base.dmg" | grep -q '^Format: ULMO$' || { echo "$base.dmg is not LZMA-compressed" >&2; exit 1; }
  echo "$base.tar.xz and $base.dmg: fine"
done

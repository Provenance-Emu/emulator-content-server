#!/bin/bash
# Builds the iCloud reader and places it, signed, inside a desktop app bundle that is about to be
# signed. The helper alone carries the iCloud entitlement, so it is signed here, first, with its
# own provisioning profile; the caller then signs the app around it.
# See docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md.
set -euo pipefail
# Say where it stopped: a command substitution that fails ends the script without a word.
trap 'echo "embed-icloud-reader.sh stopped at line $LINENO" >&2' ERR

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <app-bundle> <developer-id-provisioning-profile>" >&2
  exit 2
fi
: "${APPLE_SIGNING_IDENTITY:?Set a Developer ID Application signing identity}"
app=$1
profile=$2
root=$(cd "$(dirname "$0")/.." && pwd)
package="$root/apps/icloud-reader"
if [[ ! -d "$app/Contents/MacOS" || ! -f "$profile" ]]; then
  echo 'Embedding needs an app bundle and a provisioning profile file.' >&2
  exit 2
fi

# PlistBuddy reads keys that contain dots the same way on every macOS the nightly runs on.
read_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2"; }
identifier=$(read_plist CFBundleIdentifier "$package/Bundle/Info.plist")
container=iCloud.org.provenance-emu.provenance
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ecs-reader.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

# A profile for another app, or without the container, would be refused when the helper starts.
# Find that out now instead.
security cms -D -i "$profile" > "$scratch/profile.plist"
allowed=$(read_plist Entitlements:com.apple.application-identifier "$scratch/profile.plist")
if [[ "$allowed" != *".$identifier" ]]; then
  echo "The provisioning profile is for $allowed, not for $identifier." >&2
  exit 1
fi
containers=$(read_plist Entitlements:com.apple.developer.icloud-container-identifiers "$scratch/profile.plist")
if ! grep -qx "[[:space:]]*$container" <<<"$containers"; then
  echo "The provisioning profile does not include $container." >&2
  exit 1
fi

# Same architecture as the app it goes into.
main=$(read_plist CFBundleExecutable "$app/Contents/Info.plist")
arch=$(lipo -archs "$app/Contents/MacOS/$main" | awk '{print $1}')
echo "Building the iCloud reader for $arch"
xcrun swift build --package-path "$package" -c release --arch "$arch" > "$scratch/build.log" 2>&1 || {
  tail -40 "$scratch/build.log" >&2
  exit 1
}
built=$(xcrun swift build --package-path "$package" -c release --arch "$arch" --show-bin-path)

helper="$app/Contents/Helpers/iCloud Reader.app"
rm -rf "$helper"
mkdir -p "$helper/Contents/MacOS"
ditto "$built/icloud-reader" "$helper/Contents/MacOS/icloud-reader"
ditto "$package/Bundle/Info.plist" "$helper/Contents/Info.plist"
version=$(read_plist CFBundleShortVersionString "$app/Contents/Info.plist")
plutil -replace CFBundleShortVersionString -string "$version" "$helper/Contents/Info.plist"
ditto "$profile" "$helper/Contents/embedded.provisionprofile"

echo 'Signing the iCloud reader'
codesign --force --options runtime --timestamp \
  --entitlements "$package/Bundle/icloud-reader.entitlements" \
  --sign "$APPLE_SIGNING_IDENTITY" "$helper"
codesign --verify --strict "$helper"
signed=$(codesign -d --entitlements - "$helper" 2>/dev/null)
if [[ "$signed" != *"$container"* ]]; then
  echo 'The signed iCloud reader does not carry the container entitlement.' >&2
  exit 1
fi

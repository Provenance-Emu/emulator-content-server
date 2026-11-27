#!/bin/bash
# Builds the iCloud reader and places it, signed, inside a desktop app bundle that is about to be
# signed. The helper alone carries the iCloud entitlement, so it is signed here, first, with its
# own provisioning profile; the caller then signs the app around it.
# See docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md.
set -euo pipefail

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

identifier=$(plutil -extract CFBundleIdentifier raw -o - "$package/Bundle/Info.plist")
container=iCloud.org.provenance-emu.provenance
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ecs-reader.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

# A profile for another app, or without the container, would be refused when the helper starts.
# Find that out now instead.
security cms -D -i "$profile" > "$scratch/profile.plist"
allowed=$(plutil -extract Entitlements.com\\.apple\\.application-identifier raw -o - "$scratch/profile.plist")
if [[ "$allowed" != *".$identifier" ]]; then
  echo "The provisioning profile is for $allowed, not for $identifier." >&2
  exit 1
fi
if ! plutil -extract Entitlements.com\\.apple\\.developer\\.icloud-container-identifiers json -o - \
  "$scratch/profile.plist" | grep -q "\"$container\""; then
  echo "The provisioning profile does not include $container." >&2
  exit 1
fi

# Same architecture as the app it goes into.
main=$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")
arch=$(lipo -archs "$app/Contents/MacOS/$main" | awk '{print $1}')
echo "Building the iCloud reader for $arch"
xcrun swift build --package-path "$package" -c release --arch "$arch" >/dev/null
built=$(xcrun swift build --package-path "$package" -c release --arch "$arch" --show-bin-path)

helper="$app/Contents/Helpers/iCloud Reader.app"
rm -rf "$helper"
mkdir -p "$helper/Contents/MacOS"
ditto "$built/icloud-reader" "$helper/Contents/MacOS/icloud-reader"
ditto "$package/Bundle/Info.plist" "$helper/Contents/Info.plist"
version=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")
plutil -replace CFBundleShortVersionString -string "$version" "$helper/Contents/Info.plist"
ditto "$profile" "$helper/Contents/embedded.provisionprofile"

echo 'Signing the iCloud reader'
codesign --force --options runtime --timestamp \
  --entitlements "$package/Bundle/icloud-reader.entitlements" \
  --sign "$APPLE_SIGNING_IDENTITY" "$helper"
codesign --verify --strict "$helper"
codesign -d --entitlements - "$helper" 2>/dev/null | grep -q "$container"

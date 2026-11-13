#!/bin/bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <unsigned-dmg> <signed-dmg>" >&2
  exit 2
fi
: "${APPLE_SIGNING_IDENTITY:?Set a Developer ID Application signing identity}"
: "${ASC_KEY_PATH:?Set the App Store Connect key path}"
: "${ASC_KEY_ID:?Set the App Store Connect key ID}"
: "${ASC_ISSUER_ID:?Set the App Store Connect issuer ID}"

input=$1
output=$2
if [[ ! -f "$input" || -e "$output" ]]; then
  echo 'Signing requires an existing input and a fresh output path.' >&2
  exit 2
fi
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ecs-notarize.XXXXXX")
mount="$scratch/mounted"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount" >/dev/null || return
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

mkdir "$mount"
bundle="$scratch/bundle"
mkdir -p "$bundle/macos"
app="$bundle/macos/Emulation Server.app"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$input" >/dev/null
mounted=true
ditto "$mount/Emulation Server.app" "$app"
hdiutil detach "$mount" >/dev/null
mounted=false

bundle_id=$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")
if [[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ && ${GITHUB_RUN_NUMBER:-} =~ ^[1-9][0-9]*$ ]]; then
  plutil -insert ECSNightlyCommit -string "$GITHUB_SHA" "$app/Contents/Info.plist"
  plutil -insert ECSNightlyRun -integer "$GITHUB_RUN_NUMBER" "$app/Contents/Info.plist"
fi
echo 'Signing macOS app bundle'
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$app"
node scripts/package-macos.mjs "$bundle"
images=("$bundle"/dmg/*.dmg)
dmg=${images[0]}
echo 'Signing macOS disk image'
codesign --force --timestamp --identifier "$bundle_id.dmg" --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
codesign --verify --strict "$dmg"

result="$scratch/notary.json"
xcrun notarytool submit "$dmg" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID" --wait --timeout 25m --output-format json > "$result"
if ! jq -e '.status == "Accepted"' "$result" >/dev/null; then
  jq -r '"Apple notarization status: \(.status). Submission: \(.id)"' "$result" >&2
  exit 1
fi
# Stapler's exit code also covers invalid tickets. Retry only URL transport errors.
for action in staple validate; do
  for attempt in 1 2 3; do
    if ticket_output=$(xcrun stapler "$action" "$dmg" 2>&1); then
      printf '%s\n' "$ticket_output"
      break
    else
      status=$?
    fi
    printf '%s\n' "$ticket_output" >&2
    if (( attempt == 3 )) || ! [[ $ticket_output =~ Domain=NSURLErrorDomain[[:space:]]Code=-(1001|1004|1005)($|[[:space:]]) ]]; then
      exit "$status"
    fi
    delay=$((attempt * 5))
    printf 'Ticket %s hit a network error (attempt %s/3). Retrying in %s seconds.\n' "$action" "$attempt" "$delay" >&2
    sleep "$delay"
  done
done
hdiutil verify "$dmg" >/dev/null
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$dmg" >/dev/null
mounted=true
codesign --verify --deep --strict -R "$(<apps/tray/src-tauri/src/desktop-update.requirement)" \
  "$mount/Emulation Server.app"
spctl --assess --type execute --verbose=2 "$mount/Emulation Server.app"
hdiutil detach "$mount" >/dev/null
mounted=false
mv "$dmg" "$output"

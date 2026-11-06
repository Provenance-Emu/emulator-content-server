#!/usr/bin/env bash
set -euo pipefail

repo=Provenance-Emu/emulator-content-server
api=https://api.github.com/repos/$repo/releases
downloads=https://github.com/$repo/releases/download
origin=http://127.0.0.1:8473

die() { printf 'Emulation Server: %s\n' "$*" >&2; exit 1; }
download() {
  curl -q -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 \
    --max-time 300 --max-filesize "$3" -o "$2" "$1"
}
ask() {
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || die 'Setup was canceled.'
}

uid=$(id -u)
[[ $uid != 0 ]] || die 'Run setup as your normal user.'
case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    platform=macos-arm64
    base="$HOME/Library/Application Support/Emulation Server"
    desktop_ext=dmg
    ;;
  Linux:x86_64)
    platform=linux-x64
    base="${XDG_DATA_HOME:-$HOME/.local/share}/emulation-server"
    desktop_ext=AppImage
    ;;
  *) die 'This installer supports Apple Silicon macOS and Linux x64.' ;;
esac

channel=${1:-}
choice=${2:-}
[[ $# -le 2 ]] || die 'Usage: install-server.sh [nightly|release] [server|both]'
if [[ -z $channel ]]; then
  ask 'Install from [1] Nightly or [2] Release? [1] '
  case "$answer" in
    ''|1) channel=nightly ;;
    2) channel=release ;;
    *) die 'Choose 1 or 2.' ;;
  esac
fi
[[ $channel == nightly || $channel == release ]] || die 'Choose nightly or release.'
[[ -z $choice || $choice == server || $choice == both ]] || die 'Choose server or both.'

check_service() {
  if [[ $platform == macos-arm64 ]]; then
    local agent="$HOME/Library/LaunchAgents/app.emulator-content-server.plist"
    if [[ -e $agent || -L $agent ]] || launchctl print "gui/$uid/app.emulator-content-server" >/dev/null 2>&1; then
      die 'A login service already exists. Use it or its update settings.'
    fi
    launchctl print "gui/$uid" >/dev/null 2>&1 || die 'Run setup from a logged-in macOS account.'
  else
    local state unit="$HOME/.config/systemd/user/ecs.service"
    systemctl --user show-environment >/dev/null || die 'A systemd user session is required.'
    state=$(systemctl --user show --property=LoadState --value ecs.service) ||
      die 'Could not check the existing systemd service.'
    [[ $state == not-found && ! -e $unit && ! -L $unit ]] ||
      die 'A login service already exists. Use it or its update settings.'
  fi
}

# Emit the same columns with the system JSON parser on each platform.
asset_rows() {
  if [[ $platform == macos-arm64 ]]; then
    osascript -l JavaScript - "$1" <<'JXA'
ObjC.import('Foundation');
function run(args) {
  const json = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null));
  const entries = JSON.parse(json);
  return [].concat(entries).filter(entry => !entry.draft).flatMap(entry =>
    entry.assets.map(asset => [entry.tag_name, asset.name, asset.size, asset.digest].join('\t'))
  ).join('\n');
}
JXA
  else
    python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    entries = json.load(source)
for entry in entries if isinstance(entries, list) else [entries]:
    if not entry['draft']:
        for asset in entry['assets']:
            print(entry['tag_name'], asset['name'], asset['size'], asset.get('digest') or '', sep='\t')
PY
  fi
}

check_service
umask 077
mkdir -p "$base/launchers"
lock="$base/.installer-lock"
mkdir "$lock" 2>/dev/null || die 'Another installation is running.'
scratch=''
mounted=''
cleanup() {
  if [[ -n $mounted ]]; then hdiutil detach "$mounted" >/dev/null 2>&1 || return; fi
  if [[ -n $scratch ]]; then rm -rf -- "$scratch"; fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
scratch=$(mktemp -d "$base/launchers/.install.XXXXXXXX")

find_package() {
  if [[ $channel == nightly ]]; then
    endpoint="$api/tags/nightly"
  else
    endpoint="$api?per_page=100"
  fi
  download "$endpoint" "$scratch/releases.json" 16000000 || die 'Could not read releases from GitHub.'
  asset_rows "$scratch/releases.json" >"$scratch/assets.tsv" || die 'Could not read the release assets.'
  awk -F '\t' -v channel="$channel" -v platform="$platform" '
    channel == "nightly" && $1 != "nightly" { next }
    channel == "release" && $1 !~ /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/ { next }
    $2 == "Emulation-Server-" substr($1, 1 + (channel == "release")) "-" platform ".tar.gz" {
      print $1; exit
    }
  ' "$scratch/assets.tsv"
}

tag=$(find_package)
if [[ -z $tag && $channel == release && $# -eq 0 ]]; then
  ask 'No tagged server package is available for this system. Install Nightly? [y/N] '
  [[ $answer == y || $answer == Y ]] || exit 0
  channel=nightly
  tag=$(find_package)
fi
[[ -n $tag ]] || die "No $channel server package is available for this system."
name="Emulation-Server-${tag#v}-$platform"
desktop_name="$name.$desktop_ext"
desktop=false
if [[ $platform == macos-arm64 || -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] &&
  awk -F '\t' -v tag="$tag" -v name="$desktop_name" '$1 == tag && $2 == name { found=1 } END { exit !found }' "$scratch/assets.tsv"; then
  if [[ -z $choice ]]; then
    ask 'Install the server and the desktop app? [y/N] '
    if [[ $answer == y || $answer == Y ]]; then desktop=true; fi
  elif [[ $choice == both ]]; then
    desktop=true
  fi
elif [[ $choice == both ]]; then
  die 'A desktop app is unavailable for this release or session.'
fi

fetch_verified() {
  local asset=$1 metadata size digest actual
  metadata=$(awk -F '\t' -v tag="$tag" -v name="$asset" '
    $1 == tag && $2 == name { size=$3; digest=$4; count++ }
    END { if (count == 1) print size, digest; else exit 1 }
  ' "$scratch/assets.tsv") || die "Could not find $asset."
  read -r size digest <<<"$metadata"
  [[ $size =~ ^[1-9][0-9]{0,8}$ && $size -le 536870912 && $digest =~ ^sha256:[a-f0-9]{64}$ ]] ||
    die "Could not verify the download metadata for $asset."
  download "$downloads/$tag/$asset" "$scratch/$asset" "$size"
  if [[ $platform == macos-arm64 ]]; then
    actual=$(shasum -a 256 "$scratch/$asset")
  else
    actual=$(sha256sum "$scratch/$asset")
  fi
  [[ ${actual%% *} == "${digest#sha256:}" ]] || die "Checksum mismatch for $asset. Try again shortly."
}

printf 'Downloading %s server…\n' "$tag"
fetch_verified "$name.tar.gz"
tar -xzf "$scratch/$name.tar.gz" -C "$scratch"
[[ -x $scratch/$name/ecs ]] || die 'The downloaded package is missing its launcher.'
data="$base/data"
check_service
if ! "$scratch/$name/runtime/node" -e '
  const server = require("node:net").createServer();
  server.on("error", () => process.exit(1));
  server.listen(8473, "127.0.0.1", () => server.close());
'; then
  die "Port 8473 is already in use. Open $origin/ui/ to check the existing server."
fi
launcher="$base/launchers/$name-${scratch##*.}"
mv "$scratch/$name" "$launcher"
install_service() {
  "$launcher/ecs" init --data "$data" >/dev/null
  check_service
  "$launcher/ecs" service install --data "$data" --host 127.0.0.1
}
if [[ $platform == macos-arm64 ]]; then
  if ! "$launcher/ecs" service setup-local --data "$data" --host 127.0.0.1 >/dev/null 2>"$scratch/setup-error"; then
    if grep -Fxq 'service takes install, uninstall, or status' "$scratch/setup-error"; then
      # Earlier portable packages already support ordinary service registration.
      install_service
    else
      cat "$scratch/setup-error" >&2
      exit 1
    fi
  fi
else
  install_service
fi

for ((attempt=0; attempt<30; attempt++)); do
  if curl -qfsS --max-time 1 "$origin/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
[[ $attempt -lt 30 ]] || die "The login service was registered, but the server has not answered. Check $data/logs/ecs.log."
printf '\nServer is running. Open %s/ui/\n' "$origin"
if [[ -f $data/bootstrap.token ]]; then
  printf 'Use the one-time setup code from %s/bootstrap.token to create the owner account.\n' "$data"
fi
if [[ $platform == linux-x64 && -z ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] &&
  ! loginctl --no-ask-password enable-linger "$(id -un)" >/dev/null 2>&1; then
  printf 'Run loginctl enable-linger to keep the server running after logout.\n'
fi

if "$desktop"; then
  printf 'Downloading the desktop app…\n'
  fetch_verified "$desktop_name"
  if [[ $platform == macos-arm64 ]]; then
    app="$HOME/Applications/Emulation Server.app"
    if [[ -e $app || -L $app || -e /Applications/Emulation\ Server.app ]]; then
      printf 'Emulation Server.app is already installed.\n'
      exit 0
    fi
    spctl --assess --type open --context context:primary-signature "$scratch/$desktop_name"
    mkdir "$scratch/volume"
    hdiutil attach -nobrowse -readonly -mountpoint "$scratch/volume" "$scratch/$desktop_name" >/dev/null
    mounted="$scratch/volume"
    spctl --assess --type execute "$mounted/Emulation Server.app"
    mkdir -p "$HOME/Applications"
    ditto "$mounted/Emulation Server.app" "$app"
    printf 'Desktop app installed in %s/Applications.\n' "$HOME"
  else
    app="$base/Emulation Server.AppImage"
    if [[ -e $app || -L $app ]]; then
      printf 'Emulation Server.AppImage is already installed.\n'
      exit 0
    fi
    mv "$scratch/$desktop_name" "$app"
    chmod +x "$app"
    printf 'Desktop app installed at %s\n' "$app"
  fi
fi

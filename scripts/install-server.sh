#!/usr/bin/env bash
set -euo pipefail

repo=Provenance-Emu/emulator-content-server
api=https://api.github.com/repos/$repo/releases
downloads=https://github.com/$repo/releases/download
origin=http://127.0.0.1:8473
label=app.emulator-content-server
daemon="/Library/LaunchDaemons/$label.plist"

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

default_data="$base/data"
inspect_service() {
  data=$default_data
  origin=http://127.0.0.1:8473
  service_found=false
  service_state='not installed'
  manager_ready=false
  service_mode=login
  local port='' args='' configured_data='' state='' agent unit
  if [[ $platform == macos-arm64 ]]; then
    agent="$HOME/Library/LaunchAgents/$label.plist"
    if launchctl print "gui/$uid" >/dev/null 2>&1; then manager_ready=true; fi
    if [[ -e $daemon || -L $daemon ]]; then
      service_found=true
      service_mode=boot
      manager_ready=true
      service_state='installed, stopped'
      if state=$(launchctl print "system/$label" 2>/dev/null); then
        service_state=$(awk -F ' = ' '/^\tstate = / {print $2; exit}' <<<"$state")
      fi
      args=$(mac_registered_arguments "$daemon") || args=''
    elif state=$(launchctl print "gui/$uid/$label" 2>/dev/null); then
      service_found=true
      service_state=$(awk -F ' = ' '/^\tstate = / {print $2; exit}' <<<"$state")
      args=$(awk '/^\targuments = \{/ {active=1; next} active && /^\t}/ {exit} active {sub(/^\t\t/, ""); print}' <<<"$state")
    elif [[ -e $agent || -L $agent ]]; then
      service_found=true
      service_state='installed, stopped'
      args=$(mac_registered_arguments "$agent") || args=''
    fi
    configured_data=$(awk '$0=="--data" {getline; print; exit}' <<<"$args")
    port=$(awk '$0=="--port" {getline; print; exit}' <<<"$args")
  else
    unit="$HOME/.config/systemd/user/ecs.service"
    if systemctl --user show-environment >/dev/null 2>&1; then
      manager_ready=true
      state=$(systemctl --user show --property=LoadState --value ecs.service 2>/dev/null) || true
      if [[ -n $state && $state != not-found ]]; then
        service_found=true
        service_state=$(systemctl --user show --property=ActiveState --value ecs.service 2>/dev/null) ||
          service_state='installed'
        configured_data=$(systemctl --user show --property=WorkingDirectory --value ecs.service 2>/dev/null) ||
          configured_data=''
        args=$(systemctl --user show --property=ExecStart --value ecs.service 2>/dev/null) || args=''
        port=$(sed -nE 's/.*[[:space:]]--port[[:space:]]+([0-9]+)([[:space:];].*)?$/\1/p' <<<"$args")
      elif [[ -z $state ]]; then
        manager_ready=false
      fi
    fi
    if [[ -e $unit || -L $unit ]] && ! "$service_found"; then
      service_found=true
      service_state='installed'
    fi
  fi
  if [[ $configured_data == /* ]]; then data=$configured_data; fi
  if [[ $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]]; then origin="http://127.0.0.1:$port"; fi
  service_state=${service_state:-installed}
}

mac_registered_arguments() {
  /usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$1" 2>/dev/null |
    awk '/^    / {print substr($0, 5)}'
}

as_admin() {
  if ! sudo -n -v 2>/dev/null; then sudo -v </dev/tty || return; fi
  sudo -n "$@"
}

find_desktop() {
  installed_app=''
  local candidate
  if [[ $platform == macos-arm64 ]]; then
    for candidate in "$HOME/Applications/Emulation Server.app" '/Applications/Emulation Server.app'; do
      if [[ -e $candidate || -L $candidate ]]; then installed_app=$candidate; return; fi
    done
  elif [[ -e "$base/Emulation Server.AppImage" || -L "$base/Emulation Server.AppImage" ]]; then
    installed_app="$base/Emulation Server.AppImage"
  fi
}

server_healthy() {
  local health
  health=$(curl -qfsS --max-time 2 "$origin/health" 2>/dev/null) &&
    [[ $health =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]
}

report_installation() {
  if [[ $service_mode == boot ]]; then printf 'Boot service: %s\n' "$service_state"
  elif "$manager_ready"; then printf 'Login service: %s\n' "$service_state"
  else printf 'Login service: %s (user service manager unavailable)\n' "$service_state"; fi
  if server_healthy; then
    printf 'Server: responding at %s/ui/\n' "$origin"
  else
    printf 'Server: no response at %s/health\n' "$origin"
    if "$service_found"; then
      if [[ $service_mode == boot ]]; then
        printf 'Check the service with launchctl print system/%s.\n' "$label"
      elif [[ $platform == macos-arm64 ]]; then
        printf 'Start it from the menu bar app or check the service with launchctl print gui/%s/%s.\n' "$uid" "$label"
      else
        printf 'Check the service with systemctl --user status ecs.service.\n'
      fi
    fi
  fi
  printf 'Desktop app: %s\n' "${installed_app:-not found}"
  if [[ -f $data/bootstrap.token ]]; then
    printf 'Owner setup code: %s/bootstrap.token\n' "$data"
  fi
  if [[ -f $data/logs/ecs.log ]]; then printf 'Server log: %s/logs/ecs.log\n' "$data"; fi
}

channel=${1:-}
choice=${2:-}
startup=${3:-}
[[ $# -le 3 ]] || die 'Usage: install-server.sh [nightly|release] [server|both] [--boot|--login], or install-server.sh doctor'
inspect_service
find_desktop
if [[ $channel == doctor && $# -eq 1 ]]; then report_installation; exit 0; fi
[[ -z $channel || $channel == nightly || $channel == release ]] || die 'Choose nightly, release, or doctor.'
[[ -z $choice || $choice == server || $choice == both ]] || die 'Choose server or both.'
[[ -z $startup || $startup == --boot || $startup == --login ]] || die 'Choose --boot or --login.'
if [[ -n $startup && $platform != macos-arm64 ]]; then die 'The startup option is available on macOS.'; fi
install_server=true
if "$service_found" || server_healthy; then
  install_server=false
  report_installation
  printf 'Using the existing server installation.\n'
fi
if [[ $platform == macos-arm64 && $service_mode == login ]] &&
  { "$install_server" || [[ -f $HOME/Library/LaunchAgents/$label.plist ]]; }; then
  if [[ -z $startup && -z $choice && -t 1 ]]; then
    ask 'Start the server at [1] Login or [2] Boot before login (administrator password required)? [1] '
    case "$answer" in
      ''|1) startup=--login ;;
      2) startup=--boot ;;
      *) die 'Choose 1 or 2.' ;;
    esac
  fi
elif [[ $startup == --boot && $service_mode != boot ]]; then
  die 'The running server has no login registration for this installer to convert.'
fi
if [[ $startup == --boot && $service_mode == login ]]; then
  sudo -n -v 2>/dev/null || sudo -v </dev/tty ||
    die 'Administrator authorization is required to install the boot service.'
fi

install_boot_service() (
  set -E
  local_agent="$HOME/Library/LaunchAgents/$label.plist"
  staging="$base/.boot-service-lock"
  mkdir -m 700 "$staging" || die 'A boot service installation is already in progress.'
  candidate="$staging/$label.plist"
  saved_agent="$staging/previous.plist"
  target="system/$label"
  system_staging=''
  daemon_installed=false
  committed=false
  restore() {
    if [[ -n $system_staging ]]; then as_admin /bin/rm -f "$system_staging" || true; fi
    if ! "$committed"; then
      if "$daemon_installed"; then
        if ! as_admin /bin/launchctl bootout "$target" 2>/dev/null &&
          /bin/launchctl print "$target" >/dev/null 2>&1; then
          printf 'Could not stop the boot service. The backup is in %s.\n' "$staging" >&2
          return
        fi
        if ! as_admin /bin/rm -f "$daemon"; then
          printf 'Could not remove the boot registration. The backup is in %s.\n' "$staging" >&2
          return
        fi
      fi
      if [[ -f $saved_agent ]]; then
        mv "$saved_agent" "$local_agent" || return
        if ! /bin/launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
          /bin/launchctl bootstrap "gui/$uid" "$local_agent" || true
        fi
      fi
    fi
    rm -rf -- "$staging"
  }
  trap 'status=$?; trap - ERR EXIT; restore; exit "$status"' ERR
  trap 'restore' EXIT
  trap 'exit 1' HUP INT TERM
  [[ ! -e $daemon && ! -L $daemon ]] || die 'A boot service already exists.'

  /usr/bin/plutil -create xml1 "$candidate"
  /usr/bin/plutil -insert Label -string "$label" "$candidate"
  /usr/bin/plutil -insert RunAtLoad -bool YES "$candidate"
  /usr/bin/plutil -insert KeepAlive -bool YES "$candidate"
  /usr/bin/plutil -insert ProcessType -string Interactive "$candidate"
  if "$install_server"; then
    [[ ! -e $local_agent && ! -L $local_agent ]] || die 'A login service appeared during setup.'
    /usr/bin/plutil -insert ProgramArguments -json '[]' "$candidate"
    index=0
    for arg in "$launcher/runtime/node" "$launcher/server/dist/src/supervise.js" serve \
      --data "$data" --host 127.0.0.1 --port 8473; do
      /usr/bin/plutil -insert "ProgramArguments.$index" -string "$arg" "$candidate"
      index=$((index + 1))
    done
  else
    [[ -f $local_agent && ! -L $local_agent ]] || die 'The login registration is unavailable.'
    original_runtime=$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$local_agent")
    original_supervisor=$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$local_agent")
    [[ $original_runtime == /*/runtime/node &&
      $original_supervisor == "${original_runtime%/runtime/node}/server/dist/src/supervise.js" &&
      -x $original_runtime && -f $original_supervisor ]] ||
      die 'Boot startup requires the portable server launcher with update support.'
    /usr/bin/plutil -insert ProgramArguments -xml \
      "$(/usr/bin/plutil -extract ProgramArguments xml1 -o - "$local_agent")" "$candidate"
    if /usr/bin/plutil -extract EnvironmentVariables xml1 -o /dev/null "$local_agent" 2>/dev/null; then
      die 'This login service has custom environment settings. Move them to supported server arguments before conversion.'
    fi
  fi
  /usr/bin/plutil -replace UserName -string "$(id -un)" "$candidate"
  /usr/bin/plutil -replace WorkingDirectory -string "$HOME" "$candidate"
  /usr/bin/plutil -insert EnvironmentVariables -json '{}' "$candidate"
  /usr/bin/plutil -insert EnvironmentVariables.HOME -string "$HOME" "$candidate"
  /usr/bin/plutil -lint "$candidate" >/dev/null

  if [[ -f $local_agent ]]; then
    mv "$local_agent" "$saved_agent"
    if /bin/launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      /bin/launchctl bootout "gui/$uid/$label"
    fi
  fi
  system_staging=$(as_admin /usr/bin/mktemp "/Library/LaunchDaemons/.$label.XXXXXXXX")
  as_admin /usr/bin/tee "$system_staging" <"$candidate" >/dev/null
  as_admin /bin/chmod 0644 "$system_staging"
  as_admin /bin/mv -n "$system_staging" "$daemon"
  [[ ! -e $system_staging ]] || die 'A boot service appeared during setup.'
  system_staging=''
  daemon_installed=true
  as_admin /bin/launchctl enable "$target"
  as_admin /bin/launchctl bootstrap system "$daemon"
  for ((attempt=0; attempt<45; attempt++)); do
    if server_healthy && /bin/launchctl print "$target" 2>/dev/null | awk '
      /^\tstate = running$/ { running=1 } END { exit !running }
    '; then
      committed=true
      printf 'Boot service is running. macOS starts it after the startup disk unlocks.\n'
      exit 0
    fi
    sleep 1
  done
  printf 'The boot service did not answer at %s/health. Check %s/logs/ecs.log.\n' "$origin" "$data" >&2
  return 1
)

if ! "$install_server" && [[ $startup == --boot && $service_mode == login ]]; then
  umask 077
  mkdir -p "$base"
  install_boot_service
  inspect_service
fi
if [[ -n $installed_app ]]; then
  if "$install_server"; then printf 'Using the desktop app at %s.\n' "$installed_app"; fi
  choice=server
fi
if ! "$install_server"; then
  if [[ -z $choice && ( $platform == macos-arm64 || -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ) ]]; then
    ask 'Install the desktop app for the existing server? [y/N] '
    if [[ $answer == y || $answer == Y ]]; then choice=both; else choice=server; fi
  fi
  [[ $choice == both ]] || exit 0
fi
if [[ -z $channel ]]; then
  ask 'Install from [1] Nightly or [2] Release? [1] '
  case "$answer" in
    ''|1) channel=nightly ;;
    2) channel=release ;;
    *) die 'Choose 1 or 2.' ;;
  esac
fi
[[ $channel == nightly || $channel == release ]] || die 'Choose nightly or release.'

check_fresh_service() {
  inspect_service
  if [[ $startup != --boot ]]; then
    "$manager_ready" || die 'Run setup from your logged-in user session with the service manager available.'
  fi
  if "$service_found"; then die 'A service appeared during setup. Run the installer again to use it.'; fi
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

if "$install_server"; then check_fresh_service; fi
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
  local extension=tar.gz
  if ! "$install_server"; then extension=$desktop_ext; fi
  awk -F '\t' -v channel="$channel" -v platform="$platform" -v extension="$extension" '
    channel == "nightly" && $1 != "nightly" { next }
    channel == "release" && $1 !~ /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/ { next }
    $2 == "Emulation-Server-" substr($1, 1 + (channel == "release")) "-" platform "." extension {
      print $1; exit
    }
  ' "$scratch/assets.tsv"
}

tag=$(find_package)
if [[ -z $tag && $channel == release && $# -eq 0 ]]; then
  ask 'No compatible tagged download is available. Install Nightly? [y/N] '
  [[ $answer == y || $answer == Y ]] || exit 0
  channel=nightly
  tag=$(find_package)
fi
[[ -n $tag ]] || die "No compatible $channel download is available for this system."
name="Emulation-Server-${tag#v}-$platform"
desktop_name="$name.$desktop_ext"
desktop=false
if [[ -z $installed_app && ( $platform == macos-arm64 || -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ) ]] &&
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

if "$install_server"; then
  printf 'Downloading %s server…\n' "$tag"
  fetch_verified "$name.tar.gz"
  tar -xzf "$scratch/$name.tar.gz" -C "$scratch"
  [[ -x $scratch/$name/ecs ]] || die 'The downloaded package is missing its launcher.'
  check_fresh_service
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
    check_fresh_service
    "$launcher/ecs" service install --data "$data" --host 127.0.0.1
  }
  if [[ $startup == --boot ]]; then
    "$launcher/ecs" init --data "$data" >/dev/null
    install_boot_service
  elif [[ $platform == macos-arm64 ]]; then
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
    if server_healthy; then break; fi
    sleep 1
  done
  [[ $attempt -lt 30 ]] || die "The service was registered, but the server has not answered. Check $data/logs/ecs.log."
  printf '\nServer is running. Open %s/ui/\n' "$origin"
  if [[ -f $data/bootstrap.token ]]; then
    printf 'Use the one-time setup code from %s/bootstrap.token to create the owner account.\n' "$data"
  fi
  if [[ $platform == linux-x64 && -z ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] &&
    ! loginctl --no-ask-password enable-linger "$(id -un)" >/dev/null 2>&1; then
    printf 'Run loginctl enable-linger to keep the server running after logout.\n'
  fi
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

#!/usr/bin/env bash

nightly_release_title() {
  echo 'Emulation Server Nightly Downloads'
}

nightly_asset_label() {
  case "$1" in
    Emulation-Server-nightly-macos-arm64.dmg) echo 'Mac (Apple Silicon) – Notarized Desktop App (.dmg)' ;;
    Emulation-Server-nightly-macos-arm64.tar.gz) echo 'Mac (Apple Silicon) – Server Archive (.tar.gz)' ;;
    Emulation-Server-nightly-windows-x64.msi) echo 'Windows (64-bit) – Desktop App (.msi)' ;;
    Emulation-Server-nightly-windows-x64.zip) echo 'Windows (64-bit) – Server Archive (.zip)' ;;
    Emulation-Server-nightly-linux-x64.deb) echo 'Linux (64-bit) – Ubuntu Desktop App (.deb)' ;;
    Emulation-Server-nightly-linux-x64.AppImage) echo 'Linux (64-bit) – Desktop App (.AppImage)' ;;
    Emulation-Server-nightly-linux-x64.tar.gz) echo 'Linux (64-bit) – Server Archive (.tar.gz)' ;;
  esac
}

write_nightly_notes() {
  local repo=$1 commit=$2 run_id=$3 mac_status=$4 other_commit=${5:-}
  local home="https://github.com/$repo"
  local download="$home/releases/download/nightly"
  local guide="$home/blob/main/docs/operations/nightly-builds.md"
  local mac_download mac_setup mac_build build build_link

  case "$mac_status" in
    fresh)
      mac_download="[**Download for Mac (.dmg)**]($download/Emulation-Server-nightly-macos-arm64.dmg)"
      mac_setup='Drag the app into Applications, then choose **Open Library**. Choose **Set up this computer** or **Connect to another computer**, and follow the setup guide.'
      mac_build='Apple notarized this Mac download.'
      ;;
    retained)
      mac_download="[**Download for Mac (.dmg)**]($download/Emulation-Server-nightly-macos-arm64.dmg)"
      mac_setup='Drag the app into Applications. To host a library here, follow the one-command server setup below.'
      mac_build='The Mac desktop app is the most recent notarized build.'
      ;;
    *)
      mac_download="[**Server setup guide**]($guide#install-with-one-command)"
      mac_setup='Use the one-command installer to host a library on this Mac.'
      mac_build='A notarized Mac desktop app is currently unavailable.'
      ;;
  esac
  if [[ -n $other_commit ]]; then
    build="Apple Silicon downloads were built from commit [${commit:0:7}]($home/commit/$commit). Windows and Linux downloads are from commit [${other_commit:0:7}]($home/commit/$other_commit)."
    build_link="[Nightly build workflow]($home/actions/workflows/nightly.yml)"
  else
    build="This nightly was built from commit [${commit:0:7}]($home/commit/$commit)."
    build_link="[Build and smoke tests]($home/actions/runs/$run_id)"
  fi

  cat <<NOTES
## Download the desktop app

| Your computer | Download | After downloading |
| --- | --- | --- |
| **Mac with an Apple chip** (M1, M2, or newer) | $mac_download | $mac_setup |
| **Windows (64-bit)** | [**Download for Windows (.msi)**]($download/Emulation-Server-nightly-windows-x64.msi) | Run the installer and open Emulation Server. |
| **Linux (64-bit)** | [**Ubuntu (.deb)**]($download/Emulation-Server-nightly-linux-x64.deb) or [**AppImage**]($download/Emulation-Server-nightly-linux-x64.AppImage) | Install the DEB or make the AppImage executable and open it. |

**Already have a server?** In **Open Library**, choose **Connect to another computer**. If a library is already open, choose **Add another computer**. Enter the computer’s name or server address and follow the sign-in steps.

## Set up a server

On Windows, Linux, or a computer you manage from Terminal, use the **one-command installer**. It starts the server and offers the desktop app where available. [Copy the install command]($guide#install-with-one-command)

If you prefer to install the server manually, download the archive for your system and follow the [manual start instructions]($guide#start-the-server).

- [Mac with an Apple chip (.tar.gz)]($download/Emulation-Server-nightly-macos-arm64.tar.gz)
- [Windows (64-bit) (.zip)]($download/Emulation-Server-nightly-windows-x64.zip)
- [Linux (64-bit) (.tar.gz)]($download/Emulation-Server-nightly-linux-x64.tar.gz)

<details>
<summary>Build information and checksums</summary>

$build $mac_build The Windows and Linux desktop installers are unsigned.

$build_link · [Download checksums]($download/SHA256SUMS.txt)

Nightly builds are for testing. Back up your library data before upgrading. The update metadata and checksum files in the Assets list are used by the updater or for verification.

</details>
NOTES
}

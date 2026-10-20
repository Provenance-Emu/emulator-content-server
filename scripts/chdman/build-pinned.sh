#!/bin/sh
# Optional native CI only. Build official MAME source outside the repository.
set -eu
: "${RUNNER_TEMP:?RUNNER_TEMP must point to an isolated temporary directory}"
work="$RUNNER_TEMP/ecs-mame0289"
mkdir -p "$work"
curl --fail --location --retry 3 https://github.com/mamedev/mame/archive/refs/tags/mame0289.tar.gz -o "$work/source.tar.gz"
# SHA256 from Homebrew rom-tools 0.289's formula (also used by the tested local tool).
expected=0929cc749afabcef892900e10dd90bd8b05f94a7dde8f367ac6a5d2082589f84
actual=$(shasum -a 256 "$work/source.tar.gz" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'MAME source integrity mismatch' >&2; exit 1; }
tar -xzf "$work/source.tar.gz" -C "$work"
cd "$work/mame-mame0289"
make -j3 TOOLS=1 EMULATOR=0 OSD=sdl3 USE_LIBSDL=1 \
  USE_SYSTEM_LIB_EXPAT=1 USE_SYSTEM_LIB_ZLIB=1 USE_SYSTEM_LIB_ASIO=1 \
  USE_SYSTEM_LIB_FLAC=1 USE_SYSTEM_LIB_UTF8PROC=1 USE_SYSTEM_LIB_ZSTD=1 \
  PYTHON_EXECUTABLE=python3
test -x "$PWD/chdman"
mkdir -p "$RUNNER_TEMP/ecs-chdman"
cp "$PWD/chdman" "$RUNNER_TEMP/ecs-chdman/chdman"
printf 'ECS_CHDMAN_PATH=%s/chdman\n' "$RUNNER_TEMP/ecs-chdman" >> "$GITHUB_ENV"

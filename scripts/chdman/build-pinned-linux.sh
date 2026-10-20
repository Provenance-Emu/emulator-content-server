#!/bin/sh
# Optional Linux native acceptance only; source and build stay outside git.
set -eu
: "${RUNNER_TEMP:?RUNNER_TEMP must point to an isolated temporary directory}"
work="$RUNNER_TEMP/ecs-mame0289"
mkdir -p "$work"
if [ ! -f "$work/source.tar.gz" ]; then
  curl --fail --location --retry 3 https://github.com/mamedev/mame/archive/refs/tags/mame0289.tar.gz -o "$work/source.tar.gz"
fi
expected=0929cc749afabcef892900e10dd90bd8b05f94a7dde8f367ac6a5d2082589f84
actual=$(sha256sum "$work/source.tar.gz" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'MAME source integrity mismatch' >&2; exit 1; }
tar -xzf "$work/source.tar.gz" -C "$work"
cd "$work/mame-mame0289"
project=build/projects/sdl/mame/gmake-linux
case $(uname -m) in
  aarch64|arm64) configuration=release ;;
  x86_64) configuration=release64 ;;
  *) echo 'Unsupported native acceptance build architecture' >&2; exit 1 ;;
esac
# GENie records absolute include paths; regenerate after moving a retained build
# or changing the requested architecture/options. Cached source is still hashed.
rm -f "$project/Makefile"
# Only chdman is built. Generate its version source and official solution;
# emulator layouts/localisations and Qt debugger are unnecessary for this tool.
make -j3 build/generated/version.cpp "$project/Makefile" \
  TOOLS=1 EMULATOR=0 OSD=sdl USE_LIBSDL=1 USE_QTDEBUG=0 \
  USE_SYSTEM_LIB_EXPAT=1 USE_SYSTEM_LIB_ZLIB=1 USE_SYSTEM_LIB_ASIO=1 \
  USE_SYSTEM_LIB_FLAC=1 USE_SYSTEM_LIB_UTF8PROC=1 USE_SYSTEM_LIB_ZSTD=1 \
  PYTHON_EXECUTABLE=python3
# GCC 12 emits -Wrestrict for std::string assignments in the upstream source.
# Keep other warnings fatal while permitting this upstream compiler warning.
make -j3 -C "$project" config="$configuration" CXXFLAGS=-Wno-error=restrict chdman
test -x "$PWD/chdman"
mkdir -p "$RUNNER_TEMP/ecs-chdman"
cp "$PWD/chdman" "$RUNNER_TEMP/ecs-chdman/chdman"
printf 'ECS_CHDMAN_PATH=%s/chdman\n' "$RUNNER_TEMP/ecs-chdman" >> "$GITHUB_ENV"

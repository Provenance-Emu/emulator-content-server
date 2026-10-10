#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm verify
if command -v swift >/dev/null 2>&1; then
  swift test --package-path clients/swift
fi
echo "release verification passed"

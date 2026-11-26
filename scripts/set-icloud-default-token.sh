#!/bin/bash
# Writes the built-in iCloud API token into apps/server/src/icloud-defaults.ts.
#
# The token names the application, not a person, and ships in the open. It is still read
# straight from 1Password, or from standard input, and never printed.
#
#   scripts/set-icloud-default-token.sh 'op://Vault/Item/field'
#   pbpaste | scripts/set-icloud-default-token.sh
#   scripts/set-icloud-default-token.sh --clear
set -euo pipefail

file="$(cd "$(dirname "$0")/.." && pwd)/apps/server/src/icloud-defaults.ts"
case "${1:-}" in
  --clear) token='' ;;
  op://*)
    command -v op >/dev/null || {
      echo 'Install the 1Password CLI (op) and sign in first.' >&2
      exit 2
    }
    token=$(op read "$1")
    ;;
  '') token=$(cat) ;;
  *)
    echo "Usage: $0 ['op://Vault/Item/field' | --clear]   (or pipe the token in)" >&2
    exit 2
    ;;
esac
token=$(printf '%s' "$token" | tr -d '[:space:]')
if [[ "${1:-}" != --clear && ! "$token" =~ ^[A-Za-z0-9_-]{32,200}$ ]]; then
  echo 'That does not look like a CloudKit API token (letters, digits, - and _ only). Nothing was changed.' >&2
  exit 1
fi
grep -q "^export const ICLOUD_DEFAULT_API_TOKEN = '[A-Za-z0-9_-]*';$" "$file" || {
  echo "Could not find the token line in $file." >&2
  exit 1
}
ECS_TOKEN="$token" perl -0pi -e \
  's/^export const ICLOUD_DEFAULT_API_TOKEN = \x27[A-Za-z0-9_-]*\x27;$/export const ICLOUD_DEFAULT_API_TOKEN = \x27$ENV{ECS_TOKEN}\x27;/m' \
  "$file"
if [[ -z "$token" ]]; then
  echo 'Cleared the built-in iCloud API token.'
else
  echo "Wrote a ${#token}-character iCloud API token to apps/server/src/icloud-defaults.ts."
fi

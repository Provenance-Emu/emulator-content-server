#!/bin/bash
# Replaces the certificate the nightly workflow signs the macOS installer with.
#
# Picks the Developer ID Application identity in a keychain that expires last, packs it alone
# into a PKCS#12 file under a password made up for the occasion, and stores both as secrets of
# the nightly-macos-signing environment. Nothing secret is printed, and the private key is never
# written to disk unencrypted. macOS asks for permission to release the key from the keychain.
#
#   scripts/rotate-macos-signing-secret.sh            # replace the secrets
#   scripts/rotate-macos-signing-secret.sh --dry-run  # choose and pack, upload nothing
#
# ECS_SIGNING_KEYCHAIN  keychain to read (default: the login keychain)
# ECS_SIGNING_TEAM      only consider this team identifier
# ECS_SIGNING_REPO      owner/name (default: the repository of this checkout)
set -euo pipefail

environment=nightly-macos-signing
dry=false
case "${1:-}" in
  '') ;;
  --dry-run) dry=true ;;
  *)
    echo "Usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This needs the macOS keychain that holds the Developer ID certificate.' >&2
  exit 2
fi
openssl=/usr/bin/openssl
keychain=${ECS_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}
team=${ECS_SIGNING_TEAM:-}
repo=${ECS_SIGNING_REPO:-}
if [[ "$dry" == false ]]; then
  command -v gh >/dev/null || {
    echo 'Install the GitHub CLI (gh) and sign in first.' >&2
    exit 2
  }
  gh auth status >/dev/null 2>&1 || {
    echo 'Sign in with: gh auth login' >&2
    exit 2
  }
fi

umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ecs-rotate.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
ECS_P12_PASSWORD=$("$openssl" rand -hex 32)
export ECS_P12_PASSWORD

echo 'Reading signing identities. macOS may ask to allow the export.'
security export -k "$keychain" -t identities -f pkcs12 -P "$ECS_P12_PASSWORD" -o "$scratch/all.p12"

# Certificates are public. One file each, with the key identifier the archive pairs it by.
"$openssl" pkcs12 -in "$scratch/all.p12" -passin env:ECS_P12_PASSWORD -nokeys -clcerts 2>/dev/null |
  awk -v dir="$scratch" '
    /localKeyID:/ { id = $0; sub(/^.*localKeyID:[[:space:]]*/, "", id) }
    /^-----BEGIN CERTIFICATE-----/ { n++; file = dir "/cert-" n ".pem"; print id > (dir "/cert-" n ".id") }
    file { print > file }
    /^-----END CERTIFICATE-----/ { close(file); file = ""; id = "" }
  '

best=''
best_end=0
now=$(date -u +%s)
for cert in "$scratch"/cert-*.pem; do
  [[ -f "$cert" ]] || continue
  subject=$("$openssl" x509 -in "$cert" -noout -subject)
  [[ "$subject" == *'Developer ID Application:'* ]] || continue
  [[ -z "$team" || "$subject" == *"($team)"* ]] || continue
  end=$("$openssl" x509 -in "$cert" -noout -enddate | sed 's/^notAfter=//')
  end_seconds=$(date -j -u -f '%b %e %T %Y %Z' "$end" +%s)
  if ((end_seconds <= now)); then
    echo "Skipping an expired certificate ($end)."
    continue
  fi
  [[ -s "${cert%.pem}.id" ]] || continue
  if ((end_seconds > best_end)); then
    best=$cert
    best_end=$end_seconds
    best_text=$end
  fi
done
if [[ -z "$best" ]]; then
  echo 'No Developer ID Application certificate with a private key is still valid in this keychain.' >&2
  echo 'Create one in Xcode (Settings > Accounts > Manage Certificates) and run this again.' >&2
  exit 1
fi
wanted=$(cat "${best%.pem}.id")
name=$("$openssl" x509 -in "$best" -noout -subject | sed -E 's/^.*CN ?= ?//; s/[,/].*$//')
days=$(((best_end - now) / 86400))
echo "Using $name, valid until $best_text ($days days)."
if ((days < 30)); then
  echo 'That is under a month. Create a new certificate soon and run this again.'
fi

# The matching key goes from one openssl to the next through a pipe.
"$openssl" pkcs12 -in "$scratch/all.p12" -passin env:ECS_P12_PASSWORD -nocerts -nodes 2>/dev/null |
  awk -v wanted="$wanted" '
    /^Bag Attributes/ { block = ""; id = "" }
    /localKeyID:/ { id = $0; sub(/^.*localKeyID:[[:space:]]*/, "", id) }
    { block = block $0 "\n" }
    /^-----END / { if (id == wanted) printf "%s", block; block = "" }
  ' |
  "$openssl" pkcs12 -export -inkey /dev/stdin -in "$best" -passout env:ECS_P12_PASSWORD \
    -out "$scratch/one.p12" 2>/dev/null || {
  echo 'Could not pair the certificate with its private key.' >&2
  exit 1
}
rm "$scratch/all.p12"
count=$("$openssl" pkcs12 -in "$scratch/one.p12" -passin env:ECS_P12_PASSWORD -nokeys 2>/dev/null |
  grep -c '^-----BEGIN CERTIFICATE-----')
if [[ "$count" != 1 ]]; then
  echo "Expected one certificate in the packed identity, found $count." >&2
  exit 1
fi

if [[ "$dry" == true ]]; then
  echo 'Dry run: the identity packs correctly. Nothing was uploaded.'
  exit 0
fi
target=(--env "$environment")
[[ -z "$repo" ]] || target+=(--repo "$repo")
base64 -i "$scratch/one.p12" | gh secret set ECS_MACOS_SIGNING_P12 "${target[@]}"
printf '%s' "$ECS_P12_PASSWORD" | gh secret set ECS_MACOS_SIGNING_PASSWORD "${target[@]}"
echo "Updated ECS_MACOS_SIGNING_P12 and ECS_MACOS_SIGNING_PASSWORD in $environment."
echo 'Re-run the failed nightly, or start a new one: gh workflow run nightly.yml --ref main'

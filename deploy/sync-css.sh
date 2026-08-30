#!/usr/bin/env bash
#
# Refresh the vendored stylesheet from the store repo.
#
# css/tokens.css and css/styles.css are copies, not forks. The store repo
# is the source of truth for the Enclave design system; this site consumes
# it. css/home.css is ours and is never touched by this script.
#
# Run it after the store's design system changes, then check the diff --
# an unreviewed copy is how two sites drift into looking almost the same.
#
#   ./deploy/sync-css.sh ../enclave-rp-store

set -euo pipefail

STORE_DIR="${1:-../enclave-rp-store}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$STORE_DIR/css/tokens.css" ]]; then
    echo "error: no store checkout at $STORE_DIR" >&2
    echo "usage: $0 /path/to/enclave-rp-store" >&2
    exit 1
fi

for file in tokens.css styles.css; do
    if cmp -s "$STORE_DIR/css/$file" "$HERE/css/$file"; then
        echo "unchanged  css/$file"
    else
        cp "$STORE_DIR/css/$file" "$HERE/css/$file"
        echo "updated    css/$file"
    fi
done

echo
echo "Review with: git diff css/ — then run npm test before committing."

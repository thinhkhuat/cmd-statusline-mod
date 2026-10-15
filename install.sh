#!/usr/bin/env bash
# Install (or update) the statusline mod in the Command Code mods directory.
#
#   ./install.sh                                  install to ~/.commandcode/mods
#   COMMANDCODE_MODS_DIR=/tmp/mods ./install.sh    install somewhere else
#
# Backs up any existing statusline.ts, copies the mod and its test suite, runs the suite
# against the installed copy, then lists the registered mods.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODS_DIR="${COMMANDCODE_MODS_DIR:-$HOME/.commandcode/mods}"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -f "$REPO_DIR/statusline.ts" ] || { echo "statusline.ts missing next to this script" >&2; exit 1; }

mkdir -p "$MODS_DIR/.statusline-tests"

if [ -f "$MODS_DIR/statusline.ts" ]; then
	cp "$MODS_DIR/statusline.ts" "$MODS_DIR/statusline.ts.bak-$STAMP"
	echo "backed up the previous mod -> statusline.ts.bak-$STAMP"
fi

cp "$REPO_DIR/statusline.ts" "$MODS_DIR/statusline.ts"
cp "$REPO_DIR/test/statusline.test.mjs" "$MODS_DIR/.statusline-tests/statusline.test.mjs"
echo "installed -> $MODS_DIR/statusline.ts"

if cmp -s "$REPO_DIR/statusline.ts" "$MODS_DIR/statusline.ts"; then
	echo "verified: the installed copy is byte-identical to the repo copy"
else
	echo "WARNING: installed copy differs from the repo copy" >&2
fi

(cd "$MODS_DIR/.statusline-tests" && node --test statusline.test.mjs | tail -6)

if command -v cmd >/dev/null 2>&1; then
	cmd mods list
else
	echo "cmd is not on PATH — check the mod in a session with: cmd mods list"
fi

echo
echo "Reload a running session with /reload (mods load once per process), or start cmd fresh."
echo "Read the footer row under the input panel: the context segment shows ■/░, a percentage and used/window."

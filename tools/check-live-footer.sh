#!/usr/bin/env bash
# Live check: does the statusline's context segment actually draw a figure in the real TUI?
#
# The unit suite drives the mod against a fake host, and a headless run renders no footer at
# all — neither can prove this end to end. This drives the real TUI through a pty and reads
# the footer it renders. That is how the starved-getter incident was confirmed and then fixed
# (docs/investigation.md, "The context figure never arrived").
#
#   ./tools/check-live-footer.sh        # spends one model call, needs `script` + `timeout`
#
# Exits 0 when the footer showed a measured fill, 1 otherwise.
set -uo pipefail

raw="$(mktemp -t statusline-live)"
trap 'rm -f "$raw"' EXIT

# The app must be up before it reads stdin in raw mode, and the text must land before the
# submit key. A piped line with no delay is dropped, which silently turns this into "no turn
# ran" rather than "the figure is missing" — the exact false negative to watch for.
{ sleep 9; printf 'Reply with exactly: ok'; sleep 2; printf '\r'; sleep 50; printf '\003'; sleep 2; printf '\003'; sleep 2; } \
	| timeout 90 script -q "$raw" cmd >/dev/null 2>&1

plain() { perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g; s/\e\][^\a\x07]*(\a|\x07)//g; s/\r/\n/g' "$raw"; }

echo "footer lines rendered:"
plain | grep -oE '[■□]{10}[^\r]*' | cut -c1-90 | sort -u || true
echo

if plain | grep -qE '■+□* [0-9]+% \([0-9.]+[kM]?/[0-9.]+[kM]?\)'; then
	echo 'PASS: the footer drew a measured context fill'
	exit 0
fi

if plain | grep -q '□□□□□□□□□□ — (—/'; then
	echo 'FAIL: the footer only ever drew the em dash — the segment never got a measurement'
	exit 1
fi

echo 'FAIL: no context segment found in the captured footer at all'
exit 1

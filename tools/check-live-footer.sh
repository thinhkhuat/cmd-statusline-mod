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

raw="${STATUSLINE_RAW:-$(mktemp -t statusline-live)}"
footer="$(mktemp -t statusline-footer)"
trap 'rm -f "$raw" "$footer"' EXIT

# The app must be up before it reads stdin in raw mode, and the text must land before the
# submit key. A piped line with no delay is dropped, which silently turns this into "no turn
# ran" rather than "the figure is missing" — the exact false negative to watch for.
# STATUSLINE_RAW re-analyses an existing capture instead of driving the TUI.
if [ -z "${STATUSLINE_RAW:-}" ]; then
	{ sleep 9; printf 'Reply with exactly: ok'; sleep 2; printf '\r'; sleep 50; printf '\003'; sleep 2; printf '\003'; sleep 2; } \
		| timeout 90 script -q "$raw" cmd >/dev/null 2>&1
fi

plain() { perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g; s/\e\][^\a\x07]*(\a|\x07)//g; s/\r/\n/g' "$raw"; }

echo "footer lines rendered:"
plain | grep -oE '[■□]{10}[^\r]*' | cut -c1-90 | sort -u || true
echo

# Colour: the mod's own row, read raw so the escapes survive. Scoped to the row — the host draws
# its own hints elsewhere and may use faint legitimately.
perl -pe 's/\r/\n/g' "$raw" | grep -aE '[■□]{10}' > "$footer" || true
ESC=$(printf '\033')
colour_ok=1
echo 'colour on the mod row:'
for spec in '34:model blue' '35:project purple' '36:counters cyan' '32:skills green'; do
	code=${spec%%:*}
	label=${spec#*:}
	if grep -qa "${ESC}\[${code}m" "$footer"; then
		echo "  ok       ${label}"
	else
		echo "  MISSING  ${label}"
		colour_ok=0
	fi
done
if grep -qa "${ESC}\[2m" "$footer"; then
	echo '  FAIL     faint (ANSI 2) is back on the row'
	colour_ok=0
else
	echo '  ok       no faint (ANSI 2) on the row'
fi
echo

fill=1
if ! plain | grep -qE '■+□* [0-9]+% \([0-9.]+[kM]?/[0-9.]+[kM]?\)'; then
	fill=0
	echo 'FAIL: the footer never drew a measured context fill'
	plain | grep -q '□□□□□□□□□□ — (—/' && echo '      it only ever drew the em dash — the segment never got a measurement'
fi

if [ "$fill" = 1 ] && [ "$colour_ok" = 1 ]; then
	echo 'PASS: measured context fill, one hue per section, no faint text'
	exit 0
fi
echo 'FAIL: see above'
exit 1

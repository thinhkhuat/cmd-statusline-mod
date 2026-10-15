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
plainfile="$(mktemp -t statusline-plain)"
trap 'rm -f "$raw" "$plainfile"' EXIT

# The app must be up before it reads stdin in raw mode, and the text must land before the
# submit key. A piped line with no delay is dropped, which silently turns this into "no turn
# ran" rather than "the figure is missing" — the exact false negative to watch for.
# STATUSLINE_RAW re-analyses an existing capture instead of driving the TUI.
if [ -z "${STATUSLINE_RAW:-}" ]; then
	# A wide pty on purpose: the host truncates the row to the terminal width, and a default 80
	# columns cuts the trailing segments off with an ellipsis — which would silently hide the
	# counters instead of reporting them missing.
	{ sleep 9; printf 'Reply with exactly: ok'; sleep 2; printf '\r'; sleep 50; printf '\003'; sleep 2; printf '\003'; sleep 2; } \
		| timeout 90 script -q "$raw" sh -c 'stty cols 220 rows 50 2>/dev/null; cmd' >/dev/null 2>&1
fi

plain() { perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g; s/\e\][^\a\x07]*(\a|\x07)//g; s/\r/\n/g' "$raw"; }
# Stripped once into a file: `grep -q` closes the pipe on its first match, perl then dies of
# SIGPIPE, and under `set -o pipefail` a *successful* match would report as a failure.
plain > "$plainfile"

echo "footer lines rendered:"
grep -oE '[■□]{10}[^\r]*' "$plainfile" | cut -c1-90 | sort -u || true
echo

# Colour: read the raw stream, because the footer arrives as one fragment per styled span.
# Signatures are anchored to text only this mod emits, so the host's own styled UI cannot pass
# the check on the mod's behalf. Faint is asserted over the whole stream: the host's muted text
# is 256-colour, so any `\e[2m` here is ours.
ESC=$(printf '\033')
colour_ok=1
echo 'colour in the live stream:'
has() {
	if grep -qaE "$1" "$raw"; then
		echo "  ok       $2"
	else
		echo "  MISSING  $2"
		colour_ok=0
	fi
}
has "${ESC}\[34m\[" 'model blue'
has "${ESC}\[35m[^${ESC}]*⏱" 'project purple'
has "${ESC}\[32m✓ Sk" 'skills green'
if grep -qaE "${ESC}\[36m[⚙↻⚡]" "$raw"; then
	echo '  ok       counters cyan'
else
	echo '  n/a      counters cyan — no counted event in this run (covered by the unit suite)'
fi
if grep -qa "${ESC}\[2m" "$raw"; then
	echo '  FAIL     faint (ANSI 2) is back in the stream'
	colour_ok=0
else
	echo '  ok       no faint (ANSI 2) anywhere'
fi
echo

fill=1
if ! grep -qE '■+□* [0-9]+% \([0-9.]+[kM]?/[0-9.]+[kM]?\)' "$plainfile"; then
	fill=0
	echo 'FAIL: the footer never drew a measured context fill'
	grep -q '□□□□□□□□□□ — (—/' "$plainfile" && echo '      it only ever drew the em dash — the segment never got a measurement'
fi

if [ "$fill" = 1 ] && [ "$colour_ok" = 1 ]; then
	echo 'PASS: measured context fill, one hue per section, no faint text'
	exit 0
fi
echo 'FAIL: see above'
exit 1

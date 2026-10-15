#!/usr/bin/env bash
# Live parity: every value the row shows must be the harness's own, and a mid-session model/effort
# switch must show up on the next repaint. Drives a throwaway TUI through a pty with
# tools/probe-parity.ts loaded beside the mod.
#
#   ./tools/check-live-parity.sh                                            # spends two model calls
#   STATUSLINE_RAW=<capture> PROBE_LOG=<log> ./tools/check-live-parity.sh   # analyse a saved run
#
# The probe calls cmd.setModel/cmd.setEffort, which are session-scoped; this script backs up
# ~/.commandcode/config.json and diffs it afterwards to prove the switch did not persist.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
raw="${STATUSLINE_RAW:-$(mktemp -t statusline-parity)}"
log="${PROBE_LOG:-$(mktemp -t statusline-parity-log)}"
trap 'rm -f "$raw"' EXIT

config="$HOME/.commandcode/config.json"
backup="$(mktemp -t statusline-config)"
cp "$config" "$backup" 2>/dev/null || true

if [ -z "${STATUSLINE_RAW:-}" ]; then
	# Two turns: the probe switches the model and the effort after the first, so the second proves the
	# row moved. A 220-column pty, because the host truncates the row to the terminal width and the
	# badge is not what gets cut — but the segments after it are.
	{
		sleep 9; printf 'Reply with exactly: ok'; sleep 2; printf '\r'
		sleep 30; printf 'Reply with exactly: ok'; sleep 2; printf '\r'
		sleep 45; printf '\003'; sleep 2; printf '\003'; sleep 2
	} | timeout 140 script -q "$raw" sh -c "stty cols 220 rows 50 2>/dev/null; PROBE_LOG=$log cmd --mod $script_dir/probe-parity.ts" >/dev/null 2>&1
	echo "drive finished"
fi

if [ ! -s "$log" ]; then
	echo 'FAIL: the probe wrote nothing — it did not load, so nothing here is evidence'
	exit 1
fi

echo "=== what the harness reported (probe log) ==="
grep -aoE '"(model|effort)":"[^"]*"' "$log" | sort -u | head -10
echo

node "$script_dir/parity-report.mjs" "$raw" "$log"
verdict=$?

if [ -f "$backup" ] && [ -f "$config" ]; then
	if diff -q "$backup" "$config" >/dev/null; then
		echo "$(basename "$(dirname "$config")")/config.json untouched by the switch: yes"
	else
		echo "config.json CHANGED by the switch — restoring the backup"
		cp "$backup" "$config"
	fi
fi
exit "$verdict"

// Probe: does the row follow the harness's own truth when the model and effort change mid-session?
//
// Loaded beside the mod in a throwaway TUI session. It drives the switch itself, because
// `cmd.setModel` / `cmd.setEffort` are session-scoped (reconcileModelChange plus a
// `config_setting_changed` emit) and do not write the user's config — verified by diffing
// ~/.commandcode/config.json before and after in tools/check-live-parity.sh.
import type {ModApi} from '@commandcode/harness';
import {appendFileSync} from 'node:fs';

export default function (cmd: ModApi): void {
	const log = process.env.PROBE_LOG ?? '/tmp/cmd-probe.log';
	const write = (label: string, value: unknown): void => {
		try {
			appendFileSync(log, `${label} ${JSON.stringify(value)}\n`);
		} catch {
			/* ignore */
		}
	};
	const snap = (phase: string): void => {
		write(phase, {model: cmd.getModel?.(), effort: cmd.getEffort?.(), ctx: cmd.getContextUsage?.() ?? null});
	};

	let turns = 0;
	snap('load');
	cmd.on('session_start', () => snap('session_start'));
	cmd.on('model_request_end', () => snap('model_request_end'));
	cmd.on('run_end', () => {
		turns += 1;
		snap(`run_end_${turns}`);
		if (turns === 1) {
			// A real switch, mid-session: the row must move to it on the next repaint.
			cmd.setModel?.('moonshotai/Kimi-K3');
			cmd.setEffort?.('low');
			setTimeout(() => snap('after_switch'), 1500);
		}
	});
}

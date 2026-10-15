// Throwaway probe: records what the live ModApi actually reports, headless.
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
	const snap = () => ({model: cmd.getModel?.(), effort: cmd.getEffort?.(), ctx: cmd.getContextUsage?.()});

	cmd.on('session_start', () => write('session_start', snap()));
	cmd.on('run_start', () => write('run_start', snap()));
	cmd.on('model_request_end', event => write('model_request_end', {...snap(), event: {model: (event as {model?: string}).model}}));
	cmd.hooks({onRunEnd: () => write('run_end', snap())});
}

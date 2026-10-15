// Probe 2: prove the mod's slash command actually registered on a live host, and record
// what the host reports for it. Run with `cmd -p --mod tools/probe-commands.ts "ok"`.
import type {ModApi} from '@commandcode/harness';
import {appendFileSync} from 'node:fs';

export default function (cmd: ModApi): void {
	const log = process.env.PROBE_LOG ?? '/tmp/cmd-probe.log';
	cmd.on('session_start', () => {
		try {
			const all = cmd.getCommands?.() ?? [];
			appendFileSync(
				log,
				`commands ${JSON.stringify({
					total: all.length,
					mods: [...new Set(all.map(c => c.mod))].sort(),
					statusline: all.filter(c => c.mod === 'statusline' || c.name === 'statusline'),
				})}\n`,
			);
		} catch (error) {
			appendFileSync(log, `commands ERROR ${error instanceof Error ? error.message : String(error)}\n`);
		}
	});
}

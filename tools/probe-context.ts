// Probe: what the mod-facing context seam actually reports, and what the turn really carried.
//
//   PROBE_LOG=/tmp/probe.log cmd -p --mod tools/probe-context.ts --mod statusline.ts "Reply with exactly: ok"
//
// It produced the evidence in docs/investigation.md, "The context figure never arrived": on
// Command Code 1.82.3 `cmd.getContextUsage()` answers `{tokens: null, contextWindow, percent:
// null}` at every lifecycle point, while `onTurnEnd({state, usage})` — the hook the harness's
// own compaction tracker consumes — receives the turn's real `inputTokens`. That is why the
// segment falls back to the turn usage instead of trusting the getter alone.
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

	const ctx = () => cmd.getContextUsage?.() ?? null;

	// Deliberately NO `onTurnEnd` hook. Registering one at all makes a headless print run die
	// with `Cannot read properties of undefined (reading 'messages')` on 1.82.3 — the harness's
	// turn-end path then reads a `state` that headless never binds — so the run exits 1. The
	// `model_request_end` event carries the same `usage`, so nothing is lost. Bisected with an
	// empty probe (0), a hook-only probe (1) and an events-only probe (0). See
	// docs/investigation.md, "A mod's onTurnEnd hook fails a headless run".
	for (const name of ['session_start', 'run_start', 'model_request_start', 'model_request_end', 'turn_end', 'run_end'] as const) {
		cmd.on(name, event => write(name, {model: cmd.getModel?.(), ctx: ctx(), usage: (event as {usage?: unknown}).usage ?? null}));
	}
}

// Does the row report what the harness says? Compares a pty capture of the real footer against the
// probe log that recorded the harness's own getters at the same moments.
//
//   node tools/parity-report.mjs <capture.raw> <probe.log>
//
// Exits 1 on any disagreement. Anchored on the two things that matter: the row may never show a
// model the harness did not report, and it must end on the state the harness ended on.
import {readFileSync} from 'node:fs';

const [capturePath, logPath] = process.argv.slice(2);
const ESC = /\u001b\[[0-9;?]*[A-Za-z]/g;

const capture = readFileSync(capturePath, 'utf8').split('\r').map(part => part.replace(ESC, '')).join('\n');
const shown = [...capture.matchAll(/\[([^\][\s]+) ([·○◐◓◑◒])(?: ([a-zA-Z]+))?\]/g)].map(m => ({model: m[1], effort: m[3] ?? ''}));

const logged = readFileSync(logPath, 'utf8')
	.trim()
	.split('\n')
	.map(line => JSON.parse(line.slice(line.indexOf(' '))).model)
	.filter(model => typeof model === 'string')
	.map(model => model.split('/').pop());

const state = entry => `${entry.model} ${entry.effort}`.trim();
// The capture repeats a row on every repaint; keep the order of first appearance instead.
const sequence = [];
for (const entry of shown) {
	const key = state(entry);
	if (sequence.at(-1)?.key !== key) sequence.push({key, ...entry});
}
const shownModels = [...new Set(shown.map(entry => entry.model))];
const harnessModels = [...new Set(logged)];
const unknown = shownModels.filter(model => !harnessModels.includes(model));
const lastShown = sequence.at(-1);
const lastHarness = logged.at(-1);

console.log(`rows captured: ${shown.length}  distinct states in order: ${sequence.map(s => s.key).join(' -> ')}`);
console.log(`harness reported: ${harnessModels.join(', ')}  (last: ${lastHarness ?? 'none'})`);
console.log(`row showed:       ${shownModels.join(', ')}  (last: ${lastShown?.model ?? 'none'})`);

let failed = 0;
const check = (ok, label) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) failed += 1;
};

check(shown.length > 0, 'the row rendered a model badge at all');
check(unknown.length === 0, `every model the row showed was reported by the harness${unknown.length ? ` (not reported: ${unknown.join(', ')})` : ''}`);
check(harnessModels.length >= 2, 'the probe actually switched the harness model — if this fails, the switch is what is wrong, not the row');
check(shownModels.length >= 2, 'the row moved with the switch (two models seen mid-session)');
check(lastShown?.model === lastHarness, `the row ends on the harness's model (${lastShown?.model} vs ${lastHarness})`);

console.log(failed === 0 ? '\nPASS: the row tracks the harness.' : `\nFAIL: ${failed} disagreement(s).`);
process.exit(failed === 0 ? 0 : 1);

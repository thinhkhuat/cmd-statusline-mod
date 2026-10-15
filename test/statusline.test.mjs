// Test suite for the statusline mod (~/.commandcode/mods/statusline.ts).
//
// Run it from this directory:
//   node --test .statusline-tests/statusline.test.mjs            (from ~/.commandcode/mods)
//   node --test statusline.test.mjs                              (from .statusline-tests)
//
// It loads the real mod through Node's TypeScript stripping and drives it with a fake
// ModApi that records everything the mod does to the host. STATUSLINE_MOD points it at a
// mutant for mutation testing; STATUSLINE_SCRATCH redirects the config file so the real
// ~/.commandcode/statusline.json is never touched.
//
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, before, describe, it} from 'node:test';

const SCRATCH = process.env.STATUSLINE_SCRATCH ?? join(tmpdir(), 'statusline-test');
// The mod under test: the sibling file in the mods dir (or STATUSLINE_MOD for mutants).
const MOD_FILE = process.env.STATUSLINE_MOD ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'statusline.ts');
const CONFIG = join(SCRATCH, 'statusline.json');
process.env.COMMANDCODE_STATUSLINE_CONFIG = CONFIG;

// ── Timer instrumentation (the mod must unref and clear everything) ────────────
const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => {
	const timer = realSetInterval(fn, ms);
	const record = {timer, ms, unref: false, cleared: false};
	const originalUnref = timer.unref.bind(timer);
	timer.unref = () => {
		record.unref = true;
		return originalUnref();
	};
	intervals.push(record);
	return timer;
};
globalThis.clearInterval = timer => {
	for (const record of intervals) if (record.timer === timer) record.cleared = true;
	return realClearInterval(timer);
};

const mod = (await import(MOD_FILE)).default;
const {parseGitStatus, parseSkillCount, formatTokens, contextBar, contextTone, contextTokensFromUsage} = await import(MOD_FILE);

const strip = text => String(text).replace(/\u001b\[[0-9;]*m/g, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (times = 4) => {
	for (let i = 0; i < times; i += 1) await tick();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The loader lists a skill once per root it is reachable through, so the same name appears under
// more than one section — as on this machine, where `cmd skills list` prints 792 entries for 399
// distinct skills and the harness reports 399 loaded. `alpha` is under Project and Global here.
const SKILLS_OUT = [
	' Skills  5 installed',
	'',
	'Project (2)',
	'  alpha · first',
	'  beta · second',
	'Global (2)',
	'  alpha · first, reachable through a second root',
	'  gamma · third',
	'Bundled (1)',
	'  delta · bundled',
].join('\n');
const SKILLS_OUT_HEADERS_ONLY = 'Project (388)\nGlobal (390)\nBundled (8)\n';

async function boot(options = {}) {
	const statuses = [];
	const notifications = [];
	const flagsDeclared = new Map();
	const hooks = {};
	const handlers = new Map();
	const commands = new Map();
	const appended = [];
	const execCalls = [];
	const entries = options.entries ?? [];
	let model = options.model ?? 'deepseek/deepseek-v4.1-flash';
	let effort = options.effort ?? 'high';
	let statusRendered = options.headless !== true;

	const cmd = {
		name: 'statusline',
		cwd: options.cwd ?? '/tmp/project-alpha',
		ui: {
			setStatus: value => statuses.push(value),
			notify: (message, level) => notifications.push({message, level}),
			capabilities: {
				get status() {
					return statusRendered;
				},
			},
		},
		addFlag: (name, spec) => {
			flagsDeclared.set(name, spec);
			return {dispose() {}};
		},
		// Mirrors the host: addFlag seeds the value with the declared default, so a flag
		// that declares one can never be undefined at getFlag time.
		getFlag: name => {
			if (!flagsDeclared.has(name)) return undefined;
			if (name in (options.flags ?? {})) return options.flags[name];
			return flagsDeclared.get(name).default;
		},
		hooks: value => {
			Object.assign(hooks, value);
			return {dispose() {}};
		},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return {dispose() {}};
		},
		addCommand: command => {
			commands.set(command.name, command);
			return {dispose() {}};
		},
		session: {
			getCustomEntries: () => entries,
			appendCustomEntry: entry => appended.push(entry),
		},
		getModel: () => model,
		getEffort: () => effort,
		exec: async ({command, args, cwd}) => {
			execCalls.push({command, args, cwd});
			if (options.exec) return options.exec({command, args, cwd});
			if (command === 'git') return {stdout: options.git ?? '', code: options.git === undefined ? 128 : 0};
			if (command === 'cmd') return {stdout: options.skills ?? SKILLS_OUT, code: 0};
			return {stdout: '', code: 0};
		},
	};
	if ('context' in options) cmd.getContextUsage = typeof options.context === 'function' ? options.context : () => options.context;

	mod(cmd);
	if (options.session !== false) hooks.onSessionStart({source: 'startup'});
	await settle();

	const status = () => (statuses.length === 0 ? '' : strip(statuses[statuses.length - 1]));
	const raw = () => (statuses.length === 0 ? '' : statuses[statuses.length - 1]);
	const fire = async (event, payload = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		await settle();
	};
	const run = async (name, args = '') => {
		const result = await commands.get(name).handler({args, ui: cmd.ui, cwd: cmd.cwd, exec: cmd.exec});
		await settle();
		return result;
	};

	return {
		cmd,
		options,
		statuses,
		notifications,
		flagsDeclared,
		hooks,
		handlers,
		commands,
		appended,
		execCalls,
		status,
		raw,
		fire,
		run,
		sessions: entries,
		setModel: value => (model = value),
		setEffort: value => (effort = value),
		setStatusRendered: value => (statusRendered = value),
	};
}

describe('context segment', () => {
	it('renders the measured fill as squares, percent and (used/window)', async () => {
		const t = await boot({context: {tokens: 181_200, contextWindow: 1_000_000, percent: 18}});
		assert.match(t.status(), /■■□□□□□□□□ 18% \(181\.2k\/1M\)/);
	});

	it('rounds the bar to the nearest cell', async () => {
		const t = await boot({context: {tokens: 480_000, contextWindow: 1_000_000, percent: 48}});
		assert.match(t.status(), /■{5}□{5} 48%/);
	});

	it('shows an em dash instead of a percent before the first measurement', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		assert.match(t.status(), /□{10} — \(—\/1M\)/);
		assert.doesNotMatch(t.status(), /0%/);
	});

	it('renders a measured 0% as 0%, because tokens prove there was a measurement', async () => {
		const t = await boot({context: {tokens: 1, contextWindow: 1_000_000, percent: 0}});
		assert.match(t.status(), /□{10} 0% \(1\/1M\)/);
	});

	it('hides the whole segment when the harness reports nothing', async () => {
		const t = await boot({context: undefined});
		const status = t.status();
		assert.doesNotMatch(status, /[■□—]/, 'no bar and no em dash may survive when there is nothing to report');
		assert.doesNotMatch(status, /\d+k\//, 'and no token pair');
	});

	it('hides the segment when getContextUsage throws', async () => {
		const t = await boot({
			context: () => {
				throw new Error('not bound');
			},
		});
		assert.doesNotMatch(t.status(), /[■□]/);
		assert.equal(t.notifications.length, 0, 'a throwing getContextUsage must not be an error notice');
	});

	it('never crashes on a hostile usage object', async () => {
		for (const context of [
			{},
			{tokens: undefined, contextWindow: undefined},
			{tokens: 120_000, contextWindow: 0},
			{tokens: Number.NaN, contextWindow: 1_000},
			{tokens: 120_000, contextWindow: null},
			5,
			'x',
		]) {
			const t = await boot({context});
			assert.ok(t.status().length > 0, `status must still render for ${JSON.stringify(context)}`);
			assert.equal(t.notifications.length, 0);
		}
	});

	it('tones the context segment green under 50, yellow at 50, red at 80', async () => {
		const green = await boot({context: {tokens: 490_000, contextWindow: 1_000_000, percent: 49}});
		assert.match(green.raw(), /\u001b\[32m■/, 'the bar itself must carry the green');
		const yellow = await boot({context: {tokens: 500_000, contextWindow: 1_000_000, percent: 50}});
		assert.match(yellow.raw(), /\u001b\[33m■/, 'the bar itself must carry the yellow');
		const red = await boot({context: {tokens: 800_000, contextWindow: 1_000_000, percent: 80}});
		assert.match(red.raw(), /\u001b\[31m■/, 'the bar itself must carry the red');
	});

	it('honours contextStyle compact and tokens', async () => {
		const compact = await boot({context: {tokens: 120_000, contextWindow: 1_000_000, percent: 12}, flags: {'statusline.contextStyle': 'compact'}});
		assert.match(compact.status(), /■□□□□□□□□□ 12%/);
		assert.doesNotMatch(compact.status(), /120k/);
		const tokens = await boot({context: {tokens: 120_000, contextWindow: 1_000_000, percent: 12}, flags: {'statusline.contextStyle': 'tokens'}});
		assert.match(tokens.status(), /120k\/1M/);
		assert.doesNotMatch(tokens.status(), /12%/);
	});

	it('derives a percent when the harness sends only tokens and window', async () => {
		const t = await boot({context: {tokens: 250_000, contextWindow: 1_000_000, percent: null}});
		assert.match(t.status(), /25%/);
	});

	// The live incident (see docs/investigation.md): on Command Code 1.82.3 the harness
	// reports no measurement at all — `{tokens: null, contextWindow: 1000000, percent: null}`
	// at every lifecycle point — while the turn's real usage arrives on model_request_end.
	// The segment drew `—` forever. These three tests pin the replacement.
	it('draws a figure from the turn usage when the harness reports no measurement', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		assert.match(t.status(), /— \(—\/1M\)/, 'the harness alone reports nothing here');
		await t.fire('model_request_end', {
			model: 'deepseek/deepseek-v4.1-flash',
			usage: {inputTokens: 67_717, outputTokens: 2, cacheReadTokens: 44_544, cacheWriteTokens: 0},
		});
		assert.match(t.status(), /■□□□□□□□□□ 7% \(67\.7k\/1M\)/, 'the prompt that was sent plus what that turn appended');
		assert.doesNotMatch(t.status(), /—/, 'no em dash may survive once a turn has been measured');
	});

	it('prefers the harness measurement over the turn usage when both exist', async () => {
		let context = {tokens: null, contextWindow: 1_000_000, percent: null};
		const t = await boot({context: () => context});
		await t.fire('model_request_end', {model: 'm', usage: {inputTokens: 67_717, outputTokens: 2}});
		assert.match(t.status(), /67\.7k/, 'the turn usage stands in while the harness reports nothing');
		context = {tokens: 181_200, contextWindow: 1_000_000, percent: 18};
		await t.fire('turn_end', {});
		assert.match(t.status(), /18% \(181\.2k\/1M\)/, 'a harness measurement wins over the turn usage');
	});

	it('ignores a turn usage carrying no tokens, which is not a measurement', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		await t.fire('model_request_end', {model: 'm', usage: {inputTokens: 0, outputTokens: 0}});
		assert.match(t.status(), /— \(—\/1M\)/);
		assert.doesNotMatch(t.status(), /0%/, 'an empty usage must never read as 0%');
	});

	it('drops the stale figure when a compaction resets the fill', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		await t.fire('model_request_end', {model: 'm', usage: {inputTokens: 900_000, outputTokens: 100}});
		assert.match(t.status(), /90% \(900\.1k\/1M\)/);
		await t.fire('compaction_done', {});
		assert.match(t.status(), /— \(—\/1M\)/, 'a figure measured before a compaction is stale and must not survive it');
	});
});

describe('segment switches and precedence', () => {
	it('hides context on showContext=false', async () => {
		const t = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': false}});
		assert.doesNotMatch(t.status(), /[■□]/);
	});

	it('declares every flag without a default, so getFlag stays undefined until set', async () => {
		const t = await boot({});
		for (const [, spec] of t.flagsDeclared) assert.equal('default' in spec, false, 'a seeded default would mask the config file');
		assert.equal(t.flagsDeclared.size, 11);
	});

	it('applies flag > config file > default', async () => {
		mkdirSync(SCRATCH, {recursive: true});
		writeFileSync(CONFIG, JSON.stringify({showContext: false, label: 'file'}));

		const fromFile = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}});
		assert.doesNotMatch(fromFile.status(), /[■□]/, 'config file must override the default');
		assert.match(fromFile.status(), /file/);

		const fromFlag = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': true, 'statusline.label': 'flag'}});
		assert.match(fromFlag.status(), /[■□]/, 'a launch flag must beat the file');
		assert.match(fromFlag.status(), /flag/);

		const fromSession = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': true}});
		await fromSession.run('statusline', 'showContext=false');
		assert.doesNotMatch(fromSession.status(), /[■□]/, 'a live override must beat the launch flag');

		rmSync(CONFIG, {force: true});
	});

	it('reports the source of each value in /statusline', async () => {
		writeFileSync(CONFIG, JSON.stringify({label: 'file'}));
		const t = await boot({flags: {'statusline.showGit': false}});
		const listed = (await t.run('statusline')).message;
		assert.match(listed, /showContext = true {3}\(default\)/);
		assert.match(listed, /showGit = false {3}\(flag\)/);
		assert.match(listed, /label = file {3}\(file\)/);
		rmSync(CONFIG, {force: true});
	});

	it('honours label and separator', async () => {
		const t = await boot({flags: {'statusline.label': 'mine', 'statusline.separator': ' | '}});
		assert.match(t.status(), /^mine \| /);
	});

	it('hides the counters segment when there is nothing to count', async () => {
		const t = await boot({});
		assert.doesNotMatch(t.status(), /[⚙✗↻⚡]/);
	});

	it('turns each segment off and on again through /statusline, including the git segment', async () => {
		const t = await boot({git: '## main\n'});
		assert.match(t.status(), /⎇ main/);
		const off = await t.run('statusline', 'showGit=off');
		assert.match(off.message, /statusline\.showGit = false/);
		assert.doesNotMatch(t.status(), /⎇/, 'showGit=off must remove a segment that is actually there');
		await t.run('statusline', 'showGit=on');
		assert.match(t.status(), /⎇ main/, 'showGit=on must bring it back');
	});
});

describe('git segment', () => {
	it('parses branch, ahead/behind and worktree counts from one porcelain call', () => {
		const info = parseGitStatus(['## main...origin/main [ahead 2, behind 1]', 'M  staged.ts', ' M dirty.ts', '?? new.ts'].join('\n'));
		assert.deepEqual(info, {branch: 'main', ahead: 2, behind: 1, staged: 1, modified: 1, untracked: 1});
	});

	it('parses a fresh repo, a clean branch and a detached HEAD', async () => {
		assert.deepEqual(parseGitStatus('## No commits yet on main'), {branch: 'main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0});
		assert.deepEqual(parseGitStatus('## HEAD (no branch)')?.branch, '(detached)');
		assert.deepEqual(parseGitStatus('## main...origin/main')?.branch, 'main');
		assert.equal(parseGitStatus('') , undefined);
	});

	it('renders the real status of a real repository', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'statusline-repo-'));
		execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: repo});
		execFileSync('git', ['config', 'user.email', 't@example.com'], {cwd: repo});
		execFileSync('git', ['config', 'user.name', 't'], {cwd: repo});
		writeFileSync(join(repo, 'tracked.txt'), 'one\n');
		execFileSync('git', ['add', 'tracked.txt'], {cwd: repo});
		execFileSync('git', ['commit', '-qm', 'init'], {cwd: repo});
		writeFileSync(join(repo, 'tracked.txt'), 'two\n'); // modified
		writeFileSync(join(repo, 'staged.txt'), 's\n');
		execFileSync('git', ['add', 'staged.txt'], {cwd: repo}); // staged
		writeFileSync(join(repo, 'untracked.txt'), 'u\n'); // untracked

		const porcelain = execFileSync('git', ['status', '--porcelain=v1', '--branch'], {cwd: repo, encoding: 'utf8'});
		const t = await boot({cwd: repo, git: porcelain});
		const status = t.status();
		assert.match(status, /⎇ main/);
		assert.match(status, /\+1/);
		assert.match(status, /~1/);
		assert.match(status, /\?1/);
		rmSync(repo, {recursive: true, force: true});
	});

	it('hides the segment when git fails (not a repo, git missing)', async () => {
		const t = await boot({cwd: '/tmp/not-a-repo-xyz', git: undefined});
		assert.doesNotMatch(t.status(), /⎇/);
	});

	it('drops the segment again if git stops working mid-session', async () => {
		const options = {git: '## main\n?? a\n'};
		const t = await boot(options);
		assert.match(t.status(), /⎇ main/);
		options.git = undefined; // git now exits non-zero
		await t.run('statusline', 'refresh');
		assert.doesNotMatch(t.status(), /⎇/, 'a repo that becomes unreadable must not leave a stale segment');
	});

	it('makes exactly one git call per refresh', async () => {
		const t = await boot({git: '## main\n'});
		const before = t.execCalls.filter(c => c.command === 'git').length;
		await t.run('statusline', 'refresh');
		const after = t.execCalls.filter(c => c.command === 'git').length;
		assert.equal(after - before, 1);
	});
});

describe('skills segment', () => {
	it('counts each skill once, however many roots list it', () => {
		assert.equal(parseSkillCount(SKILLS_OUT), 4, 'the name lines are the truth: five listed entries, four distinct skills');
	});

	it('does not add the section headers up when the names are listed', () => {
		// The headers sum to 5 while only 4 skills exist. Summing them is the 792-vs-399 defect.
		assert.notEqual(parseSkillCount(SKILLS_OUT), 5);
	});

	it('falls back to the section sum only when no names are listed', () => {
		assert.equal(parseSkillCount(SKILLS_OUT_HEADERS_ONLY), 786);
	});

	it('falls back to the "N installed" header if section format drifts', () => {
		assert.equal(parseSkillCount(' Skills  786 installed\n'), 786);
		assert.equal(parseSkillCount('nothing here'), 0);
	});

	it('renders the count from the harness loader', async () => {
		const t = await boot({});
		assert.match(t.status(), /✓ Skills \(4\)/);
	});

	it('hides when the loader call fails', async () => {
		const t = await boot({exec: () => ({stdout: '', code: 1})});
		assert.doesNotMatch(t.status(), /Skills/);
	});
});

describe('session counters', () => {
	it('counts tools, errors, subagents and turns', async () => {
		const t = await boot({});
		await t.fire('tool_completed');
		await t.fire('tool_completed');
		await t.fire('tool_errored');
		await t.fire('subagent_stop');
		await t.fire('turn_end');
		const status = t.status();
		assert.match(status, /⚙3/);
		assert.match(status, /✗1/);
		assert.match(status, /⚡1/);
		assert.match(status, /↻1/);
	});

	it('persists once per turn, not once per tool call', async () => {
		const t = await boot({});
		await t.fire('tool_completed');
		await t.fire('tool_completed');
		assert.equal(t.appended.length, 0, 'tool calls alone must not write session entries');
		await t.fire('turn_end');
		assert.equal(t.appended.length, 1);
		await t.fire('turn_end');
		assert.equal(t.appended.length, 2);
	});

	it('does not rewrite the entry when nothing changed', async () => {
		const t = await boot({});
		await t.fire('turn_end');
		await t.fire('run_end');
		assert.equal(t.appended.length, 1);
	});

	it('restores counters on resume', async () => {
		const entries = [{customType: 'statusline/counters', data: {turns: 4, tools: 9, toolErrors: 2, subagents: 1}}];
		const t = await boot({entries});
		t.hooks.onSessionStart({source: 'resume'});
		const status = t.status();
		assert.match(status, /⚙9/);
		assert.match(status, /✗2/);
		assert.match(status, /⚡1/);
		assert.match(status, /↻4/);
	});

	it('survives a malformed stored entry', async () => {
		const t = await boot({entries: [{customType: 'statusline/counters', data: {turns: 'x', tools: null}}]});
		t.hooks.onSessionStart({source: 'resume'});
		await t.fire('tool_completed');
		assert.match(t.status(), /⚙1/);
	});
});

describe('model + activity', () => {
	it('shows the model without its provider prefix and the effort', async () => {
		const t = await boot({});
		assert.match(t.status(), /\[deepseek-v4\.1-flash · high\]/);
	});

	it('prefers the live event model over the harness getter', async () => {
		const t = await boot({});
		await t.fire('model_request_end', {model: 'zai-org/GLM-5.3', effort: 'low'});
		assert.match(t.status(), /\[GLM-5\.3 · low\]/);

		await t.fire('effort_change', {effort: 'ultra'});
		assert.match(t.status(), /GLM-5\.3 · ultra/);
	});

	it('resyncs to the harness when the session config changes the model', async () => {
		const t = await boot({});
		await t.fire('model_request_end', {model: 'deepseek/deepseek-v4.1-flash', effort: 'high'});
		assert.match(t.status(), /deepseek-v4\.1-flash/);
		t.setModel('zai-org/GLM-5.3');
		t.setEffort('low');
		await t.fire('config_setting_changed');
		assert.match(t.status(), /\[GLM-5\.3 · low\]/, 'a model switch must not leave the old badge on screen');
	});

	it('marks the run active and generating', async () => {
		const t = await boot({});
		await t.fire('run_start');
		assert.match(t.status(), /\[deepseek-v4\.1-flash ○ high\]/);
		await t.fire('model_request_start', {model: 'deepseek/deepseek-v4.1-flash'});
		assert.match(t.status(), /\[deepseek-v4\.1-flash [◐◓◑◒] high\]/);
		await t.fire('model_request_end', {model: 'deepseek/deepseek-v4.1-flash', effort: 'high'});
		assert.match(t.status(), /\[deepseek-v4\.1-flash ○ high\]/);
		await t.fire('run_end');
		assert.match(t.status(), /\[deepseek-v4\.1-flash · high\]/);
	});
});

describe('repaint triggers', () => {
	it('repaints the context after a compaction resets it', async () => {
		const t = await boot({context: {tokens: 500_000, contextWindow: 1_000_000, percent: 50}});
		assert.match(t.status(), /50%/);
		// What the harness wrapper returns once a compaction has zeroed the fill.
		t.cmd.getContextUsage = () => ({tokens: null, contextWindow: 1_000_000, percent: null});
		await t.fire('compaction_done');
		assert.match(t.status(), /□{10} — \(—\/1M\)/, 'a compaction must not leave the pre-compaction percentage on screen');
	});
});

describe('robustness', () => {
	it('unrefs every interval it creates', async () => {
		intervals.length = 0;
		const t = await boot({});
		t.hooks.onSessionStart({source: 'startup'});
		await t.fire('model_request_start', {model: 'm'});
		assert.ok(intervals.length >= 2, 'refresh + spinner timers expected');
		for (const record of intervals) assert.equal(record.unref, true, 'a referenced timer would hold a headless run open');
		t.hooks.onSessionEnd({reason: 'shutdown'});
		for (const record of intervals) assert.equal(record.cleared, true, 'timers must be cleared at session end');
	});

	it('clears the status segment at session end', async () => {
		const t = await boot({});
		t.hooks.onSessionEnd({reason: 'shutdown'});
		assert.equal(t.statuses.at(-1), null);
	});

	it('spawns no subprocess when the host renders no status', async () => {
		intervals.length = 0; // other tests' timers must not leak into this one
		const t = await boot({headless: true});
		t.hooks.onSessionStart({source: 'startup'});
		await settle();
		assert.deepEqual(t.execCalls, []);
		assert.deepEqual(intervals.filter(r => r.ms === 5000), []);
	});

	it('bootstraps the shell refreshes when the status capability turns true later', async () => {
		intervals.length = 0;
		const t = await boot({headless: true, git: '## main\n'});
		await settle();
		assert.deepEqual(t.execCalls, [], 'nothing rendered yet: no subprocesses');
		t.setStatusRendered(true);
		await t.fire('run_start');
		assert.ok(t.execCalls.some(c => c.command === 'git'), 'git must be fetched once the footer renders');
		assert.ok(t.execCalls.some(c => c.command === 'cmd'), 'the skills count must be fetched too');
		assert.ok(intervals.some(r => r.ms === 5000), 'the refresh timer must start once the footer renders');
	});

	it('reconfigures the running refresh interval when refreshSeconds changes live', async () => {
		intervals.length = 0;
		const t = await boot({flags: {'statusline.refreshSeconds': '1'}});
		assert.deepEqual(intervals.map(r => r.ms), [1000]);
		await t.run('statusline', 'refreshSeconds=10');
		assert.deepEqual(intervals.map(r => r.ms), [1000, 10_000], 'the live change must reach the running interval');
		assert.equal(intervals[0].cleared, true);
	});

	it('does not let a pending repaint resurrect a cleared status', async () => {
		const t = await boot({});
		await t.fire('model_request_end', {model: 'deepseek/deepseek-v4.1-flash'}); // schedules one
		await t.run('statusline', 'clear');
		assert.equal(t.statuses.at(-1), null);
		await sleep(500);
		assert.equal(t.statuses.at(-1), null, 'a cleared status must stay cleared');
	});

	it('does not repaint after session end', async () => {
		const t = await boot({});
		await t.fire('model_request_end', {model: 'deepseek/deepseek-v4.1-flash'});
		t.hooks.onSessionEnd({reason: 'shutdown'});
		assert.equal(t.statuses.at(-1), null);
		await sleep(500);
		assert.equal(t.statuses.at(-1), null, 'the segment must stay clear after the session is gone');
	});

	it('does not trust output from a command that failed', async () => {
		const t = await boot({
			exec: ({command}) => (command === 'git' ? {stdout: '## main\n?? a\n', code: 128} : {stdout: 'Project (5)\n', code: 1}),
		});
		assert.doesNotMatch(t.status(), /⎇/, 'a non-zero git exit must not render a segment from its leftover stdout');
		assert.doesNotMatch(t.status(), /Skills/, 'a non-zero loader exit must not render a count from its leftover stdout');
	});

	it('survives a host with no exec seam', async () => {
		const t = await boot({});
		delete t.cmd.exec;
		t.hooks.onSessionStart({source: 'startup'});
		await settle();
		assert.ok(t.status().length > 0);
	});

	it('survives a host with no session seam', async () => {
		const t = await boot({});
		delete t.cmd.session;
		t.hooks.onSessionStart({source: 'startup'});
		await t.fire('turn_end');
		assert.match(t.status(), /↻1/);
	});

	it('survives a host with no model or effort getters', async () => {
		const t = await boot({});
		delete t.cmd.getModel;
		delete t.cmd.getEffort;
		await t.fire('model_request_end', {model: 'm'});
		await t.fire('config_setting_changed');
		assert.ok(t.status().length > 0);
	});

	it('notices a broken render once instead of thrashing the host', async () => {
		const t = await boot({});
		t.cmd.ui.setStatus = () => {
			throw new Error('boom');
		};
		await t.fire('tool_completed');
		await t.fire('tool_completed');
		assert.equal(t.notifications.length, 1);
		assert.match(t.notifications[0].message, /statusline mod render failed: boom/);
	});

	it('always hands setStatus a string', async () => {
		const t = await boot({});
		await t.fire('turn_end');
		for (const value of t.statuses) if (value !== null) assert.equal(typeof value, 'string');
		assert.ok(t.statuses.length > 0);
	});
});

describe('command surface', () => {
	it('registers /statusline with a hint', async () => {
		const t = await boot({});
		assert.ok(t.commands.has('statusline'));
		assert.match(t.commands.get('statusline').argumentHint, /refresh/);
	});

	it('lists every key', async () => {
		const t = await boot({});
		const {message} = await t.run('statusline');
		for (const key of ['showContext', 'contextStyle', 'showModel', 'showProject', 'showCounters', 'showSkills', 'showGit', 'showMode', 'refreshSeconds', 'label', 'separator']) {
			assert.match(message, new RegExp(key));
		}
	});

	it('rejects an unknown key and a bad value without throwing', async () => {
		const t = await boot({});
		assert.match((await t.run('statusline', 'nope=1')).message, /Unknown statusline option 'nope'/);
		assert.match((await t.run('statusline', 'showContext=maybe')).message, /must be true\/false/);
		assert.match((await t.run('statusline', 'contextStyle=sparkly')).message, /must be full, compact or tokens/);
	});

	it('saves to the config file and resets it', async () => {
		rmSync(CONFIG, {force: true});
		const t = await boot({});
		await t.run('statusline', 'showContext=false');
		const saved = await t.run('statusline', 'save');
		assert.match(saved.message, /Saved to/);
		assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).showContext, false);

		const relaunched = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}});
		assert.doesNotMatch(relaunched.status(), /[■□]/, 'the saved file must apply to the next launch');

		await relaunched.run('statusline', 'reset');
		assert.equal(existsSync(CONFIG), false);
		const cleared = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}});
		assert.match(cleared.status(), /[■□]/, 'reset must return to defaults');
	});

	it('clears the segment on /statusline clear', async () => {
		const t = await boot({});
		await t.run('statusline', 'clear');
		assert.equal(t.statuses.at(-1), null);
	});
});

describe('pure helpers', () => {
	it('formats tokens in the host context-view style, minus a trailing .0', () => {
		assert.equal(formatTokens(999), '999');
		assert.equal(formatTokens(1200), '1.2k');
		assert.equal(formatTokens(120_000), '120k');
		assert.equal(formatTokens(181_200), '181.2k');
		assert.equal(formatTokens(999_900), '999.9k');
		assert.equal(formatTokens(1_000_000), '1M');
		assert.equal(formatTokens(1_050_000), '1.1M');
	});

	it('clamps the bar at the edges', () => {
		assert.equal(contextBar(null), '□'.repeat(10));
		assert.equal(contextBar(0), '□'.repeat(10));
		assert.equal(contextBar(100), '■'.repeat(10));
		assert.equal(contextBar(250), '■'.repeat(10));
		assert.equal(contextBar(-5), '□'.repeat(10));
	});

	it('bins the tone like the host does', () => {
		assert.equal(contextTone(null), 'normal');
		assert.equal(contextTone(0), 'normal');
		assert.equal(contextTone(49), 'normal');
		assert.equal(contextTone(50), 'warning');
		assert.equal(contextTone(79), 'warning');
		assert.equal(contextTone(80), 'danger');
	});

	it('reads a context measurement out of the turn usage, and nothing out of its absence', () => {
		assert.equal(contextTokensFromUsage({inputTokens: 67_717, outputTokens: 2, cacheReadTokens: 44_544}), 67_719);
		assert.equal(contextTokensFromUsage({inputTokens: 120_000}), 120_000);
		assert.equal(contextTokensFromUsage({cacheReadTokens: 44_544, cacheWriteTokens: 0}), undefined);
		assert.equal(contextTokensFromUsage({inputTokens: 0, outputTokens: 0}), undefined);
		assert.equal(contextTokensFromUsage({inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY}), undefined);
		assert.equal(contextTokensFromUsage(undefined), undefined);
		assert.equal(contextTokensFromUsage(null), undefined);
		assert.equal(contextTokensFromUsage('usage'), undefined);
	});
});

// Colours: one hue per section, every slot a theme-defined ANSI colour so the terminal's own
// palette carries dark/light adaptation. `dim`/faint is gone — see tools/check-contrast.mjs for
// the measured reason and the remaining limit.
describe('segment colours', () => {
	it('uses no faint text anywhere in the row', async () => {
		const t = await boot({git: '## main\n', context: {tokens: 181_200, contextWindow: 1_000_000, percent: 18}, flags: {'statusline.label': 'mine'}});
		await t.fire('permission_mode_changed', {mode: 'bypass'});
		assert.doesNotMatch(t.raw(), /\u001b\[2m/, 'ANSI faint is where terminal text loses its contrast headroom');
		assert.doesNotMatch(t.raw(), /\u001b\[90m/, 'brightBlack is the faint-coloured slot by another name');
	});

	it('colours the model segment blue', async () => {
		const t = await boot({});
		assert.match(t.raw(), /\u001b\[34m\[deepseek-v4\.1-flash · high\]\u001b\[39m/);
	});

	it('colours the project segment purple', async () => {
		const t = await boot({});
		assert.match(t.raw(), /\u001b\[35mproject-alpha ⏱ \d+s\u001b\[39m/);
	});

	it('colours the counters cyan while the error count stays red', async () => {
		const t = await boot({});
		await t.fire('tool_completed', {});
		await t.fire('tool_errored', {});
		await t.fire('turn_end', {});
		const raw = t.raw();
		assert.match(raw, /\u001b\[31m✗1\u001b\[39m/, 'an error count must stay the danger colour');
		assert.match(raw, /\u001b\[36m⚙2\u001b\[39m/);
		assert.match(raw, /\u001b\[36m↻1\u001b\[39m/);
	});

	it('colours the skills count green', async () => {
		const t = await boot({});
		assert.match(t.raw(), /\u001b\[32m✓ Skills \(4\)\u001b\[39m/);
	});

	it('colours the git segment by meaning: branch blue, ahead green, behind yellow, counts too', async () => {
		const t = await boot({git: '## main...origin/main [ahead 1, behind 2]\nM  s.ts\n M m.ts\n?? u.ts\n'});
		const raw = t.raw();
		assert.match(raw, /\u001b\[34m⎇ main\u001b\[39m/);
		assert.match(raw, /\u001b\[32m↑1\u001b\[39m/);
		assert.match(raw, /\u001b\[33m↓2\u001b\[39m/);
		assert.match(raw, /\u001b\[32m\+1\u001b\[39m/);
		assert.match(raw, /\u001b\[33m~1\u001b\[39m/);
		assert.match(raw, /\u001b\[36m\?1\u001b\[39m/);
	});

	it('colours the permission mode yellow', async () => {
		const t = await boot({});
		await t.fire('permission_mode_changed', {mode: 'bypass'});
		assert.match(t.raw(), /\u001b\[33m⏵⏵ bypass\u001b\[39m/);
	});

	it('colours the label white', async () => {
		const t = await boot({flags: {'statusline.label': 'mine'}});
		assert.match(t.raw(), /\u001b\[37mmine\u001b\[39m/);
	});

	it('renders an unmeasured context in white rather than faint', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		assert.match(t.raw(), /\u001b\[37m□{10} — \(—\/1M\)\u001b\[39m/);
	});
});

before(() => {
	mkdirSync(SCRATCH, {recursive: true});
});
after(() => {
	rmSync(CONFIG, {force: true});
});

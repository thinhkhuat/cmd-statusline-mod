// Test suite for the statusline mod (~/.commandcode/mods/statusline.ts).
//
// Run it from this directory:
//   node --test .statusline-tests/statusline.test.mjs            (from ~/.commandcode/mods)
//   node --test statusline.test.mjs                              (from .statusline-tests)
//
// It loads the real mod through Node's TypeScript stripping and drives it with a fake
// ModApi that records everything the mod does to the host. STATUSLINE_MOD points it at a
// mutant for mutation testing.
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
	const record = {timer, unref: false, cleared: false};
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
const {parseGitStatus, parseSkillCount, formatTokens, contextBar, contextTone} = await import(MOD_FILE);

const strip = text => String(text).replace(/\u001b\[[0-9;]*m/g, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (times = 4) => {
	for (let i = 0; i < times; i += 1) await tick();
};

const SKILLS_OUT = [' Skills  786 installed', '', 'Project (388)', '  a · x', 'Global (390)', 'Bundled (8)'].join('\n');

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

	const cmd = {
		name: 'statusline',
		cwd: options.cwd ?? '/tmp/project-alpha',
		ui: {
			setStatus: value => statuses.push(value),
			notify: (message, level) => notifications.push({message, level}),
			capabilities: {status: options.headless ? false : true},
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
	const fire = async (event, payload = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		await settle();
	};
	const run = async (name, args = '') => {
		const result = await commands.get(name).handler({args, ui: cmd.ui, cwd: cmd.cwd, exec: cmd.exec});
		await settle();
		return result;
	};

	return {cmd, options, statuses, notifications, flagsDeclared, hooks, handlers, commands, appended, execCalls, status, fire, run, sessions: entries};
}

describe('context segment', () => {
	it('renders harness-measured fill: bar, percent and tokens/window', async () => {
		const t = await boot({context: {tokens: 120_000, contextWindow: 1_000_000, percent: 12}});
		assert.match(t.status(), /█░{9} 12% · 120k\/1M/);
	});

	it('rounds the bar to the nearest cell', async () => {
		const t = await boot({context: {tokens: 480_000, contextWindow: 1_000_000, percent: 48}});
		assert.match(t.status(), /█{5}░{5} 48%/);
	});

	it('never shows a misleading 0% before the first measurement', async () => {
		const t = await boot({context: {tokens: null, contextWindow: 1_000_000, percent: null}});
		assert.match(t.status(), /░{10} — · —\/1M/);
		assert.doesNotMatch(t.status(), /0%/);
	});

	it('hides the segment when the harness reports nothing', async () => {
		const t = await boot({context: undefined});
		assert.doesNotMatch(t.status(), /[█░]/);
	});

	it('hides the segment when getContextUsage throws', async () => {
		const t = await boot({
			context: () => {
				throw new Error('not bound');
			},
		});
		assert.doesNotMatch(t.status(), /[█░]/);
		assert.equal(t.notifications.length, 0, 'a throwing getContextUsage must not be an error notice');
	});

	it('tones green under 50, yellow at 50, red at 80', async () => {
		const green = await boot({context: {tokens: 490_000, contextWindow: 1_000_000, percent: 49}});
		assert.match(green.statuses.at(-1), /\u001b\[32m/);
		const yellow = await boot({context: {tokens: 500_000, contextWindow: 1_000_000, percent: 50}});
		assert.match(yellow.statuses.at(-1), /\u001b\[33m/);
		const red = await boot({context: {tokens: 800_000, contextWindow: 1_000_000, percent: 80}});
		assert.match(red.statuses.at(-1), /\u001b\[31m/);
	});

	it('honours contextStyle compact and tokens', async () => {
		const compact = await boot({context: {tokens: 120_000, contextWindow: 1_000_000, percent: 12}, flags: {'statusline.contextStyle': 'compact'}});
		assert.match(compact.status(), /12%/);
		assert.doesNotMatch(compact.status(), /120k\/1M/);
		const tokens = await boot({context: {tokens: 120_000, contextWindow: 1_000_000, percent: 12}, flags: {'statusline.contextStyle': 'tokens'}});
		assert.match(tokens.status(), /120k\/1M/);
		assert.doesNotMatch(tokens.status(), /12%/);
	});

	it('derives a percent when the harness sends only tokens and window', async () => {
		const t = await boot({context: {tokens: 250_000, contextWindow: 1_000_000, percent: null}});
		assert.match(t.status(), /25%/);
	});
});

describe('segment switches and precedence', () => {
	it('hides context on showContext=false', async () => {
		const t = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': false}});
		assert.doesNotMatch(t.status(), /[█░]/);
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
		assert.doesNotMatch(fromFile.status(), /[█░]/, 'config file must override the default');
		assert.match(fromFile.status(), /file/);

		const fromFlag = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': true, 'statusline.label': 'flag'}});
		assert.match(fromFlag.status(), /[█░]/, 'a launch flag must beat the file');
		assert.match(fromFlag.status(), /flag/);

		const fromSession = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}, flags: {'statusline.showContext': true}});
		await fromSession.run('statusline', 'showContext=false');
		assert.doesNotMatch(fromSession.status(), /[█░]/, 'a live override must beat the launch flag');

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
	it('sums the loader section counts', () => {
		assert.equal(parseSkillCount(SKILLS_OUT), 786);
	});

	it('falls back to the "N installed" header if section format drifts', () => {
		assert.equal(parseSkillCount(' Skills  786 installed\n'), 786);
		assert.equal(parseSkillCount('nothing here'), 0);
	});

	it('renders the count from the harness loader', async () => {
		const t = await boot({});
		assert.match(t.status(), /✓ Skills \(786\)/);
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
		const t = await boot({headless: true});
		t.hooks.onSessionStart({source: 'startup'});
		await settle();
		assert.deepEqual(t.execCalls, []);
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

	it('accepts on/off and key=value and bare-value forms', async () => {
		const t = await boot({});
		await t.run('statusline', 'showGit=off');
		assert.doesNotMatch(t.status(), /⎇/);
		await t.run('statusline', 'label mine');
		assert.match(t.status(), /mine/);
	});

	it('saves to the config file and resets it', async () => {
		rmSync(CONFIG, {force: true});
		const t = await boot({});
		await t.run('statusline', 'showContext=false');
		const saved = await t.run('statusline', 'save');
		assert.match(saved.message, /Saved to/);
		assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).showContext, false);

		const relaunched = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}});
		assert.doesNotMatch(relaunched.status(), /[█░]/, 'the saved file must apply to the next launch');

		await relaunched.run('statusline', 'reset');
		assert.equal(existsSync(CONFIG), false);
		const cleared = await boot({context: {tokens: 1, contextWindow: 100, percent: 1}});
		assert.match(cleared.status(), /[█░]/, 'reset must return to defaults');
	});

	it('clears the segment on /statusline clear', async () => {
		const t = await boot({});
		await t.run('statusline', 'clear');
		assert.equal(t.statuses.at(-1), null);
	});
});

describe('pure helpers', () => {
	it('formats tokens the way the host does', () => {
		assert.equal(formatTokens(999), '999');
		assert.equal(formatTokens(1_200), '1k');
		assert.equal(formatTokens(120_000), '120k');
		assert.equal(formatTokens(1_000_000), '1M');
		assert.equal(formatTokens(1_050_000), '1.1M');
	});

	it('clamps the bar at the edges', () => {
		assert.equal(contextBar(null), '░'.repeat(10));
		assert.equal(contextBar(0), '░'.repeat(10));
		assert.equal(contextBar(100), '█'.repeat(10));
		assert.equal(contextBar(250), '█'.repeat(10));
		assert.equal(contextBar(-5), '░'.repeat(10));
	});

	it('bins the tone like the host does', () => {
		assert.equal(contextTone(null), 'normal');
		assert.equal(contextTone(0), 'normal');
		assert.equal(contextTone(49), 'normal');
		assert.equal(contextTone(50), 'warning');
		assert.equal(contextTone(79), 'warning');
		assert.equal(contextTone(80), 'danger');
	});
});

before(() => {
	mkdirSync(SCRATCH, {recursive: true});
});
after(() => {
	rmSync(CONFIG, {force: true});
});

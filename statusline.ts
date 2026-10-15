// statusline mod — a configurable, event-driven statusline for the Command Code TUI.
//
// Renders a persistent per-mod footer segment (under the input panel) through
// `cmd.ui.setStatus` — the surface the mod docs mark as wired and rendering today.
// (`cmd.ui.widget` exists but renders nowhere, so this mod never uses it.)
//
// Segments — real data only, from the harness or the shell; nothing proxied:
//   ■■□□□□□□□□ 18% (181.2k/1M)    context fill, measured (harness getter, else the turn usage)
//   [fable-5 ◑ high]              model + effort + activity spinner
//   news-tracking ⏱ 2m            project (cwd basename) + session elapsed
//   ✗1 ⚙12 ⚡2 ↻3                 tool errors / calls / subagents / turns, this session
//   ✓ Skills (786)                skills the harness actually loads
//   ⎇ main ↑2↓1 +1 ~3 ?4          git branch, ahead/behind, staged/modified/untracked
//   ⏵⏵ bypass                     permission mode
//
// Colour: one theme-defined ANSI hue per section — model blue, project purple, counters cyan,
// skills green, git by meaning, mode yellow — and no `dim`/faint anywhere. ANSI_CODES and
// SECTION_COLORS below are the single source of truth; tools/check-contrast.mjs scores them
// against 811 real terminal themes and records what that cannot fix.
//
// Context comes from the harness's own measurement (`cmd.getContextUsage()`) whenever there is
// one, and from the turn's reported usage otherwise — the `model_request_end` event's
// `usage.inputTokens + usage.outputTokens`, the same quantity the harness's own compaction
// logic builds. The stand-in is needed because Command Code 1.82.3 answers
// `{tokens: null, contextWindow: <n>, percent: null}` at every lifecycle point even after the
// turn that reported 67,717 input tokens, so the getter alone drew `—` forever (see
// docs/investigation.md). `—` is rendered only when neither source has a measurement, never a
// misleading `0%`; the segment hides entirely when there is neither a fill nor a window. No
// hardcoded model→window table and no accumulation across requests — those are proxies, and
// they go wrong silently. A figure measured before a compaction is dropped on
// `compaction_done`, because the harness resets its fill there and the old number is stale.
//
// Configuration, precedence (later wins):
//   1. built-in defaults (DEFAULTS below)
//   2. ~/.commandcode/statusline.json        (written by `/statusline save`)
//   3. --mod-option statusline.<key>=<value> (per launch)
//   4. /statusline <key>=<value>             (this session only)
//
// Keys (all flags are `statusline.<key>`):
//   showContext      boolean  true               context-fill segment
//   contextStyle     string   'full'             full (bar + % + (used/window)) | compact (bar + %) | tokens
//   showModel        boolean  true               model + effort + spinner
//   showProject      boolean  true               project name + elapsed time
//   showCounters     boolean  true               tools / errors / subagents / turns
//   showSkills       boolean  true               skills the harness loads
//   showGit          boolean  true               git status of the working directory
//   showMode         boolean  true               permission-mode indicator
//   refreshSeconds   string   '5'                staleness bound for git + context
//   label            string   ''                 optional prefix segment
//   separator        string   ' · '              segment separator (ANSI allowed)
//
// Commands: `/statusline` (list), `/statusline key=value`, `/statusline refresh`,
//   `/statusline save`, `/statusline reset`, `/statusline clear`.
//
// Durability: per-session totals (turns, tool calls, tool errors, subagents) persist
// through `cmd.session` (appendCustomEntry / getCustomEntries), so they survive /resume.
// Run-scoped state (model, spinner tick, elapsed start) lives in the factory closure.
//
// Headless (-p): setStatus is stored and rendered nowhere, so the mod skips its shell
// refreshes there, and every timer is unref'd so a print run still exits on its own.
//
// Verify: `cmd mods list` (registered, no warnings) · `cmd --mod <file> -p "hi"` (loads,
// exits) · `cmd` then /reload, and read the footer row under the input.
// Test: node --test .statusline-tests/statusline.test.mjs   (72 tests, from this directory)

import type {ModApi} from '@commandcode/harness';
import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';

const MOD_ID = 'statusline';
const CUSTOM_TYPE = `${MOD_ID}/counters`; // durable per-session counters
// Overridable so a test (or a second profile) never touches the real config.
const CONFIG_FILE = process.env.COMMANDCODE_STATUSLINE_CONFIG ?? join(homedir(), '.commandcode', 'statusline.json');

const DEFAULTS: Record<string, string | boolean> = {
	showContext: true,
	contextStyle: 'full',
	showModel: true,
	showProject: true,
	showCounters: true,
	showSkills: true,
	showGit: true,
	showMode: true,
	refreshSeconds: '5',
	label: '',
	separator: ' · ',
};

const BOOL_KEYS = ['showContext', 'showModel', 'showProject', 'showCounters', 'showSkills', 'showGit', 'showMode'];
const STRING_KEYS = ['contextStyle', 'refreshSeconds', 'label', 'separator'];
const ALL_KEYS = [...BOOL_KEYS, ...STRING_KEYS];

const FLAG_DESCRIPTIONS: Record<string, string> = {
	showContext: 'Show the context-fill segment (harness-measured). Default true.',
	contextStyle: 'Context segment style: full (bar + % + (used/window)), compact (bar + %), tokens (used/window). Default full.',
	showModel: 'Show the model + effort + activity segment. Default true.',
	showProject: 'Show the project name + elapsed-time segment. Default true.',
	showCounters: 'Show the session counters segment (tools, errors, subagents, turns). Default true.',
	showSkills: 'Show the loaded-skills count segment. Default true.',
	showGit: 'Show the git status segment of the working directory. Default true.',
	showMode: 'Show the permission-mode segment. Default true.',
	refreshSeconds: 'Seconds between background refreshes of git status and context. Default 5.',
	label: 'Optional prefix segment for the statusline (e.g. a profile name). Default empty.',
	separator: 'Segment separator (ANSI styling allowed). Default " · ".',
};

const CONTEXT_BAR_CELLS = 10;
const BAR_FILLED = '■'; // the square pair the claude-hud profile settled on
const BAR_EMPTY = '□';
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

interface Counters {
	readonly turns: number;
	readonly tools: number;
	readonly toolErrors: number;
	readonly subagents: number;
}

export interface GitInfo {
	readonly branch: string;
	readonly ahead: number;
	readonly behind: number;
	readonly staged: number;
	readonly modified: number;
	readonly untracked: number;
}

const EMPTY_COUNTERS: Counters = {turns: 0, tools: 0, toolErrors: 0, subagents: 0};

// Colour. Every slot is a theme-defined ANSI colour, so the terminal's own palette is what
// adapts the row to a dark or a light background — a hardcoded RGB would hold one background
// mode and break the other. No `dim`/faint and no `brightBlack`: both cut the contrast headroom
// the theme gave the text.
//
// SECTION_COLORS is the single source of truth for which hue each section wears, exported so
// tools/check-contrast.mjs scores exactly what this file renders — it is measured against 811
// real terminal themes there, not asserted here.
export const ANSI_CODES = {
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	purple: 35,
	cyan: 36,
	white: 37,
} as const;

export const SECTION_COLORS = {
	label: 'white',
	contextUnknown: 'white',
	contextOk: 'green',
	contextWarning: 'yellow',
	contextDanger: 'red',
	model: 'blue',
	project: 'purple',
	counters: 'cyan',
	counterErrors: 'red',
	skills: 'green',
	gitBranch: 'blue',
	gitAhead: 'green',
	gitBehind: 'yellow',
	gitStaged: 'green',
	gitModified: 'yellow',
	gitUntracked: 'cyan',
	mode: 'yellow',
} as const;

type ColorName = keyof typeof ANSI_CODES;

const ansi = Object.fromEntries(
	(Object.keys(ANSI_CODES) as ColorName[]).map(name => [name, (s: string) => `\u001b[${ANSI_CODES[name]}m${s}\u001b[39m`]),
) as Record<ColorName, (s: string) => string>;

const paint = (section: keyof typeof SECTION_COLORS, text: string): string => ansi[SECTION_COLORS[section]](text);

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`;
	return String(n);
}

// One decimal where there is one: 120k, but 181.2k and 1.1M.
function trimZero(value: string): string {
	return value.endsWith('.0') ? value.slice(0, -2) : value;
}

export function contextBar(percent: number | null): string {
	const filled = percent === null ? 0 : Math.max(0, Math.min(CONTEXT_BAR_CELLS, Math.round((percent / 100) * CONTEXT_BAR_CELLS)));
	return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(CONTEXT_BAR_CELLS - filled);
}

export function contextTone(percent: number | null): 'normal' | 'warning' | 'danger' {
	if (percent === null) return 'normal';
	return percent >= 80 ? 'danger' : percent >= 50 ? 'warning' : 'normal';
}

function elapsedLabel(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

// `git status --porcelain=v1 --branch`: one call, header + worktree counts.
export function parseGitStatus(out: string): GitInfo | undefined {
	let branch = '';
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;

	for (const line of out.split('\n')) {
		if (line === '') continue;

		if (line.startsWith('## ')) {
			const header = line.slice(3);
			const counts = /\[(.+)\]$/.exec(header);
			if (counts) {
				const a = /ahead (\d+)/.exec(counts[1]);
				const b = /behind (\d+)/.exec(counts[1]);
				if (a) ahead = Number(a[1]);
				if (b) behind = Number(b[1]);
			}
			const name = header.replace(/\s*\[.*\]$/, '').replace(/\.\.\..*$/, '').trim();
			if (name === 'HEAD (no branch)') branch = '(detached)';
			else if (name.startsWith('No commits yet on ')) branch = name.slice('No commits yet on '.length);
			else branch = name;
			continue;
		}

		const x = line[0];
		const y = line[1];
		if (x === '?' && y === '?') {
			untracked += 1;
			continue;
		}
		if (x === '!') continue; // ignored
		if (x !== ' ') staged += 1;
		if (y !== ' ') modified += 1;
	}

	if (!branch) return undefined;
	return {branch, ahead, behind, staged, modified, untracked};
}

// `cmd skills list` prints the loader's own section counts, e.g. "Project (388)".
export function parseSkillCount(out: string): number {
	let total = 0;
	for (const line of out.split('\n')) {
		const m = /^\s*(?:Bundled|Project|Global)\s*\((\d+)\)\s*$/.exec(line);
		if (m) total += Number(m[1]);
	}
	if (total > 0) return total;
	const header = /(\d+)\s+installed/.exec(out); // fallback if the section format drifts
	return header ? Number(header[1]) : 0;
}

// The turn's own context measurement, off a `model_request_end` event's `usage`: the whole
// prompt that was sent (`inputTokens`, the real fill) plus what that turn appended
// (`outputTokens`) — the same quantity the harness's compaction logic builds. `undefined`
// when the event carries no usage: that is not a measurement, and must never read as 0%.
export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== 'object') return undefined;
	const {inputTokens, outputTokens} = usage as {inputTokens?: unknown; outputTokens?: unknown};
	const input = typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : 0;
	const output = typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : 0;
	const total = input + output;
	return total > 0 ? total : undefined;
}

// ── Mod ────────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
	const safe = <T,>(fn: () => T): T | undefined => {
		try {
			return fn();
		} catch {
			return undefined;
		}
	};

	// Flags carry no `default`: `getFlag` seeds nothing then, so an unset flag is
	// genuinely undefined and the file/default layers below can apply. Defaults live in
	// DEFAULTS, which is also what `/statusline` prints.
	for (const key of ALL_KEYS) {
		safe(() =>
			cmd.addFlag(`${MOD_ID}.${key}`, {
				type: BOOL_KEYS.includes(key) ? 'boolean' : 'string',
				description: FLAG_DESCRIPTIONS[key] ?? key,
			}),
		);
	}

	// ── Configuration: live > flag > file > default ──────────────────────────────
	let liveOptions: Record<string, string | boolean> = {};
	let fileOptions: Record<string, string | boolean> = readConfigFile();

	function readConfigFile(): Record<string, string | boolean> {
		return (
			safe(() => {
				const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
				const out: Record<string, string | boolean> = {};
				for (const key of ALL_KEYS) {
					const value = (parsed as Record<string, unknown>)[key];
					if (typeof value === 'boolean' || typeof value === 'string') out[key] = value;
				}
				return out;
			}) ?? {}
		);
	}

	function rawOption(key: string): string | boolean | undefined {
		const live = liveOptions[key];
		if (live !== undefined) return live;
		const flag = safe(() => cmd.getFlag(`${MOD_ID}.${key}`));
		if (flag !== undefined) return flag;
		return fileOptions[key];
	}

	function optionSource(key: string): string {
		if (liveOptions[key] !== undefined) return 'session';
		if (safe(() => cmd.getFlag(`${MOD_ID}.${key}`)) !== undefined) return 'flag';
		if (fileOptions[key] !== undefined) return 'file';
		return 'default';
	}

	function boolOption(key: string): boolean {
		const value = rawOption(key);
		if (value === undefined) return DEFAULTS[key] === true;
		return value === true || String(value) === 'true';
	}

	function stringOption(key: string): string {
		const value = rawOption(key);
		return value === undefined ? String(DEFAULTS[key]) : String(value);
	}

	function writeConfigFile(): {ok: boolean; error?: string} {
		try {
			const out: Record<string, string | boolean> = {};
			for (const key of ALL_KEYS) out[key] = rawOption(key) ?? DEFAULTS[key];
			mkdirSync(dirname(CONFIG_FILE), {recursive: true});
			const tmp = `${CONFIG_FILE}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(out, null, '\t')}\n`, 'utf8');
			renameSync(tmp, CONFIG_FILE);
			fileOptions = out;
			return {ok: true};
		} catch (error) {
			return {ok: false, error: error instanceof Error ? error.message : String(error)};
		}
	}

	// ── Run-scoped state ─────────────────────────────────────────────────────────
	let currentModel = '';
	let currentEffort = '';
	let active = false;
	let busy = false;
	let spinner = 0;
	let counters: Counters = {...EMPTY_COUNTERS};
	let sessionStart = Date.now();
	let permissionMode = '';
	let skillCount = 0;
	let gitInfo: GitInfo | undefined;
	let lastPersistedCounters = JSON.stringify(EMPTY_COUNTERS);
	let renderBroken = false;
	// The last completed request's own measurement, and the stand-in for a harness getter that
	// answers `tokens: null` at every lifecycle point on Command Code 1.82.3 — see docs/investigation.md.
	let measuredContextTokens: number | undefined;

	let spinTimer: ReturnType<typeof setInterval> | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let followUpRepaint: ReturnType<typeof setTimeout> | undefined;
	let bootstrapped = false; // the shell refreshes + refresh timer have started

	const unref = (timer: unknown): void => {
		(timer as {unref?: () => void}).unref?.();
	};

	// Non-blocking process helper: the harness runtime, which shell-quotes the args.
	// Returns undefined on failure (missing binary, non-zero exit, no exec seam).
	async function runProcess(command: string, args: string[], cwd?: string): Promise<string | undefined> {
		const exec = (cmd as {exec?: (o: {command: string; args?: string[]; cwd?: string}) => Promise<{stdout?: string; code?: number}>}).exec;
		if (typeof exec !== 'function') return undefined;
		const result = await safe(() => exec({command, args, cwd}));
		if (!result) return undefined;
		if (typeof result.code === 'number' && result.code !== 0) return undefined;
		return typeof result.stdout === 'string' ? result.stdout : '';
	}

	const statusRendered = (): boolean =>
		safe(() => (cmd.ui as unknown as {capabilities?: {status?: boolean}}).capabilities?.status) !== false;

	async function refreshGit(): Promise<void> {
		const out = await runProcess('git', ['status', '--porcelain=v1', '--branch'], cmd.cwd);
		const next = out === undefined ? undefined : parseGitStatus(out);
		if (JSON.stringify(next ?? null) === JSON.stringify(gitInfo ?? null)) return;
		gitInfo = next;
		render();
	}

	async function refreshSkills(): Promise<void> {
		const out = await runProcess('cmd', ['skills', 'list']);
		if (out === undefined) return;
		const next = parseSkillCount(out);
		if (next === skillCount) return;
		skillCount = next;
		render();
	}

	// `capabilities.status` is not "TUI vs headless" as a constant: the host flips it true
	// when the footer subscribes. So an early false must not be final — bootstrap latches on
	// the first moment the flag is true (load, session start, or the first run) and does the
	// shell refreshes and starts the refresh timer exactly once. While it stays false
	// (headless), no subprocess is spawned for a segment nobody renders.
	function bootstrap(): void {
		if (bootstrapped || !statusRendered()) return;
		bootstrapped = true;
		startRefreshTimer();
		void refreshSkills();
		void refreshGit();
	}

	function startRefreshTimer(): void {
		if (refreshTimer) return;
		const seconds = Math.max(1, Number.parseInt(stringOption('refreshSeconds'), 10) || 5);
		refreshTimer = setInterval(() => {
			void refreshGit();
			render();
		}, seconds * 1000);
		unref(refreshTimer);
	}

	// A live change to refreshSeconds must reach the running interval, not only the next one.
	function restartRefreshTimer(): void {
		if (!refreshTimer) return; // never started (headless, or not bootstrapped yet)
		clearInterval(refreshTimer);
		refreshTimer = undefined;
		startRefreshTimer();
	}

	function cancelFollowUpRepaint(): void {
		if (!followUpRepaint) return;
		clearTimeout(followUpRepaint);
		followUpRepaint = undefined;
	}

	function stopTimers(): void {
		if (spinTimer) {
			clearInterval(spinTimer);
			spinTimer = undefined;
		}
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		cancelFollowUpRepaint(); // or it repaints a status we just cleared
		spinner = 0;
	}

	function startSpin(): void {
		if (spinTimer) return;
		spinTimer = setInterval(() => {
			spinner = (spinner + 1) % SPINNER_FRAMES.length;
			render();
		}, 250);
		unref(spinTimer);
	}

	function stopSpin(): void {
		if (spinTimer) {
			clearInterval(spinTimer);
			spinTimer = undefined;
		}
		spinner = 0;
	}

	// ── Segments ─────────────────────────────────────────────────────────────────
	function contextSegment(): string | undefined {
		const usage = safe(() =>
			(cmd as unknown as {getContextUsage?: () => {tokens?: number | null; contextWindow?: number | null; percent?: number | null} | undefined}).getContextUsage?.(),
		);

		const window = usage && typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		const harnessTokens = usage && typeof usage.tokens === 'number' && usage.tokens >= 0 ? usage.tokens : undefined;
		// The harness's own measurement wins whenever it exists; the last turn's reported usage
		// stands in when it does not — which is every point on Command Code 1.82.3.
		const tokens = harnessTokens ?? measuredContextTokens;
		if (window === undefined && tokens === undefined) return undefined;

		const percent =
			tokens !== undefined && window !== undefined
				? Math.max(0, Math.min(100, harnessTokens !== undefined && usage && typeof usage.percent === 'number' ? usage.percent : Math.round((tokens / window) * 100)))
				: null;

		const percentLabel = percent === null ? '—' : `${percent}%`;
		const pairLabel = `${tokens === undefined ? '—' : formatTokens(tokens)}/${window === undefined ? '—' : formatTokens(window)}`;

		const style = stringOption('contextStyle');
		const text =
			style === 'tokens'
				? pairLabel
				: style === 'compact'
					? `${contextBar(percent)} ${percentLabel}`
					: `${contextBar(percent)} ${percentLabel} (${pairLabel})`;

		switch (contextTone(percent)) {
			case 'danger':
				return paint('contextDanger', text);
			case 'warning':
				return paint('contextWarning', text);
			default:
				return paint(percent === null ? 'contextUnknown' : 'contextOk', text);
		}
	}

	function modelSegment(): string {
		const model = currentModel || safe(() => cmd.getModel?.()) || '';
		const effort = currentEffort || safe(() => cmd.getEffort?.()) || '';
		const name = model.split('/').pop() || '…';
		const dot = busy ? SPINNER_FRAMES[spinner] : active ? '○' : '·';
		return paint('model', `[${name} ${dot}${effort ? ` ${effort}` : ''}]`);
	}

	function countersSegment(): string | undefined {
		const bits: string[] = [];
		if (counters.toolErrors > 0) bits.push(paint('counterErrors', `✗${counters.toolErrors}`));
		if (counters.tools > 0) bits.push(paint('counters', `⚙${counters.tools}`));
		if (counters.subagents > 0) bits.push(paint('counters', `⚡${counters.subagents}`));
		if (counters.turns > 0) bits.push(paint('counters', `↻${counters.turns}`));
		return bits.length > 0 ? bits.join(' ') : undefined;
	}

	function gitSegment(): string | undefined {
		if (!gitInfo) return undefined;
		const bits = [paint('gitBranch', `⎇ ${gitInfo.branch}`)];
		if (gitInfo.ahead > 0) bits.push(paint('gitAhead', `↑${gitInfo.ahead}`));
		if (gitInfo.behind > 0) bits.push(paint('gitBehind', `↓${gitInfo.behind}`));
		if (gitInfo.staged > 0) bits.push(paint('gitStaged', `+${gitInfo.staged}`));
		if (gitInfo.modified > 0) bits.push(paint('gitModified', `~${gitInfo.modified}`));
		if (gitInfo.untracked > 0) bits.push(paint('gitUntracked', `?${gitInfo.untracked}`));
		return bits.join(' ');
	}

	function render(): void {
		if (renderBroken) return;
		try {
			const parts: string[] = [];

			const label = stringOption('label');
			if (label) parts.push(paint('label', label));

			if (boolOption('showContext')) {
				const context = contextSegment();
				if (context) parts.push(context);
			}
			if (boolOption('showModel')) parts.push(modelSegment());
			if (boolOption('showProject')) parts.push(paint('project', `${basename(cmd.cwd) || '…'} ⏱ ${elapsedLabel(Date.now() - sessionStart)}`));
			if (boolOption('showCounters')) {
				const segment = countersSegment();
				if (segment) parts.push(segment);
			}
			if (boolOption('showSkills') && skillCount > 0) parts.push(paint('skills', `✓ Skills (${skillCount})`));
			if (boolOption('showGit')) {
				const segment = gitSegment();
				if (segment) parts.push(segment);
			}
			if (boolOption('showMode') && permissionMode) parts.push(paint('mode', `⏵⏵ ${permissionMode}`));

			cmd.ui.setStatus(parts.join(stringOption('separator')));
		} catch (error) {
			// One loud failure, then stay quiet: a render bug must never thrash the host,
			// and it must never be silent either.
			renderBroken = true;
			safe(() => cmd.ui.notify(`statusline mod render failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
		}
	}

	// ── Durable counters ─────────────────────────────────────────────────────────
	function loadCounters(): void {
		const entries = safe(() => cmd.session?.getCustomEntries({customType: CUSTOM_TYPE})) ?? [];
		const data = entries[entries.length - 1]?.data as Partial<Counters> | undefined;
		counters = data
			? {
					turns: Number(data.turns) || 0,
					tools: Number(data.tools) || 0,
					toolErrors: Number(data.toolErrors) || 0,
					subagents: Number(data.subagents) || 0,
				}
			: {...EMPTY_COUNTERS};
		lastPersistedCounters = JSON.stringify(counters);
	}

	function persistCounters(): void {
		const snapshot = JSON.stringify(counters);
		if (snapshot === lastPersistedCounters) return;
		safe(() => cmd.session?.appendCustomEntry({customType: CUSTOM_TYPE, data: counters}));
		lastPersistedCounters = snapshot;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────────
	cmd.hooks({
		onSessionStart: () => {
			sessionStart = Date.now();
			renderBroken = false;
			loadCounters();
			bootstrap();
			render();
		},
		onSessionEnd: () => {
			persistCounters();
			stopTimers();
			cmd.ui.setStatus(null);
		},
	});

	// ── Events ───────────────────────────────────────────────────────────────────
	cmd.on('run_start', () => {
		active = true;
		bootstrap(); // the footer subscribes by now even if it had not at load time
		render();
	});
	cmd.on('run_end', () => {
		active = false;
		busy = false;
		stopSpin();
		persistCounters();
		render();
	});
	cmd.on('model_request_start', event => {
		if (event.type === 'model_request_start') currentModel = event.model;
		busy = true;
		startSpin();
		render();
	});
	cmd.on('model_request_end', event => {
		if (event.type === 'model_request_end') {
			currentModel = event.model;
			if (event.effort) currentEffort = event.effort;
			// The turn's real usage, kept only until the harness reports a measurement of its own.
			const measured = contextTokensFromUsage((event as unknown as {usage?: unknown}).usage);
			if (measured !== undefined) measuredContextTokens = measured;
		}
		busy = false;
		stopSpin();
		render();
		// The harness publishes context usage just after the request settles; one short
		// follow-up repaint keeps the row live without depending on that ordering.
		cancelFollowUpRepaint();
		followUpRepaint = setTimeout(() => {
			followUpRepaint = undefined;
			render();
		}, 400);
		unref(followUpRepaint);
	});
	cmd.on('config_setting_changed', () => {
		// The live model can change under us (/model, /effort). The harness getters are
		// authoritative; the event model is only a cache for the window between events.
		currentModel = safe(() => cmd.getModel?.()) ?? '';
		currentEffort = safe(() => cmd.getEffort?.()) ?? '';
		render();
	});
	cmd.on('effort_change', event => {
		if (event.type === 'effort_change') currentEffort = event.effort;
		render();
	});
	cmd.on('permission_mode_changed', event => {
		if (event.type === 'permission_mode_changed') permissionMode = event.mode;
		render();
	});
	cmd.on('compaction_done', () => {
		// The harness resets its fill after a compaction, so a figure measured before it is
		// stale: drop it and let the next turn's usage draw the new one.
		measuredContextTokens = undefined;
		render(); // context resets after a compaction
	});
	cmd.on('turn_end', () => {
		counters = {...counters, turns: counters.turns + 1};
		persistCounters();
		render();
	});
	cmd.on('tool_completed', () => {
		counters = {...counters, tools: counters.tools + 1};
		render();
	});
	cmd.on('tool_errored', () => {
		counters = {...counters, tools: counters.tools + 1, toolErrors: counters.toolErrors + 1};
		render();
	});
	cmd.on('subagent_stop', () => {
		counters = {...counters, subagents: counters.subagents + 1};
		render();
	});
	for (const event of ['interrupted', 'run_error'] as const) {
		cmd.on(event, () => {
			active = false;
			busy = false;
			stopSpin();
			render();
		});
	}

	// ── /statusline ──────────────────────────────────────────────────────────────
	function applyOption(key: string, value: string): string {
		if (BOOL_KEYS.includes(key)) {
			const normalized = value.toLowerCase();
			if (!['true', 'false', 'on', 'off'].includes(normalized)) return `Value for ${key} must be true/false (or on/off).`;
			liveOptions[key] = normalized === 'true' || normalized === 'on';
		} else if (STRING_KEYS.includes(key)) {
			if (key === 'contextStyle' && !['full', 'compact', 'tokens'].includes(value)) return 'Value for contextStyle must be full, compact or tokens.';
			liveOptions[key] = value;
		} else {
			return `Unknown statusline option '${key}'. Run /statusline for the list.`;
		}
		if (key === 'refreshSeconds') restartRefreshTimer();
		render();
		return `statusline.${key} = ${String(liveOptions[key])}`;
	}

	cmd.addCommand({
		name: MOD_ID,
		description: 'Configure the statusline (segments, style, label, save/reset/clear)',
		argumentHint: '[<key>=<value> | refresh | save | reset | clear]',
		handler: ({args}) => {
			const input = args.trim();

			if (input === '') {
				return {
					message: [
						'Statusline segments:',
						...ALL_KEYS.map(key => `  ${key} = ${String(rawOption(key) ?? DEFAULTS[key])}   (${optionSource(key)})`),
						'Set with /statusline showContext=false or /statusline label=mine.',
						'/statusline refresh · save (writes ~/.commandcode/statusline.json) · reset · clear',
					].join('\n'),
				};
			}
			if (input === 'clear') {
				cancelFollowUpRepaint(); // a pending repaint would put it straight back
				cmd.ui.setStatus(null);
				return {message: 'Statusline cleared. It returns on the next event.'};
			}
			if (input === 'refresh') {
				void refreshGit();
				void refreshSkills();
				render();
				return {message: 'Statusline refreshed.'};
			}
			if (input === 'save') {
				const result = writeConfigFile();
				return {message: result.ok ? `Saved to ${CONFIG_FILE}` : `Could not save: ${result.error}`};
			}
			if (input === 'reset') {
				liveOptions = {};
				fileOptions = {};
				const removed = safe(() => {
					unlinkSync(CONFIG_FILE);
					return true;
				});
				render();
				return {message: removed ? 'Reset to defaults (config file removed).' : 'Reset to defaults.'};
			}

			const [rawKey, ...rest] = input.split(/[\s=]+/);
			return {message: applyOption(rawKey.replace(/^--?/, ''), rest.join(' ').trim())};
		},
	});

	// ── Initial paint ────────────────────────────────────────────────────────────
	// Factory time runs before the session binds, so this paints what does not need a
	// session (model/effort from the harness, project, flags) right away, and asks for the
	// shell-backed segments. A host whose footer has not subscribed yet gets them from
	// bootstrap() on session start or the first run.
	bootstrap();
	render();
}

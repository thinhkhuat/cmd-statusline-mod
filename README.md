# cmd-statusline-mod

A **Command Code** mod that renders one persistent footer segment under the input panel:
live context-window usage, model + reasoning effort, project + elapsed time, session
counters, loaded-skills count, git status, and the permission mode.

```
■■□□□□□□□□ 18% (181.2k/1M) · [deepseek-v4.1-flash ◑ high] · MY-WORKBENCH ⏱ 24m · ✗1 ⚙38 ↻12 · ✓ Skills (786) · ⎇ main +2 ~1 ?3 · ⏵⏵ bypass
```

Every value is real: context comes from the harness's own measurement
(`cmd.getContextUsage()`), falling back to the turn's reported usage where the harness reports
none; the rest from the harness API or a shell command the mod runs.

This is the Command Code sibling of `mods-dev/prompt-enhancer` (a Claude Code plugin). All
Command Code mod work lives here under `mods-dev/` with a `cmd-*` prefix.

Repository: <https://github.com/thinhkhuat/cmd-statusline-mod>

## Install

**Package route — the live one.** Installed once, then upgrades come from the repo:

```bash
cmd mods add -g thinhkhuat/cmd-statusline-mod    # -g = user scope; clones into mods/.registry/git/…
cmd mods update                                  # pulls the pushed revision
```

`cmd mods list` then reports `statusline · user · from git:github.com/thinhkhuat/cmd-statusline-mod`.
After an update, `/reload` a running session (mods load once per process).

**Release path.** Change it here → `node --test test/statusline.test.mjs` → commit and push →
`cmd mods update` → `/reload`. `cmd mods update` is the only step that touches the checkout.

**Drop-in route** (the manual alternative, still supported):

```bash
./install.sh              # backups, copies, runs the test suite, lists the mod
```

or by hand:

```bash
cp statusline.ts ~/.commandcode/mods/statusline.ts
mkdir -p ~/.commandcode/mods/.statusline-tests
cp test/statusline.test.mjs ~/.commandcode/mods/.statusline-tests/
```

> Do not run both routes at once. Both are named `statusline` and the first one found wins, so
> the package's copy is skipped — `cmd mods list` says so under `Warnings`, naming the losing
> path and `duplicate mod name "statusline" — first one wins`, and the source itself reports
> `installed, but provides no mods`. Remove the drop-in file before switching:
> `rm ~/.commandcode/mods/statusline.ts`.

`package.json` is marked `"private": true` so an accidental `npm publish` cannot ship it.
Publishing to npm (for the bare-name `cmd mods add cmd-statusline-mod` route) means flipping
that flag and adding a `repository` URL; the local-path and GitHub routes need neither.

### Why the test dir is hidden

Command Code scans `~/.commandcode/mods/` for `.ts|.js|.mts|.mjs` (`hx` in the CLI bundle) via
`scanModsDir`, which skips any entry whose name starts with `.` and never recurses into it. A
*visible* subdirectory is not read for loose files either — it is resolved as a package
(`package.json` → `commandcode.mods`, then `<dir>/mods/`, then `index.*`), so a stray `.mjs`
there would not load today. The dot-prefixed dir is kept anyway: it is the documented skip,
and it removes the question entirely. Corroboration: the deployed dir holds three mod files
plus the hidden test dir, and `cmd mods list` reports exactly three mods.

## Configure

Layers, later wins:

1. built-in defaults (below)
2. `~/.commandcode/statusline.json` — written by `/statusline save`
3. `--mod-option statusline.<key>=<value>` — per launch
4. `/statusline <key>=<value>` — that session only

| Key | Type | Default | Meaning |
|---|---|---|---|
| `showContext` | bool | `true` | context-fill segment |
| `contextStyle` | string | `full` | `full` — bar + % + `(used/window)` · `compact` — bar + % · `tokens` — `used/window` |
| `showModel` | bool | `true` | model + effort + activity spinner |
| `showProject` | bool | `true` | project (cwd basename) + elapsed time |
| `showCounters` | bool | `true` | tools / errors / subagents / turns, this session |
| `showSkills` | bool | `true` | skills the harness loads |
| `showGit` | bool | `true` | branch, ahead/behind, staged/modified/untracked |
| `showMode` | bool | `true` | permission-mode indicator |
| `refreshSeconds` | string | `5` | staleness bound for the git refresh (a live change restarts the timer) |
| `label` | string | `''` | optional prefix segment (profile name) |
| `separator` | string | ` · ` | segment separator (ANSI allowed) |

Commands: `/statusline` (list, with the source of each value) · `/statusline key=value` ·
`/statusline refresh` · `/statusline save` · `/statusline reset` · `/statusline clear`.

Set an env override for the config path (tests, or a second profile):

```bash
COMMANDCODE_STATUSLINE_CONFIG=/tmp/other.json cmd
```

## Context segment

`cmd.getContextUsage()` returns `{tokens, contextWindow, percent}` for the bound session —
the harness's own measurement, wrapped in the CLI bundle as
`getContextUsage: () => ({tokens: current > 0 ? current : null, contextWindow: limit, percent: ...})`.

It is starved on Command Code 1.82.3, so the segment has a second source. In order:

1. **the harness getter** above — authoritative whenever it reports a measurement;
2. **the turn's own usage** — the `model_request_end` event's
   `usage.inputTokens + usage.outputTokens`: the whole prompt that was sent plus what that turn
   appended, which is the quantity the harness's own compaction logic builds.

Source 2 exists because source 1 was measured answering `{tokens: null, contextWindow: 1000000,
percent: null}` at **every** lifecycle point — load, session start, run start, request start,
request end, turn end, run end — across `deepseek-v4.1-flash`, `claude-haiku-5-5` and
`google/gemini-3.8-flash`, including the turn whose usage reported 67,717 input tokens. With
source 1 alone the segment drew `—` forever. Full evidence in `docs/investigation.md`.

`■■□□□□□□□□ 18% (181.2k/1M)` — ten cells, rounded to the nearest cell, then the rounded
percentage, then used/window in parentheses. Token counts carry one decimal where there is
one: `120k`, `181.2k`, `1M`, `1.1M`. (The host's own formatter keeps a trailing `.0`; this
one trims it, so `120000` reads `120k` rather than `120.0k`.)

- `—` appears only when **neither** source has a measurement: an empty bar and an em dash,
  `□□□□□□□□□□ — (—/1M)`, never a misleading `0%`. A `0%` that arrives *with* a token count is
  a real rounded measurement and is shown as such.
- A figure measured before a `/compact` is dropped on `compaction_done`: the harness resets its
  fill there, so keeping the old number would draw a stale bar.
- Tone follows the host's own thresholds: green under 50%, yellow at 50%, red at 80%.
- No hardcoded model→window table and no token accumulation: both are proxies that go wrong
  silently. (The previous revision of this mod did exactly that, then dropped the segment
  entirely — see `docs/investigation.md`.)

## Colour

One hue per section, every one a **theme-defined ANSI slot** — never a hardcoded RGB. A fixed hex
holds one background mode and breaks the other; a theme slot is re-tuned by the terminal for its
own light or dark palette, which is the only way the row adapts to *any* terminal.

| Section | Colour | Slot |
|---|---|---|
| context fill | green, yellow at 50%, red at 80% · white when unmeasured | 32 / 33 / 31 / 37 |
| model + effort | blue | 34 |
| project + elapsed | purple | 35 |
| counters (tools, subagents, turns) | cyan · the error count red | 36 / 31 |
| skills | green | 32 |
| git | branch blue · ahead/staged green · behind/modified yellow · untracked cyan | 34 / 32 / 33 / 36 |
| permission mode | yellow | 33 |
| label | white | 37 |

`dim` (ANSI 2) and `brightBlack` are gone: both cut the contrast headroom the theme gave the text,
and a uniformly muted row was the complaint. Colour is never the only cue — every section keeps its
own glyph and words, so the row still reads with colour off (WCAG 1.4.1).

**The limit, measured.** `tools/check-contrast.mjs` scores the palette against 811 real terminal
themes. No set of distinct ANSI hues clears WCAG 1.4.3's 4.5:1 on every theme: the best any slot
manages on *both* modes is blue 69%, purple 69%, red 65%, while cyan, green, yellow and white are
dark-mode specialists. The palette therefore maximises the weaker mode, and the residual belongs
to the theme, not the mod. Re-run the check after any colour change.

**It will not match `/context`, and the segment is the one to trust.** The harness's own `/context`
panel reports a different quantity: a sum of the component rows it tracks, printed with an
`(estimated)` label. Measured on one session, the segment read `40% (401.8k/1M)` while the panel read
`294.3k / 1M … (estimated)` — the panel has no row for the base system prompt or for MCP tool schemas,
and its `Messages` row counts user and assistant text without the tool-result payloads that dominate an
agentic context. The segment instead shows the provider's own count of the prompt it was sent (the
`usage.inputTokens` the harness's compaction gate is itself computed from), so it is the number tied to
the model's real window.

## Verify

```bash
node --test test/statusline.test.mjs     # 74 tests, no network, no real config touched
node tools/check-contrast.mjs            # the palette against 811 real themes; no network
cmd mods list                            # registered, no load warnings
cmd -p "Reply with exactly: ok"          # loads in a session and exits cleanly (no hang)
./tools/check-live-footer.sh             # drives the real TUI through a pty; spends one model call
```

The suite drives the real mod file through Node's TypeScript stripping with a fake `ModApi`
that records every call the mod makes to the host: 74 cases covering each segment, the
switch and precedence layers, the failure paths and the repaint triggers. `STATUSLINE_MOD=<path>`
points it at a mutant for mutation testing. Nineteen seeded defects were each caught:

| Seeded defect | Caught by |
|---|---|
| context segment disabled | 10 tests |
| flag declares a default (masking the config file) | 4 tests |
| timers left referenced | the run hangs on the `unref` assertion |
| tone colour flattened | the bar's own colour assertion |
| non-zero exit trusted | `does not trust output from a command that failed` |
| broken render swallowed silently | `notices a broken render once` |
| counters persisted per tool call | `persists once per turn` |
| `null` tokens rendered as `0%` | `never shows a misleading 0%` |
| `on`/`off` rejected | `turns each segment off and on again` |
| `refreshSeconds` ignored | `reconfigures the running refresh interval` |
| `compaction_done` repaint deleted | `repaints the context after a compaction resets it` |
| context segment never hidden | `hides the whole segment when the harness reports nothing` |
| live `refreshSeconds` does not restart the timer | `reconfigures the running refresh interval` |
| pending repaint not cancelled on clear | `does not let a pending repaint resurrect a cleared status` |
| `config_setting_changed` resync deleted | `resyncs to the harness when the session config changes the model` |
| a starved context getter left unhandled (the live incident) | `draws a figure from the turn usage when the harness reports no measurement` |
| a 0/0 turn usage treated as a measurement | `ignores a turn usage carrying no tokens, which is not a measurement` |
| the turn usage preferred over the harness measurement | `prefers the harness measurement over the turn usage when both exist` |
| a pre-compaction figure kept across the reset | `drops the stale figure when a compaction resets the fill` |

Nine colour tests were written before the palette existed and watched fail first — eight red, one
already green. The four contrast gates in `tools/check-contrast.mjs` were each proven to bite on
their own mutant: an identity slot swapped to an unbalanced hue, a faint slot smuggled back in,
and state parity broken. The skills-deduplication pair was likewise red first, against a fixture
that lists one skill under two roots — the shape this machine actually produces.

## Layout

```
statusline.ts                     the mod — the file Command Code loads
test/statusline.test.mjs          the suite (the drop-in route also copies it to .statusline-tests/)
tools/probe-modapi.ts             probe used to confirm the live ModApi shape
tools/probe-commands.ts           probe used to confirm the slash command registered
tools/probe-context.ts            probe that recorded the starved context seam (see below)
tools/check-live-footer.sh        drives the real TUI through a pty and reads the footer it renders
tools/check-contrast.mjs          scores the colour palette against real terminal themes
tools/palettes.json               811 terminal themes (MIT) that the contrast check reads
docs/investigation.md             root cause, the evidence trail, and the review round
install.sh                        drop-in route: backup → copy → test → list
archive/                          superseded revisions (gitignored)
package.json                      manifest for the cmd mods add route
```

The probes print to `$PROBE_LOG` (default `/tmp/cmd-probe.log`) and are run like:

```bash
PROBE_LOG=/tmp/probe.log cmd -p --mod tools/probe-modapi.ts "Reply with exactly: ok"
```

`statusline.ts` here is the **source of truth**. The live copy is the registry checkout at
`~/.commandcode/mods/.registry/git/github.com/thinhkhuat/cmd-statusline-mod/`, installed with
`cmd mods add -g` and refreshed with `cmd mods update`. Never edit either copy in place.

## Limits

- `cmd.ui.setStatus` collapses newlines, tabs and runs of spaces to one space: the statusline
  is one line, so the multi-line layouts a Claude Code HUD can draw are not reachable through
  this seam.
- `cmd.ui.widget` exists but renders nowhere in the TUI (wire-up pending); this mod does not
  use it.
- Headless (`-p`) renders no status segment, so the mod spawns no subprocess there. The gate is
  the host's live `capabilities.status`, which turns true when the footer subscribes — the mod
  re-checks it at load, session start and first run, so a late subscription still gets its git
  and skills segments and its refresh timer. Every timer is `unref`'d, so a print run exits.
- `--mod-option statusline.<bool>=on` does **not** work: the host coerces a `--mod-option`
  value with `"true" === value`, so only `true`/`false` reach a boolean flag. `/statusline
  key=on` does accept `on`/`off`.
- The permission-mode segment appears only after the first `permission_mode_changed` event;
  the API has no getter for the current mode, so a resumed session that is already in
  plan/bypass mode shows nothing until the mode changes.
- The skills count comes from a separate `cmd skills list` process — a disk view, refreshed at
  load, session start and `/statusline refresh`. It cannot see session-scoped skill paths and
  does not track skills added mid-session. It counts each skill **once**, however many roots reach
  it: the loader lists a skill per root, so its section headers summed to 792 on a machine holding
  399 distinct skills, which is the inflated number the segment used to report.
- Command Code's **built-in** context indicator behaves differently: below 70% usage it shows
  nothing at all, unless more than ~180k tokens are in context, in which case it shows a
  `~N tokens in context · try /compact` nudge. The mod's segment is independent of it and
  draws at every level.

# cmd-statusline-mod

A **Command Code** mod that renders one persistent footer segment under the input panel:
live context-window usage, model + reasoning effort, project + elapsed time, session
counters, loaded-skills count, git status, and the permission mode.

```
■■□□□□□□□□ 18% (181.2k/1M) · [deepseek-v4.1-flash ◑ high] · MY-WORKBENCH ⏱ 24m · ⚙38 ✗1 ↻12 · ✓ Skills (786) · ⎇ main +2 ~1 ?3 · ⏵⏵ bypass
```

Every value is real: context comes from the harness's own measurement
(`cmd.getContextUsage()`), the rest from the harness API or a shell command the mod runs.

This is the Command Code sibling of `mods-dev/prompt-enhancer` (a Claude Code plugin). All
Command Code mod work lives here under `mods-dev/` with a `cmd-*` prefix.

## Install

**Drop-in (what is live today, verified):**

```bash
./install.sh              # backups, copies, runs the test suite, lists the mod
```

By hand:

```bash
cp statusline.ts ~/.commandcode/mods/statusline.ts
mkdir -p ~/.commandcode/mods/.statusline-tests
cp test/statusline.test.mjs ~/.commandcode/mods/.statusline-tests/
cmd mods list             # must list statusline · user, with no load warning
```

Then `/reload` inside a running session (mods load once per process), or start `cmd` fresh.

**Package route** (`cmd mods add`), once you publish this repo:

```bash
cmd mods add -g ./mods-dev/cmd-statusline-mod   # local path, referenced in place; -g = user scope
cmd mods add -g thinhkhuat/cmd-statusline-mod   # GitHub shorthand (owner/repo)
```

> Do not run both routes at once. Both would be named `statusline`, and the host drops the
> second one — silently as far as `cmd mods list` is concerned, because the "duplicate mod
> name" line it writes goes to the debug log, not to that output. So remove the drop-in file
> first: `rm ~/.commandcode/mods/statusline.ts`.

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

`■■□□□□□□□□ 18% (181.2k/1M)` — ten cells, rounded to the nearest cell, then the rounded
percentage, then used/window in parentheses. Token counts carry one decimal where there is
one: `120k`, `181.2k`, `1M`, `1.1M`. (The host's own formatter keeps a trailing `.0`; this
one trims it, so `120000` reads `120k` rather than `120.0k`.)

- `tokens`/`percent` are `null` until a model call has measured the window; the segment then
  renders `□□□□□□□□□□ — (—/1M)` — an empty bar and an em dash, never a misleading `0%`. A
  `0%` that arrives *with* a token count is a real rounded measurement and is shown as such.
- Tone follows the host's own thresholds: green under 50%, yellow at 50%, red at 80%.
- No hardcoded model→window table and no token accumulation: both are proxies that go wrong
  silently. (The previous revision of this mod did exactly that, then dropped the segment
  entirely — see `docs/investigation.md`.)

## Verify

```bash
node --test test/statusline.test.mjs     # 58 tests, no network, no real config touched
cmd mods list                            # registered, no load warnings
cmd -p "Reply with exactly: ok"          # loads in a session and exits cleanly (no hang)
```

The suite drives the real mod file through Node's TypeScript stripping with a fake `ModApi`
that records every call the mod makes to the host: 58 cases covering each segment, the
switch and precedence layers, the failure paths and the repaint triggers. `STATUSLINE_MOD=<path>`
points it at a mutant for mutation testing. Fifteen seeded defects were each caught:

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

## Layout

```
statusline.ts                     the mod — the file Command Code loads
test/statusline.test.mjs          the suite (also installed to .statusline-tests/)
tools/probe-modapi.ts             probe used to confirm the live ModApi shape
tools/probe-commands.ts           probe used to confirm the slash command registered
docs/investigation.md             root cause, the evidence trail, and the review round
install.sh                        backup → copy → test → list
archive/                          superseded revisions (gitignored)
package.json                      manifest for the cmd mods add route
```

Both probes print to `$PROBE_LOG` (default `/tmp/cmd-probe.log`) and are run like:

```bash
PROBE_LOG=/tmp/probe.log cmd -p --mod tools/probe-modapi.ts "Reply with exactly: ok"
```

`statusline.ts` here is the **source of truth**; `~/.commandcode/mods/statusline.ts` is the
deployed copy. Change it here, run the suite, then re-run `install.sh` — never edit the
deployed copy in place.

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
  does not track skills added mid-session.
- Command Code's **built-in** context indicator behaves differently: below 70% usage it shows
  nothing at all, unless more than ~180k tokens are in context, in which case it shows a
  `~N tokens in context · try /compact` nudge. The mod's segment is independent of it and
  draws at every level.

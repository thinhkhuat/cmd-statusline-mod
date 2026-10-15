# cmd-statusline-mod

A **Command Code** mod that renders one persistent footer segment under the input panel:
live context-window usage, model + reasoning effort, project + elapsed time, session
counters, loaded-skills count, git status, and the permission mode.

```
■□□□□□□□□□ 12% · 120k/1M · [deepseek-v4.1-flash ◑ high] · MY-WORKBENCH ⏱ 24m · ⚙38 ✗1 ↻12 · ✓ Skills (786) · ⎇ main +2 ~1 ?3 · ⏵⏵ bypass
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
cmd mods add ./mods-dev/cmd-statusline-mod --scope user   # local, referenced in place
cmd mods add thinhkhuat/cmd-statusline-mod               # after it is on GitHub
```

> Do not run both routes at once: the drop-in file and the package would both be named
> `statusline`, and a duplicate name means one of them is skipped with a load warning.
> Remove the drop-in file (`rm ~/.commandcode/mods/statusline.ts`) before switching.

`package.json` is marked `"private": true` so an accidental `npm publish` cannot ship it.
Publishing to npm (for the bare-name `cmd mods add cmd-statusline-mod` route) means flipping
that flag and adding a `repository` URL; the local-path and GitHub routes need neither.

### Why the test dir is hidden

Command Code scans `~/.commandcode/mods/` for `.ts|.js|.mts|.mjs` and **recurses into visible
subdirectories** (`scanModsDir` in the CLI bundle). A visible `statusline-tests/` folder would
get its `.mjs` loaded as a second mod. Entries starting with `.` are skipped and never
recursed into, so the suite lives in `.statusline-tests/`.

## Configure

Layers, later wins:

1. built-in defaults (below)
2. `~/.commandcode/statusline.json` — written by `/statusline save`
3. `--mod-option statusline.<key>=<value>` — per launch
4. `/statusline <key>=<value>` — that session only

| Key | Type | Default | Meaning |
|---|---|---|---|
| `showContext` | bool | `true` | context-fill segment |
| `contextStyle` | string | `full` | `full` (bar + % + tokens/window) · `compact` (bar + %) · `tokens` (used/window) |
| `showModel` | bool | `true` | model + effort + activity spinner |
| `showProject` | bool | `true` | project (cwd basename) + elapsed time |
| `showCounters` | bool | `true` | tools / errors / subagents / turns, this session |
| `showSkills` | bool | `true` | skills the harness actually loads |
| `showGit` | bool | `true` | branch, ahead/behind, staged/modified/untracked |
| `showMode` | bool | `true` | permission-mode indicator |
| `refreshSeconds` | string | `5` | staleness bound for the git refresh |
| `label` | string | `''` | optional prefix segment (profile name) |
| `separator` | string | ` · ` | segment separator (ANSI allowed) |

Commands: `/statusline` (list, with the source of each value) · `/statusline key=value` ·
`/statusline refresh` · `/statusline save` · `/statusline reset` · `/statusline clear`.
Booleans accept `true/false/on/off`.

Set an env override for the config path (tests, or a second profile):

```bash
COMMANDCODE_STATUSLINE_CONFIG=/tmp/other.json cmd
```

## Context segment

`cmd.getContextUsage()` returns `{tokens, contextWindow, percent}` for the bound session —
the harness's own measurement, wrapped in the CLI bundle as
`getContextUsage: () => ({tokens: current > 0 ? current : null, contextWindow: limit, percent: ...})`.

- `tokens`/`percent` are `null` until a model call has measured the window. The segment then
  renders an empty bar and `—`, never a misleading `0%`.
- Tone follows the host's own thresholds: green under 50%, yellow at 50%, red at 80%.
- No hardcoded model→window table and no token accumulation: both are proxies that go wrong
  silently. (The previous revision of this mod did exactly that, then dropped the segment
  entirely — see `docs/investigation.md`.)

## Verify

```bash
node --test test/statusline.test.mjs     # 49 tests, no network, no real config touched
cmd mods list                            # registered, no load warnings
cmd -p "Reply with exactly: ok"          # loads in a session and exits cleanly (no hang)
```

The suite drives the real mod file through Node's TypeScript stripping with a fake `ModApi`
that records every call the mod makes to the host, so each segment, switch, precedence rule
and failure path is asserted by name. `STATUSLINE_MOD=<path>` points it at a mutant for
mutation testing — all eight seeded defects (segment disabled, seeded flag default, timers
left referenced, flattened tones, non-zero exit trusted, silent render failure, counters
persisted per tool call, `null` rendered as `0%`) fail the suite.

## Layout

```
statusline.ts                     the mod — the file Command Code loads
test/statusline.test.mjs          the suite (also installed to .statusline-tests/)
tools/probe-modapi.ts             probe used to confirm the live ModApi shape
docs/investigation.md             root cause and the evidence trail
install.sh                        backup → copy → test → list
archive/                          superseded revisions (gitignored)
package.json                      manifest for the cmd mods add route
```

`statusline.ts` here is the **source of truth**; `~/.commandcode/mods/statusline.ts` is the
deployed copy. Change it here, run the suite, then re-run `install.sh` — never edit the
deployed copy in place.

## Limits

- `cmd.ui.setStatus` collapses newlines and tabs to spaces: the statusline is one line, so
  the multi-line layouts a Claude Code HUD can draw are not reachable through this seam.
- `cmd.ui.widget` exists but renders nowhere in the TUI (wire-up pending); this mod does not
  use it.
- Headless (`-p`) renders no status segment, so the mod skips its shell refreshes there. Its
  timers are `unref`'d, so a print run always exits on its own.
- Command Code's **built-in** context indicator appears only at 70% usage or above
  (`projectContextIndicator` returns `hidden` below that). This mod's segment shows at every
  level; the two are independent.
- The skills count shells out to `cmd skills list`, so it reflects the loader's own numbers
  and can lag the session by one load order change.

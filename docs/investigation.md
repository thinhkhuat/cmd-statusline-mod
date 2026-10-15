# Investigation — why the context segment disappeared, and what replaced it

## Symptom

The footer segment under the input panel kept showing the skills count, the model + effort
and the project name, but the context-window display was gone.

## Root cause

`~/.commandcode/mods/statusline.ts` (the deployed copy, dated 2026-08-22 23:46) had **no
context segment at all**. An earlier revision of the same day computed one from a hardcoded
`MODEL_CONTEXT` model→window table plus accumulated input tokens, with the comment:

```
// Context usage: total input tokens consumed so far this session vs the model's
// advertised context window. This is a best-effort proxy (the model's real context
// budget includes output tokens and any reserved headroom).
```

The revision that dropped it rewrote the file header to "only real, verifiable data — no
fabricated or proxied values" and removed the proxy — correctly, but it never replaced it
with the real API, which exists in the installed build.

Four superseded revisions of that file are preserved in the CLI's own history store, under
`~/.commandcode/file-history/f60299ce-ad83-4d63-8b0e-91f599b96cce/`. Three of them carry the
old `MODEL_CONTEXT` proxy table — `8673654f…` (22:39), `0ff0a478…` (22:42) and `8605ad4b…`
(22:49) — and `361995b6…` (23:32) already has none, which places the removal between 22:49 and
23:32. The deployed file's own mtime read `Aug 22 23:46` in `ls -la ~/.commandcode/mods` before
the fix; that timestamp is no longer reproducible now that the file has been replaced, so it is
recorded as an observation, not as evidence.

## The real API

`reference/api.md` (bundled with Command Code) documents:

| Method | Signature |
|---|---|
| `cmd.getContextUsage` | `() => {tokens, contextWindow, percent} \| undefined` |

"It returns `{tokens, contextWindow, percent}` for the bound session: `tokens` and `percent`
are `null` until the first model call has measured the window (never a misleading 0%)."

The implementation in the installed bundle (`dist/cli.mjs`) wraps the harness state:

```js
getContextUsage: () => {
  const e = A?.getContextUsage?.();
  if (!e) return;
  const n = e.current > 0;
  return {tokens: n ? e.current : null, contextWindow: e.limit,
          percent: n && e.limit > 0 ? Math.round(e.current / e.limit * 100) : null};
}
```

with `contextUsage: {current: contextTokens, limit: contextLimit}` as the underlying state, and
tone thresholds that the host itself uses (`getContextUsageTone`): `>=80` danger, `>=50`
warning.

## Proof the API is live in this build

`tools/probe-modapi.ts` was loaded alongside the mod in a real headless run
(`cmd -p --mod probe.ts --mod statusline.ts "Reply with exactly: ok"`, exit 0):

```
session_start       {"model":"deepseek/deepseek-v4.1-flash","effort":"high","ctx":{"tokens":null,"contextWindow":1000000,"percent":null}}
run_start           {"model":"deepseek/deepseek-v4.1-flash","effort":"high","ctx":{"tokens":null,"contextWindow":1000000,"percent":null}}
model_request_end   {"model":"deepseek/deepseek-v4.1-flash","effort":"high","ctx":{"tokens":null,"contextWindow":1000000,"percent":null}}
run_end             {"model":"deepseek/deepseek-v4.1-flash","effort":"high","ctx":{"tokens":null,"contextWindow":1000000,"percent":null}}
```

So `contextWindow` is real (1,000,000 for that model) and `tokens` is `null` before a
measurement — which is exactly the case the segment must render as `—`, not `0%`.

Also visible in the same run: `cmd.getModel()` / `cmd.getEffort()` report the live session
values, which is why the mod no longer reads `~/.commandcode/config.json` to seed them.

## Proof the `/statusline` command registered

`cmd.getCommands()` returns every slash command mods registered on the host. A second probe
(`tools/probe-commands.ts`) logged it in a real headless run:

```
commands {"total":5,"mods":["acp","herdr","mnemosyne-bridge","peek","statusline"],
          "statusline":[{"name":"statusline",
                         "description":"Configure the statusline (segments, style, label, save/reset/clear)",
                         "mod":"statusline"}]}
```

So the command is registered by this mod on a live host, and no built-in shadows the name
(grepping the CLI bundle for `statusline` finds only internal helpers — `statusLinePath`,
`meaningfulStatusLines` — never a command registration).

A note on method: `cmd -p "/statusline"` prints the *model's answer*, not the command's
output — print mode does not dispatch slash commands, and the model cannot see mod-registered
commands, so it will confidently deny that `/statusline` exists. Use `cmd.getCommands()` to
check registration, and the interactive TUI to exercise it.

## Rival explanation, checked and kept

Command Code's **built-in** context indicator is gated: `projectContextIndicator` returns
`{kind: "hidden"}` while the session is under 70% used and the mod's own segment was the only
one that drew at low usage. Both facts are true; the mod's segment is the fix either way.

## Why the old proxy had to go

- A hardcoded model→window table silently returns nothing for any model it does not list, and
  a wrong window renders a wrong percentage with no error.
- Accumulating input tokens across requests is not context fill: it counts re-sent prefixes
  repeatedly.

Both failure modes are invisible on screen, which is the worst property a status line can have.

## Verification of the replacement

- 58 tests (`test/statusline.test.mjs`) drive the real mod through a fake `ModApi`, asserting
  each segment, switch, precedence layer, failure path and repaint trigger by name.
- Mutation check: fifteen seeded defects, each caught — see the table in `README.md`.
- Host-level checks: `cmd mods list` lists `statusline · user` with no warning; a headless run
  exits 0 without hanging; `cmd.getCommands()` reports the slash command registered by
  `mod:"statusline"`.

## Independent review round (2026-10-15)

A blind reviewer (no involvement in the build) was pointed at the repo with instructions to
falsify every claim and to seed its own mutants. It ran 12 more mutants and reported 16 defects.
What it proved, and what changed as a result:

**Escaping mutants — the suite was weaker than the README said.** Four documented behaviours
could be broken with a green board: `on`/`off` acceptance, the refresh period, the
`compaction_done` repaint, and the context segment failing to hide. Two causes: the fake host
failed `git` by default, so the one assertion that would have noticed a broken `on/off` had
nothing to match; and the "hides the segment" test asserted the absence of bar glyphs rather
than the absence of the segment. The tone test was also catching its mutant off the green
`✓ Skills` segment instead of the bar. Fixed: the fixture now renders a git segment, the
hiding test asserts on structure, the tone assertions anchor to `\u001b[3Nm■`, and four new
tests cover the escapees. Re-run: all fifteen mutants now fail the suite.

**Real defects fixed.**

| Defect | Consequence | Fix |
|---|---|---|
| `capabilities.status` read only at load and session start | if the footer had not subscribed yet, git + skills never appeared and the refresh timer never started, for the whole session | `bootstrap()` latches on the first moment the flag is true — load, session start, or first run |
| the 400 ms follow-up repaint was never cancelled | `/statusline clear` and session end were both undone 400 ms later | the handle is kept and cleared by `stopTimers()` and by the clear path |
| a live `refreshSeconds` change did not reach the running interval | the reported new value had no effect until the next session | `restartRefreshTimer()` on that key |
| `currentModel` cached forever | the badge kept the previous model after a `/model` switch | `config_setting_changed` resyncs both getters |
| `formatTokens` disagreed with the host formatter while the test claimed parity | the suite asserted a false claim | reformatted to the requested style and the test renamed to state the actual rule |

**Claims the reviewer refuted, corrected in these docs.** `cmd mods add --scope user` does not
exist (it is `-g`); the stated reason for the hidden test dir was wrong (a visible subdirectory
is resolved as a package, not scanned for loose files — the dot dir is still the documented
skip); the built-in indicator is not simply off below 70%, it turns into a `/compact` nudge past
~180k tokens; the sample line used the wrong glyphs for the bar; and the history note counted
two context-bearing revisions where there are three.

One of the reviewer's own findings was then refuted by observation: it read the duplicate-name
path as reaching only the debug log, so a collision would be silent to `cmd mods list`. With
both routes installed, that command printed a `Warnings (1)` section naming the losing path and
`duplicate mod name "statusline" — first one wins`, plus `installed, but provides no mods` on the
source. Reading the code lost to running it, and the docs now say what the command prints.

## Install route: package, not drop-in (2026-10-15)

Chosen so upgrades come from the repo instead of a manual copy. `cmd mods add -g
thinhkhuat/cmd-statusline-mod` clones into `~/.commandcode/mods/.registry/git/github.com/
thinhkhuat/cmd-statusline-mod` and records `mods.sources: ["thinhkhuat/cmd-statusline-mod"]` in
`~/.commandcode/settings.json`; from then on `cmd mods update` pulls the pushed revision.

Order of operations mattered: the package was added **before** the drop-in was retired, so the
statusline never went dark, and only one of the two ever wins the name. The retired drop-in and
its `statusline.ts.bak-*` files are archived at `~/_ARCHIVE/cmd-statusline-drop-in/`; the
installed suite moved to the repo, and `install.sh` remains for anyone who wants the drop-in
route back.

**Deliberately unchanged.** The permission-mode segment is still absent until the first
`permission_mode_changed` event: the API exposes no getter for the current mode, so seeding it
would mean guessing. It is documented as a limit instead.

## The context figure never arrived (2026-10-15, live)

The restored segment shipped drawing `□□□□□□□□□□ — (—/1M)` and stayed there. Reported from the
live TUI footer after three turns and seven tool calls — the other segments were live, so the
render path was never in doubt: `—` is what the mod renders when the harness reports no
measurement, and the harness was reporting none.

### What was measured

A probe mod loaded beside the real one in a real session (`tools/probe-context.ts`; rerun it
with `PROBE_LOG=/tmp/probe.log cmd -p --mod tools/probe-context.ts --mod statusline.ts "Reply
with exactly: ok"`) recorded `cmd.getContextUsage()` at every lifecycle point. It answered

```
{tokens: null, contextWindow: 1000000, percent: null}
```

at `probe_load` (`undefined`, pre-bind), `session_start`, `run_start`, `model_request_start`,
`model_request_end`, `turn_end` and `run_end` — on `deepseek/deepseek-v4.1-flash`,
`claude-haiku-5-5` and `google/gemini-3.8-flash`. Not provider-specific, and not a timing race:
the follow-up repaint fires 400 ms after the request settles and still saw `null`.

The measurement existed anyway. The same run logged the turn's own usage:

```
event_model_request_end {"keys":["effort","model","stopReason","type","usage"],
  "usage":{"inputTokens":67717,"outputTokens":2,"cacheReadTokens":44544,"cacheWriteTokens":0}}
hook_onTurnEnd {"usage":{…same…},"messageCount":2,"roles":["user","assistant"],
  "ctx":{"tokens":null,"contextWindow":1000000,"percent":null}}
```

`onTurnEnd({state, usage})` is the hook the harness's own context tracker consumes, and it
received 67,717 input tokens while the mod-facing getter answered `null` in the same breath. The
number was inside the harness and never reached the documented seam.

### Root cause

Read from `dist/cli.mjs` (1.82.3, the latest published — `updates.json` reports nothing pending):

- the mod-facing wrapper maps a non-positive `current` to `tokens: null` —
  `getContextUsage: () => { const e = A?.getContextUsage?.(); const n = e.current > 0; return {tokens: n ? e.current : null, contextWindow: e.limit, …}; }`
  — deliberately, so a missing measurement never renders a misleading `0%`;
- the harness side of it is
  `Xt = () => ({current: It.getContextTokens({state: Kt, messages: Kt.messages}), limit: _.getContextLimit({model: G()})})`,
  and `getContextTokens` reads a mod-state value that the built-in tracker
  (`id: "compaction"`) writes in its own `onTurnEnd`.

So the documented getter is starved in this build while the number is available on the event.
**The mod was faithful: it drew exactly what the API reported.**

### Fix

`model_request_end`'s `usage` is now the stand-in — `usage.inputTokens + usage.outputTokens`, the
prompt that was sent plus what that turn appended, which is the quantity the harness's own
compaction logic builds. The harness getter still wins whenever it reports a measurement, and a
figure measured before a compaction is dropped on `compaction_done`, because the harness resets
its fill there and the old number would draw a stale bar.

Four tests pin it, each proven to bite on its own seeded mutant: the starved getter itself, a
`0/0` usage treated as a measurement, the precedence reversed, and the pre-compaction figure
kept. Suite 58 → 63.

### Proven live

Driving the real TUI through a pty (`tools/check-live-footer.sh`) shows the same footer either
side of one turn:

```
□□□□□□□□□□ — (—/1M) · [deepseek-v4.1-flash ◐ high] · MY-WORKBENCH ⏱ 19s
■□□□□□□□□□ 7% (69.9k/1M) · [deepseek-v4.1-flash · high] · MY-WORKBENCH ⏱ 24s
```

The measured figure holds across every redraw after it. Before the fix, the first line was the
only thing the segment ever drew — 63 unit tests and a clean headless run both said the mod was
fine, which is exactly why the footer itself had to be read.

### A mod's `onTurnEnd` hook fails a headless run

`onTurnEnd({state, usage})` carries the same usage, so it looked like the seam to use. It is
not: on 1.82.3, registering an `onTurnEnd` hook at all makes a headless print run die with

```
Error: Cannot read properties of undefined (reading 'messages')
```

and exit 1 — the harness's turn-end path then reads a `state` that headless never binds.
Bisected with three throwaway probes, each run in a real session: an empty mod (exit 0), an
events-only mod (exit 0), and a hook-only mod whose handler guards `state` throughout (exit 1).
So it is the registration, not the handler, and it is not this mod's bug — `statusline.ts`
registers only `onSessionStart` / `onSessionEnd` and reads the `model_request_end` event, which
is why a plain headless run of it exits 0.

`tools/probe-context.ts` therefore uses the event and no hook. A throwing mod hook fails the
whole run, so this is worth remembering before adding one.

### Still open

The asymmetry is worth checking from the host's own side. The built-in `/context` panel reads
`computeSessionStats`, not this seam, and that path carries an `estimateTokens4(state.messages)`
fallback for when no provider measurement exists. If `/context` shows real numbers while the
seam answers `null`, then the seam — not the measurement — is the defect to report upstream, and
this stand-in can retire.

## Colour: what a statusline can and cannot guarantee (2026-10-15)

Every section wore `dim` (ANSI 2) except the context bar. The ask was to colour the row by section
and follow WCAG, which turns a matter of taste into a measurement.

`tools/check-contrast.mjs` scores candidate slots against **811 real terminal themes**
(`tools/palettes.json`, from the iTerm2-Color-Schemes windowsterminal port, MIT). Two facts came
out of it, and both shaped the design:

- **No set of distinct ANSI hues clears WCAG 1.4.3's 4.5:1 on every theme.** Best on a dark
  background: white 96%, yellow 94%, cyan 90%. Best on a light background: black 77%, blue 69%,
  purple 69%. The two sets are disjoint, so any slot chosen for one mode is a gamble on the other.
  A hardcoded RGB is worse still: it holds one mode and breaks the other outright.
- **The most balanced slots are blue (72% dark / 69% light), purple (73/69) and red (65/68).**
  So the two identity sections take blue and purple, and everywhere else the palette maximises the
  weaker mode.

Design rules that follow: theme-defined slots only; no `dim`/faint (ANSI 2) and no `brightBlack`,
both of which spend the contrast headroom the theme provided; and colour is never the only cue,
since every section keeps its own glyph and words (SC 1.4.1).

The residual is stated rather than hidden: on a light-background theme four of the seven slots fall
under 4.5:1 in more than half of themes, and that is the theme's palette to fix. The checker gates
the four properties that are ours — no faint slot, every slot above 3:1 on half of each mode,
balanced identity slots, and the host's own state thresholds — and each gate was proven to bite on
its own mutant.


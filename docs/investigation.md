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


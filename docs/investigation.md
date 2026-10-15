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
`~/.commandcode/file-history/f60299ce-ad83-4d63-8b0e-91f599b96cce/` — the two `context`-bearing
ones are `0ff0a478…` (22:42) and `8605ad4b…` (22:49); `361995b6…` (23:32) already has none.

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

- 49 tests (`test/statusline.test.mjs`) drive the real mod through a fake `ModApi`, asserting
  each segment, switch, precedence layer and failure path by name.
- Mutation check: eight seeded defects, each caught —
  segment disabled (8 failures), seeded flag default masking the config file (4), timers left
  referenced (hangs the run — caught by the unref assertion), flattened tones (1), non-zero
  exit trusted (1), silent render failure (1), counters persisted per tool call (1), `null`
  rendered as `0%` (1).
- One seeded defect initially escaped: "non-zero exit treated as success" was invisible while
  the only failing-command fixture had empty stdout. The suite gained
  `does not trust output from a command that failed`, which feeds partial stdout with a
  non-zero exit code for both `git` and `cmd skills list`; the mutant now fails.
- Host-level checks: `cmd mods list` lists `statusline · user` with no warning; a headless run
  exits 0 without hanging.

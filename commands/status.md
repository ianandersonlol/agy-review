---
description: Show agy readiness plus exactly what a review would cover right now
argument-hint: '[--base REF] [--staged] [--uncommitted] [--json] [-- paths...]'
allowed-tools: Bash(node:*)
---

Show whether the toolchain is ready **and** what a review would send if you ran
one this second — scope, size, and whether the credential pre-flight would block.
Spends **no** Antigravity quota and makes no agy review call.

Arguments: $ARGUMENTS

## Steps

1. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" status $ARGUMENTS
```

2. Present the output compactly. It is already formatted as a short report; do
   not expand it into prose or a table unless the user asks.

3. Act on what it shows, without being asked to re-run anything:

   - **`credential pre-flight: would BLOCK`** — say so prominently. A review
     right now would exit 4. Tell the user which is likely needed: scoping to
     safe paths, or waiving with `--allow-secrets`. Never waive it yourself.
   - **`nothing to review`** — the scope is empty. Check whether they meant a
     different scope (`--staged`, `--uncommitted`, or a `--base`) before
     concluding there is no work.
   - **large diff** — suggest scoping with `-- <paths>` to conserve quota.
   - **`NOT READY`** — point at `/agy:setup`, which explains the specific fix.

4. This is a read-only status check. Do not follow it with a review unless the
   user asks for one.

## Notes

- The scope flags mean the same thing as in `/agy:review`, so
  `/agy:status --staged` previews exactly what `/agy:review --staged` would send.
- This is not a job monitor. Reviews here run synchronously and return in well
  under a minute; there is no queue to inspect. If a review needs to run without
  blocking, launch `/agy:review` as a background Bash task instead.
- `--json` emits the same report machine-readably.

---
description: Check that agy, git, and node are ready for reviews, and explain how to fix what is not
argument-hint: '[--json]'
allowed-tools: Bash(node:*), Bash(agy install:*), Bash(agy update:*), AskUserQuestion
---

Verify the local toolchain `agy-review` depends on, and give the user a concrete
fix for anything that is not ready. Spends **no** Antigravity quota.

Arguments: $ARGUMENTS

## Steps

1. Run the check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" setup $ARGUMENTS
```

Exit **0** means ready, exit **2** means something needs fixing. The output
already contains a per-component status and an ordered remediation list, headed
`To fix:` when it blocks and `Notes:` when the toolchain is ready anyway.

2. Present the output. If everything is ready, keep it to a line or two — do not
   pad a clean result.

3. If something is not ready, act on the specific problem:

   - **agy not found on PATH.** It ships with Google Antigravity. If the user
     has installed the app, the fix is usually `agy install`, which configures
     the shell PATH. Offer to run it with `AskUserQuestion` (options:
     `Run agy install (Recommended)` / `Skip`). If the app itself is missing,
     point them at <https://antigravity.google/download> — do not attempt to
     install it yourself.

   - **agy present but models did not respond.** Almost always authentication.
     `agy` authenticates through an interactive OAuth flow, so you cannot do it
     for them. Tell the user to type `! agy` to run it interactively in this
     session, complete the sign-in, and re-run `/agy:setup`. If that succeeds
     and the check still fails, quota is the next suspect.

   - **models respond but the list was not readable.** Not an install problem
     and *not* an auth problem — agy answered, and this plugin failed to read the
     format. Reviews are unaffected, because the review path never consults the
     model list. Say exactly that, suggest updating the plugin, and do not send
     the user through the OAuth flow. This has happened once already: `agy models`
     changed from one bare id per line to `id<TAB>Display Name`.

   - **default model missing from the model list.** Suggest `agy update`. Do not
     silently switch to a different model — the choice of
     `gemini-3.7-flash-high` is deliberate.

   - **node too old.** The scripts need Node 18+. Point at <https://nodejs.org>.

   - **git missing.** Install git and put it on PATH.

4. Do not re-run the check in a loop. Run it once after a fix the user confirms
   they made, and report the result.

## Notes

- `agy models` is the readiness probe. It exercises the binary end to end and
  spends no review quota, but it is a *responds* signal, not proof of
  authentication — agy may answer from a cached list. Report it that way.
- Readiness turns on whether agy answered at all, never on how many models were
  parsed out of the answer. Only silence means something is wrong with the
  install.
- This command checks the toolchain only. For what a review would actually cover
  in the current repository, use `/agy:status`.
- `--json` emits the same result machine-readably, if you need to branch on it.

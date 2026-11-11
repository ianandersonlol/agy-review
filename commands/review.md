---
description: Adversarial review of your working diff via agy (Gemini) with real repo access
argument-hint: '[--base REF] [--staged] [--uncommitted] [--focus "TEXT"] [--model ID] [-- paths...]'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" review:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" setup:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Get an independent adversarial review of the current change from Gemini via `agy`.
The reviewer runs **read-only** (`--mode plan --sandbox`) but has **read access to
the whole repository**, so it verifies findings against real code and call sites
instead of guessing from the diff.

This is the **defect lens**: it hunts for what is broken. To challenge the design
and approach instead, use `/agy:challenge`.

Arguments: $ARGUMENTS

## Model choice

Use `gemini-3.8-flash-high` for normal, small, and routine reviews. For a
difficult review involving multi-subsystem reasoning, concurrency or security
invariants, architectural tradeoffs, or an inconclusive successful Flash review,
prefer Gemini 4 Carbon when listed (access depends on the user's plan). Before
selecting Carbon, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" setup --json
```

Read the exact identifiers in `environment.agy.models`; pass the listed ID using
`--model`. Do not guess an ID or presumed suffix. A listed model is an
availability signal, not proof of authorization. If Carbon is absent or the
optional probe fails or is unreadable, keep Flash and briefly disclose that
choice; this is not a readiness gate, so let the original review invocation
handle its errors.

Pass any explicit user-supplied `--model` unchanged and skip model probing.
`--dry-run` needs no probe. This is orchestration guidance, not runtime routing:
direct script runs default to Flash. Do not retry or fall back after quota, auth,
or empty-output failures; report them using the existing behavior. A successful
but inconclusive Flash result may warrant a separate Carbon review. Preserve
every user argument. Only when choosing Carbon with no explicit `--model`,
insert `--model <exact-listed-id>` before any `--` path separator (or append it
if there is no separator); do not alter other arguments.

## Steps

1. Run the review, preserving every user argument. Follow the model-choice
   instructions above; only the documented Carbon override may be inserted:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" review $ARGUMENTS
```

2. Interpret the exit code before anything else:
   - **0** — review printed. Continue to step 3.
   - **4** — blocked by the secret-shape scan. Do NOT rerun with
     `--allow-secrets` on your own initiative. Show the user which lines matched
     and ask whether to scope the review to safe paths or waive the scan.
   - **3** — agy produced no output. The message names the class: `quota`
     (Antigravity limit hit), `auth` (re-run `agy` interactively to re-auth), or
     `empty_output`. Report it; do not retry in a loop.
   - **2** — setup problem (not a git repo, bad ref, agy missing). Suggest
     `/agy:setup`, which diagnoses exactly what is wrong.
   - anything else — surface agy's stderr verbatim.

3. Present the review to the user **verbatim first**, unedited. Do not soften,
   filter, or reorder the findings. This is the whole point of a second opinion.

   One exception: if stderr carried the `leaked reasoning` note, agy dumped the
   model's scratchpad before the real answer. Present only the final findings
   block (the last contiguous run of `### <SEVERITY> ...` headings plus the
   `### Verdict:` heading). Read the scratchpad yourself before discarding it —
   if it contains a finding that never made it into the final block, surface
   that separately and say where it came from. Never drop content you have not
   read.

4. Then add your own short assessment underneath, clearly separated. For each
   finding, say whether you **agree**, **disagree**, or **need to check** — and
   where you disagree, say why, citing the code. Gemini cannot see this
   conversation and does not know the constraints we've discussed, so some
   findings will be context-blind. Flag those explicitly rather than silently
   dropping them.

5. Do not start fixing anything unless the user asks. Report, then wait.

## Notes

- Default scope is the working tree vs the merge-base with `origin/HEAD`/`main`/
  `master`, so committed-on-branch **and** uncommitted work are reviewed together.
- Keep the Flash default for routine reviews; Carbon is a per-review choice only
  for difficult reviews when its exact ID is listed by `setup --json`.
- **This command is one voice, not a council.** If the user wants a council,
  that is your job as the orchestrator: run this for the Gemini opinion, run the
  Codex plugin's adversarial review for the GPT opinion, then reconcile the two
  yourself. Do not try to build a panel inside this command.
- Each run consumes Antigravity quota, which is shared with the desktop app and
  IDE. Prefer scoping large diffs with `-- <paths>` over reviewing everything.
- `--dry-run` shows exactly what would be sent and spends no quota.

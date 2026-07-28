---
description: Challenge the design and approach of your change via agy (Gemini), not its bugs
argument-hint: [--base REF] [--staged] [--uncommitted] [--focus "TEXT"] [--model ID] [-- paths...]
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Ask Gemini whether this change is the **right shape** — not whether it is correct.

`/agy:review` hunts for defects. This command assumes the code works and its
tests pass, then interrogates the approach: what it takes for granted, what it
forecloses, how it fails under load, and what it locks in. The reviewer runs
**read-only** (`--mode plan --sandbox`) with read access to the whole repository,
so it can compare your approach against how this codebase already solves the
same class of problem.

Arguments: $ARGUMENTS

## When this is the right command

Reach for it on a new subsystem, an architectural decision, a change that adds a
dependency or a public contract, or anything you would describe as "I'm not sure
this is the right way to do it." For a bug hunt on a diff you already believe in,
use `/agy:review`.

Running both is reasonable on a risky change — they ask different questions and
produce disjoint verdict vocabularies so the two reviews never blur together.

## Steps

1. Run the challenge. Pass `$ARGUMENTS` straight through:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" challenge $ARGUMENTS
```

2. Interpret the exit code before anything else — identical to `/agy:review`:
   - **0** — review printed. Continue to step 3.
   - **4** — blocked by the secret-shape scan. Do NOT rerun with
     `--allow-secrets` on your own initiative. Show the matched lines and ask.
   - **3** — agy produced no output; the message says `quota`, `auth`, or
     `empty_output`. Report it; do not retry in a loop.
   - **2** — setup problem. Suggest `/agy:setup`.
   - anything else — surface agy's stderr verbatim.

3. Present the output **verbatim first**, unedited.

4. Then add your own assessment, clearly separated. Design challenges are more
   context-dependent than bug reports: Gemini cannot see this conversation and
   does not know the constraints, deadlines, or prior decisions behind the
   approach. Expect a higher proportion of context-blind objections than in a
   defect review, and say plainly which ones the constraints already answer —
   but do not silently drop them. An objection you can rebut is still worth the
   user seeing.

5. A `Verdict: SOUND` here is meaningful and worth reporting as-is. Do not go
   looking for problems the reviewer did not find.

6. Do not start redesigning anything unless the user asks. Report, then wait.

## Notes

- Output format: `### CHALLENGE <claim>` blocks, each with **Assumption**,
  **Breaks when**, **Confirmed** (VERIFIED/SUSPECTED), and **Alternative**,
  closing with `### Verdict: SOUND` / `RECONSIDER` / `WRONG-SHAPE`.
- Any incidental bugs it notices are listed in one line at the end under
  "Incidental defects" — that is deliberate, since `/agy:review` is the pass that
  hunts them properly.
- Same model policy as `/agy:review`: `gemini-3.6-flash-high`, do not change it.
- Same quota. Scope large diffs with `-- <paths>`; `--dry-run` spends nothing.

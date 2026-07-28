---
name: agy-review
description: "Delegate code review, design critique, or a fix to Gemini via the agy (Antigravity) CLI, which runs inside the real repository so it verifies claims against actual call sites rather than a pasted diff. Use when the user asks for an independent second opinion, an adversarial or red-team review, to poke holes in a change, or to check a risky diff before merging; to challenge the design or approach of a change rather than its bugs; or to check that the agy toolchain is set up. It ALSO covers handing agy a problem to fix, which EDITS FILES — invoke that only when the user explicitly asks for agy or Gemini to do the fixing, never as your own first resort for a bug you could fix yourself. Do not invoke unprompted on every change."
---

# Adversarial review via agy (Gemini)

Delegates review of the current diff to `gemini-3.6-flash-high` through the `agy`
CLI. The reviewer runs **read-only** (`--mode plan --sandbox`) but with read
access to the whole repository, so it greps for call sites and reads changed
files in full rather than critiquing a diff in isolation. That is the point of
this skill: it catches breakage in files the diff never touched.

## Running it

The script is Node and lives in this skill's `scripts/` directory. Requires
**Node 18+**, `git`, and `agy` on `PATH`.

```bash
node scripts/agy-review.mjs [subcommand] [options]
```

If a relative path does not resolve, use the absolute path to
`scripts/agy-review.mjs` inside this skill directory. In Claude Code the
`/agy:*` slash commands already handle this.

### Subcommands

| Subcommand | What it does |
|---|---|
| `review` (default) | **Defect lens.** What is wrong with this change? Read-only. |
| `challenge` | **Design lens.** Is this the right approach at all? Read-only. |
| `rescue "<problem>"` | Diagnose and **fix** a problem. **Edits files.** |
| `setup` | Check node/git/agy readiness and explain how to fix what is not |
| `status` | Readiness plus what a review would cover right now |

`setup` and `status` never call agy for a review and spend no quota.

**`rescue` is the only subcommand that writes.** `review` and `challenge` pass
`--mode plan --sandbox` and cannot edit anything; that is not configurable. Do
not reach for `rescue` when the user asked for a review or a second opinion —
it is for "fix this", not "check this".

### Options

```
--base REF        compare against REF (default: origin/HEAD, main, or master)
--staged          staged changes only
--uncommitted     uncommitted only (vs HEAD)
--lens defect|design  override the lens the subcommand picked
--focus "TEXT"    steer the reviewer, e.g. --focus "auth and data loss"
-- <paths>        scope a large diff to specific paths
--dry-run         show what would be reviewed; spends no quota
--allow-secrets   waive the credential pre-flight (see below)
--json            machine-readable output (setup and status only)

rescue only:
--read-only       diagnose and propose a fix without editing anything
--no-context      do not send your uncommitted diff as context
```

Default scope is the working tree vs the merge-base, so work committed on the
branch **and** still-uncommitted work are reviewed together. Untracked files are
included — `git diff` ignores them, and new files are where new bugs live.

## Picking a lens

`review` assumes the design is settled and hunts for defects: correctness, edge
cases, error handling, concurrency, data loss, auth, contract breaks. It returns
severity-ranked findings and a verdict of SHIP / REVISE / RETHINK.

`challenge` assumes the code works and interrogates the approach: load-bearing
assumptions, the alternative not taken, behaviour under scale and partial
failure, what the change locks in, and whether it matches how this repository
already solves the same problem. It returns CHALLENGE blocks and a verdict of
SOUND / RECONSIDER / WRONG-SHAPE.

The verdict vocabularies are deliberately disjoint, so a transcript containing
both reviews can never blur which lens reached which conclusion. Running both on
a risky change is reasonable; they ask genuinely different questions.

## Using rescue safely

`rescue` takes a problem statement instead of a diff, and by default agy edits
files to fix it. Before invoking it:

- Confirm the user wants files **changed**, not explained. A question ("why is
  this failing?") wants `--read-only`.
- It refuses to run outside a git repository, because git recoverability is the
  entire safety model.

After it runs, the report is followed by an **exact diff of every file agy
modified**, computed from tree snapshots taken either side of the run — so it
never attributes the user's own uncommitted work to agy. Your job:

1. Show the report and that diff verbatim.
2. Read the changes and say whether you agree. An applied fix is still a
   suggestion; review it as you would any patch. Offer `git checkout -- <files>`
   if you think it is wrong.
3. Re-run the test yourself rather than trusting the "Verification" section.
4. Flag scope creep — the prompt forbids refactoring and unrelated edits, but
   those are instructions, not a sandbox.
5. Never commit on the user's behalf. Rescue leaves staging and history alone
   deliberately.

If agy edited files and then failed, the diff is still printed. Always surface
that; a half-applied edit is the case the user most needs to see.

## Do not change the model

`gemini-3.6-flash-high` is deliberate. It beats `gemini-3.1-pro` on every
published coding and agentic benchmark while being faster and cheaper. Never
substitute `gpt-oss-120b-medium` (produces confident hallucinations) or a
`claude-*` model. The whole value here is an *independent* voice, so picking a
model from the same family as the agent driving the review defeats the purpose.

## Exit codes — check before interpreting output

| Code | Meaning | What to do |
|---|---|---|
| 0 | review printed (or `setup`/`status` succeeded) | continue below |
| 2 | setup problem: not a git repo, bad `--base`, `agy` missing, or `setup` found something not ready | report it; `setup` explains the fix |
| 3 | agy produced no output; message says `quota` or `auth` | report it, do not retry in a loop |
| 4 | blocked by the credential pre-flight | **do not** re-run with `--allow-secrets` on your own initiative — show the matched lines and ask the user |

Exit 4 exists because the diff is sent to a third party. Waiving it is the
user's call, never yours.

## Presenting the result

1. Show the review **verbatim first**, unedited. Do not soften, filter, or
   reorder findings. That is the entire point of a second opinion.
2. Then add your own assessment, clearly separated. For each finding say whether
   you **agree**, **disagree**, or **need to check** — and where you disagree,
   say why, citing the code.
3. Verify before endorsing. This reviewer marks findings VERIFIED or SUSPECTED;
   treat SUSPECTED as a lead, not a fact, and check it against the real code.
4. The reviewer cannot see your conversation and does not know constraints
   already discussed, so some findings will be context-blind. Flag those
   explicitly rather than silently dropping them. Expect more of these from
   `challenge` than from `review` — design objections depend on context the
   reviewer does not have.
5. Do not start fixing anything unless the user asks. Report, then wait.

## Notes

- If stderr mentions `leaked reasoning`, agy dumped the model's scratchpad before
  the real answer (a known agy print-mode quirk). Present only the final findings
  block, but read the scratchpad first — if it contains a finding missing from the
  final block, surface it separately.
- Each review run spends Antigravity quota, shared with the Antigravity desktop
  app and IDE. Scope large diffs with `-- <paths>` rather than reviewing
  everything. `--dry-run` and `status` show the scope for free.
- Reviews are synchronous and typically return in well under a minute. There is
  no job queue; if you need one to run without blocking, launch it as a
  background task from the host agent.
- Tests: `npm test` at the repo root (`node --test`), no dependencies required.

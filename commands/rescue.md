---
description: Hand a problem to Gemini to diagnose and fix — this one edits your files
argument-hint: '"<problem statement>" [--read-only] [--no-context] [-- paths...]'
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git diff:*), Bash(git rev-parse:*), AskUserQuestion
---

Delegate a **problem** to agy, rather than a diff. Gemini reads the repository,
diagnoses the root cause, edits files to fix it, and verifies its own work.

**This is the only agy command that writes to your working tree.** `/agy:review`
and `/agy:challenge` are read-only by construction and stay that way.

Arguments: $ARGUMENTS

## Before running

1. **Confirm the user actually wants files edited.** If the request reads like a
   question ("why is this slow?", "what's causing this?") rather than an
   instruction to fix, prefer `--read-only`, which diagnoses and proposes
   without touching anything. When genuinely ambiguous, use `AskUserQuestion`
   once: `Fix it (edits files)` / `Diagnose only (--read-only)`.

2. **Check the tree is recoverable.** Run `git status --short`. Rescue refuses
   to run outside a git repository, but a repo with a large pile of uncommitted
   work is still worth flagging: agy's edits will land alongside it. Mention it
   and let the user decide; do not commit or stash on their behalf.

## Running it

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.mjs" rescue $ARGUMENTS
```

Bare words are the problem statement. `--` still introduces path scoping, so
`rescue "tests fail" -- src/auth` narrows the context diff to `src/auth`.

Exit codes match the other commands: **0** report printed · **2** setup problem
(not a git repo, agy missing) · **3** agy produced no output (`quota`/`auth`) ·
**4** blocked by the credential pre-flight on your context diff.

## After it runs

The command prints agy's report (Root cause / Change made / Verification /
Risks and gaps) followed by an **exact diff of every file it modified**. That
diff is computed from tree snapshots taken immediately before and after the
run, so it shows agy's changes only — never the user's own uncommitted work.

Your job:

1. **Present the report and the diff verbatim.** Do not summarize the diff away.
2. **Read the changes yourself and say whether you agree.** A rescue fix is a
   suggestion that happens to already be applied, not a verdict. Check it
   against the surrounding code the same way you would review a patch. If you
   think it is wrong or papers over the real problem, say so plainly and offer
   to revert: `git checkout -- <files>`.
3. **Verify independently.** Agy reports what it ran under "Verification". Run
   the test or command yourself rather than taking that on trust.
4. **Flag scope creep.** The prompt forbids refactoring, reformatting, and
   unrelated edits. If the diff contains any, call it out — that is a signal the
   fix wandered.
5. **Never commit on the user's behalf.** Rescue deliberately leaves staging and
   history untouched so the decision stays theirs.

If agy exited non-zero or produced no report, the change diff is **still
printed** when it had already edited something. Always surface that — a
half-applied edit is exactly the situation the user must know about.

## Notes

- `--read-only` runs the same diagnosis under `--mode plan --sandbox` and edits
  nothing. It is the right default for "explain this to me".
- Your uncommitted diff is sent as context by default, since the problem is
  often in it. `--no-context` omits it. The credential pre-flight applies to
  that context exactly as it does for a review.
- agy is told never to touch git history, never to weaken a test into passing,
  and to make the smallest change that fixes the problem. Those are prompt-level
  constraints, not enforced ones — which is why you review the diff.
- Same model policy and quota as the review commands.

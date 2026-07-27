---
name: agy-review
description: "Get an independent adversarial code review of the current diff from Gemini via the agy (Antigravity) CLI, with read access to the real repository so it verifies findings against actual call sites. Use when the user explicitly asks for a second opinion, an adversarial or independent review, a red-team pass, to poke holes in a change, or to check a risky diff before merging. Do not invoke unprompted on every change."
---

# Adversarial review via agy (Gemini)

Delegates review of the current diff to `gemini-3.6-flash-high` through the `agy`
CLI. The reviewer runs **read-only** (`--mode plan --sandbox`) but with read
access to the whole repository, so it greps for call sites and reads changed
files in full rather than critiquing a diff in isolation. That is the point of
this skill: it catches breakage in files the diff never touched.

## Running it

The script lives in this skill's `scripts/` directory. Invoke it with `bash`:

```bash
bash scripts/agy-review.sh [options]
```

If a relative path does not resolve, use the absolute path to
`scripts/agy-review.sh` inside this skill directory. In Claude Code the
`/agy:review` slash command already handles this.

Options:

```
--base REF        compare against REF (default: origin/HEAD, main, or master)
--staged          staged changes only
--uncommitted     uncommitted only (vs HEAD)
--focus "TEXT"    steer the reviewer, e.g. --focus "auth and data loss"
-- <paths>        scope a large diff to specific paths
--dry-run         show what would be reviewed; spends no quota
--allow-secrets   waive the credential pre-flight (see below)
```

Default scope is the working tree vs the merge-base, so work committed on the
branch **and** still-uncommitted work are reviewed together. Untracked files are
included — `git diff` ignores them, and new files are where new bugs live.

## Do not change the model

`gemini-3.6-flash-high` is deliberate. It beats `gemini-3.1-pro` on every
published coding and agentic benchmark while being faster and cheaper. Never
substitute `gpt-oss-120b-medium` (produces confident hallucinations) or a
`claude-*` model. The whole value here is an *independent* voice, so picking a
model from the same family as the agent driving the review defeats the purpose.

## Exit codes — check before interpreting output

| Code | Meaning | What to do |
|---|---|---|
| 0 | review printed | continue below |
| 2 | setup problem: not a git repo, bad `--base`, `agy` missing | report it |
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
   explicitly rather than silently dropping them.
5. Do not start fixing anything unless the user asks. Report, then wait.

## Notes

- If stderr mentions `leaked reasoning`, agy dumped the model's scratchpad before
  the real answer (a known agy print-mode quirk). Present only the final findings
  block, but read the scratchpad first — if it contains a finding missing from the
  final block, surface it separately.
- Each run spends Antigravity quota, shared with the Antigravity desktop app and
  IDE. Scope large diffs with `-- <paths>` rather than reviewing everything.
- Requires `agy` on `PATH` and OAuth-authenticated, plus `git`.

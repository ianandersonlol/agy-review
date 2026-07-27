---
description: Adversarial review of your working diff via agy (Gemini) with real repo access
argument-hint: [--base REF] [--staged] [--uncommitted] [--focus "TEXT"] [--model ID] [-- paths...]
allowed-tools: Bash(bash:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Get an independent adversarial review of the current change from Gemini via `agy`.
The reviewer runs **read-only** (`--mode plan --sandbox`) but has **read access to
the whole repository**, so it verifies findings against real code and call sites
instead of guessing from the diff.

Arguments: $ARGUMENTS

## Steps

1. Run the review. Pass `$ARGUMENTS` straight through — the script parses them:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/agy-review/scripts/agy-review.sh" $ARGUMENTS
```

2. Interpret the exit code before anything else:
   - **0** — review printed. Continue to step 3.
   - **4** — blocked by the secret-shape scan. Do NOT rerun with
     `--allow-secrets` on your own initiative. Show the user which lines matched
     and ask whether to scope the review to safe paths or waive the scan.
   - **3** — agy produced no output. The message names the class: `quota`
     (Antigravity limit hit), `auth` (re-run `agy` interactively to re-auth), or
     `empty_output`. Report it; do not retry in a loop.
   - **2** — setup problem (not a git repo, bad ref, agy missing). Report it.
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
- The model is `gemini-3.6-flash-high` and should stay that way. It beats
  `gemini-3.1-pro` on every published coding and agentic benchmark while running
  faster and cheaper, so do not "upgrade" it to a pro model. Do not substitute
  `gpt-oss-120b-medium` (3 confident hallucinations across 2 runs) or a `claude-*`
  model (correlates with you, so it is not an independent voice).
- **This command is one voice, not a council.** If the user wants a council,
  that is your job as the orchestrator: run this for the Gemini opinion, run the
  Codex plugin's adversarial review for the GPT opinion, then reconcile the two
  yourself. Do not try to build a panel inside this command.
- Each run consumes Antigravity quota, which is shared with the desktop app and
  IDE. Prefer scoping large diffs with `-- <paths>` over reviewing everything.

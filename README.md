# agy — adversarial review plugin

Independent adversarial code review from Gemini via `agy` (Google Antigravity
CLI)


## Usage

```
/agy:review                            # working tree vs origin/HEAD (or main/master)
/agy:review --base v1.4.0              # against a specific ref
/agy:review --staged                   # staged changes only
/agy:review --uncommitted              # uncommitted only (vs HEAD)
/agy:review --focus "auth, data loss"  # steer the reviewer
/agy:review -- src/billing             # scope to paths
/agy:review --dry-run                  # what would be reviewed; spends no quota
```

Or directly, outside Claude Code:

```bash
bash /path/to/agy-review/scripts/agy-review.sh --base main
```

## Install

Requires [`agy`](https://antigravity.google/) on `PATH` and OAuth-authenticated,
plus `git`. No `coreutils`/`gtimeout` dependency — the script uses agy's own
`--print-timeout`.

```bash
claude plugin marketplace add ianandersonlol/agy-review
claude plugin install agy@agy-review
```

Then `/agy:review` in any git repository. To verify the wiring without spending
any quota:

```bash
/agy:review --dry-run
```

## Model choice

The reviewer is **`gemini-3.6-flash-high`**, and that is deliberate on two axes.

**Why Flash over Pro.** It beats `gemini-3.1-pro` on every published coding and
agentic benchmark — SWE-Bench Pro, DeepSWE, Terminal-Bench, MLE-Bench — with a
higher Artificial Analysis intelligence index (50 vs 46), and runs ~2.3x faster
and cheaper. Pro's only remaining leads are GPQA Diamond and Humanity's Last
Exam: academic reasoning that code review does not need. **Do not "upgrade" this
to a pro model.**

**Why no second model inside agy.** agy exposes three families and neither
non-Gemini option earns a seat:

- `gpt-oss-120b-medium` produced **3 confident hallucinations across 2 runs** on
  this codebase, all labelled VERIFIED: a nonexistent indentation error; a claim
  the scripts use `>2` when they use `>&2` 18 times and bare `>2` zero times; and
  a claim that `"${arr[@]}"` word-splits. Anecdote, not a benchmark — but a
  confident false finding costs more review time than no finding at all.
- `claude-*` correlates with the Claude session driving the review, so it adds
  little independence — which is the entire point of a second opinion.

Model diversity therefore lives **across tools, not inside agy**:

| Tool | Model | Role |
|---|---|---|
| Codex CLI plugin | GPT-5.6 | adversarial review, repo-aware |
| this plugin | Gemini 3.6 Flash | adversarial review, repo-aware |
| the Claude session | Opus 5 | reconciles, adjudicates, verifies |

Three families, three tools. `--model` overrides per run if you want to test a
different one.

## The leash

The reviewer is read-only by construction, three ways over:

| Mechanism | Effect |
|---|---|
| `--mode plan` | agy's agent-level read-only mode. It cannot edit files. |
| `--sandbox` | terminal restrictions. |
| `--add-dir` | workspace confined to the repo root + our temp dir. |

This is stronger than prompt-level "you must not write files" text, which a
model can simply ignore.

The prompt and diff are written to a `0600` temp file and agy is pointed at it,
so nothing large or sensitive lands on `argv` — no `ps` leakage, no `ARG_MAX`
ceiling on diff size. The temp dir is removed on any exit path via `trap`.

## Secret pre-flight

The diff is sent to Google. Before that happens, added lines are scanned for
credential shapes (private-key headers, `AKIA…`, `gh[pousr]_…`, `sk_live_`,
`rk_live_`, `xox[baprs]-`, and `key/secret/password/token = <20+ chars>`). On a
match the run is **blocked with exit 4** and the matching lines are printed.

Waive with `--allow-secrets`, or scope around it with `-- <paths>`. The scan
only looks at **added** lines, so removing a secret does not trip it.

**Known false positive:** any file that *documents* credential shapes trips the
scan — including `agy-review.sh` itself, whose `SECRET_RE` contains the literal
`-----BEGIN OPENSSH`. Security docs, scanner configs, and test fixtures will do
the same. The block is working as designed; `--allow-secrets` is the answer once
you have eyeballed the matched lines.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | review printed (or nothing to review) |
| 2 | setup problem — not a git repo, unresolvable `--base`, `agy` missing |
| 3 | agy produced no output; message classifies it as `quota`, `auth`, or `empty_output` |
| 4 | blocked by the secret pre-flight |
| other | agy's own exit code, with its stderr surfaced |

## Scope: one voice, not a council

This plugin is deliberately **one reviewer**, not a panel. Convening a council is
the orchestrating Claude session's job — it delegates to agy for the Gemini voice
and to the Codex plugin for the GPT voice, then reconciles. Building a council
inside a single-provider plugin would just fan out to models from the same
provider, which is the opposite of what a council is for.

So: no `--models`, no parallel panel, no internal voting. One diff, one
independent reviewer, honest output.

## Notes and gotchas

- **Untracked files are included.** `git diff` ignores them, so the script
  synthesizes a diff against `/dev/null` for each untracked file — new files are
  where new bugs live. Untracked files over 256KB are skipped with a warning.
  Exception: `--staged` uses `git diff --cached` alone, which already covers
  newly `git add`ed files.
- **Default scope is the working tree vs the merge-base**, so work committed on
  the branch *and* still-uncommitted work are reviewed together.
- **Hacking on it.** `claude plugin install` copies a snapshot into
  `~/.claude/plugins/cache/<marketplace>/agy/<version>/`, so edits to a clone do
  not take effect until you reinstall:
  `claude plugin uninstall agy@<marketplace> && claude plugin install agy@<marketplace>`.
  Bump `version` in `plugin.json` if the cache looks stale. To iterate quickly,
  run `scripts/agy-review.sh` directly instead — it needs no plugin machinery.
- **agy print-mode quirk.** agy occasionally prefixes output with
  `MD Parse Error` and dumps the model's scratchpad before the real answer. The
  script detects this and warns on stderr rather than truncating — a heuristic
  cut could silently drop a real finding. The review is the final findings block.
- **Quota.** Every run spends Antigravity quota, shared with the desktop app and
  IDE. Scope large diffs with `-- <paths>`.
- **Provenance.** Written from scratch, but two ideas are owed to
  [davdittrich/delegate-agy](https://github.com/davdittrich/delegate-agy): keeping
  the prompt off `argv` behind a short constant pointer, and the discovery that
  agy exits 0 with empty stdout when quota is exhausted (hence exit 3 and the
  `quota`/`auth` classification). Its core design choice — sandboxing the reviewer
  to a temp dir so it only sees a pasted diff — is the one this plugin inverts.

## License

MIT — see [LICENSE](./LICENSE).

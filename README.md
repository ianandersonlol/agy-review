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

/agy:challenge                         # challenge the design, not the bugs
/agy:setup                             # is the toolchain ready? how do I fix it?
/agy:status                            # readiness + what a review would cover

/agy:rescue "the login test fails"     # diagnose and FIX — this one edits files
/agy:rescue "why is this slow" --read-only   # diagnose only, edits nothing
```

Or directly, with no plugin machinery at all:

```bash
node /path/to/agy-review/skills/agy-review/scripts/agy-review.mjs review --base main
```

## Two lenses

`review` and `challenge` ask genuinely different questions, so they have
different output contracts.

| | `/agy:review` | `/agy:challenge` |
|---|---|---|
| Question | What is **wrong** with this? | Is this the **right shape**? |
| Assumes | design is settled | code works, tests pass |
| Looks for | correctness, edge cases, error handling, concurrency, data loss, auth, contract breaks | load-bearing assumptions, the alternative not taken, behaviour under scale and partial failure, what it locks in, fit with the existing codebase |
| Output | `### HIGH <claim>` + Where / Failure / Confirmed / Fix | `### CHALLENGE <claim>` + Assumption / Breaks when / Confirmed / Alternative |
| Verdict | SHIP · REVISE · RETHINK | SOUND · RECONSIDER · WRONG-SHAPE |

The verdict vocabularies are deliberately disjoint: a council transcript can
contain both reviews, and the reconciler must never have to guess which lens
reached which conclusion. `challenge` defers bug hunting to `review`, listing any
incidental defects in a single line at the end.

Both lenses demand a concrete failure condition on every finding and drop
anything unfalsifiable, and both mark each finding VERIFIED (established by
reading the code) or SUSPECTED (inferred from the diff).

## Rescue: the one command that writes

`review` and `challenge` critique a diff. `rescue` takes a **problem statement**
instead — "the login test fails after my change" — reads the repository,
diagnoses the root cause, **edits files to fix it**, and verifies its own work by
running the relevant test.

It mirrors `codex-rescue`, which defaults to a write-capable run. `--read-only`
gives you the same diagnosis under `--mode plan --sandbox` with nothing touched,
and is the right choice for "explain this to me".

**The safety model is git, and it is the reason rescue refuses to run outside a
repository.** Everything agy does is recoverable, and the run is bracketed by two
working-tree snapshots so the report ends with an *exact diff of what agy
changed*:

```
agy-review: agy modified 1 file(s):
  M  cart.js

--- exact diff of what agy changed ---
…
--- end of agy's changes ---
Nothing was staged or committed. Review the above before keeping it.
```

Those snapshots matter more than they might look. Diffing against `HEAD` would
blame agy for your own uncommitted work; `git stash` would mutate your worktree
to find out. Instead each snapshot writes a tree object through a scratch index
held **outside** the repo, leaving your index, `HEAD`, staging, and worktree
byte-for-byte untouched. Tested: a pre-existing edit to a second file is
correctly excluded from agy's attributed changes.

The scratch index must live outside the worktree or `git add -A` captures it and
reports it as a change agy made. The code refuses an inside-the-repo index path,
and a test enforces it.

What is *not* enforced: the prompt tells agy never to touch git history, never to
weaken a test into passing, never to refactor adjacent code, and to make the
smallest change that fixes the problem. Those are instructions, not a sandbox.
The printed diff exists precisely because you should not take them on trust.

If agy edits files and *then* fails or returns nothing, the change diff is still
printed. A half-applied edit is the case you most need to see.

## Install

Works in **both Claude Code and Codex** from this one repo. Requires:

- **Node 18+** — the scripts are plain ESM, no dependencies
- [`agy`](https://antigravity.google/) on `PATH` and OAuth-authenticated
- `git`

No `coreutils`/`gtimeout` dependency — agy's own `--print-timeout` handles it.
Run `/agy:setup` to check all three at once; it spends no quota.

**Claude Code** — adds the `/agy:review`, `/agy:challenge`, `/agy:rescue`,
`/agy:setup`, and `/agy:status` slash commands:

```bash
claude plugin marketplace add ianandersonlol/agy-review
claude plugin install agy@agy-review
```

**Codex** — adds the `agy-review` skill:

```bash
codex plugin marketplace add ianandersonlol/agy-review
codex plugin add agy@agy-review
```

To verify the wiring without spending any quota, run `/agy:setup` in Claude Code,
or ask Codex to "check whether the agy review tooling is set up".

### Where this runs

Plugins now install into Claude Code, Claude Cowork, and Claude chat, but plugin
format compatibility is **not** what decides whether this one works. Every
command here is a local process: `node` spawns `agy` and `git` against a
repository on disk. So the only question that matters is *do I get a shell with
an authenticated `agy` on it?*

| Surface | Works | Why |
|---|---|---|
| Claude Code (terminal, desktop app, IDE) | **yes** | local shell, local repo, local `agy` |
| Cowork, running locally | **probably** | operates on your real files; verify with `/agy:setup` |
| Cowork, running in the cloud | **no** | your `agy` binary and its OAuth credentials are not there |
| Claude Code on the web | **no** | cloud sandbox without `agy` |
| Claude chat (web/desktop) | **installs, then fails** | the skill loads; there is no local shell to run it |

The chat row is the trap: it looks supported right up until execution.

**Settle it empirically rather than by reasoning:** run `/agy:setup` on whatever
surface you are curious about. It reports node, git, and `agy` — path, version,
and whether it responds — in about two seconds, and spends no quota. If it says
ready, reviews will work.

### How one repo targets both

| | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Surface | `commands/*.md` → `/agy:review`, `/agy:challenge`, `/agy:rescue`, `/agy:setup`, `/agy:status` | `skills/agy-review/SKILL.md`, model-invoked |
| Script | `skills/agy-review/scripts/agy-review.mjs` — **one copy, shared** |

The script is the whole product and contains no harness-specific logic. It lives
inside the skill directory because Codex skills resolve scripts by relative path
and there is no `CODEX_PLUGIN_ROOT` equivalent; Claude Code reaches the same file
through `${CLAUDE_PLUGIN_ROOT}`.

Note the surfaces differ: Claude Code gets slash commands you type, Codex gets a
skill the model invokes when you ask for a review in natural language. Same
script, same output.

## Portability

The implementation is Node rather than shell, and that is a deliberate
correctness choice rather than a taste one. The original `agy-review.sh` had four
Windows failure modes, three of them silent:

| Problem | Consequence under Git Bash |
|---|---|
| The temp file path was embedded **inside** the prompt sentence passed to `-p`. MSYS only rewrites POSIX paths in standalone arguments, never mid-string. | `agy.exe` was told to read `/tmp/agy-review.XXXX/review-request.md`, which does not exist on Windows. Loud failure. |
| Untracked files were diffed against `/dev/null`. | MSYS mangles it en route to `git.exe`; new files silently vanished from the review. |
| `chmod 600` on the request file. | A no-op on NTFS. The "the diff sits in a 0600 file" guarantee was quietly false. |
| No declared `bash` dependency. | Nothing told you any of the above applied. |

The Node port spawns everything with an argv array and `shell: false`, so no
argument is ever parsed by a shell and no path is ever rewritten in transit.
Temp directories come from `os.tmpdir()` in the platform's native format.
Untracked files are diffed against a real empty file, then the headers are
rewritten to the conventional new-file form — the assembled diff is byte-identical
to what the shell version produced on macOS and Linux, and now actually works on
Windows. `which()` resolves executables to full paths because Node's
`shell: false` does not apply `PATHEXT`, so a bare `spawn("agy")` would miss
`agy.exe`.

The request file is still written `0600`. On Windows that mode is advisory; the
real protection there is that `os.tmpdir()` resolves to a per-user directory
whose ACL the file inherits. That is a weaker guarantee than on POSIX, stated
plainly rather than assumed away.

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
different one; `/agy:setup` lists what your agy build actually offers.

## The leash

**`review` and `challenge` are read-only by construction**, three ways over:

| Mechanism | Effect |
|---|---|
| `--mode plan` | agy's agent-level read-only mode. It cannot edit files. |
| `--sandbox` | terminal restrictions. |
| `--add-dir` | workspace confined to the repo root + our temp dir. |

This is stronger than prompt-level "you must not write files" text, which a
model can simply ignore. Those two commands never pass anything but
`--mode plan`, and that is not configurable.

**`rescue` is the deliberate exception**, and the only way to reach
`--mode accept-edits` in this plugin. It keeps `--sandbox` and `--add-dir`, so
the workspace is still confined to your repo, but it can write. Its safety story
is git recoverability plus the printed change diff — see [Rescue](#rescue-the-one-command-that-writes)
above. `rescue --read-only` puts it back under the same leash as the reviewers.

The division is intentional: a reviewer that can edit the code it is reviewing
is not a second opinion, it is a co-author. Keep the critique commands read-only
even though the machinery for writing now exists in the same binary.

The prompt and diff are written to a `0600` temp file and agy is pointed at it,
so nothing large or sensitive lands on `argv` — no `ps` leakage, no `ARG_MAX`
ceiling on diff size.

The temp dir is removed on **every** exit path, including interruption. A bare
`try`/`finally` is not enough here: signal termination kills the process without
unwinding pending promises, so Ctrl+C during a review would leave the whole diff
on disk. `lib/tempdir.mjs` registers `exit`, `SIGINT`, `SIGTERM`, and `SIGHUP`
handlers to reproduce what the shell version got from `trap`, exiting with the
conventional `128 + signal` code. A test kills a real child process mid-run and
asserts the directory is gone.

## Secret pre-flight

The diff is sent to Google. Before that happens, added lines are scanned for
credential shapes (private-key headers, `AKIA…`, `gh[pousr]_…`, `sk_live_`,
`rk_live_`, `xox[baprs]-`, and `key/secret/password/token = <20+ chars>`). On a
match the run is **blocked with exit 4** and the matching lines are printed.

Waive with `--allow-secrets`, or scope around it with `-- <paths>`. The scan only
looks at **added** lines, so removing a secret does not trip it. `+++ b/path`
header lines are excluded too, so a file named `api_key_helper.ts` cannot block a
review on its own name.

`/agy:status` tells you whether the pre-flight would block **before** you spend
any quota on a review.

**Known false positive:** any file that *documents* credential shapes trips the
scan — security docs, scanner configs, test fixtures. The block is working as
designed; `--allow-secrets` is the answer once you have eyeballed the matched
lines. The scanner's own pattern list is split across a string concatenation
specifically so that reviewing *this* repository does not block on it, and a test
enforces that.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | review printed (or nothing to review; or `setup`/`status` succeeded) |
| 2 | setup problem — not a git repo, unresolvable `--base`, `agy` missing, or `setup` found something not ready |
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

There is also **no job tracker**, for the same kind of reason. Reviews run
synchronously and return in well under a minute, so a job table would be
machinery around a wait that does not exist — and the host agent can already
background a run itself. `/agy:status` reports tool readiness and review scope,
not queued work.

## Notes and gotchas

- **Untracked files are included.** `git diff` ignores them, so the script
  synthesizes a new-file diff for each untracked file — new files are where new
  bugs live. Untracked files over 256KB are skipped with a warning. Exception:
  `--staged` uses `git diff --cached` alone, which already covers newly
  `git add`ed files. Three details that are easy to get wrong, and are tested:
  - **Symlinks are never followed.** An untracked `ln -s /etc/passwd notes.txt`
    would, via `fs.stat`, look like an ordinary file and ship its *target's*
    contents to Google. The scan uses `lstat` and renders the link the way git
    does — mode `120000`, content is the link text.
  - **Empty new files still appear.** `git diff` prints nothing when both sides
    are empty, so a new `__init__.py` would vanish. Its existence is the content.
  - **The executable bit survives**, as `100755` rather than a hardcoded `100644`.
- **Default scope is the working tree vs the merge-base**, so work committed on
  the branch *and* still-uncommitted work are reviewed together.
- **Hacking on it.** `claude plugin install` copies a snapshot into
  `~/.claude/plugins/cache/<marketplace>/agy/<version>/`, so edits to a clone do
  not take effect until you reinstall:
  `claude plugin uninstall agy@<marketplace> && claude plugin install agy@<marketplace>`.
  Bump `version` in `plugin.json` if the cache looks stale. To iterate quickly,
  run `skills/agy-review/scripts/agy-review.mjs` directly instead — it needs no
  plugin machinery.
- **Tests.** `npm test` runs `node --test` over `tests/`. No dependencies, no
  network, no agy calls — the suite covers argument parsing, the secret scanner,
  diff assembly against real throwaway git repositories, prompt construction, and
  the process layer.
- **agy print-mode quirk.** agy occasionally prefixes output with
  `MD Parse Error` and dumps the model's scratchpad before the real answer. The
  script detects this and warns on stderr rather than truncating — a heuristic
  cut could silently drop a real finding. The review is the final findings block.
- **Quota.** Every review run spends Antigravity quota, shared with the desktop
  app and IDE. Scope large diffs with `-- <paths>`. `--dry-run`, `/agy:setup`, and
  `/agy:status` all spend nothing.
- **Provenance.** Written from scratch, but two ideas are owed to
  [davdittrich/delegate-agy](https://github.com/davdittrich/delegate-agy): keeping
  the prompt off `argv` behind a short constant pointer, and the discovery that
  agy exits 0 with empty stdout when quota is exhausted (hence exit 3 and the
  `quota`/`auth` classification). Its core design choice — sandboxing the reviewer
  to a temp dir so it only sees a pasted diff — is the one this plugin inverts.

## License

MIT — see [LICENSE](./LICENSE).

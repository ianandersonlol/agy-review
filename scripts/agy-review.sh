#!/usr/bin/env bash
# agy-review.sh — adversarial code review via agy (Google Antigravity CLI).
#
# Runs agy against YOUR ACTUAL REPO in read-only plan mode, so the reviewer can
# follow call sites instead of only critiquing the pasted diff.
#
# Leash (defence in depth):
#   --mode plan  : agent-level read-only mode. It cannot edit files.
#   --sandbox    : terminal restrictions.
#   --add-dir    : workspace limited to the repo root + our temp dir.
# The prompt+diff are written to a 0600 temp file and agy is pointed at it, so
# nothing large or sensitive lands on argv (no ps leakage, no ARG_MAX cap).

set -euo pipefail

# gemini-3.6-flash-high beats gemini-3.1-pro on every published coding/agentic
# benchmark (SWE-Bench Pro, DeepSWE, Terminal-Bench, MLE-Bench) while running
# ~2.3x faster and cheaper. Pro only still leads on GPQA/HLE academic reasoning,
# which is not what code review needs. Do not "upgrade" this to a pro model.
MODEL_DEFAULT="gemini-3.6-flash-high"
TIMEOUT_DEFAULT="10m"

MODEL="$MODEL_DEFAULT"
PRINT_TIMEOUT="$TIMEOUT_DEFAULT"
BASE=""
DIFF_MODE="branch"          # branch | staged | uncommitted
ALLOW_SECRETS=0
FOCUS=""
QUIET=0
DRY_RUN=0
PATHS=()

die() { printf 'agy-review: %s\n' "$1" >&2; exit "${2:-1}"; }

usage() {
    cat <<'EOF'
agy-review — adversarial review of your working diff via agy (Gemini), with real repo access.

Usage:
  agy-review [options] [-- <paths>...]

Options:
  --base REF          compare against REF (default: auto — origin/HEAD, main, or master)
  --staged            review only staged changes
  --uncommitted       review only uncommitted changes (vs HEAD)
  --model ID          agy model (default: gemini-3.6-flash-high; see `agy models`)
  --focus TEXT        extra instruction, e.g. --focus "auth and data loss"
  --timeout DUR       agy print timeout, Go duration (default: 10m)
  --allow-secrets     skip the secret-shape pre-flight scan
  --quiet             suppress the metadata header on stderr
  --dry-run           build the diff and run the secret scan, then stop without
                      calling agy — shows exactly what would be reviewed and
                      spends no quota
  -h, --help          this message

The reviewer runs read-only (--mode plan --sandbox) and can read the whole repo,
so it verifies claims against real code rather than guessing from the diff.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base)         [[ $# -ge 2 ]] || die "--base requires a value" 2; BASE="$2"; shift 2 ;;
        --model)        [[ $# -ge 2 ]] || die "--model requires a value" 2; MODEL="$2"; shift 2 ;;
        --focus)        [[ $# -ge 2 ]] || die "--focus requires a value" 2; FOCUS="$2"; shift 2 ;;
        --timeout)
            [[ $# -ge 2 ]] || die "--timeout requires a value" 2
            # agy wants a Go duration ("10m"). A bare number reaches agy as an
            # invalid duration and fails with an opaque error, so catch it here
            # and treat it as seconds.
            if [[ "$2" =~ ^[0-9]+$ ]]; then
                PRINT_TIMEOUT="${2}s"
            elif [[ "$2" =~ ^[0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h)$ ]]; then
                PRINT_TIMEOUT="$2"
            else
                die "--timeout must be a Go duration like 30s, 10m, 1h (bare numbers are read as seconds)" 2
            fi
            shift 2 ;;
        --staged)       DIFF_MODE="staged"; shift ;;
        --uncommitted)  DIFF_MODE="uncommitted"; shift ;;
        --allow-secrets) ALLOW_SECRETS=1; shift ;;
        --quiet)        QUIET=1; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        --)             shift; PATHS+=("$@"); break ;;
        --*)            die "unknown flag: $1" 2 ;;
        *)              PATHS+=("$1"); shift ;;
    esac
done

# ── Dependencies ─────────────────────────────────────────────────────────────
command -v agy >/dev/null 2>&1 || die "agy not found on PATH (expected ~/.local/bin/agy)" 2
command -v git >/dev/null 2>&1 || die "git not found on PATH" 2

# ── Repo root ────────────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die "not inside a git repository — cd into your project first" 2
cd "$REPO_ROOT"

# ── Resolve the base ref ─────────────────────────────────────────────────────
# Validate an explicit --base HERE, in the main shell. resolve_base() is called
# inside a command substitution, and `exit` from a subshell would only kill the
# subshell — the script would print the error and then review the wrong thing.
if [[ -n "$BASE" ]]; then
    git rev-parse --verify --quiet "$BASE" >/dev/null \
        || die "base ref '$BASE' does not resolve in this repo" 2
fi

resolve_base() {
    local b
    if [[ -n "$BASE" ]]; then printf '%s' "$BASE"; return 0; fi
    for b in origin/HEAD origin/main origin/master main master; do
        if git rev-parse --verify --quiet "$b" >/dev/null; then printf '%s' "$b"; return 0; fi
    done
    return 1
}

WORK_DIR="$(mktemp -d -t agy-review.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT QUIT TERM
DIFF_FILE="$WORK_DIR/changes.diff"
REQ_FILE="$WORK_DIR/review-request.md"

# ── Collect the diff ─────────────────────────────────────────────────────────
# Default ("branch") diffs the WORKING TREE against the merge-base, so both
# committed-on-this-branch and still-uncommitted work are reviewed together.
DIFF_DESC=""
case "$DIFF_MODE" in
    staged)
        DIFF_DESC="staged changes (git diff --cached)"
        git diff --cached --no-color -- "${PATHS[@]:-.}" > "$DIFF_FILE" || true ;;
    uncommitted)
        DIFF_DESC="uncommitted changes (git diff HEAD)"
        git diff HEAD --no-color -- "${PATHS[@]:-.}" > "$DIFF_FILE" || true ;;
    branch)
        if BASE_REF="$(resolve_base)"; then
            MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || printf '%s' "$BASE_REF")"
            DIFF_DESC="working tree vs $BASE_REF (merge-base ${MERGE_BASE:0:8})"
            git diff "$MERGE_BASE" --no-color -- "${PATHS[@]:-.}" > "$DIFF_FILE" || true
        else
            DIFF_DESC="uncommitted changes (no base branch found; vs HEAD)"
            git diff HEAD --no-color -- "${PATHS[@]:-.}" > "$DIFF_FILE" || true
        fi ;;
esac

# ── Include untracked files ──────────────────────────────────────────────────
# `git diff` ignores untracked files entirely, so a brand-new file added on this
# branch would be silently excluded from review — and new files are exactly where
# new bugs live. Synthesize a diff for each with --no-index against /dev/null.
# (--staged is exempt: `git diff --cached` already covers newly `git add`ed files,
# and an unstaged file is deliberately out of scope for that mode.)
UNTRACKED_SKIPPED=0
if [[ "$DIFF_MODE" != "staged" ]]; then
    while IFS= read -r f; do
        [[ -n "$f" && -f "$f" ]] || continue
        fsize="$(wc -c < "$f" 2>/dev/null | tr -d '[:space:]')"
        if [[ -n "$fsize" && "$fsize" -gt 262144 ]]; then
            UNTRACKED_SKIPPED=$(( UNTRACKED_SKIPPED + 1 ))
            printf 'agy-review: skipping untracked file over 256KB: %s (%s bytes)\n' "$f" "$fsize" >&2
            continue
        fi
        # `--` is required: without it a file named e.g. "-x" is parsed as a flag.
        git diff --no-index --no-color -- /dev/null "$f" >> "$DIFF_FILE" 2>/dev/null || true
    done < <(git ls-files --others --exclude-standard -- "${PATHS[@]:-.}")
fi

if [[ ! -s "$DIFF_FILE" ]]; then
    printf 'agy-review: no changes to review (%s).\n' "$DIFF_DESC" >&2
    exit 0
fi

DIFF_BYTES="$(wc -c < "$DIFF_FILE" | tr -d '[:space:]')"
FILES_CHANGED="$(grep -c '^diff --git ' "$DIFF_FILE" || true)"
[[ "$DIFF_BYTES" -gt 400000 ]] && printf 'agy-review: WARNING: diff is %s bytes — consider scoping with paths or --staged.\n' "$DIFF_BYTES" >&2

# ── Secret-shape pre-flight ──────────────────────────────────────────────────
# The diff is sent to Google. Block on obvious credential shapes unless waived.
if [[ "$ALLOW_SECRETS" -ne 1 ]]; then
    SECRET_RE='BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN OPENSSH|(api[_-]?key|secret|password|passwd|token)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9/+_-]{20,}'
    if HITS="$(grep -nEi "$SECRET_RE" "$DIFF_FILE" | grep -E '^[0-9]+:\+' | head -5)"; [[ -n "$HITS" ]]; then
        {
            printf 'agy-review: BLOCKED — the diff contains added lines matching credential shapes.\n'
            printf 'This review would send them to Google. Matched (diff line numbers):\n'
            printf '%s\n' "$HITS" | cut -c1-160 | sed 's/^/  /'
            printf 'Scope it (agy-review -- path/to/safe/dir) or waive with --allow-secrets.\n'
        } >&2
        exit 4
    fi
fi

# ── Dry run stops here ───────────────────────────────────────────────────────
# Diff is assembled and the secret scan has passed. No agy call, no quota spent.
# Useful for confirming scope on a large branch, and for checking whether the
# secret pre-flight will block, before committing any quota to a review.
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'agy-review: dry run OK — scope=%s files=%s diff=%sB (no agy call, no quota spent)\n' \
        "$DIFF_DESC" "$FILES_CHANGED" "$DIFF_BYTES" >&2
    exit 0
fi

# ── Build the review request ─────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
{
    cat <<EOF
# Adversarial code review

You are an adversarial reviewer. Your job is to find what is WRONG with this
change — not to summarize it, not to praise it. Assume the author is competent
and has already thought about the obvious cases; look for what they missed.

Repository: $REPO_ROOT
Branch: $BRANCH
Scope: $DIFF_DESC
Files changed: $FILES_CHANGED

## You have read access to the entire repository

This is the most important instruction. Do NOT review the diff in isolation.
Use your file-reading and search tools on the repo at $REPO_ROOT to:

- read each changed file IN FULL, not just the hunks
- find every CALLER of every function whose signature, return value, error
  behaviour, or nullability changed, and check each call site still holds
- check whether tests exist for the changed paths, and whether they actually
  cover the new behaviour or just the happy path
- look for OTHER places in the codebase with the same bug or the same pattern
  that the author fixed here but missed there
- verify claims in comments and commit messages against the real code

A finding you confirmed by reading code is worth ten you inferred from a hunk.

## What to look for

Correctness and edge cases; error and failure handling; concurrency and
ordering; data loss and destructive operations; auth, permissions, and input
validation; resource leaks; API/contract breaks for existing callers; state
that can go inconsistent on a partial failure.
EOF
    [[ -n "$FOCUS" ]] && printf '\n## Focus from the author\n\n%s\n' "$FOCUS"
    cat <<'EOF'

## Output format

Emit findings in descending severity. Format each one as a level-3 markdown
heading holding one severity word followed by the claim, then four bullets.
Severity is exactly one of CRITICAL, HIGH, MEDIUM, LOW. Like this:

### HIGH Retry loop double-charges on a timeout
- **Where:** `billing/charge.py:88`
- **Failure:** concrete inputs or sequence of events, then the wrong result. If
  you cannot write a concrete failure scenario, drop the finding entirely.
- **Confirmed:** say VERIFIED if you read the surrounding code and call sites to
  establish this, or SUSPECTED if it is inferred from the diff alone.
- **Fix:** the smallest safe change.

After the last finding, close with a level-3 heading reading exactly
"Verdict: SHIP" or "Verdict: REVISE" or "Verdict: RETHINK", then one paragraph.
If REVISE or RETHINK, list the specific blocking items.

Rules: no praise sections, no restating the diff, no style or formatting nits
unless they cause a real bug. If you genuinely find nothing substantive after
reading the surrounding code, say so plainly and return SHIP — do not invent
findings to look thorough.

Output the review only. Do not narrate your process, do not show your working,
do not restate these instructions, and do not preface the review with anything.
Begin your reply directly with the first finding heading (or with the verdict
heading if there are no findings).

## The diff under review

EOF
    printf '```diff\n'
    cat "$DIFF_FILE"
    printf '\n```\n'
} > "$REQ_FILE"
chmod 600 "$REQ_FILE" "$DIFF_FILE" 2>/dev/null || true

# ── Run agy ──────────────────────────────────────────────────────────────────
# Only a short constant pointer goes on argv; the request + diff stay in the
# 0600 temp file. Run from the repo root so agy's own repo detection works.
POINTER="Read the file '$REQ_FILE' and carry out the adversarial code review it specifies, exactly as instructed. Use your file tools on the repository at '$REPO_ROOT' to verify findings against real code before reporting them. Output only the review."

if [[ "$QUIET" -ne 1 ]]; then
    printf 'agy-review: model=%s scope=%s files=%s diff=%sB timeout=%s\n' \
        "$MODEL" "$DIFF_DESC" "$FILES_CHANGED" "$DIFF_BYTES" "$PRINT_TIMEOUT" >&2
fi

STDOUT_FILE="$WORK_DIR/stdout"
STDERR_FILE="$WORK_DIR/stderr"
START=$SECONDS
set +e
agy --mode plan --sandbox \
    --add-dir "$REPO_ROOT" \
    --add-dir "$WORK_DIR" \
    --model "$MODEL" \
    --print-timeout "$PRINT_TIMEOUT" \
    -p "$POINTER" \
    > "$STDOUT_FILE" 2> "$STDERR_FILE"
EXIT_CODE=$?
set -e
DURATION=$(( SECONDS - START ))

if [[ "$EXIT_CODE" -ne 0 ]]; then
    printf 'agy-review: agy exited %d after %ds\n%s\n' \
        "$EXIT_CODE" "$DURATION" "$(cat "$STDERR_FILE" 2>/dev/null)" >&2
    exit "$EXIT_CODE"
fi

# agy exits 0 with empty stdout on quota exhaustion and some backend errors.
if [[ ! -s "$STDOUT_FILE" ]]; then
    REASON="$(cat "$STDERR_FILE" 2>/dev/null)"
    [[ -n "$REASON" ]] || REASON="agy returned no output (exit 0, empty stdout) after ${DURATION}s"
    CLASS="empty_output"
    case "$REASON" in
        *RESOURCE_EXHAUSTED*|*429*|*[Qq]uota*)  CLASS="quota" ;;
        *UNAUTHENTICATED*|*[Aa]uth*)            CLASS="auth" ;;
    esac
    printf 'agy-review: no review produced [%s]: %s\n' "$CLASS" "$REASON" >&2
    exit 3
fi

# agy sometimes prefixes print-mode output with "MD Parse Error" and dumps the
# model's raw scratchpad before the real answer. We deliberately do NOT truncate
# — a heuristic cut could silently drop a real finding — but we flag it so the
# caller knows the tail is the review and the head is noise.
if grep -q 'MD Parse Error' "$STDOUT_FILE"; then
    printf 'agy-review: NOTE: agy leaked reasoning before the review (known agy print-mode quirk). The real review is the FINAL findings block; everything before it is scratchpad.\n' >&2
fi

cat "$STDOUT_FILE"
[[ "$QUIET" -ne 1 ]] && printf 'agy-review: completed in %ds\n' "$DURATION" >&2
exit 0

// Invoking agy, and making sense of what comes back.

import { run, which } from "./exec.mjs";

export const MODEL_DEFAULT = "gemini-3.6-flash-high";
export const TIMEOUT_DEFAULT = "10m";
export const ANTIGRAVITY_URL = "https://antigravity.google/download";

export async function findAgy() {
  return which("agy");
}

export async function agyVersion(agyPath) {
  const result = await run(agyPath, ["--version"], { timeout: 15000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().split("\n")[0] || null;
}

// Terminal colour, in case a future agy build decides stdout is a TTY.
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// "- id", "* id", "1. id" — list decoration around an otherwise fine id.
const LIST_MARKER = /^(?:[-*•>]|\d+[.)])\s+/;
// Model ids are lowercase identifiers: gemini-3.6-flash-high, claude-sonnet-4-6,
// gpt-oss-120b-medium, and elsewhere shapes like openai/gpt-4o or llama3:8b.
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/;
const SEPARATOR = /[-._:/]/;
const URL_SCHEME = /:\/\//;
const TRAILING_SEPARATOR = /[-._:/]$/;

/**
 * Is this token shaped like a model id rather than like prose?
 *
 * Lowercase-plus-a-separator gets most of the way, but two prose shapes slip
 * through it and both would produce the same bogus conclusion — that the default
 * model is missing — so both are excluded explicitly:
 *
 *   https://antigravity.google/oauth   a bare URL is all lowercase with slashes
 *   not-authenticated:                 an id never ends on its own separator
 */
function looksLikeModelId(token) {
  return MODEL_ID.test(token) &&
    SEPARATOR.test(token) &&
    !URL_SCHEME.test(token) &&
    !TRAILING_SEPARATOR.test(token);
}

// A trailing comma or semicolon is list punctuation; a trailing colon is NOT
// stripped, because doing so is what turned "not-authenticated:" into an id.
const firstField = (text) => text.trim().split(/\s+/)[0].replace(/[,;]+$/, "");

/**
 * Pull model ids out of whatever `agy models` printed.
 *
 * The format is not a contract and has already changed under us once: it used to
 * be one bare id per line, and is now `id<TAB>Display Name`. The original parser
 * kept only lines with no space in them, so every line with a display name was
 * discarded and the list came back empty — which the caller then reported as an
 * authentication failure. Hence: take the FIRST whitespace-delimited field of
 * each line and ignore the rest, which reads both formats.
 *
 * Deliberately biased towards false negatives. A dropped id degrades to "the
 * list could not be read", which is now a display-only note; a prose line
 * mistaken for an id would tell the user their default model is missing and send
 * them off to run `agy update` for nothing. That is why an id must be lowercase
 * and must contain a separator — "Fetching", "Available", "models" are not ids.
 */
export function parseModelList(stdout) {
  const ids = new Set();
  for (const rawLine of (stdout ?? "").split("\n")) {
    let line = rawLine.replace(ANSI, "").trim();
    if (!line) continue;

    // A table row. Which column holds the id is not ours to assume, so every
    // cell is considered: taking only the first would let a leading status or
    // version column ("| active-ok | gemini-3.6-flash-high |") mask the real id,
    // and a spare junk entry is much cheaper than a missing real one.
    if (line.startsWith("|")) {
      for (const cell of line.split("|")) {
        const token = firstField(cell);
        if (looksLikeModelId(token)) ids.add(token);
      }
      continue;
    }

    line = line.replace(LIST_MARKER, "");
    // Only the FIRST field: the rest of the line is the display name, and its
    // fragments ("3.6") would otherwise pass for ids themselves.
    const first = firstField(line);
    if (looksLikeModelId(first)) ids.add(first);
  }
  return [...ids];
}

/**
 * Decide what a finished `agy models` run means. Pure, so the three outcomes
 * that matter can be tested without a binary.
 *
 *   responded: false            agy failed, or exited 0 saying nothing at all.
 *                               That is the auth/quota shape, and the only one
 *                               that should ever count against readiness.
 *   responded, models non-empty the happy path.
 *   responded, models empty     agy answered in a format we could not read.
 *                               A bug in HERE, not in the user's install — so it
 *                               must never be reported as an auth problem and
 *                               must never block a review, which does not
 *                               consult this list at all.
 */
export function interpretModels(result) {
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "timed out"
      : result.notFound
        ? "could not be executed"
        : `exited ${result.code}`;
    const stderr = (result.stderr ?? "").trim().split("\n")[0];
    return {
      responded: false,
      models: [],
      reason: `\`agy models\` ${detail}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!(result.stdout ?? "").trim()) {
    return { responded: false, models: [], reason: "`agy models` exited 0 but printed nothing" };
  }
  const models = parseModelList(result.stdout);
  return {
    responded: true,
    models,
    reason: models.length > 0
      ? null
      : "`agy models` printed output in a format this plugin does not recognise",
  };
}

/**
 * List the models agy offers.
 *
 * This doubles as our readiness probe. It is the cheapest call that exercises
 * the binary end to end, and it spends no review quota. Note it is a readiness
 * signal, not a proof of authentication — agy may answer from a cached list.
 * Report it as "responds", never as "authenticated".
 */
export async function agyModels(agyPath, timeout = 30000) {
  return interpretModels(await run(agyPath, ["models"], { timeout }));
}

/**
 * Run the review.
 *
 * Only a short constant pointer goes on argv; the request and diff stay in the
 * 0600 temp file. agy runs from the repo root so its own repo detection works.
 *
 * The leash, defence in depth:
 *   --mode plan  agent-level read-only mode; it cannot edit files
 *   --sandbox    terminal restrictions
 *   --add-dir    workspace limited to the repo root plus our temp dir
 */
export const MODE_READ_ONLY = "plan";
export const MODE_WRITE = "accept-edits";

/**
 * The single place that decides whether agy may write.
 *
 * Centralised deliberately: "the reviewers cannot edit anything" is the property
 * this plugin most needs to keep, and an invariant enforced in one tested
 * function is worth more than the same rule spread across call sites. Only
 * `rescue`, and only without --read-only, ever yields write mode.
 */
export function resolveMode(subcommand, readOnly) {
  if (subcommand !== "rescue") return MODE_READ_ONLY;
  return readOnly ? MODE_READ_ONLY : MODE_WRITE;
}

export async function runReview({
  agyPath,
  repoRoot,
  workDir,
  requestFile,
  model,
  printTimeout,
  // "plan" is read-only and is the ONLY mode review and challenge ever use.
  // "accept-edits" lets agy write, and is reachable exclusively via rescue.
  mode = "plan",
  pointer: customPointer,
}) {
  const pointer = customPointer ??
    `Read the file '${requestFile}' and carry out the code review it specifies, ` +
    `exactly as instructed. Use your file tools on the repository at '${repoRoot}' ` +
    `to verify findings against real code before reporting them. Output only the review.`;

  if (mode !== MODE_READ_ONLY && mode !== MODE_WRITE) {
    throw new Error(`refusing to run agy with unrecognised mode '${mode}'`);
  }

  const started = Date.now();
  const result = await run(
    agyPath,
    [
      "--mode", mode,
      "--sandbox",
      "--add-dir", repoRoot,
      "--add-dir", workDir,
      "--model", model,
      "--print-timeout", printTimeout,
      "-p", pointer,
    ],
    { cwd: repoRoot },
  );
  const durationSeconds = Math.round((Date.now() - started) / 1000);

  return { ...result, durationSeconds };
}

/**
 * agy exits 0 with empty stdout on quota exhaustion and some backend errors, so
 * a successful exit code is not enough to conclude a review happened.
 */
export function classifyEmptyOutput(stderr, durationSeconds) {
  const reason = (stderr ?? "").trim() ||
    `agy returned no output (exit 0, empty stdout) after ${durationSeconds}s`;
  let className = "empty_output";
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(reason)) className = "quota";
  else if (/UNAUTHENTICATED|auth/i.test(reason)) className = "auth";
  return { className, reason };
}

/**
 * agy sometimes prefixes print-mode output with "MD Parse Error" and dumps the
 * model's raw scratchpad before the real answer. We deliberately do NOT
 * truncate — a heuristic cut could silently drop a real finding — but we flag it
 * so the caller knows the tail is the review and the head is noise.
 */
export function leakedReasoning(stdout) {
  return stdout.includes("MD Parse Error");
}

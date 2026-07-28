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

/**
 * List the models agy offers.
 *
 * This doubles as our readiness probe. It is the cheapest call that exercises
 * the binary end to end, and it spends no review quota. Note it is a readiness
 * signal, not a proof of authentication — agy may answer from a cached list.
 * Report it as "responds", never as "authenticated".
 */
export async function agyModels(agyPath, timeout = 30000) {
  const result = await run(agyPath, ["models"], { timeout });
  if (result.code !== 0) return null;
  const models = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(" "));
  return models.length > 0 ? models : null;
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

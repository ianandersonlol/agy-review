#!/usr/bin/env node
// agy-review — adversarial code review via agy (Google Antigravity CLI).
//
// Runs agy against YOUR ACTUAL REPO in read-only plan mode, so the reviewer can
// follow call sites instead of only critiquing the pasted diff.
//
// This is a Node port of the original bash implementation. The port exists for
// portability: the shell version embedded a POSIX temp path inside the prompt
// string, which MSYS could not rewrite on its way to a native agy.exe, so the
// reviewer opened a path that did not exist on Windows. Nothing here goes
// through a shell — every spawn takes an argv array and a natively-formatted
// path from os.tmpdir().

import { promises as fs } from "node:fs";
import path from "node:path";

import { parseArgs, USAGE, UsageError } from "./lib/args.mjs";
import {
  ANTIGRAVITY_URL,
  classifyEmptyOutput,
  findAgy,
  leakedReasoning,
  MODEL_DEFAULT,
  resolveMode,
  runReview,
} from "./lib/agy.mjs";
import {
  collectDiff,
  currentBranch,
  diffTrees,
  findGit,
  GitError,
  refExists,
  repoRoot,
  snapshotTree,
  treeChanges,
} from "./lib/git.mjs";
import { probeEnvironment, remediation } from "./lib/env.mjs";
import { buildRequest, buildRescueRequest } from "./lib/prompts.mjs";
import { scanForSecrets } from "./lib/secrets.mjs";
import { createTempDir, removeTempDir } from "./lib/tempdir.mjs";

const LARGE_DIFF_BYTES = 400000;

const log = (message) => process.stderr.write(`agy-review: ${message}\n`);
const raw = (message) => process.stderr.write(`${message}\n`);

class ExitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const die = (message, code = 1) => {
  throw new ExitError(message, code);
};

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) die(error.message, 2);
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.subcommand === "setup") return commandSetup(options);
  if (options.subcommand === "status") return commandStatus(options);
  if (options.subcommand === "rescue") return commandRescue(options);
  return commandReview(options);
}

// ── review / challenge ───────────────────────────────────────────────────────

async function commandReview(options) {
  const gitPath = await findGit();
  if (!gitPath) die("git not found on PATH", 2);

  const agyPath = options.dryRun ? null : await findAgy();
  if (!options.dryRun && !agyPath) {
    die(`agy not found on PATH (expected ~/.local/bin/agy). Run \`agy install\`, or see ${ANTIGRAVITY_URL}`, 2);
  }

  const root = await repoRoot(gitPath);
  if (!root) die("not inside a git repository — cd into your project first", 2);

  // Validate an explicit --base up front so we never silently review the wrong
  // thing after printing an error.
  if (options.base && !(await refExists(gitPath, root, options.base))) {
    die(`base ref '${options.base}' does not resolve in this repo`, 2);
  }

  const workDir = await createTempDir("agy-review-");
  try {
    let diff;
    try {
      diff = await collectDiff({
        gitPath,
        repoRoot: root,
        mode: options.diffMode,
        base: options.base,
        paths: options.paths,
        workDir,
      });
    } catch (error) {
      // A failed git invocation must not be reported as "no changes to review".
      if (error instanceof GitError) die(error.message, 2);
      throw error;
    }

    for (const skipped of diff.untrackedSkipped) {
      log(`skipping untracked file over 256KB: ${skipped}`);
    }
    if (diff.truncated) {
      log("WARNING: the diff exceeded the internal buffer limit and was truncated — scope it with paths or --staged");
    }

    if (!diff.text.trim()) {
      log(`no changes to review (${diff.description}).`);
      return 0;
    }

    const diffBytes = Buffer.byteLength(diff.text, "utf8");
    if (diffBytes > LARGE_DIFF_BYTES) {
      log(`WARNING: diff is ${diffBytes} bytes — consider scoping with paths or --staged.`);
    }

    // The diff is sent to Google. Block on obvious credential shapes unless waived.
    if (!options.allowSecrets) {
      const hits = scanForSecrets(diff.text);
      if (hits.length > 0) {
        raw("agy-review: BLOCKED — the diff contains added lines matching credential shapes.");
        raw("This review would send them to Google. Matched (diff line numbers):");
        for (const hit of hits) raw(`  ${hit.line}:${hit.text}`);
        raw("Scope it (agy-review -- path/to/safe/dir) or waive with --allow-secrets.");
        return 4;
      }
    }

    // Dry run stops here: the diff is assembled and the secret scan has passed,
    // but no agy call is made and no quota is spent. Useful for confirming scope
    // on a large branch and for checking whether the pre-flight will block.
    if (options.dryRun) {
      log(
        `dry run OK — lens=${options.lens} scope=${diff.description} files=${diff.filesChanged} ` +
          `diff=${diffBytes}B (no agy call, no quota spent)`,
      );
      return 0;
    }

    const branch = await currentBranch(gitPath, root);
    const request = buildRequest({
      lens: options.lens,
      repoRoot: root,
      branch,
      description: diff.description,
      filesChanged: diff.filesChanged,
      focus: options.focus,
      diff: diff.text,
    });

    // 0600 on POSIX. On Windows the mode is advisory; the real protection is
    // that os.tmpdir() resolves to a per-user directory whose ACL we inherit.
    const requestFile = path.join(workDir, "review-request.md");
    await fs.writeFile(requestFile, request, { mode: 0o600 });

    if (!options.quiet) {
      log(
        `lens=${options.lens} model=${options.model} scope=${diff.description} ` +
          `files=${diff.filesChanged} diff=${diffBytes}B timeout=${options.printTimeout}`,
      );
    }

    const result = await runReview({
      agyPath,
      repoRoot: root,
      workDir,
      requestFile,
      model: options.model,
      printTimeout: options.printTimeout,
    });

    if (result.code !== 0) {
      log(`agy exited ${result.code} after ${result.durationSeconds}s`);
      if (result.stderr.trim()) raw(result.stderr.trim());
      return result.code;
    }

    if (!result.stdout.trim()) {
      const { className, reason } = classifyEmptyOutput(result.stderr, result.durationSeconds);
      log(`no review produced [${className}]: ${reason}`);
      return 3;
    }

    if (leakedReasoning(result.stdout)) {
      log(
        "NOTE: agy leaked reasoning before the review (known agy print-mode quirk). " +
          "The real review is the FINAL findings block; everything before it is scratchpad.",
      );
    }

    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (!options.quiet) log(`completed in ${result.durationSeconds}s`);
    return 0;
  } finally {
    await removeTempDir(workDir);
  }
}

// ── rescue ───────────────────────────────────────────────────────────────────

/**
 * Diagnose and fix a problem. Unlike every other subcommand, the default mode
 * lets agy WRITE to the working tree.
 *
 * The safety model is entirely git-based, which is why a repository is
 * mandatory here even though a bare diagnosis would not strictly need one:
 * every change agy makes is recoverable, and we bracket the run with two tree
 * snapshots so the report shows precisely what it touched — not merely what
 * differs from HEAD, which would wrongly blame agy for the user's own work.
 */
async function commandRescue(options) {
  const gitPath = await findGit();
  if (!gitPath) die("git not found on PATH", 2);

  const agyPath = options.dryRun ? null : await findAgy();
  if (!options.dryRun && !agyPath) {
    die(`agy not found on PATH (expected ~/.local/bin/agy). Run \`agy install\`, or see ${ANTIGRAVITY_URL}`, 2);
  }

  const root = await repoRoot(gitPath);
  if (!root) {
    die(
      "rescue must run inside a git repository — it edits files, and git is what makes that undoable",
      2,
    );
  }

  const workDir = await createTempDir("agy-rescue-");
  try {
    // Context is the user's uncommitted work: often the cause, always a lead.
    let contextDiff = "";
    if (!options.noContext) {
      try {
        const diff = await collectDiff({
          gitPath,
          repoRoot: root,
          mode: "uncommitted",
          base: "",
          paths: options.paths,
          workDir,
        });
        contextDiff = diff.text;
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        log(`could not collect context diff (${error.message}); continuing without it`);
      }
    }

    // The context diff leaves the machine, so it gets the same pre-flight as a
    // review. The problem statement is the user's own words and is not scanned.
    if (contextDiff && !options.allowSecrets) {
      const hits = scanForSecrets(contextDiff);
      if (hits.length > 0) {
        raw("agy-review: BLOCKED — your uncommitted diff contains added lines matching credential shapes.");
        raw("Rescue would send them to Google as context. Matched (diff line numbers):");
        for (const hit of hits) raw(`  ${hit.line}:${hit.text}`);
        raw("Re-run with --no-context to omit the diff, or --allow-secrets to send it anyway.");
        return 4;
      }
    }

    const branch = await currentBranch(gitPath, root);
    const mode = resolveMode(options.subcommand, options.readOnly);

    if (options.dryRun) {
      log(
        `dry run OK — rescue mode=${mode} branch=${branch} context=${
          contextDiff ? `${Buffer.byteLength(contextDiff, "utf8")}B` : "none"
        } (no agy call, no quota spent, no files touched)`,
      );
      raw(`Problem: ${options.problem}`);
      return 0;
    }

    const request = buildRescueRequest({
      problem: options.problem,
      repoRoot: root,
      branch,
      readOnly: options.readOnly,
      contextDiff,
      focus: options.focus,
    });
    const requestFile = path.join(workDir, "rescue-request.md");
    await fs.writeFile(requestFile, request, { mode: 0o600 });

    // Snapshot BEFORE. Index lives in workDir — a scratch index inside the
    // repo would be picked up by `git add -A` and reported as agy's own edit.
    const before = options.readOnly
      ? null
      : await snapshotTree(gitPath, root, path.join(workDir, "index-before"));

    if (!options.quiet) {
      log(
        `rescue mode=${mode}${options.readOnly ? " (no edits)" : " — WILL EDIT FILES"} ` +
          `model=${options.model} branch=${branch} timeout=${options.printTimeout}`,
      );
    }

    const pointer =
      `Read the file '${requestFile}' and carry out the rescue request it specifies, ` +
      `exactly as instructed, working in the repository at '${root}'. ` +
      `Obey its hard constraints. Output only the report.`;

    const result = await runReview({
      agyPath,
      repoRoot: root,
      workDir,
      requestFile,
      model: options.model,
      printTimeout: options.printTimeout,
      mode,
      pointer,
    });

    // Snapshot AFTER, before interpreting the exit code: agy may have edited
    // files and then failed, and the user needs to know either way.
    let changes = [];
    let changeDiff = "";
    if (!options.readOnly && before) {
      const after = await snapshotTree(gitPath, root, path.join(workDir, "index-after"));
      changes = await treeChanges(gitPath, root, before, after);
      if (changes.length > 0) changeDiff = await diffTrees(gitPath, root, before, after);
    }

    const reportChanges = () => {
      if (options.readOnly) return;
      if (changes.length === 0) {
        log("agy made no file changes.");
        return;
      }
      raw("");
      raw(`agy-review: agy modified ${changes.length} file(s):`);
      for (const change of changes) raw(`  ${change.status}\t${change.file}`);
      raw("");
      raw("--- exact diff of what agy changed ---");
      process.stdout.write(changeDiff.endsWith("\n") ? changeDiff : `${changeDiff}\n`);
      raw("--- end of agy's changes ---");
      raw("Nothing was staged or committed. Review the above before keeping it.");
    };

    if (result.code !== 0) {
      log(`agy exited ${result.code} after ${result.durationSeconds}s`);
      if (result.stderr.trim()) raw(result.stderr.trim());
      reportChanges();
      return result.code;
    }

    if (!result.stdout.trim()) {
      const { className, reason } = classifyEmptyOutput(result.stderr, result.durationSeconds);
      log(`no report produced [${className}]: ${reason}`);
      reportChanges();
      return 3;
    }

    if (leakedReasoning(result.stdout)) {
      log("NOTE: agy leaked reasoning before the report (known agy print-mode quirk).");
    }

    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    reportChanges();
    if (!options.quiet) log(`completed in ${result.durationSeconds}s`);
    return 0;
  } finally {
    await removeTempDir(workDir);
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

async function commandSetup(options) {
  const environment = await probeEnvironment({ includeRepo: false });
  const steps = remediation(environment);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ready: environment.ready, environment, remediation: steps }, null, 2)}\n`);
    return environment.ready ? 0 : 2;
  }

  const out = [];
  out.push(environment.ready ? "agy-review is ready." : "agy-review is NOT ready.");
  out.push("");
  out.push(`  node   ${environment.node.ok ? "ok" : "TOO OLD"}  ${environment.node.version} (need >= ${environment.node.minimum})`);
  out.push(`  git    ${environment.git.ok ? "ok" : "MISSING"}  ${environment.git.version ?? "not found on PATH"}`);
  out.push(
    `  agy    ${environment.agy.ok ? "ok" : "NOT READY"}  ${
      environment.agy.path ? `${environment.agy.version ?? "unknown version"} at ${environment.agy.path}` : "not found on PATH"
    }`,
  );
  if (environment.agy.path) {
    out.push(
      `         models ${environment.agy.responds ? `respond (${environment.agy.models.length} available)` : "did NOT respond"}` +
        (environment.agy.defaultModelAvailable === false ? `; default ${MODEL_DEFAULT} is missing` : ""),
    );
  }
  out.push(`  platform  ${environment.platform}`);

  if (steps.length > 0) {
    out.push("", "To fix:");
    for (const step of steps) {
      out.push(`  - ${step.problem}`);
      out.push(`    ${step.fix}`);
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return environment.ready ? 0 : 2;
}

// ── status ───────────────────────────────────────────────────────────────────

async function commandStatus(options) {
  // The scope preview is purely local; the agy probe can touch the network.
  // Running them concurrently means status costs max(local, remote) instead of
  // the sum, so an offline machine still gets its diff preview promptly.
  const [environment, scope] = await Promise.all([
    probeEnvironment({ modelsTimeout: 5000 }),
    collectScopePreview(options),
  ]);
  const report = { ready: environment.ready, environment, scope };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const out = [];
  out.push(`Tools: node ${environment.node.version} · git ${environment.git.ok ? "ok" : "MISSING"} · agy ${
    environment.agy.ok ? `${environment.agy.version ?? "ok"} responding` : "NOT READY"
  } · ${environment.platform}`);

  if (!report.scope) {
    out.push("Repo:  not inside a git repository — cd into your project.");
  } else if (report.scope.error) {
    out.push(`Repo:  ${report.scope.error}`);
  } else {
    const scope = report.scope;
    out.push(`Repo:  ${scope.root} (branch ${scope.branch})`);
    out.push(`Scope: ${scope.description}`);
    if (scope.empty) {
      out.push("       nothing to review");
    } else {
      out.push(
        `       ${scope.filesChanged} file(s), ${scope.diffBytes} bytes${scope.large ? "  ← large, consider scoping" : ""}`,
      );
      out.push(
        `       credential pre-flight: ${scope.secretPreflight}${
          scope.secretMatches > 0 ? ` (${scope.secretMatches} matching added line(s))` : ""
        }`,
      );
    }
    for (const skipped of scope.untrackedSkipped) out.push(`       skipped untracked >256KB: ${skipped}`);
  }

  if (!environment.ready) {
    out.push("", "Not ready. Run `agy-review setup` for remediation steps.");
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

/**
 * Exactly what a review would send, without calling agy. Resolves git itself
 * rather than reusing the environment probe's result, so it can run
 * concurrently with that probe instead of waiting behind it.
 *
 * Returns null when there is no repository to describe.
 */
async function collectScopePreview(options) {
  const gitPath = await findGit();
  if (!gitPath) return null;
  const root = await repoRoot(gitPath);
  if (!root) return null;

  if (options.base && !(await refExists(gitPath, root, options.base))) {
    return { root, error: `base ref '${options.base}' does not resolve in this repo` };
  }

  const workDir = await createTempDir("agy-status-");
  try {
    const diff = await collectDiff({
      gitPath,
      repoRoot: root,
      mode: options.diffMode,
      base: options.base,
      paths: options.paths,
      workDir,
    });
    const diffBytes = Buffer.byteLength(diff.text, "utf8");
    const hits = scanForSecrets(diff.text);
    return {
      root,
      branch: await currentBranch(gitPath, root),
      description: diff.description,
      filesChanged: diff.filesChanged,
      diffBytes,
      empty: !diff.text.trim(),
      large: diffBytes > LARGE_DIFF_BYTES,
      untrackedSkipped: diff.untrackedSkipped,
      secretPreflight: hits.length > 0 ? "would BLOCK" : "clear",
      secretMatches: hits.length,
    };
  } catch (error) {
    // status is diagnostic: report the git failure rather than crashing, so the
    // tool-readiness half of the output still reaches the user.
    if (error instanceof GitError) return { root, error: error.message };
    throw error;
  } finally {
    await removeTempDir(workDir);
  }
}

// ── entrypoint ───────────────────────────────────────────────────────────────

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    if (error instanceof ExitError) {
      log(error.message);
      process.exitCode = error.code;
      return;
    }
    log(`unexpected failure: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });

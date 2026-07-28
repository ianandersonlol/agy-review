import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, UsageError } from "../skills/agy-review/scripts/lib/args.mjs";
import { buildRescueRequest } from "../skills/agy-review/scripts/lib/prompts.mjs";
import { run, which } from "../skills/agy-review/scripts/lib/exec.mjs";
import {
  MODE_READ_ONLY,
  MODE_WRITE,
  resolveMode,
  runReview,
} from "../skills/agy-review/scripts/lib/agy.mjs";
import { diffTrees, GitError, snapshotTree, treeChanges } from "../skills/agy-review/scripts/lib/git.mjs";

const gitPath = await which("git");
const skip = gitPath ? false : "git is not installed";

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-test-"));
  const real = await fs.realpath(dir);
  const git = (...args) => run(gitPath, args, { cwd: real });
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(real, "app.js"), "export const x = 1;\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  return { dir: real, git };
}

const cleanup = async (...dirs) => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
};

// ── argument handling ────────────────────────────────────────────────────────

test("rescue takes bare words as the problem statement", () => {
  const options = parseArgs(["rescue", "the", "login", "test", "fails"]);
  assert.equal(options.problem, "the login test fails");
  assert.deepEqual(options.paths, []);
});

test("rescue still scopes paths after --", () => {
  const options = parseArgs(["rescue", "tests fail", "--", "src/auth"]);
  assert.equal(options.problem, "tests fail");
  assert.deepEqual(options.paths, ["src/auth"]);
});

test("rescue without a problem statement is rejected", () => {
  assert.throws(() => parseArgs(["rescue"]), UsageError);
});

test("rescue --help does not demand a problem statement", () => {
  assert.equal(parseArgs(["rescue", "--help"]).help, true);
});

test("--problem and bare words compose", () => {
  const options = parseArgs(["rescue", "--problem", "build breaks", "on windows"]);
  assert.equal(options.problem, "build breaks on windows");
});

test("rescue defaults to write-capable, with an explicit read-only opt-out", () => {
  // Mirrors codex-rescue, which defaults to --write.
  assert.equal(parseArgs(["rescue", "x"]).readOnly, false);
  assert.equal(parseArgs(["rescue", "x", "--read-only"]).readOnly, true);
});

test("only rescue treats bare words as prose", () => {
  // For review, a bare word is a path — that must not change.
  assert.deepEqual(parseArgs(["review", "src"]).paths, ["src"]);
  assert.equal(parseArgs(["review", "src"]).problem, "");
});

// ── prompt construction ──────────────────────────────────────────────────────

const baseRequest = {
  problem: "the login test fails",
  repoRoot: "/repo",
  branch: "main",
  readOnly: false,
  contextDiff: "",
  focus: "",
};

test("the rescue prompt forbids touching git history", () => {
  // agy runs with write access; history must stay the user's to manage.
  const request = buildRescueRequest(baseRequest);
  for (const forbidden of ["commit", "push", "reset", "checkout", "rebase", "stash"]) {
    assert.ok(request.includes(forbidden), `should forbid ${forbidden}`);
  }
});

test("the rescue prompt forbids weakening tests into passing", () => {
  assert.ok(/do not weaken a test/i.test(buildRescueRequest(baseRequest)));
});

test("the rescue prompt demands the smallest change", () => {
  assert.ok(/smallest change/i.test(buildRescueRequest(baseRequest)));
});

test("write mode and read-only mode give opposite editing instructions", () => {
  const write = buildRescueRequest(baseRequest);
  const read = buildRescueRequest({ ...baseRequest, readOnly: true });
  assert.ok(/you have write access/i.test(write));
  assert.ok(/do NOT edit any files/i.test(read));
  assert.ok(!/do NOT edit any files/i.test(write));
});

test("the problem statement reaches the prompt", () => {
  assert.ok(buildRescueRequest(baseRequest).includes("the login test fails"));
});

test("context diff is included when present and omitted when not", () => {
  const withContext = buildRescueRequest({ ...baseRequest, contextDiff: "+broken line" });
  assert.ok(withContext.includes("+broken line"));
  assert.ok(withContext.includes("uncommitted work"));
  assert.ok(!buildRescueRequest(baseRequest).includes("uncommitted work"));
});

test("the rescue prompt requires an explicit verification section", () => {
  const request = buildRescueRequest(baseRequest);
  assert.ok(request.includes("### Verification"));
  assert.ok(request.includes("### Risks and gaps"));
  assert.ok(/unverified fix must be labelled/i.test(request));
});

// ── snapshot mechanics: the safety net for a write-capable run ───────────────

test("snapshots attribute only the changes made between them", { skip }, async () => {
  // The core safety property: the user's own uncommitted work must never be
  // reported as something agy did.
  const { dir } = await makeRepo();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-work-"));
  try {
    await fs.writeFile(path.join(dir, "app.js"), "export const x = 2; // user's WIP\n");
    await fs.writeFile(path.join(dir, "user-note.txt"), "mine\n");

    const before = await snapshotTree(gitPath, dir, path.join(work, "index-before"));

    // Simulate agy's edits.
    await fs.writeFile(path.join(dir, "app.js"), "export const x = 3; // agy\n");
    await fs.writeFile(path.join(dir, "agy-new.js"), "export const y = 1;\n");

    const after = await snapshotTree(gitPath, dir, path.join(work, "index-after"));
    const changes = await treeChanges(gitPath, dir, before, after);
    const files = changes.map((c) => c.file).sort();

    assert.deepEqual(files, ["agy-new.js", "app.js"]);
    assert.ok(!files.includes("user-note.txt"), "the user's own new file is not agy's change");

    const diff = await diffTrees(gitPath, dir, before, after);
    assert.ok(diff.includes("// agy"));
    assert.ok(!diff.includes("mine"), "the user's untouched file must not appear in the diff");
  } finally {
    await cleanup(dir, work);
  }
});

test("snapshotting leaves the index, HEAD, and worktree untouched", { skip }, async () => {
  const { dir, git } = await makeRepo();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-work-"));
  try {
    await fs.writeFile(path.join(dir, "staged.js"), "staged\n");
    await git("add", "staged.js");
    const headBefore = (await git("rev-parse", "HEAD")).stdout.trim();
    const stagedBefore = (await git("diff", "--cached", "--name-only")).stdout.trim();

    await snapshotTree(gitPath, dir, path.join(work, "index-snap"));

    assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), headBefore, "HEAD must not move");
    assert.equal(
      (await git("diff", "--cached", "--name-only")).stdout.trim(),
      stagedBefore,
      "staging must be preserved exactly",
    );
    assert.equal((await git("stash", "list")).stdout.trim(), "", "must not create a stash");
  } finally {
    await cleanup(dir, work);
  }
});

test("a snapshot index inside the repo is refused", { skip }, async () => {
  // `git add -A` would capture the scratch index itself and report it as a
  // change agy made. Caught this the hard way while testing.
  const { dir } = await makeRepo();
  try {
    await assert.rejects(
      () => snapshotTree(gitPath, dir, path.join(dir, "index-inside")),
      GitError,
    );
  } finally {
    await cleanup(dir);
  }
});

test("gitignored files are excluded from snapshots", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-work-"));
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n");
    const before = await snapshotTree(gitPath, dir, path.join(work, "a"));
    await fs.writeFile(path.join(dir, "debug.log"), "noise\n");
    const after = await snapshotTree(gitPath, dir, path.join(work, "b"));
    assert.deepEqual(await treeChanges(gitPath, dir, before, after), []);
  } finally {
    await cleanup(dir, work);
  }
});

test("an unchanged tree yields no reported changes", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-work-"));
  try {
    const before = await snapshotTree(gitPath, dir, path.join(work, "a"));
    const after = await snapshotTree(gitPath, dir, path.join(work, "b"));
    assert.equal(before, after, "identical trees should hash identically");
    assert.deepEqual(await treeChanges(gitPath, dir, before, after), []);
  } finally {
    await cleanup(dir, work);
  }
});

test("deletions are reported", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rescue-work-"));
  try {
    const before = await snapshotTree(gitPath, dir, path.join(work, "a"));
    await fs.rm(path.join(dir, "app.js"));
    const after = await snapshotTree(gitPath, dir, path.join(work, "b"));
    const changes = await treeChanges(gitPath, dir, before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, "D");
    assert.equal(changes[0].file, "app.js");
  } finally {
    await cleanup(dir, work);
  }
});

// ── the write-mode invariant ─────────────────────────────────────────────────

test("only rescue can ever select write mode", () => {
  // The property this plugin most needs to keep: a reviewer that can edit the
  // code it is reviewing is a co-author, not a second opinion.
  for (const subcommand of ["review", "challenge", "setup", "status"]) {
    assert.equal(
      resolveMode(subcommand, false), MODE_READ_ONLY,
      `${subcommand} must be read-only`,
    );
    assert.equal(resolveMode(subcommand, true), MODE_READ_ONLY);
  }
});

test("rescue writes by default and honours --read-only", () => {
  assert.equal(resolveMode("rescue", false), MODE_WRITE);
  assert.equal(resolveMode("rescue", true), MODE_READ_ONLY);
});

test("an unrecognised subcommand falls back to read-only", () => {
  // Fail closed: a future subcommand is read-only until it opts in explicitly.
  assert.equal(resolveMode("something-new", false), MODE_READ_ONLY);
  assert.equal(resolveMode(undefined, false), MODE_READ_ONLY);
});

test("runReview refuses an unrecognised mode outright", async () => {
  await assert.rejects(
    () => runReview({
      agyPath: "/nonexistent", repoRoot: "/tmp", workDir: "/tmp",
      requestFile: "/tmp/x", model: "m", printTimeout: "1m", mode: "yolo",
    }),
    /unrecognised mode/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, UsageError } from "../skills/agy-review/scripts/lib/args.mjs";

test("defaults to the review subcommand and the defect lens", () => {
  const options = parseArgs([]);
  assert.equal(options.subcommand, "review");
  assert.equal(options.lens, "defect");
  assert.equal(options.diffMode, "branch");
  assert.equal(options.model, "gemini-3.6-flash-high");
});

test("challenge subcommand selects the design lens", () => {
  assert.equal(parseArgs(["challenge"]).lens, "design");
});

test("--lens overrides the subcommand default in both directions", () => {
  assert.equal(parseArgs(["review", "--lens", "design"]).lens, "design");
  assert.equal(parseArgs(["challenge", "--lens", "defect"]).lens, "defect");
});

test("rejects an unknown lens", () => {
  assert.throws(() => parseArgs(["--lens", "vibes"]), UsageError);
});

test("bare numeric timeouts are read as seconds", () => {
  assert.equal(parseArgs(["--timeout", "45"]).printTimeout, "45s");
});

test("go durations pass through untouched", () => {
  assert.equal(parseArgs(["--timeout", "10m"]).printTimeout, "10m");
  assert.equal(parseArgs(["--timeout", "1.5h"]).printTimeout, "1.5h");
});

test("nonsense timeouts are rejected rather than reaching agy", () => {
  assert.throws(() => parseArgs(["--timeout", "soon"]), UsageError);
  assert.throws(() => parseArgs(["--timeout", "10 minutes"]), UsageError);
});

test("flags requiring a value fail when it is missing", () => {
  for (const flag of ["--base", "--model", "--focus", "--lens", "--timeout"]) {
    assert.throws(() => parseArgs([flag]), UsageError, `${flag} should require a value`);
  }
});

test("unknown flags are rejected instead of being treated as paths", () => {
  assert.throws(() => parseArgs(["--wat"]), UsageError);
});

test("paths collect before and after the -- separator", () => {
  assert.deepEqual(parseArgs(["src", "--", "lib", "test"]).paths, ["src", "lib", "test"]);
});

test("a path after -- is never parsed as a flag", () => {
  // Without this, a file literally named --staged would silently change scope.
  const options = parseArgs(["--", "--staged"]);
  assert.deepEqual(options.paths, ["--staged"]);
  assert.equal(options.diffMode, "branch");
});

test("diff mode flags are honoured", () => {
  assert.equal(parseArgs(["--staged"]).diffMode, "staged");
  assert.equal(parseArgs(["--uncommitted"]).diffMode, "uncommitted");
});

test("setup and status accept --json", () => {
  assert.equal(parseArgs(["setup", "--json"]).json, true);
  assert.equal(parseArgs(["status", "--json"]).json, true);
});

test("a subcommand name is only consumed in first position", () => {
  // `agy-review -- status` is asking to scope to a path called status.
  assert.deepEqual(parseArgs(["--", "status"]).paths, ["status"]);
  assert.equal(parseArgs(["--", "status"]).subcommand, "review");
});

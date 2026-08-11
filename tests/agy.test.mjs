import assert from "node:assert/strict";
import test from "node:test";

import {
  interpretModels,
  MODEL_DEFAULT,
  parseModelList,
} from "../skills/agy-review/scripts/lib/agy.mjs";
import { remediation, summariseAgy } from "../skills/agy-review/scripts/lib/env.mjs";

// Verbatim from `agy models` — the format that broke the original parser.
const TSV = [
  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

test("the id<TAB>display-name format parses", () => {
  // The regression: every display name contains spaces, the old parser dropped
  // every line containing a space, and a working install looked unauthenticated.
  const models = parseModelList(TSV);
  assert.equal(models.length, 6);
  assert.ok(models.includes(MODEL_DEFAULT));
  assert.ok(models.includes("claude-sonnet-4-6"));
  assert.ok(models.every((id) => !id.includes("\t") && !id.includes(" ")));
});

test("the older bare-id-per-line format still parses", () => {
  assert.deepEqual(parseModelList("gemini-3.6-flash-high\ngemini-3.1-pro-low\n"), [
    "gemini-3.6-flash-high",
    "gemini-3.1-pro-low",
  ]);
});

test("decoration around the ids is tolerated", () => {
  const models = parseModelList(
    [
      "  - gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
      "  * gemini-3.1-pro-low",
      "1. claude-opus-4-6-thinking\tClaude Opus 4.6",
      "| gpt-oss-120b-medium | GPT-OSS 120B |",
      "\u001B[32mgemini-3.6-flash-low\u001B[0m\tGemini 3.6 Flash (Low)",
    ].join("\n"),
  );
  assert.deepEqual(models, [
    "gemini-3.6-flash-high",
    "gemini-3.1-pro-low",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
    "gemini-3.6-flash-low",
  ]);
});

test("prose is not mistaken for a model id", () => {
  // A false positive here would claim the default model is missing and send the
  // user off to run `agy update` for nothing.
  const models = parseModelList(
    [
      "Fetching available models...",
      "Available models:",
      "ID\tName",
      "",
      "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
      "Sign in at https://antigravity.google to continue",
    ].join("\n"),
  );
  assert.deepEqual(models, ["gemini-3.6-flash-high"]);
});

test("lowercase prose shapes that survive the separator rule are still rejected", () => {
  // Both of these are all-lowercase with separators, so only the explicit
  // exclusions keep them out — and either alone would be read as "your default
  // model is missing, run agy update".
  assert.deepEqual(parseModelList("https://antigravity.google/oauth\n"), []);
  assert.deepEqual(parseModelList("not-authenticated: please sign in\n"), []);
  assert.deepEqual(parseModelList("visit http://localhost:8080/auth to continue\n"), []);
  // A trailing separator is never part of an id, but an internal one is.
  assert.deepEqual(parseModelList("llama3:8b\nopenai/gpt-4o\n"), ["llama3:8b", "openai/gpt-4o"]);
});

test("a table row does not let a leading status column mask the id", () => {
  // find(Boolean) took the first cell, so "active-ok" would have been the only
  // id parsed out of this row and the real model would have vanished.
  const models = parseModelList("| active-ok | gemini-3.6-flash-high | Gemini 3.6 Flash |\n");
  assert.ok(models.includes(MODEL_DEFAULT), "the real id must survive");
});

test("a display name never contributes fragments of its own", () => {
  // "3.6" is lowercase-ish, starts with a digit and contains a separator — it
  // only stays out because just the first field of a line is considered.
  assert.deepEqual(parseModelList("gemini-3.6-flash-high\tGemini 3.6 Flash (High)"), [
    "gemini-3.6-flash-high",
  ]);
});

test("ids are deduplicated and empty input yields an empty list", () => {
  assert.deepEqual(parseModelList("a-b\na-b\n"), ["a-b"]);
  assert.deepEqual(parseModelList(""), []);
  assert.deepEqual(parseModelList(null), []);
});

test("a successful run with a readable list is a clean probe", () => {
  const probe = interpretModels({ code: 0, stdout: TSV, stderr: "Fetching available models..." });
  assert.equal(probe.responded, true);
  assert.equal(probe.reason, null);
  assert.ok(probe.models.includes(MODEL_DEFAULT));
});

test("exit 0 with no output at all is a non-response", () => {
  // The auth/quota shape: agy said nothing, so we genuinely do not know it works.
  const probe = interpretModels({ code: 0, stdout: "  \n", stderr: "" });
  assert.equal(probe.responded, false);
  assert.match(probe.reason, /printed nothing/);
});

test("a failed run carries its reason", () => {
  const failed = interpretModels({ code: 1, stdout: "", stderr: "UNAUTHENTICATED\nmore" });
  assert.equal(failed.responded, false);
  assert.match(failed.reason, /exited 1: UNAUTHENTICATED/);

  const timedOut = interpretModels({ code: 124, stdout: "", stderr: "", timedOut: true });
  assert.match(timedOut.reason, /timed out/);
});

test("unreadable output counts as responding, not as failing", () => {
  // The whole point of the fix: a format we cannot read is our bug, not the
  // user's broken install.
  const probe = interpretModels({ code: 0, stdout: "<xml><model/></xml>\n", stderr: "" });
  assert.equal(probe.responded, true);
  assert.deepEqual(probe.models, []);
  assert.match(probe.reason, /format this plugin does not recognise/);
});

test("an unreadable model list does not make the environment unready", () => {
  const agy = summariseAgy("/usr/local/bin/agy", "agy 1.0", {
    responded: true,
    models: [],
    reason: "unrecognised",
  });
  assert.equal(agy.ok, true, "agy answered — it is ready");
  assert.equal(agy.responds, true);
  assert.equal(agy.modelListUnreadable, true);
  assert.equal(agy.defaultModelAvailable, null, "unknown, not missing");

  const steps = remediation({ node: { ok: true }, git: { ok: true }, agy, repo: null });
  assert.equal(steps.length, 1);
  assert.doesNotMatch(steps[0].problem, /authentic/i, "must not be blamed on auth");
  assert.doesNotMatch(steps[0].fix, /OAuth/i);
});

test("a readable list drives the default-model check", () => {
  const present = summariseAgy("/bin/agy", null, { responded: true, models: [MODEL_DEFAULT], reason: null });
  assert.equal(present.defaultModelAvailable, true);
  assert.equal(present.modelListUnreadable, false);
  assert.deepEqual(remediation({ node: { ok: true }, git: { ok: true }, agy: present, repo: null }), []);

  const absent = summariseAgy("/bin/agy", null, { responded: true, models: ["something-else"], reason: null });
  assert.equal(absent.defaultModelAvailable, false);
  const steps = remediation({ node: { ok: true }, git: { ok: true }, agy: absent, repo: null });
  assert.match(steps[0].fix, /agy update/);
});

test("a non-responding agy is still a readiness failure pointing at auth", () => {
  const agy = summariseAgy("/bin/agy", null, {
    responded: false,
    models: [],
    reason: "`agy models` exited 0 but printed nothing",
  });
  assert.equal(agy.ok, false);
  assert.equal(agy.models, null);
  const steps = remediation({ node: { ok: true }, git: { ok: true }, agy, repo: null });
  assert.match(steps[0].fix, /OAuth/);
});

test("a missing agy reports as absent rather than as a parse problem", () => {
  const agy = summariseAgy(null, null, null);
  assert.equal(agy.ok, false);
  assert.equal(agy.responds, false);
  assert.equal(agy.modelListUnreadable, false);
  assert.equal(agy.probeReason, null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildRequest, isLens, LENSES } from "../skills/agy-review/scripts/lib/prompts.mjs";

const base = {
  repoRoot: "/repo",
  branch: "feature",
  description: "working tree vs main",
  filesChanged: 3,
  focus: "",
  diff: "diff --git a/x b/x\n+added\n",
};

test("isLens recognises exactly the two lenses", () => {
  assert.ok(isLens("defect"));
  assert.ok(isLens("design"));
  assert.equal(isLens("constructor"), false, "must not inherit from Object.prototype");
  assert.equal(isLens("nope"), false);
});

test("both lenses embed the repo root so the reviewer reads real code", () => {
  for (const lens of ["defect", "design"]) {
    const request = buildRequest({ ...base, lens });
    assert.ok(request.includes("/repo"), `${lens} should name the repo root`);
    assert.ok(request.includes("read access to the entire repository"));
  }
});

test("the diff is fenced and present", () => {
  const request = buildRequest({ ...base, lens: "defect" });
  assert.ok(request.includes("```diff"));
  assert.ok(request.includes("+added"));
});

test("verdict vocabularies are disjoint across lenses", () => {
  // A council transcript can contain both reviews. If the verdict words
  // overlapped, the reconciler could not tell which lens reached which verdict.
  const defectWords = ["SHIP", "REVISE", "RETHINK"];
  const designWords = ["SOUND", "RECONSIDER", "WRONG-SHAPE"];
  const defect = buildRequest({ ...base, lens: "defect" });
  const design = buildRequest({ ...base, lens: "design" });

  for (const word of defectWords) {
    assert.ok(defect.includes(`Verdict: ${word}`), `defect lens should offer ${word}`);
    assert.ok(!design.includes(`Verdict: ${word}`), `design lens must not offer ${word}`);
  }
  for (const word of designWords) {
    assert.ok(design.includes(`Verdict: ${word}`), `design lens should offer ${word}`);
    assert.ok(!defect.includes(`Verdict: ${word}`), `defect lens must not offer ${word}`);
  }
});

test("the defect lens asks for severities, the design lens does not", () => {
  const defect = buildRequest({ ...base, lens: "defect" });
  const design = buildRequest({ ...base, lens: "design" });
  assert.ok(defect.includes("CRITICAL, HIGH, MEDIUM, LOW"));
  assert.ok(!design.includes("CRITICAL, HIGH, MEDIUM, LOW"));
  assert.ok(design.includes("CHALLENGE"));
});

test("the design lens explicitly defers bug hunting", () => {
  const design = buildRequest({ ...base, lens: "design" });
  assert.ok(/do not report implementation defects/i.test(design));
});

test("both lenses demand a concrete failure condition", () => {
  // The guard against plausible-sounding but unfalsifiable findings.
  assert.ok(/drop the finding entirely/i.test(buildRequest({ ...base, lens: "defect" })));
  assert.ok(/drop the challenge entirely/i.test(buildRequest({ ...base, lens: "design" })));
});

test("both lenses require a VERIFIED/SUSPECTED confidence marker", () => {
  for (const lens of ["defect", "design"]) {
    const request = buildRequest({ ...base, lens });
    assert.ok(request.includes("VERIFIED"), `${lens} needs VERIFIED`);
    assert.ok(request.includes("SUSPECTED"), `${lens} needs SUSPECTED`);
  }
});

test("focus text is injected when present and absent otherwise", () => {
  const withFocus = buildRequest({ ...base, lens: "defect", focus: "auth and data loss" });
  assert.ok(withFocus.includes("## Focus from the author"));
  assert.ok(withFocus.includes("auth and data loss"));
  assert.ok(!buildRequest({ ...base, lens: "defect" }).includes("## Focus from the author"));
});

test("metadata reaches the reviewer", () => {
  const request = buildRequest({ ...base, lens: "defect" });
  assert.ok(request.includes("Branch: feature"));
  assert.ok(request.includes("Scope: working tree vs main"));
  assert.ok(request.includes("Files changed: 3"));
});

test("every lens defines the full section set", () => {
  for (const [name, spec] of Object.entries(LENSES)) {
    for (const key of ["title", "intro", "body", "format"]) {
      assert.ok(spec[key]?.trim(), `${name}.${key} must be non-empty`);
    }
  }
});

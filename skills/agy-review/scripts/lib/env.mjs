// Shared readiness probe behind `setup` and `status`.

import { agyModels, agyVersion, ANTIGRAVITY_URL, findAgy, MODEL_DEFAULT } from "./agy.mjs";
import { findGit, repoRoot } from "./git.mjs";
import { run } from "./exec.mjs";

const NODE_MINIMUM = 18;

/**
 * Inspect the local toolchain. Never throws, never spends review quota — every
 * field is either a fact or null, and the caller decides how loud to be.
 */
export async function probeEnvironment({
  cwd = process.cwd(),
  includeRepo = true,
  // `agy models` can reach the network. `setup` is explicitly a readiness check
  // and can afford to wait; `status` is mostly a local scope preview and passes
  // a short bound so an offline or proxied machine does not stall it.
  modelsTimeout = 30000,
} = {}) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

  const gitPath = await findGit();
  let gitVersion = null;
  if (gitPath) {
    const result = await run(gitPath, ["--version"], { timeout: 15000 });
    if (result.code === 0) gitVersion = result.stdout.trim();
  }

  const agyPath = await findAgy();
  const version = agyPath ? await agyVersion(agyPath) : null;
  const probe = agyPath ? await agyModels(agyPath, modelsTimeout) : null;

  const environment = {
    node: {
      version: process.versions.node,
      ok: Number.isFinite(nodeMajor) && nodeMajor >= NODE_MINIMUM,
      minimum: `${NODE_MINIMUM}.0.0`,
    },
    platform: process.platform,
    git: { path: gitPath, version: gitVersion, ok: Boolean(gitPath) },
    agy: summariseAgy(agyPath, version, probe),
    repo: null,
  };

  if (includeRepo && gitPath) {
    const root = await repoRoot(gitPath, cwd);
    environment.repo = { root, ok: Boolean(root) };
  }

  environment.ready = environment.node.ok && environment.git.ok && environment.agy.ok;
  return environment;
}

/**
 * Turn the raw agy probe into the reported facts. Pure, so the distinction it
 * exists to keep can be tested.
 *
 * Readiness hangs on `responds` alone, never on how many models we managed to
 * read out. Those were previously the same thing, and when agy changed its
 * output format the plugin declared a working, authenticated install broken and
 * sent the user off to redo an OAuth flow that was fine. A list we cannot read
 * is a defect in this plugin, and reviews never consult the list at all.
 */
export function summariseAgy(agyPath, version, probe) {
  const responds = Boolean(probe?.responded);
  const models = responds ? probe.models : null;
  // agy answered, but in a shape parseModelList did not recognise.
  const modelListUnreadable = responds && probe.models.length === 0;
  return {
    path: agyPath,
    version,
    // `responds` is deliberately not called `authenticated` — see agyModels.
    responds,
    models,
    modelListUnreadable,
    // Why the probe came back as it did, when there is anything to say.
    probeReason: probe?.reason ?? null,
    // null means "unknown", and only an outright false is worth acting on: an
    // unreadable list must not be read as "your default model is missing".
    defaultModelAvailable: models?.length ? models.includes(MODEL_DEFAULT) : null,
    ok: Boolean(agyPath) && responds,
  };
}

/** Ordered, actionable remediation for whatever is not ready. */
export function remediation(environment) {
  const steps = [];
  if (!environment.node.ok) {
    steps.push({
      problem: `Node ${environment.node.version} is older than the required ${environment.node.minimum}.`,
      fix: "Install a current Node runtime (https://nodejs.org) and re-run.",
    });
  }
  if (!environment.git.ok) {
    steps.push({
      problem: "git was not found on PATH.",
      fix: "Install git and make sure it is on PATH.",
    });
  }
  if (!environment.agy.path) {
    steps.push({
      problem: "agy was not found on PATH.",
      fix:
        "Install Google Antigravity, then run `agy install` to configure your " +
        `shell PATH. Download: ${ANTIGRAVITY_URL}`,
    });
  } else if (!environment.agy.responds) {
    steps.push({
      problem: environment.agy.probeReason
        ? `agy is installed but did not answer: ${environment.agy.probeReason}.`
        : "agy is installed but `agy models` returned nothing.",
      fix:
        "Usually authentication. Run `agy` once interactively to complete the " +
        "OAuth flow, then re-run this check. If that succeeds, quota may be exhausted.",
    });
  } else if (environment.agy.modelListUnreadable) {
    // Not a readiness failure, and pointedly not an auth one: agy answered.
    steps.push({
      problem:
        "agy answered, but this plugin could not read its model list — the output " +
        "format has probably changed again. Reviews are unaffected; only this " +
        "readiness display and the default-model check are.",
      fix:
        "Update the agy-review plugin. If it persists, run `agy models` and report " +
        "its output at https://github.com/ianandersonlol/agy-review/issues.",
    });
  } else if (environment.agy.defaultModelAvailable === false) {
    steps.push({
      problem: `The default model ${MODEL_DEFAULT} is not in this agy build's model list.`,
      fix: "Run `agy update`, or pass --model with one of the listed models.",
    });
  }
  if (environment.repo && !environment.repo.ok) {
    steps.push({
      problem: "The current directory is not inside a git repository.",
      fix: "cd into your project before running a review.",
    });
  }
  return steps;
}

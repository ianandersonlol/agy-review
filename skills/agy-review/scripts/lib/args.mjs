// Argument parsing. Mirrors the flags of the original shell implementation so
// existing invocations, docs, and command files keep working.

import { MODEL_DEFAULT, TIMEOUT_DEFAULT } from "./agy.mjs";
import { isLens } from "./prompts.mjs";

export class UsageError extends Error {}

const SUBCOMMANDS = new Set(["review", "challenge", "rescue", "setup", "status"]);

const GO_DURATION = /^[0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h)$/;

export function parseArgs(argv) {
  const args = [...argv];
  let subcommand = "review";
  if (args.length > 0 && SUBCOMMANDS.has(args[0])) {
    subcommand = args.shift();
  }

  const options = {
    subcommand,
    // `challenge` is the design lens; `review` defaults to defect but --lens wins.
    lens: subcommand === "challenge" ? "design" : "defect",
    model: MODEL_DEFAULT,
    printTimeout: TIMEOUT_DEFAULT,
    base: "",
    diffMode: "branch",
    allowSecrets: false,
    focus: "",
    quiet: false,
    dryRun: false,
    json: false,
    help: false,
    // rescue only: free text describing the problem, and the opt-out from
    // agy actually editing files.
    problem: "",
    readOnly: false,
    noContext: false,
    paths: [],
  };

  // For rescue, bare words are the problem statement, not path scoping —
  // `agy-review rescue "the login test fails"`. Paths still come after `--`.
  const bareWords = [];

  const requireValue = (flag, rest) => {
    if (rest.length === 0) throw new UsageError(`${flag} requires a value`);
    return rest.shift();
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--base":
        options.base = requireValue("--base", args);
        break;
      case "--model":
        options.model = requireValue("--model", args);
        break;
      case "--focus":
        options.focus = requireValue("--focus", args);
        break;
      case "--lens": {
        const value = requireValue("--lens", args);
        if (!isLens(value)) throw new UsageError(`--lens must be 'defect' or 'design', got '${value}'`);
        options.lens = value;
        break;
      }
      case "--timeout": {
        const value = requireValue("--timeout", args);
        // agy wants a Go duration ("10m"). A bare number reaches agy as an
        // invalid duration and fails with an opaque error, so catch it here and
        // treat it as seconds.
        if (/^[0-9]+$/.test(value)) options.printTimeout = `${value}s`;
        else if (GO_DURATION.test(value)) options.printTimeout = value;
        else {
          throw new UsageError(
            "--timeout must be a Go duration like 30s, 10m, 1h (bare numbers are read as seconds)",
          );
        }
        break;
      }
      case "--staged":
        options.diffMode = "staged";
        break;
      case "--uncommitted":
        options.diffMode = "uncommitted";
        break;
      case "--allow-secrets":
        options.allowSecrets = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--read-only":
        options.readOnly = true;
        break;
      case "--no-context":
        options.noContext = true;
        break;
      case "--problem":
        options.problem = requireValue("--problem", args);
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--":
        options.paths.push(...args);
        args.length = 0;
        break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown flag: ${arg}`);
        if (subcommand === "rescue") bareWords.push(arg);
        else options.paths.push(arg);
        break;
    }
  }

  if (subcommand === "rescue") {
    const spoken = bareWords.join(" ").trim();
    // An explicit --problem wins; bare words are appended so both forms compose.
    options.problem = [options.problem, spoken].filter(Boolean).join(" ").trim();
    if (!options.problem && !options.help) {
      throw new UsageError(
        'rescue needs a problem statement, e.g. agy-review rescue "the login test fails after my change"',
      );
    }
  }

  return options;
}

export const USAGE = `agy-review — adversarial review of your working diff via agy (Gemini), with real repo access.

Usage:
  agy-review [subcommand] [options] [-- <paths>...]

Subcommands:
  review              hunt for defects in the diff (default)
  challenge           challenge the design and approach instead of the implementation
  rescue "<problem>"  diagnose and FIX a problem — this one EDITS YOUR FILES
  setup               check that agy, git, and node are ready; explain how to fix what is not
  status              show tool readiness plus what a review would cover right now

Options:
  --base REF          compare against REF (default: auto — origin/HEAD, main, or master)
  --staged            review only staged changes
  --uncommitted       review only uncommitted changes (vs HEAD)
  --lens defect|design  override the lens for the chosen subcommand
  --model ID          agy model (default: ${MODEL_DEFAULT}; see \`agy models\`)
  --focus TEXT        extra instruction, e.g. --focus "auth and data loss"
  --timeout DUR       agy print timeout, Go duration (default: ${TIMEOUT_DEFAULT})
  --allow-secrets     skip the secret-shape pre-flight scan
  --quiet             suppress the metadata header on stderr
  --dry-run           build the diff and run the secret scan, then stop without
                      calling agy — shows exactly what would be reviewed and
                      spends no quota
  --json              machine-readable output (setup and status only)
  -h, --help          this message

rescue only:
  --read-only         diagnose and propose a fix WITHOUT editing anything
  --no-context        do not include your uncommitted diff as context
  --problem TEXT      the problem statement (equivalent to bare words)

rescue runs agy with --mode accept-edits, so it MODIFIES YOUR WORKING TREE. It
never touches git history or staging, and it reports a precise diff of every
change it made. review and challenge are always read-only.

The reviewer runs read-only (--mode plan --sandbox) and can read the whole repo,
so it verifies claims against real code rather than guessing from the diff.

Exit codes: 0 ok · 2 setup problem · 3 agy produced no output · 4 blocked by the
credential pre-flight.`;

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectories = [
  "internal/cli",
  "goalbuddy/scripts",
  "goalbuddy/surfaces/local-goal-board/scripts",
  "goalbuddy/surfaces/local-goal-board/scripts/lib",
];
const testDirectories = ["internal/test", "goalbuddy/surfaces/local-goal-board/test"];

function filesIn(directory, suffix) {
  const files = readdirSync(join(packageRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
  if (!files.length) throw new Error(`No ${suffix} files found in ${directory}`);
  return files;
}

// Use the current runtime and argument arrays: no shell globbing or quoting is needed.
export function runNode(args, cwd = packageRoot) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`Node subprocess terminated by ${result.signal}`);
    const signalNumber = constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);
  const testsOnly = args.length === 1 && args[0] === "--tests-only";
  if (args.length && !testsOnly) {
    console.error("Usage: node internal/cli/check.mjs [--tests-only]");
    process.exitCode = 2;
    return;
  }
  if (!testsOnly) {
    const sources = sourceDirectories.flatMap((directory) => filesIn(directory, ".mjs"));
    console.log(`Checking syntax in ${sources.length} source files.`);
    // node --check accepts one script; subsequent paths would only be script arguments.
    for (const file of sources) runNode(["--check", file]);
  }
  const tests = testDirectories.flatMap((directory) => filesIn(directory, ".test.mjs"));
  console.log(`Running ${tests.length} internal and board test files.`);
  runNode(["--test", ...tests]);
}

try {
  // Stdin's '-' is not a file entry. Real file entries may use directory aliases.
  if (process.argv[1] && process.argv[1] !== "-" && existsSync(process.argv[1]) && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
    main();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

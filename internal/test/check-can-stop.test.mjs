import { copyFileSync, constants, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fakeCommandBin, fixtureEnv, forwardGit } from "./core-fixtures.mjs";
import assert from "node:assert/strict";

import { toYamlLines } from "../../goalbuddy/scripts/apply-receipt.mjs";
import { acceptanceContext, literalCommand } from "../../goalbuddy/scripts/acceptance-proof.mjs";
import { sha256 } from "../../goalbuddy/scripts/file-snapshot.mjs";

const script = resolve(process.env.GOALBUDDY_TEST_SCRIPT_ROOT || "goalbuddy/scripts", "check-can-stop.mjs");
const recorder = resolve("goalbuddy/scripts/record-acceptance.mjs");
const packageNode = process.platform === "win32" ? "node" : `"${process.execPath}"`;

function makeGoal(state) {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-can-stop-"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "goal.md"), "# Test goal\n");
  writeFileSync(join(root, "state.yaml"), state.trimStart());
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [script, root, "--json"], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(result.stdout || result.stderr) };
}

const activeState = `
version: 2
goal:
  title: "Keep going"
  slug: "keep-going"
  kind: specific
  tranche: "Continue safe work"
  status: active
  oracle:
    signal: "The requested outcome works."
    final_proof: "A final audit verifies the outcome."
  intake:
    completion_proof: "The final audit passes."
rules:
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T001
tasks:
  - id: T001
    type: pm
    assignee: PM
    status: active
    objective: "Continue the next safe work package."
    receipt: null
checks:
  dirty_fingerprint: clean
  last_verification:
    result: unknown
    task: null
    commands: []
`;

test("rejects host turn exit while an active task remains", () => {
  const root = makeGoal(activeState);
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.equal(result.report.can_stop, false);
    assert.equal(result.report.reason, "runnable_work_remains");
    assert.equal(result.report.active_task, "T001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const doneState = `
version: 2
goal:
  title: "Finished"
  slug: "finished"
  kind: specific
  tranche: "Verify completion"
  status: done
  oracle:
    signal: "The requested outcome works."
    final_proof: "T999 verifies the complete outcome."
  intake:
    completion_proof: "T999 passes."
rules:
  continuous_until_full_outcome: true
  no_completion_on_weak_proof: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit the full outcome."
    receipt:
      result: done
      decision: complete
      full_outcome_complete: true
      summary: "The original outcome is verified."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T999
    commands: []
`;

test("legacy terminal completion without acceptance proof is rejected without rewriting history", () => {
  const root = makeGoal(doneState);
  try {
    const original = readFileSync(join(root, "state.yaml"), "utf8");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.equal(result.report.can_stop, false);
    assert.equal(result.report.reason, "acceptance_not_proven");
    assert.equal(readFileSync(join(root, "state.yaml"), "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allows the exact validated terminal approval wait", () => {
  const root = makeGoal(`
version: 2
goal:
  title: "Approval gate"
  slug: "approval-gate"
  kind: specific
  tranche: "Wait for exact approval"
  status: blocked
rules:
  continuous_until_full_outcome: true
  missing_input_or_credentials_do_not_stop_goal: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: blocked
    objective: "Apply the approved production change."
    allowed_files:
      - src/**
    verify:
      - npm test
    stop_if:
      - "Exact approval is missing."
    receipt:
      result: blocked
      waiting_for_user_approval: true
      required_reply: "approve production"
      blocked_reason: "Production change requires exact approval."
      summary: "Asked once and stopped."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: unknown
    task: T001
    commands: []
`);
  try {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.equal(result.report.can_stop, true);
    assert.equal(result.report.reason, "validated_terminal_block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function acceptanceProject({ failing = false, inputs = [], timeout = 5 } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "goalbuddy-acceptance-"));
  const goal = join(repo, "docs/goals/one");
  mkdirSync(join(goal, "notes"), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/result.txt"), failing ? "broken\n" : "working\n");
  writeFileSync(join(repo, "acceptance.mjs"), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("src/result.txt", "utf8") === "working\\n" ? 0 : 1);\n');
  writeFileSync(join(goal, "goal.md"), "# Deliver a working result\n");
  const project = { repo, goal, command: [process.execPath, "acceptance.mjs"], config: { command: [process.execPath, "acceptance.mjs"], artifacts: ["src"], inputs, timeout_seconds: timeout } };
  stateFor(project);
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return project;
}

function stateFor(project, evidence, receiptChanges = {}, verification = "pass") {
  const active = !evidence;
  const receipt = active ? "    receipt: null\n" : "    receipt:\n" + toYamlLines({ result: "done", decision: "complete", full_outcome_complete: true, summary: "Final audit consumed the observed acceptance.", ...evidence, ...receiptChanges }, 6).join("\n") + "\n";
  let state = doneState.replace(/    receipt:\n[\s\S]*?checks:\n/, () => `${toYamlLines({ acceptance: project.config }, 4).join("\n")}\n${receipt}checks:\n`);
  if (active) state = state.replace("  status: done", "  status: active").replace("    status: done", "    status: active").replace("active_task: null", "active_task: T999").replace("    result: pass", "    result: unknown");
  else state = state.replace("    result: pass", `    result: ${verification}`);
  writeFileSync(join(project.goal, "state.yaml"), state);
}

function record(project, env = {}) {
  const result = spawnSync(process.execPath, [recorder, project.goal, "--", ...project.command], { cwd: project.repo, encoding: "utf8", timeout: project.outerTimeout || 15000, env: { ...process.env, ...env } });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, report: JSON.parse(result.stdout || result.stderr) };
}
// Independent native npm execution for the exact-command failure controls.
// These fixtures use only safe ASCII npm arguments; scripts remain in package.json.
function runActual(command, options) {
  if (process.platform === "win32" && ["npm", "npm.cmd"].includes(command[0])) {
    assert.ok(command.slice(1).every(arg => /^[A-Za-z0-9_./:=+-]+$/.test(arg)));
    return spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32/cmd.exe"), ["/d", "/s", "/c", command.join(" ")], { ...options, shell: false, windowsVerbatimArguments: true });
  }
  return spawnSync(command[0], command.slice(1), options);
}
function finalize(project, observed, changes = {}, verification = "pass") { stateFor(project, observed.report.audit_evidence, changes, verification); }
function edit(path, from, to) { writeFileSync(path, readFileSync(path, "utf8").replace(from, to)); }
function changeProof(project, observed, mutate) {
  const proof = JSON.parse(readFileSync(observed.report.proof_path));
  mutate(proof);
  const bytes = JSON.stringify(proof);
  writeFileSync(observed.report.proof_path, bytes);
  // Even a final audit that hashes the malformed evidence must not legitimize it.
  observed.report.audit_evidence.acceptance_sha256 = sha256(bytes);
  finalize(project, observed);
}

// Original failure assertion retained: a failed independent check and terminal claim
// cannot authorize completion, regardless of the newer recorder's setup protocol.
test("reproduced failed verification and independent acceptance cannot complete a terminal board", () => {
  const project = acceptanceProject({ failing: true });
  try {
    writeFileSync(join(project.goal, "state.yaml"), doneState.replace("result: pass", "result: fail"));
    assert.equal(spawnSync(process.execPath, ["acceptance.mjs"], { cwd: project.repo }).status, 1);
    const before = readFileSync(join(project.goal, "state.yaml"));
    const result = run(project.goal);
    assert.equal(result.status, 1, JSON.stringify(result.report));
    assert.equal(result.report.can_stop, false);
    assert.match(result.report.errors.join(" "), /non-passing/);
    assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), before);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("one observed verification is consumed by final audit without a second execution", () => {
  const project = acceptanceProject();
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("invocations", "run\\n");\n');
    const before = readFileSync(join(project.goal, "state.yaml"));
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    assert.equal(observed.report.cleanup.status, "not_required");
    assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), before);
    assert.equal(run(project.goal).report.reason, "runnable_work_remains");
    finalize(project, observed);
    const result = run(project.goal);
    assert.equal(result.status, 0, JSON.stringify(result.report));
    assert.equal(result.report.reason, "full_outcome_complete");
    assert.equal(result.report.board_revision, sha256(readFileSync(join(project.goal, "state.yaml"))));
    assert.equal(readFileSync(join(project.repo, "invocations"), "utf8"), "run\n");
    assert.equal(record(project).status, 1, "A finalized historical audit cannot run implicitly again.");
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("failed acceptance stays failed despite final audit completion claims", () => {
  const project = acceptanceProject({ failing: true });
  try {
    const observed = record(project);
    assert.equal(observed.status, 1);
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).exit_status, 1);
    assert.equal(observed.report.cleanup.status, "not_required");
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("recovery records a new attempt and preserves the failed historical evidence", () => {
  const project = acceptanceProject({ failing: true });
  try {
    const failed = record(project), bytes = readFileSync(failed.report.proof_path);
    writeFileSync(join(project.repo, "src/result.txt"), "working\n");
    const passed = record(project);
    assert.equal(passed.status, 0);
    assert.notEqual(passed.report.proof_path, failed.report.proof_path);
    finalize(project, passed);
    assert.equal(run(project.goal).report.can_stop, true);
    assert.deepEqual(readFileSync(failed.report.proof_path), bytes);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ["artifact contents", ({ repo }) => writeFileSync(join(repo, "src/result.txt"), "broken\n")],
  ["artifact directory additions", ({ repo }) => writeFileSync(join(repo, "src/extra.txt"), "new\n")],
  ["deleted artifact", ({ repo }) => rmSync(join(repo, "src/result.txt"))],
  ["charter", ({ goal }) => writeFileSync(join(goal, "goal.md"), "# A different outcome\n")],
  ["board outcome", ({ goal }) => edit(join(goal, "state.yaml"), 'title: "Finished"', 'title: "Different"')],
  ["acceptance settings", ({ goal }) => edit(join(goal, "state.yaml"), "timeout_seconds: 5", "timeout_seconds: 6")],
  ["omitted local validator", ({ repo }) => writeFileSync(join(repo, "acceptance.mjs"), "process.exit(1);\n")],
]) {
  test(`completion rejects stale proof after ${name} changes`, () => {
    const project = acceptanceProject();
    try {
      const observed = record(project);
      assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed); mutate(project);
      const result = run(project.goal);
      assert.equal(result.status, 1, JSON.stringify(result.report));
      assert.match(result.report.errors.join(" "), /stale|must exist/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("declared configuration inputs are bound even when omitted from artifacts", () => {
  const project = acceptanceProject({ inputs: ["config.txt"] });
  try {
    writeFileSync(join(project.repo, "config.txt"), "good");
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("config.txt", "utf8") === "good" ? 0 : 1);');
    const observed = record(project);
    assert.equal(observed.status, 0);
    finalize(project, observed);
    writeFileSync(join(project.repo, "config.txt"), "bad");
    assert.equal(spawnSync(process.execPath, project.command.slice(1), { cwd: project.repo }).status, 1);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("package launchers bind local script entry points and package configuration", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "run", "accept"];
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} acceptance.mjs` } }));
    stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
    edit(join(project.repo, "acceptance.mjs"), "process.exit(", "process.exit(1 || ");
    assert.equal(run(project.goal).report.can_stop, false);
    writeFileSync(join(project.repo, "acceptance.mjs"), "process.exit(0);");
    stateFor(project);
    const next = record(project);
    assert.equal(next.status, 0);
    finalize(project, next);
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" -e "process.exit(1)"` } }));
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

const literalEntryCases = [
  { name: "direct literal file", file: "acceptance.mjs", direct: ["acceptance.mjs"] },
  { name: "direct extensionless file", file: "acceptance", direct: ["acceptance"] },
  { name: "direct literal shell punctuation without a shell", file: "acceptance %!&^$'.mjs", direct: ["acceptance %!&^$'.mjs"] },
  { name: "direct filename with spaces", file: "acceptance check.mjs", direct: ["acceptance check.mjs"] },
  { name: "package literal file", file: "acceptance.mjs", script: "node acceptance.mjs" },
  { name: "package extensionless file", file: "acceptance", script: "node acceptance" },
  { name: "concrete subdirectory file", file: "checks/run.mjs", script: "node checks/run.mjs" },
  { name: "ASCII tab separator", file: "acceptance.mjs", script: "node\tacceptance.mjs" },
  { name: "quoted local filename", file: "acceptance check.mjs", script: 'node "acceptance check.mjs"' },
  { name: "single-quoted local filename", file: "acceptance check.mjs", script: "node 'acceptance check.mjs'", posixOnly: true },
  { name: "escaped local filename", file: "acceptance check.mjs", script: "node acceptance\\ check.mjs", posixOnly: true },
  { name: "quoted local executable", file: "acceptance check.sh", script: '"./acceptance check.sh"', executable: true },
  { name: "direct local executable", file: "acceptance check.sh", direct: ["./acceptance check.sh"], executable: true },
  { name: "explicit-input concrete-file control", file: "acceptance.mjs", script: "node acceptance.mjs", explicit: true },
  { name: "unquoted NBSP without decoy", file: "acceptance\u00a0check.mjs", script: "node acceptance\u00a0check.mjs" },
  { name: "explicit-input NBSP control", file: "acceptance\u00a0check.mjs", script: "node acceptance\u00a0check.mjs", explicit: true, decoy: true },
  { name: "quoted tab filename", file: "acceptance\tcheck.mjs", script: 'node "acceptance\tcheck.mjs"', invalidOnWindows: true },
  ...[
    ["NBSP", "\u00a0"], ["narrow NBSP", "\u202f"], ["em space", "\u2003"],
    ["Unicode line separator", "\u2028"], ["BOM", "\ufeff"],
  ].flatMap(([name, space]) => [
    { name: `unquoted ${name}`, file: `acceptance${space}check.mjs`, script: `node acceptance${space}check.mjs`, decoy: true },
    { name: `quoted ${name} control`, file: `acceptance${space}check.mjs`, script: `node "acceptance${space}check.mjs"`, decoy: true },
  ]),
];
for (const entry of literalEntryCases) {
  test(`R3 local entry freshness: ${entry.name}`, () => {
    const recovery = process.platform === "win32" && (entry.invalidOnWindows || entry.posixOnly || entry.executable);
    const file = recovery ? "acceptance check.mjs" : entry.file;
    const shellExecutable = entry.executable && !recovery;
    const project = acceptanceProject({ inputs: ["config.txt", ...(entry.explicit ? [file] : [])] });
    try {
      mkdirSync(join(project.repo, "checks"), { recursive: true });
      writeFileSync(join(project.repo, "config.txt"), "good");
      writeFileSync(join(project.repo, file), shellExecutable ? "#!/bin/sh\nexit 0\n" : "process.exit(0);\n");
      if (recovery && entry.executable) writeFileSync(join(project.repo, entry.file), "#!/bin/sh\nexit 0\n");
      if (entry.decoy) writeFileSync(join(project.repo, "acceptance"), "process.exit(0);\n");
      if (shellExecutable) chmodSync(join(project.repo, file), 0o755);
      const pkg = entry.script ? { scripts: { accept: entry.script } } : {};
      writeFileSync(join(project.repo, "package.json"), JSON.stringify(pkg));
      project.command = project.config.command = entry.direct ? (entry.executable ? entry.direct : [process.execPath, ...entry.direct]) : ["npm", "run", "--silent", "accept"];
      stateFor(project);
      if (recovery) {
        // Native cmd rejects POSIX-only escaping/shell executables, and Windows
        // cannot create tab filenames. Each rejected launch recovers with direct
        // concrete Node argv and retains the actual execution/freshness proof.
        const rejected = record(project);
        assert.equal(rejected.status, 1); assert.equal(rejected.report.proof_path, undefined);
        assert.match(rejected.report.error, /direct local validator/);
        project.command = project.config.command = [process.execPath, file]; stateFor(project);
      }
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      const board = readFileSync(join(project.goal, "state.yaml")), proof = readFileSync(observed.report.proof_path);
      writeFileSync(join(project.repo, file), shellExecutable ? "#!/bin/sh\nexit 1\n" : "process.exit(1);\n");
      const actual = runActual(project.command, { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
      assert.deepEqual(readFileSync(observed.report.proof_path), proof);
      assert.equal(run(project.goal).report.can_stop, false, "A validator-only change must invalidate the earlier passing proof.");
      const inputs = JSON.parse(proof).binding.inputs;
      assert.ok(inputs.includes(file), "The concrete validator is bound.");
      assert.ok(JSON.parse(proof).binding.local_entry_points.includes(file));
      if (entry.decoy) assert.ok(!inputs.includes("acceptance"), "Unicode whitespace must not select a different file.");
      assert.ok(!inputs.includes(".") && !inputs.includes("checks"), "Bind the exact file without hashing its directory.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

// Directory launch support was deliberately removed: metadata and admitted
// inputs cannot make Node's directory/extension fallback a concrete file argv.
for (const entry of [
  { name: "package main with admitted validator", directory: ".", operand: ".", main: "acceptance.mjs", explicit: true },
  { name: "package main with spaces", directory: ".", operand: ".", main: "acceptance check.mjs" },
  { name: "direct package main", directory: ".", operand: ".", main: "acceptance.mjs", direct: true },
  { name: "root index", directory: ".", operand: "." },
  { name: "direct root index slash", directory: ".", operand: "./", direct: true },
  { name: "root main slash", directory: ".", operand: "./", main: "acceptance.mjs" },
  { name: "subdirectory main shadow", directory: "checks", operand: "checks", main: "run.mjs", shadow: true },
  { name: "subdirectory index shadow", directory: "checks", operand: "checks", shadow: true },
  { name: "direct subdirectory shadow", directory: "checks", operand: "checks", main: "run.mjs", shadow: true, direct: true },
  { name: "subdirectory slash shadow with admitted files", directory: "checks", operand: "checks/", main: "run.mjs", shadow: true, explicit: true },
  { name: "subdirectory main without shadow", directory: "checks", operand: "checks", main: "run.mjs", explicit: true },
  { name: "subdirectory index without shadow", directory: "checks", operand: "checks" },
  { name: "direct subdirectory index slash", directory: "checks", operand: "checks/", direct: true },
  { name: "quoted subdirectory", directory: "check dir", operand: '"check dir/"', main: "run.mjs" },
]) {
  test(`R4 directory rejects before execution and concrete-file recovery stays fresh: ${entry.name}`, () => {
    const file = entry.directory === "." ? entry.main || "index.js" : `${entry.directory}/${entry.main || "index.js"}`;
    const project = acceptanceProject({ inputs: ["config.txt", ...(entry.explicit ? [file, ...(entry.shadow ? ["checks.js"] : [])] : [])] });
    try {
      mkdirSync(join(project.repo, entry.directory), { recursive: true });
      writeFileSync(join(project.repo, "config.txt"), "good");
      const markerCode = 'import("node:fs").then(fs => fs.appendFileSync("invocations", "run\\n"));\n';
      writeFileSync(join(project.repo, file), markerCode);
      if (entry.shadow) writeFileSync(join(project.repo, "checks.js"), markerCode);
      const pkg = { scripts: { accept: `node ${entry.operand}` } };
      if (entry.directory === "." && entry.main) pkg.main = entry.main;
      writeFileSync(join(project.repo, "package.json"), JSON.stringify(pkg));
      if (entry.directory !== "." && entry.main) writeFileSync(join(project.repo, entry.directory, "package.json"), JSON.stringify({ main: entry.main }));
      project.command = project.config.command = entry.direct ? [process.execPath, entry.operand] : ["npm", "run", "--silent", "accept"];
      stateFor(project);
      const activeBoard = readFileSync(join(project.goal, "state.yaml"));
      const rejected = record(project);
      assert.equal(rejected.status, 1, JSON.stringify(rejected.report));
      assert.equal(rejected.report.proof_path, undefined);
      assert.match(rejected.report.error, /exact local file.*direct local validator.*concrete filename.*acceptance.inputs/i);
      assert.equal(existsSync(join(project.repo, "invocations")), false, "The directory command must never execute.");
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), activeBoard);

      project.command = project.config.command = [process.execPath, file];
      stateFor(project);
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      assert.equal(run(project.goal).report.can_stop, false, "The final audit must consume the one observed verification.");
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      assert.equal(readFileSync(join(project.repo, "invocations"), "utf8"), "run\n");
      const board = readFileSync(join(project.goal, "state.yaml")), proof = readFileSync(observed.report.proof_path);
      assert.ok(JSON.parse(proof).binding.local_entry_points.includes(file));
      assert.ok(!JSON.parse(proof).binding.inputs.includes(entry.directory));
      writeFileSync(join(project.repo, file), "process.exit(1);\n");
      const actual = runActual(project.command, { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.equal(run(project.goal).report.can_stop, false);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
      assert.deepEqual(readFileSync(observed.report.proof_path), proof);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const entry of [
  { name: "unresolved declared main despite index fallback", script: "node .", main: "missing.mjs" },
  { name: "directory-valued main", script: "node .", main: "checks" },
  { name: "implicit extension resolution", script: "node acceptance", extra: "acceptance.js" },
  { name: "file with trailing slash", script: "node acceptance.mjs/" },
  { name: "unresolved directory", script: "node missing" },
  { name: "unbalanced quote", script: "node 'acceptance.mjs" },
  { name: "newline", script: "node acceptance.mjs\nnode acceptance.mjs" },
  { name: "quoted newline", script: 'node "acceptance\ncheck.mjs"' },
  { name: "quoted carriage return", script: 'node "acceptance\rcheck.mjs"' },
  { name: "command composition", script: "node acceptance.mjs && node acceptance.mjs" },
  { name: "shell expansion", script: 'node "$VALIDATOR"' },
  { name: "shell glob", script: "node acceptance*.mjs" },
  { name: "shell assignment", script: "VALIDATOR=acceptance.mjs node acceptance.mjs" },
  { name: "nested package launcher", script: "npm run alternate" },
  { name: "shell wrapper", script: 'sh -c "node acceptance.mjs"' },
  { name: "direct opaque wrapper", direct: ["env", "node", "."], main: "acceptance.mjs" },
  { name: "unresolved Node option", script: "node --require ./preload.cjs ." },
]) {
  test(`unresolved local entry rejects before execution: ${entry.name}`, () => {
    const project = acceptanceProject();
    try {
      const markerCode = 'import("node:fs").then(fs => fs.writeFileSync("executed", "bad"));';
      for (const name of ["acceptance.mjs", "index.js", "preload.cjs", ...(entry.extra ? [entry.extra] : [])]) writeFileSync(join(project.repo, name), markerCode);
      mkdirSync(join(project.repo, "checks")); writeFileSync(join(project.repo, "checks/index.js"), markerCode);
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ ...(entry.main ? { main: entry.main } : {}), scripts: { accept: entry.script } }));
      project.command = project.config.command = entry.direct || ["npm", "run", "--silent", "accept"]; stateFor(project);
      const observed = record(project, { VALIDATOR: "acceptance.mjs" });
      assert.equal(observed.status, 1, JSON.stringify(observed.report));
      assert.equal(observed.report.proof_path, undefined, "Reject before any execution attempt.");
      assert.equal(existsSync(join(project.repo, "executed")), false);
      assert.match(observed.report.error, /direct local validator/i);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const argv of [
  ["run", "--silent", "accept"],
  ["--silent", "run", "accept"],
  ["-s", "run", "accept"],
  ["run", "accept", "--silent"],
  ["run", "--loglevel", "silent", "accept"],
  ["--loglevel=silent", "run-script", "accept"],
  ["run", "--", "accept"],
  ["run", "accept", "--", "--prefix", "elsewhere", "--silent"],
]) {
  test(`R2 npm validator remains bound: ${argv.join(" ")}`, () => {
    const project = acceptanceProject();
    try {
      project.command = project.config.command = ["npm", ...argv];
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} acceptance.mjs` } }));
      stateFor(project);
      const observed = record(project);
      assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      writeFileSync(join(project.repo, "acceptance.mjs"), "process.exit(1);");
      const actual = runActual(["npm", ...argv], { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.equal(run(project.goal).report.can_stop, false, "The exact declared command now fails; its earlier proof is stale.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("R2 sequence continuation cannot hide a failed verification status", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project); assert.equal(observed.status, 0);
    finalize(project, observed);
    edit(join(project.goal, "state.yaml"), "    commands: []", '    commands:\n      - status: fail\n          status: pass\n          cmd: "node acceptance.mjs"');
    const result = run(project.goal);
    assert.equal(result.report.can_stop, false, JSON.stringify(result.report));
    assert.match(result.report.errors.join(" "), /Duplicate YAML key/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const argv of [
  ["--prefix", "nested", "run", "accept"],
  ["run", "accept", "--prefix=nested"],
  ["run", "--workspace", "nested", "accept"],
  ["run", "--unknown", "accept"],
  ["run", "--loglevel", "accept"],
  ["--", "run", "accept"],
  ["exec", "node", "acceptance.mjs"],
]) {
  test(`ambiguous package launcher rejects without execution: ${argv.join(" ")}`, () => {
    const project = acceptanceProject();
    try {
      project.command = project.config.command = ["npm", ...argv];
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} acceptance.mjs` } }));
      writeFileSync(join(project.repo, "acceptance.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "bad");');
      stateFor(project);
      const observed = record(project);
      assert.equal(observed.status, 1, JSON.stringify(observed.report));
      assert.match(observed.report.error, /[Pp]ackage/);
      assert.equal(existsSync(join(project.repo, "executed")), false);
      assert.equal(observed.report.proof_path, undefined, "Rejected before launching a command.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("package lifecycle alias and pre/post entry points are bound", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "--silent", "test"];
    const scripts = { test: `${packageNode} acceptance.mjs`, pretest: `${packageNode} before.mjs`, posttest: `${packageNode} after.mjs` };
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts }));
    writeFileSync(join(project.repo, "before.mjs"), "process.exit(0);");
    writeFileSync(join(project.repo, "after.mjs"), "process.exit(0);");
    stateFor(project);
    const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const entries = JSON.parse(readFileSync(observed.report.proof_path)).binding.local_entry_points;
    assert.ok(entries.includes("before.mjs") && entries.includes("after.mjs"));
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    for (const path of ["before.mjs", "after.mjs"]) {
      writeFileSync(join(project.repo, path), "process.exit(1);");
      assert.equal(run(project.goal).report.can_stop, false);
      writeFileSync(join(project.repo, path), "process.exit(0);");
    }
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("implicit or absent package scripts require an explicit local validator", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "start"];
    writeFileSync(join(project.repo, "package.json"), "{}");
    writeFileSync(join(project.repo, "server.js"), 'require("fs").writeFileSync("executed", "bad");');
    stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 1);
    assert.match(observed.report.error, /explicitly declared/);
    assert.equal(existsSync(join(project.repo, "executed")), false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const target of ["proof", "artifact"]) {
  test(`missing or symlinked ${target} cannot certify completion`, () => {
    const project = acceptanceProject();
    try {
      const observed = record(project);
      assert.equal(observed.status, 0);
      finalize(project, observed);
      const path = target === "proof" ? observed.report.proof_path : join(project.repo, "src/result.txt");
      const backup = join(project.repo, "preserved-evidence");
      const bytes = readFileSync(path);
      writeFileSync(backup, bytes); rmSync(path);
      assert.equal(run(project.goal).report.can_stop, false);
      symlinkSync(backup, path);
      assert.equal(run(project.goal).report.can_stop, false);
      assert.deepEqual(readFileSync(backup), bytes);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("stop checker never executes board commands and recorder requires explicit matching argv", () => {
  const project = acceptanceProject();
  try {
    project.config.command = [process.execPath, "-e", 'require("fs").writeFileSync("executed", "bad")'];
    stateFor(project);
    assert.equal(run(project.goal).report.can_stop, false);
    assert.equal(record(project).status, 1);
    assert.throws(() => readFileSync(join(project.repo, "executed")), /ENOENT/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const target of ["src/result.txt", "docs/goals/one/state.yaml"]) {
  test(`recorder rejects verification that mutates ${target}`, () => {
    const project = acceptanceProject();
    try {
      writeFileSync(join(project.repo, "acceptance.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(target)}, "\\n# changed\\n");`);
      const observed = record(project);
      assert.equal(observed.status, 1);
      assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).result, "fail");
      assert.match(readFileSync(join(project.repo, target), "utf8"), /changed/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const field of ["missing_evidence", "remaining_blockers", "contradictions", "blocked_tasks"]) {
  test(`completion cannot override audit ${field}`, () => {
    const project = acceptanceProject();
    try { const observed = record(project); finalize(project, observed, { [field]: ["unresolved"] }); assert.equal(run(project.goal).report.can_stop, false); }
    finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const [name, mutate] of [
  ["missing stdout", proof => { delete proof.stdout; }],
  ["missing stderr", proof => { delete proof.stderr; }],
  ["malformed output", proof => { proof.stdout.bytes = "unknown"; }],
  ["contradictory exit", proof => { proof.exit_status = 1; }],
  ["contradictory cleanup", proof => { proof.cleanup = { status: "unproven" }; }],
  ["future timestamp", proof => { proof.finished_at = new Date(Date.now() + 3600000).toISOString(); }],
  ["wrong command", proof => { proof.command = ["true"]; }],
  ["historical v1 proof", proof => { proof.version = 1; }],
]) {
  test(`completion rejects ${name} even if the audit hashes it`, () => {
    const project = acceptanceProject();
    try { const observed = record(project); changeProof(project, observed, mutate); assert.equal(run(project.goal).report.can_stop, false); }
    finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("earlier passing version-2 evidence without additive cleanup facts remains supported", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project);
    assert.equal(observed.status, 0);
    changeProof(project, observed, proof => { delete proof.cleanup; });
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const key of ["result", "result ", "result\t"]) {
  test(`normalized duplicate YAML ${JSON.stringify(key)} is rejected`, () => {
    const project = acceptanceProject();
    try {
      edit(join(project.goal, "state.yaml"), "    result: unknown", `    ${key}: fail\n    result: unknown`);
      assert.equal(record(project).status, 1);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("duplicate JSON proof members are rejected after escape normalization", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project);
    const bytes = readFileSync(observed.report.proof_path, "utf8").replace('"result": "pass"', '"\\u0072esult": "fail", "result": "pass"');
    writeFileSync(observed.report.proof_path, bytes);
    observed.report.audit_evidence.acceptance_sha256 = sha256(bytes);
    finalize(project, observed);
    assert.match(run(project.goal).report.errors.join(" "), /Duplicate JSON/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("explicit freshness expiry is enforced without a universal one-day cap", () => {
  const project = acceptanceProject();
  try {
    project.config.max_age_seconds = 10 * 86400; stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0);
    changeProof(project, observed, proof => { proof.started_at = "2020-01-01T00:00:00.000Z"; proof.finished_at = "2020-01-01T00:00:01.000Z"; });
    assert.match(run(project.goal).report.errors.join(" "), /stale/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("configured timeout is observed and large ordinary logs do not fail successful checks", () => {
  const project = acceptanceProject({ timeout: 130 });
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'process.stdout.write("a".repeat(5 * 1024 * 1024)); process.stderr.write("b".repeat(5 * 1024 * 1024));');
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.equal(proof.timeout_seconds, 130);
    assert.equal(proof.stdout.bytes, 5 * 1024 * 1024);
    assert.equal(proof.stderr.truncated, true);
    assert.ok(readFileSync(observed.report.proof_path).length < 200000);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("timeout failure preserves observed signal and cannot complete", () => {
  const project = acceptanceProject({ timeout: 0.05 });
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'setTimeout(() => {}, 2000);');
    const observed = record(project);
    assert.equal(observed.status, 1);
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.equal(proof.timed_out, true);
    assert.match(proof.signal, /SIGTERM|SIGKILL/);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("timeout also terminates a package launcher's validator process group", { skip: process.platform === "win32" }, () => {
  const project = acceptanceProject({ timeout: 1 });
  try {
    project.command = project.config.command = ["npm", "run", "accept"];
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} acceptance.mjs` } }));
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("started", "yes"); process.on("SIGTERM", () => {}); setTimeout(() => {}, 10000);');
    stateFor(project);
    const start = Date.now(), observed = record(project);
    assert.equal(observed.status, 1);
    assert.equal(readFileSync(join(project.repo, "started"), "utf8"), "yes");
    assert.ok(Date.now() - start < 6000, "Timeout must not await the launcher's surviving child.");
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).timed_out, true);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const stdio of ["ignore", "inherit"]) {
  test(`R2 timeout cleans same-group ${stdio} descendants before returning`, { skip: process.platform === "win32" }, async () => {
    const project = acceptanceProject({ timeout: 0.4, inputs: ["child.mjs"] });
    try {
      writeFileSync(join(project.repo, "child.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("child.pid", String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => writeFileSync("alive-after-grace", "yes"), 2200); setTimeout(() => process.exit(0), 5000);');
      writeFileSync(join(project.repo, "acceptance.mjs"), `import { spawn } from "node:child_process"; spawn(process.execPath, ["child.mjs"], { stdio: "${stdio}" }); setTimeout(() => {}, 10000);`);
      const started = Date.now(), observed = record(project), elapsed = Date.now() - started;
      assert.equal(observed.status, 1);
      assert.ok(existsSync(join(project.repo, "child.pid")), "The descendant actually started.");
      await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, started + 2800 - Date.now())));
      assert.equal(existsSync(join(project.repo, "alive-after-grace")), false, "The child survived timeout escalation.");
      assert.ok(elapsed >= 1400 && elapsed < 5000, `Cleanup must outlive direct-child close but remain bounded: ${elapsed}ms`);
      const proof = JSON.parse(readFileSync(observed.report.proof_path));
      assert.equal(proof.timed_out, true);
      assert.equal(proof.cleanup.status, "complete");
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally {
      // Only the PID written by this fixture is eligible for fallback cleanup.
      const pidPath = join(project.repo, "child.pid");
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      rmSync(project.repo, { recursive: true, force: true });
    }
  });
}

test("failed cleanup inspection remains explicitly unproven and bounded", () => {
  const project = acceptanceProject({ timeout: 0.05, inputs: ["probe-denied.mjs"] });
  try {
    const preload = join(project.repo, "probe-denied.mjs");
    writeFileSync(preload, 'const kill = process.kill; process.kill = (pid, signal) => { if (signal === 0) { const error = new Error("fixture probe denied"); error.code = "EPERM"; throw error; } return kill.call(process, pid, signal); };');
    writeFileSync(join(project.repo, "acceptance.mjs"), 'setTimeout(() => {}, 10000);');
    const start = Date.now(), observed = record(project, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    assert.equal(observed.status, 1);
    assert.ok(Date.now() - start < 5000);
    assert.equal(observed.report.cleanup.status, "unproven");
    assert.match(observed.report.error, /Cleanup unproven:/);
    if (process.platform === "win32") {
      assert.equal(observed.report.cleanup.scope, "direct_child");
      assert.match(observed.report.error, /Could not establish/);
    } else assert.match(observed.report.error, /fixture probe denied/);
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).timed_out, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("explicit non-Git artifact workspaces can earn current acceptance", () => {
  const project = acceptanceProject();
  try {
    rmSync(join(project.repo, ".git"), { recursive: true });
    project.config.workspace = "../../.."; stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const phase of ["record", "stop"]) {
  test(`concurrent board mutation during ${phase} context read never reports success`, () => {
    const project = acceptanceProject();
    try {
      if (phase === "stop") { const observed = record(project); assert.equal(observed.status, 0); finalize(project, observed); }
      const replacement = join(project.repo, "active.yaml"); writeFileSync(replacement, activeState);
      const bin = fakeCommandBin(project.repo, "git", `fs.copyFileSync(${JSON.stringify(replacement)}, ${JSON.stringify(join(project.goal, "state.yaml"))}); ${forwardGit}`);
      const env = fixtureEnv(bin);
      const result = phase === "record" ? record(project, env) : (() => { const run = spawnSync(process.execPath, [script, project.goal, "--json"], { cwd: project.repo, encoding: "utf8", env }); return { status: run.status, report: JSON.parse(run.stdout) }; })();
      assert.equal(result.status, 1, JSON.stringify(result.report));
      assert.notEqual(result.report.can_stop, true);
      assert.match(readFileSync(join(project.goal, "state.yaml"), "utf8"), /title: "Keep going"/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("authorized long verification can finish beyond the old 120-second ceiling", { skip: process.env.GOALBUDDY_LONG_CHECK !== "1" }, () => {
  const project = acceptanceProject({ timeout: 130 }); project.outerTimeout = 135000;
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), "setTimeout(() => process.exit(0), 121000);\n");
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("workspace aliases share one acceptance binding and preserve validator freshness", () => {
  const project = acceptanceProject(), alias = project.repo + "-alias";
  try {
    symlinkSync(realpathSync.native(project.repo), alias, process.platform === "win32" ? "junction" : "dir");
    const canonicalGoal = project.goal; project.goal = join(alias,"docs/goals/one");
    const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).binding.workspace, realpathSync.native(project.repo));
    finalize(project, observed);
    assert.equal(run(canonicalGoal).report.can_stop, true);
    assert.equal(run(project.goal).report.can_stop, true);
    writeFileSync(join(project.repo,"acceptance.mjs"),"process.exit(1);");
    assert.equal(spawnSync(project.command[0],project.command.slice(1),{cwd:project.repo}).status,1);
    assert.equal(run(canonicalGoal).report.can_stop,false);
    assert.equal(run(project.goal).report.can_stop,false);
  } finally { rmSync(alias,{recursive:true,force:true}); rmSync(project.repo,{recursive:true,force:true}); }
});


for (const [source, expected] of [
  ['node acceptance.mjs', ['node', 'acceptance.mjs']],
  ['node "acceptance check.mjs"', ['node', 'acceptance check.mjs']],
  [String.raw`node "checks\acceptance check.mjs"`, ["node", String.raw`checks\acceptance check.mjs`]],
  ['node\tacceptance.mjs', ['node', 'acceptance.mjs']],
  ...['\u00a0', '\u202f', '\u2003', '\u2028', '\ufeff'].flatMap(space => [
    [`node acceptance${space}check.mjs`, ['node', `acceptance${space}check.mjs`]],
    [`node "acceptance${space}check.mjs"`, ['node', `acceptance${space}check.mjs`]],
  ]),
]) {
  test(`native Windows literal grammar: ${JSON.stringify(source)}`, () => {
    assert.deepEqual(literalCommand(source, 'win32'), expected);
  });
}
for (const source of [
  "echo acceptance.mjs", "call acceptance.mjs", "@node.exe acceptance.mjs", "check.exe acceptance.mjs",
  String.raw`"C:\Program Files\nodejs\node.exe" acceptance.mjs`,
  "node 'acceptance check.mjs'", String.raw`node acceptance\ check.mjs`,
  String.raw`node "acceptance\"check.mjs"`, 'node "acceptance".mjs',
  'node "%VALIDATOR%"', 'node "!VALIDATOR!"', 'node acceptance^ check.mjs',
  'node acceptance.mjs & node marker.mjs', 'node acceptance.mjs\nnode marker.mjs',
  'node acceptance.mjs | node marker.mjs', 'node acceptance.mjs > marker',
]) {
  test(`native Windows ambiguous grammar rejects: ${JSON.stringify(source)}`, () => {
    assert.throws(() => literalCommand(source, 'win32'), /direct local validator.*concrete filename/);
    if (process.platform !== 'win32') return; // Grammar proof above runs on every host.
    const project = acceptanceProject();
    try {
      writeFileSync(join(project.repo, 'acceptance.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "bad");');
      writeFileSync(join(project.repo, 'package.json'), JSON.stringify({ scripts: { accept: source } }));
      project.command = project.config.command = ['npm', 'run', '--silent', 'accept']; stateFor(project);
      const rejected = record(project);
      assert.equal(rejected.status, 1); assert.equal(rejected.report.proof_path, undefined);
      assert.match(rejected.report.error, /direct local validator/);
      assert.equal(existsSync(join(project.repo, 'executed')), false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const option of ["-e", "--eval", "-p", "--print", "--eval="]) {
  for (const declaration of ["artifact", "input"]) {
    test(`inline Node code preserves literal parent text and ${declaration} freshness: ${option}`, () => {
      const dependency = declaration === "artifact" ? "src/result.txt" : "settings.txt";
      const project = acceptanceProject({ inputs: declaration === "input" ? [dependency] : [] });
      try {
        writeFileSync(join(project.repo, dependency), "working\n");
        const code = `const expected = "plain/../text"; if (require("node:fs").readFileSync(${JSON.stringify(dependency)}, "utf8") !== "working\\n") process.exit(1); expected`;
        project.command = project.config.command = option.endsWith("=") ? [process.execPath, option + code] : [process.execPath, option, code];
        stateFor(project);
        const actual = runActual(project.command, { cwd: project.repo, encoding: "utf8", timeout: 5000 });
        assert.equal(actual.status, 0, actual.stderr);
        if (option === "-p" || option.startsWith("--print")) assert.equal(actual.stdout.trim(), "plain/../text");
        const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
        const proof = readFileSync(observed.report.proof_path), parsed = JSON.parse(proof);
        assert.deepEqual(parsed.command, project.command);
        assert.ok(parsed.binding.inputs.includes(declaration === "artifact" ? "src" : dependency));
        assert.deepEqual(parsed.binding.local_entry_points, []);
        finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
        const board = readFileSync(join(project.goal, "state.yaml"));
        writeFileSync(join(project.repo, dependency), "broken\n");
        assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 1);
        assert.equal(run(project.goal).report.can_stop, false);
        assert.deepEqual(readFileSync(observed.report.proof_path), proof);
        assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
}

for (const flag of ["-p", "--print"]) {
  for (const launcher of ["direct", "package"]) {
    test(`inline Node print needs literal code before other options: ${launcher} ${flag}`, () => {
      const project = acceptanceProject();
      try {
        mkdirSync(join(project.repo, "checks"));
        const file = join(project.repo, "checks/index.js");
        writeFileSync(file, 'require("node:fs").writeFileSync("executed", "validator");');
        project.command = [process.execPath, flag, "--no-warnings", "checks"];
        if (launcher === "package") {
          writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} ${flag} --no-warnings checks` } }));
          project.command = ["npm", "run", "--silent", "accept"];
        }
        project.config.command = project.command; stateFor(project);
        assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 0);
        assert.equal(readFileSync(join(project.repo, "executed"), "utf8"), "validator");
        rmSync(join(project.repo, "executed"));
        const board = readFileSync(join(project.goal, "state.yaml")), notes = readdirSync(join(project.goal, "notes")).sort();
        const rejected = record(project);
        assert.equal(rejected.status, 1, JSON.stringify(rejected.report));
        assert.equal(rejected.report.proof_path, undefined);
        assert.match(rejected.report.error, /Node inline verification needs a literal code operand.*--eval=<literal code>.*node checks\/run\.mjs/);
        assert.equal(existsSync(join(project.repo, "executed")), false);
        assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
        assert.deepEqual(readdirSync(join(project.goal, "notes")).sort(), notes);
        project.command = project.config.command = [process.execPath, realpathSync.native(file)]; stateFor(project);
        const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
        const proof = readFileSync(observed.report.proof_path);
        assert.ok(JSON.parse(proof).binding.local_entry_points.includes("checks/index.js"));
        finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
        const finalBoard = readFileSync(join(project.goal, "state.yaml"));
        writeFileSync(file, "process.exit(23);");
        assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 23);
        assert.equal(run(project.goal).report.can_stop, false);
        assert.deepEqual(readFileSync(observed.report.proof_path), proof);
        assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), finalBoard);
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
}

// --print= was supported in the unshipped candidate, but intervening options
// can make Node execute a source file that the old collector omitted. Reject
// the option itself and recover with an explicit concrete validator.
const ambiguousPrintCases = [
  ["source after no-warnings", ["--print=ignored", "--no-warnings", "./entry.cjs"]],
  ["source after trace-warnings", ["--print=ignored", "--trace-warnings", "./entry.cjs"]],
  ["source after option boundary", ["--print=ignored", "--", "./entry.cjs"]],
  ["self-link source", ["--print=ignored", "--no-warnings", "./again/entry.cjs"]],
  ["parent traversal source", ["--print=ignored", "--no-warnings", "./again/../entry.cjs"]],
  ["separate preload", ["--print=ignored", "--require", "./preload.cjs"]],
  ["equal preload", ["--print=ignored", "--require=./preload.cjs"]],
  ["separate preload and source", ["--print=ignored", "--require", "./preload.cjs", "./entry.cjs"]],
  ["equal preload and source", ["--print=ignored", "--require=./preload.cjs", "./entry.cjs"]],
  ["no expression", ["--print=ignored"]],
  ["immediate expression", ["--print=ignored", "Math.PI"]],
  ["explicit eval", ["--print=ignored", "--eval", "Math.PI"]],
  ["after inline code", ["--eval", "Math.PI", "--print=ignored"]],
  ["after inline separate preload", ["--eval", "Math.PI", "--require", "./preload.cjs", "--print=ignored"]],
  ["after inline equal preload", ["--eval", "Math.PI", "--require=./preload.cjs", "--print=ignored"]],
  ["after short print option", ["-p", "--print=ignored", "--no-warnings", "./entry.cjs"]],
  ["after long print option", ["--print", "--print=ignored", "--no-warnings", "./entry.cjs"]],
  ["empty equals value", ["--print="]],
  ["parent text in equals value", ["--print=plain/../text"]],
];
for (const launcher of ["direct", "package"]) {
  for (const [name, args] of ambiguousPrintCases) {
    test(`ambiguous print equals rejects before execution and recovers: ${launcher} ${name}`, () => {
      const project = acceptanceProject({ inputs: ["settings.txt"] });
      try {
        writeFileSync(join(project.repo, "settings.txt"), "working");
        const previous = record(project); assert.equal(previous.status, 0, JSON.stringify(previous.report));
        const previousProof = readFileSync(previous.report.proof_path);
        const body = 'const fs = require("node:fs"); if (fs.readFileSync("settings.txt", "utf8") !== "working") process.exit(1); fs.writeFileSync("executed", "validator");\n';
        for (const file of ["entry.cjs", "preload.cjs"]) writeFileSync(join(project.repo, file), body);
        symlinkSync(realpathSync.native(project.repo), join(project.repo, "again"), process.platform === "win32" ? "junction" : "dir");
        if (launcher === "package") writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} ${args.join(" ")}` } }));
        project.command = project.config.command = launcher === "direct" ? [process.execPath, ...args] : ["npm", "run", "--silent", "accept"];
        stateFor(project);
        const board = readFileSync(join(project.goal, "state.yaml"));
        const notes = readdirSync(join(project.goal, "notes")).sort();
        const rejected = record(project);
        assert.equal(rejected.status, 1, JSON.stringify(rejected.report));
        assert.equal(rejected.report.proof_path, undefined);
        assert.match(rejected.report.error, /--print= option is unsupported/);
        assert.match(rejected.report.error, /--print <literal code>.*--eval <literal code>.*node checks\/run\.mjs/);
        assert.match(rejected.report.error, /acceptance\.inputs/);
        assert.equal(existsSync(join(project.repo, "executed")), false);
        assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
        assert.deepEqual(readdirSync(join(project.goal, "notes")).sort(), notes);
        assert.deepEqual(readFileSync(previous.report.proof_path), previousProof);

        const file = name.includes("preload") ? "preload.cjs" : "entry.cjs";
        project.command = project.config.command = [process.execPath, realpathSync.native(join(project.repo, file))];
        stateFor(project);
        assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 0);
        rmSync(join(project.repo, "executed"));
        const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
        assert.equal(readFileSync(join(project.repo, "executed"), "utf8"), "validator");
        const proof = readFileSync(observed.report.proof_path), parsed = JSON.parse(proof);
        assert.deepEqual(parsed.command, project.command);
        assert.ok(parsed.binding.local_entry_points.includes(file));
        assert.ok(parsed.binding.inputs.includes("settings.txt"));
        finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
        const finalBoard = readFileSync(join(project.goal, "state.yaml"));
        writeFileSync(join(project.repo, file), "process.exit(23);\n");
        assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 23);
        assert.equal(run(project.goal).report.can_stop, false);
        assert.deepEqual(readFileSync(observed.report.proof_path), proof);
        assert.deepEqual(readFileSync(previous.report.proof_path), previousProof);
        assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), finalBoard);
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
}

for (const launcher of ["direct script", "script after boundary", "package script", "non-Node validator", "inline arguments after boundary"]) {
  test(`print equals data retains ordinary operand inference: ${launcher}`, () => {
    const project = acceptanceProject();
    try {
      writeFileSync(join(project.repo, "operand.txt"), "working");
      const callback = 'process.exit(fs.readFileSync("operand.txt", "utf8") === "working" ? 0 : 23);';
      let env = process.env;
      if (launcher === "non-Node validator") {
        const bin = fakeCommandBin(project.repo, "validator", callback);
        env = fixtureEnv(bin);
        project.command = [join(bin, `validator${process.platform === "win32" ? ".exe" : ""}`), "--print=operand.txt"];
        project.config.inputs = ["fake-bin/validator.cjs", "fake-bin/bootstrap.cjs"];
      } else if (launcher === "inline arguments after boundary") {
        project.command = [process.execPath, "--eval", 'const fs = require("node:fs"); if (!process.argv.includes("--print=operand.txt")) process.exit(2); ' + callback, "--", "--print=operand.txt"];
      } else {
        writeFileSync(join(project.repo, "entry.cjs"), 'const fs = require("node:fs"); if (!process.argv.includes("--print=operand.txt")) process.exit(2); ' + callback);
        const args = [...(launcher === "script after boundary" ? ["--"] : []), "entry.cjs", "--print=operand.txt"];
        project.command = [process.execPath, ...args];
        if (launcher === "package script") {
          writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${packageNode} ${args.join(" ")}` } }));
          project.command = ["npm", "run", "--silent", "accept"];
        }
      }
      project.config.command = project.command; stateFor(project);
      assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 0);
      const observed = record(project, env); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      assert.ok(JSON.parse(readFileSync(observed.report.proof_path)).binding.local_entry_points.includes("operand.txt"));
      finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
      writeFileSync(join(project.repo, "operand.txt"), "broken");
      assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 23);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("print equals data inside inline code remains literal and freshness-bound", () => {
  const project = acceptanceProject({ inputs: ["settings.txt"] });
  try {
    writeFileSync(join(project.repo, "settings.txt"), "working");
    project.command = project.config.command = [process.execPath, "--eval", 'const data = "--print=plain/../text"; console.log(data);'];
    stateFor(project);
    const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
    assert.deepEqual(JSON.parse(readFileSync(observed.report.proof_path)).command, project.command);
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    writeFileSync(join(project.repo, "settings.txt"), "changed declared input");
    const actual = runActual(project.command, { cwd: project.repo, encoding: "utf8", timeout: 5000 });
    assert.equal(actual.status, 0); assert.equal(actual.stdout.trim(), "--print=plain/../text");
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("inline Node code retains following option-file inference", () => {
  for (const option of [["--require", "./preload.cjs"], ["--require=./preload.cjs"]]) {
    const project = acceptanceProject();
    try {
      writeFileSync(join(project.repo, "preload.cjs"), "process.exitCode = 0;\n");
      project.command = project.config.command = [process.execPath, "-e", '"plain/../text"', ...option];
      stateFor(project);
      assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 0);
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      assert.ok(JSON.parse(readFileSync(observed.report.proof_path)).binding.local_entry_points.includes("preload.cjs"));
      finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
      writeFileSync(join(project.repo, "preload.cjs"), "process.exit(1);\n");
      assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 1);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  }
});

test("non-Node eval option retains ordinary operand inference", () => {
  const project = acceptanceProject();
  try {
    const bin = fakeCommandBin(project.repo, "validator", 'process.exit(fs.readFileSync("operand.txt", "utf8") === "working" ? 0 : 1);');
    const file = `fake-bin/validator${process.platform === "win32" ? ".exe" : ""}`;
    writeFileSync(join(project.repo, "operand.txt"), "working");
    project.command = project.config.command = [join(project.repo, file), "--eval=operand.txt"];
    project.config.inputs = ["fake-bin/validator.cjs", "fake-bin/bootstrap.cjs"]; stateFor(project);
    const env = fixtureEnv(bin), observed = record(project, env);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    assert.ok(JSON.parse(readFileSync(observed.report.proof_path)).binding.local_entry_points.includes("operand.txt"));
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    writeFileSync(join(project.repo, "operand.txt"), "broken");
    assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 1);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("exact local executable binds native callback dependencies and preserves freshness", t => {
  const project = acceptanceProject();
  try {
    const bin = fakeCommandBin(project.repo, 'validator', 'process.exit(0);');
    const file = `fake-bin/validator${process.platform === 'win32' ? '.exe' : ''}`;
    const body = 'fake-bin/validator.cjs';
    project.command = project.config.command = [resolve(project.repo, file)];
    const root = realpathSync.native(project.repo);
    assert.equal(realpathSync.native(project.command[0]), realpathSync.native(join(root, file)));
    t.diagnostic(JSON.stringify({ platform: process.platform, lexical_relative_executable: relative(root, project.command[0]), canonical_relative_executable: relative(root, realpathSync.native(project.command[0])) }));
    project.config.inputs = [body, 'fake-bin/bootstrap.cjs']; stateFor(project);
    const env = fixtureEnv(bin), observed = record(project, env);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.ok(proof.binding.local_entry_points.includes(file));
    assert.ok(proof.binding.inputs.includes(body));
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    edit(join(project.repo, body), 'process.exit(0);', 'process.exit(1);');
    assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 1);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const kind of ["local executable", "Node entry file"]) {
  test(`workspace alias binds the same ${kind} and rejects stale dependency proof`, () => {
    const project = acceptanceProject(), alias = project.repo + "-alias";
    try {
      // A real directory alias exercises the root identity boundary on every OS.
      // Windows CI also retains its original short-temp-name executable case.
      symlinkSync(realpathSync.native(project.repo), alias, process.platform === "win32" ? "junction" : "dir");
      const bin = fakeCommandBin(project.repo, "validator", "process.exit(0);");
      const file = kind === "local executable" ? `fake-bin/validator${process.platform === "win32" ? ".exe" : ""}` : "acceptance.mjs";
      const dependency = kind === "local executable" ? "fake-bin/validator.cjs" : file;
      project.command = project.config.command = kind === "local executable" ? [join(alias, file)] : [process.execPath, join(alias, file)];
      project.config.inputs = kind === "local executable" ? [dependency, "fake-bin/bootstrap.cjs"] : [];
      assert.equal(realpathSync.native(join(alias, file)), realpathSync.native(join(project.repo, file)));
      assert.ok(relative(realpathSync.native(project.repo), join(alias, file)).startsWith(".."));
      stateFor(project);
      const env = fixtureEnv(bin);
      assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 0);
      const observed = record(project, env);
      assert.equal(observed.status, 0, JSON.stringify(observed.report));
      const proof = readFileSync(observed.report.proof_path);
      assert.ok(JSON.parse(proof).binding.local_entry_points.includes(file));
      finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
      const board = readFileSync(join(project.goal, "state.yaml"));
      writeFileSync(join(project.repo, dependency), "process.exit(1);\n");
      assert.equal(runActual(project.command, { cwd: project.repo, env, timeout: 5000 }).status, 1);
      assert.equal(run(project.goal).report.can_stop, false);
      assert.deepEqual(readFileSync(observed.report.proof_path), proof);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
    } finally { rmSync(alias, { recursive: true, force: true }); rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const kind of [
  "sibling executable", "external link to local executable", "local executable link",
  "source directory link", "source link back to workspace root", "Node source link",
  "missing local executable", "missing Node file", "missing Node operand", "external Node file",
  "aliased parent traversal", "source parent traversal",
]) {
  test(`lexical command paths reject ${kind} before execution`, () => {
    const project = acceptanceProject(), alias = project.repo + "-alias", sibling = project.repo + "-sibling", spellings = project.repo + "-spellings";
    try {
      const dirLink = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(realpathSync.native(project.repo), alias, dirLink);
      mkdirSync(sibling);
      mkdirSync(spellings);
      symlinkSync(realpathSync.native(project.repo), join(spellings, basename(sibling)), dirLink);
      const bin = fakeCommandBin(project.repo, "validator", 'fs.writeFileSync("executed", "bad");');
      const external = fakeCommandBin(sibling, "validator", 'fs.writeFileSync("executed", "bad");');
      if (kind === "source parent traversal") fakeCommandBin(join(project.repo, basename(project.repo)), "validator", "process.exit(0);");
      const name = `validator${process.platform === "win32" ? ".exe" : ""}`;
      writeFileSync(join(sibling, "check.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "bad");');
      writeFileSync(join(project.repo, "check.mjs"), readFileSync(join(sibling, "check.mjs")));
      symlinkSync(join(bin, name), join(project.repo, "linked-" + name), "file");
      symlinkSync(join(bin, name), join(sibling, "linked-" + name), "file");
      symlinkSync(bin, join(project.repo, "linked-bin"), dirLink);
      symlinkSync(realpathSync.native(project.repo), join(project.repo, "again"), dirLink);
      symlinkSync(join(project.repo, "check.mjs"), join(project.repo, "linked.mjs"), "file");
      const commands = {
        "sibling executable": [join(external, name)],
        "external link to local executable": [join(sibling, "linked-" + name)],
        "local executable link": [join(alias, "linked-" + name)],
        "source directory link": [join(alias, "linked-bin", name)],
        "source link back to workspace root": [join(alias, "again", "fake-bin", name)],
        "Node source link": [process.execPath, join(alias, "linked.mjs")],
        "missing local executable": [join(alias, "missing-" + name)],
        "missing Node file": [process.execPath, join(alias, "missing.mjs")],
        "missing Node operand": [process.execPath],
        "external Node file": [process.execPath, join(sibling, "check.mjs")],
        // Keep raw ..: lexical normalization points into the workspace, while
        // POSIX execution follows the directory alias into the real sibling.
        "aliased parent traversal": [join(spellings, basename(sibling)) + "/../" + basename(sibling) + "/fake-bin/" + name],
        "source parent traversal": [join(realpathSync.native(project.repo), "again") + "/../" + basename(project.repo) + "/fake-bin/" + name],
      };
      project.command = project.config.command = commands[kind];
      project.config.inputs = ["fake-bin/validator.cjs", "fake-bin/bootstrap.cjs"];
      stateFor(project);
      const board = readFileSync(join(project.goal, "state.yaml"));
      const observed = record(project, fixtureEnv(bin));
      assert.equal(existsSync(join(project.repo, "executed")), false, "Rejected command must not execute its callback.");
      assert.equal(observed.status, 1); assert.equal(observed.report.proof_path, undefined);
      assert.match(observed.report.error, /symlink|exact local|concrete entry|escapes the authorized/i);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(project.repo, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
      rmSync(spellings, { recursive: true, force: true });
    }
  });
}

test("npm execution observes the bound concrete Node argv and native shell selection", () => {
  const project = acceptanceProject();
  try {
    const validator = 'acceptance\u00a0 check.mjs';
    writeFileSync(join(project.repo, validator), 'import { writeFileSync } from "node:fs"; writeFileSync("observed.json", JSON.stringify({ argv:process.argv, event:process.env.npm_lifecycle_event, script:process.env.npm_lifecycle_script, shell:process.env.npm_config_script_shell }));');
    const cmd = `node "${validator}" expected`;
    writeFileSync(join(project.repo, 'package.json'), JSON.stringify({ scripts: { accept: cmd } }));
    project.command = project.config.command = ['npm', 'run', '--silent', 'accept']; stateFor(project);
    // A conflicting per-process npm shell must not change the Windows grammar.
    const observed = record(project, process.platform === 'win32' ? { npm_config_script_shell: 'nonexistent-shell.exe' } : {});
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const actual = JSON.parse(readFileSync(join(project.repo, 'observed.json')));
    assert.equal(realpathSync.native(actual.argv[0]), realpathSync.native(process.execPath));
    assert.equal(realpathSync.native(actual.argv[1]), realpathSync.native(join(project.repo, validator)));
    assert.deepEqual(actual.argv.slice(2), ['expected']);
    assert.equal(actual.event, 'accept'); assert.equal(actual.script, cmd);
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.ok(proof.binding.local_entry_points.includes(validator));
    if (process.platform === 'win32') {
      assert.equal(proof.binding.launcher.kind, 'windows_bundled_npm');
      assert.equal(realpathSync.native(actual.shell), proof.binding.launcher.script_shell);
      assert.match(proof.binding.launcher.npm_cli, /npm-cli\.js$/);
    } else assert.equal(proof.binding.launcher, undefined);
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    writeFileSync(join(project.repo, validator), 'process.exit(1);');
    assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 1);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

// Native-only integration assertions are exercised by Windows CI. Host grammar
// tests above are supporting evidence, not substitutes for executing cmd.exe.
if (process.platform === 'win32') {
  test("native package lookup preserves local runtime symlink rejection", () => {
    const project = acceptanceProject();
    try {
      symlinkSync(process.execPath, join(project.repo, "node.exe"), "file");
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: "node acceptance.mjs" } }));
      project.command = project.config.command = ["npm", "run", "--silent", "accept"]; stateFor(project);
      const observed = record(project);
      assert.equal(observed.status, 1); assert.equal(observed.report.proof_path, undefined);
      assert.match(observed.report.error, /symlink/i);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
  for (const shadow of ['node.cmd', 'node_modules/.bin/node.cmd']) {
    test(`native npm rejects a shadow Node launcher before execution: ${shadow}`, () => {
      const project = acceptanceProject();
      try {
        mkdirSync(resolve(project.repo, shadow, '..'), { recursive: true });
        writeFileSync(join(project.repo, shadow), '@echo forbidden>executed\r\n@exit /b 0\r\n');
        writeFileSync(join(project.repo, 'package.json'), JSON.stringify({ scripts: { accept: 'node acceptance.mjs' } }));
        project.command = project.config.command = ['npm', 'run', '--silent', 'accept']; stateFor(project);
        const observed = record(project);
        assert.equal(observed.status, 1); assert.equal(observed.report.proof_path, undefined);
        assert.match(observed.report.error, /direct local validator/);
        assert.equal(existsSync(join(project.repo, 'executed')), false);
        project.command = project.config.command = [process.execPath, 'acceptance.mjs']; stateFor(project);
        const recovered = record(project); assert.equal(recovered.status, 0, JSON.stringify(recovered.report));
        finalize(project, recovered); assert.equal(run(project.goal).report.can_stop, true);
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
  for (const command of [
    ['pnpm', 'run', 'accept'], ['yarn', 'run', 'accept'],
    ['npm', 'run', 'accept', '--', '%VALIDATOR%'], ['npm', 'run', 'accept', '--', 'argument with spaces'],
    ['check.cmd'],
  ]) {
    test(`native unsupported launch rejects before execution: ${JSON.stringify(command)}`, () => {
      const project = acceptanceProject();
      try {
        writeFileSync(join(project.repo, 'check.cmd'), '@echo forbidden>executed\r\n@exit /b 0\r\n');
        writeFileSync(join(project.repo, 'package.json'), JSON.stringify({ scripts: { accept: 'node acceptance.mjs' } }));
        project.command = project.config.command = command; stateFor(project);
        const observed = record(project);
        assert.equal(observed.status, 1); assert.equal(observed.report.proof_path, undefined);
        assert.match(observed.report.error, /direct local validator/);
        assert.equal(existsSync(join(project.repo, 'executed')), false);
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
}


const nodeCaseSpellings = ["node.exe", "NODE.EXE", "Node.exe", "nOdE.ExE"];

function assertCaseFileFreshness(project, command, file) {
  project.command = project.config.command = command; stateFor(project);
  const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
  const proof = readFileSync(observed.report.proof_path);
  assert.ok(JSON.parse(proof).binding.local_entry_points.includes(file));
  finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
  const board = readFileSync(join(project.goal, "state.yaml"));
  writeFileSync(join(project.repo, file), "process.exit(1);\n");
  assert.equal(runActual(command, { cwd: project.repo, encoding: "utf8", timeout: 5000 }).status, 1);
  assert.equal(run(project.goal).report.can_stop, false);
  assert.deepEqual(readFileSync(observed.report.proof_path), proof);
  assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
  writeFileSync(join(project.repo, file), "process.exit(0);\n");
}

// Host-only branch probe: actual filesystem and renamed host Node callbacks,
// mocked Windows platform/runtime/where identities. It never executes cmd.exe
// or produces a simulated Windows acceptance proof. Restore globals per call.
function windowsCaseContext(project, runtime, resolvedExecutable, system) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const executable = Object.getOwnPropertyDescriptor(process, "execPath");
  const systemRoot = process.env.SystemRoot, actualSpawn = childProcess.spawnSync;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "execPath", { value: runtime });
    process.env.SystemRoot = system;
    childProcess.spawnSync = (file, args, options) => String(file).endsWith("where.exe")
      ? { status: 0, stdout: resolvedExecutable + "\n", stderr: "" } : actualSpawn(file, args, options);
    syncBuiltinESMExports();
    const state = join(project.goal, "state.yaml");
    return acceptanceContext(state, readFileSync(state));
  } finally {
    Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "execPath", executable);
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    childProcess.spawnSync = actualSpawn; syncBuiltinESMExports();
  }
}

if (process.platform !== "win32") {
  for (const spelling of nodeCaseSpellings) {
    test(`Windows case classification host branch rejects copied runtime and directory bypass: ${spelling}`, () => {
      const project = acceptanceProject();
      try {
        const runtimeDir = join(project.repo, "simulated-runtime"), system = join(project.repo, "simulated-system");
        mkdirSync(join(runtimeDir, "node_modules/npm/bin"), { recursive: true });
        mkdirSync(join(system, "System32"), { recursive: true });
        writeFileSync(join(runtimeDir, "node_modules/npm/bin/npm-cli.js"), "// identity fixture; never executed\n");
        writeFileSync(join(system, "System32/cmd.exe"), "identity fixture; never executed\n");
        const runtime = join(runtimeDir, "node.exe"), shadow = join(project.repo, spelling);
        copyFileSync(process.execPath, runtime, constants.COPYFILE_FICLONE);
        copyFileSync(process.execPath, shadow, constants.COPYFILE_FICLONE);
        chmodSync(runtime, 0o755); chmodSync(shadow, 0o755);
        mkdirSync(join(project.repo, "checks"));
        for (const file of ["checks/index.js", "checks/run.mjs"]) writeFileSync(join(project.repo, file), "process.exit(0);\n");
        // The review's real renamed-binary callback: its directory validator
        // actually changes exit status after only index.js changes.
        assert.equal(spawnSync(shadow, ["checks"], { cwd: project.repo, timeout: 5000 }).status, 0);
        writeFileSync(join(project.repo, "checks/index.js"), "process.exit(1);\n");
        assert.equal(spawnSync(shadow, ["checks"], { cwd: project.repo, timeout: 5000 }).status, 1);
        project.config.workspace = "../../..";
        for (const operand of ["checks", "checks/", ".", "checks/run.mjs"]) {
          writeFileSync(join(project.repo, "package.json"), JSON.stringify({ main: "checks/run.mjs", scripts: { accept: `${spelling} ${operand}` } }));
          project.command = project.config.command = ["npm", "run", "--silent", "accept"]; stateFor(project);
          assert.throws(() => windowsCaseContext(project, runtime, shadow, system), /shadowed or differs.*direct local validator/);
          if (operand !== "checks/run.mjs") {
            assert.throws(() => windowsCaseContext(project, runtime, runtime, system), /exact local file/);
            project.command = project.config.command = [shadow, operand]; stateFor(project);
            assert.throws(() => windowsCaseContext(project, runtime, shadow, system), /exact local file/);
          }
        }
        writeFileSync(join(project.repo, "checks/package.json"), JSON.stringify({ main: "run.mjs" }));
        project.command = project.config.command = [shadow, "checks"]; stateFor(project);
        assert.throws(() => windowsCaseContext(project, runtime, shadow, system), /exact local file/);
        // Explicit direct runtimes keep their existing authority: exact file,
        // both binary and validator bound, regardless of the .exe letter case.
        project.command = project.config.command = [shadow, "checks/run.mjs"]; stateFor(project);
        const direct = windowsCaseContext(project, runtime, shadow, system).binding;
        assert.ok(direct.local_entry_points.includes("checks/run.mjs"));
        assert.ok(direct.local_entry_points.includes(spelling));
        project.command = project.config.command = ["npm", "run", "--silent", "accept"]; stateFor(project);
        const before = windowsCaseContext(project, runtime, runtime, system).binding;
        assert.ok(before.local_entry_points.includes("checks/run.mjs"));
        assert.equal(spawnSync(runtime, ["checks/run.mjs"], { cwd: project.repo, timeout: 5000 }).status, 0);
        writeFileSync(join(project.repo, "checks/run.mjs"), "process.exit(1);\n");
        assert.equal(spawnSync(runtime, ["checks/run.mjs"], { cwd: project.repo, timeout: 5000 }).status, 1);
        assert.notEqual(windowsCaseContext(project, runtime, runtime, system).binding.inputs_sha256, before.inputs_sha256);
        project.command = project.config.command = [shadow, "checks/run.mjs"]; stateFor(project);
        assert.notEqual(windowsCaseContext(project, runtime, shadow, system).binding.inputs_sha256, direct.inputs_sha256);
        writeFileSync(join(project.repo, "checks/run.mjs"), "process.exit(0);\n");
        // Actual recorder -> final audit -> failing exact command -> stale stop,
        // using real host Node argv after all branch simulation is restored.
        assertCaseFileFreshness(project, [process.execPath, "checks/run.mjs"], "checks/run.mjs");
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }

  test("POSIX case classification preserves a distinct uppercase local executable", () => {
    const project = acceptanceProject();
    try {
      const bin = fakeCommandBin(project.repo, "NODE.EXE", 'process.exit(fs.readFileSync("checks/result", "utf8") === "pass" ? 0 : 1);');
      mkdirSync(join(project.repo, "checks")); writeFileSync(join(project.repo, "checks/result"), "pass");
      project.command = project.config.command = [join(bin, "NODE.EXE"), "checks"];
      project.config.inputs = ["checks/result", "fake-bin/NODE.EXE.cjs"]; stateFor(project);
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
      writeFileSync(join(project.repo, "checks/result"), "fail");
      assert.equal(runActual(project.command, { cwd: project.repo, timeout: 5000 }).status, 1);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

// These assertions require actual Win32 filename aliases, native npm/cmd, and
// a copied PE executable. Host branch simulations above cannot certify them.
if (process.platform === "win32") {
  for (const spelling of nodeCaseSpellings) {
    test(`native Windows case classification accepts current runtime aliases and rejects directory/shadow launches: ${spelling}`, () => {
      const project = acceptanceProject();
      try {
        const current = join(dirname(process.execPath), spelling);
        assert.equal(realpathSync.native(current), realpathSync.native(process.execPath));
        mkdirSync(join(project.repo, "checks"));
        for (const file of ["checks/index.js", "checks/run.mjs"]) writeFileSync(join(project.repo, file), "process.exit(0);\n");
        writeFileSync(join(project.repo, "checks/package.json"), JSON.stringify({ main: "run.mjs" }));
        writeFileSync(join(project.repo, "package.json"), JSON.stringify({ main: "checks/run.mjs", scripts: { accept: `${spelling} checks/run.mjs` } }));
        assertCaseFileFreshness(project, [current, "checks/run.mjs"], "checks/run.mjs");
        assertCaseFileFreshness(project, ["npm", "run", "--silent", "accept"], "checks/run.mjs");
        for (const file of ["index.js", "checks/index.js", "checks/run.mjs"]) writeFileSync(join(project.repo, file), 'import("node:fs").then(fs => fs.writeFileSync("executed", "bad"));');
        const shadow = join(project.repo, spelling);
        for (const useShadow of [false, true]) {
          if (useShadow) copyFileSync(process.execPath, shadow, constants.COPYFILE_FICLONE);
          for (const { operand, main } of [
            { operand: "checks", main: false }, { operand: "checks/", main: true },
            { operand: ".", main: false }, { operand: ".", main: true },
          ]) {
            if (main) writeFileSync(join(project.repo, "checks/package.json"), JSON.stringify({ main: "run.mjs" }));
            else rmSync(join(project.repo, "checks/package.json"), { force: true });
            writeFileSync(join(project.repo, "package.json"), JSON.stringify({ ...(main ? { main: "checks/run.mjs" } : {}), scripts: { accept: `${spelling} ${operand}` } }));
            for (const command of [[useShadow ? shadow : current, operand], ["npm", "run", "--silent", "accept"]]) {
              project.command = project.config.command = command; stateFor(project);
              const board = readFileSync(join(project.goal, "state.yaml")), observed = record(project);
              assert.equal(observed.status, 1); assert.equal(observed.report.proof_path, undefined);
              assert.match(observed.report.error, /exact local file|shadowed or differs/);
              assert.equal(existsSync(join(project.repo, "executed")), false);
              assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
            }
          }
        }
        writeFileSync(join(project.repo, "checks/run.mjs"), "process.exit(0);\n");
        writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `${spelling} checks/run.mjs` } }));
        project.command = project.config.command = ["npm", "run", "--silent", "accept"]; stateFor(project);
        const rejected = record(project); assert.equal(rejected.status, 1); assert.equal(rejected.report.proof_path, undefined);
        assert.match(rejected.report.error, /shadowed or differs/);
        assertCaseFileFreshness(project, [shadow, "checks/run.mjs"], "checks/run.mjs");
        assertCaseFileFreshness(project, [current, "checks/run.mjs"], "checks/run.mjs");
      } finally { rmSync(project.repo, { recursive: true, force: true }); }
    });
  }
}

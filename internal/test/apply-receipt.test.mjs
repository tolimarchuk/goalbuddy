import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fakeCommandBin, fixtureEnv } from "./core-fixtures.mjs";
import assert from "node:assert/strict";

const script = resolve("goalbuddy/scripts/apply-receipt.mjs");
const checker = resolve("goalbuddy/scripts/check-goal-state.mjs");

function makeBoard() {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-apply-receipt-"));
  const goalDir = join(root, "docs", "goals", "one");
  mkdirSync(join(goalDir, "notes"), { recursive: true });
  writeFileSync(join(goalDir, "goal.md"), "# one\n");
  writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "one goal"
  slug: "one"
  kind: specific
  tranche: "test"
  status: active
agents:
  scout: unknown
  worker: unknown
  judge: unknown
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Adjust the widget."
    allowed_files:
      - src/widget.mjs
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
  - id: T999
    type: judge
    assignee: Judge
    status: queued
    objective: "Audit the outcome."
    receipt: null
`);
  return { root, goalDir };
}

const DONE_RECEIPT = {
  result: "done",
  task_id: "T001",
  changed_files: ["src/widget.mjs"],
  commands: [{ cmd: "npm test", status: "pass" }],
  summary: "widget adjusted",
  harness: "codex",
};

function runApply(root, args, receipt) {
  const receiptPath = join(root, "receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt));
  return spawnSync(process.execPath, [script, "docs/goals/one", "--receipt", receiptPath, "--json", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("apply-receipt records a done receipt and activates the next task atomically", () => {
  const { root, goalDir } = makeBoard();
  try {
    const result = runApply(root, ["--task", "T001", "--activate", "T999"], DONE_RECEIPT);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.stop_allowed, false);
    assert.equal(report.continuation_required, true);
    assert.match(report.next_action, /Continue the active task T999/i);

    const state = readFileSync(join(goalDir, "state.yaml"), "utf8");
    assert.match(state, /active_task: T999/);
    assert.match(state, /summary: "widget adjusted"/);
    assert.match(state, /harness: codex/);
    assert.match(state, /status: pass/);

    const check = spawnSync(process.execPath, [checker, goalDir], { encoding: "utf8" });
    assert.equal(JSON.parse(check.stdout).ok, true, check.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-receipt reverts the board when the transition is invalid", () => {
  const { root, goalDir } = makeBoard();
  try {
    const before = readFileSync(join(goalDir, "state.yaml"), "utf8");
    const badReceipt = { ...DONE_RECEIPT, commands: [{ cmd: "npm test", status: "fail" }] };
    const result = runApply(root, ["--task", "T001", "--activate", "T999"], badReceipt);
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.checker_errors.length > 0);
    assert.equal(readFileSync(join(goalDir, "state.yaml"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-receipt accepts a dispatch report and defaults status from the receipt", () => {
  const { root, goalDir } = makeBoard();
  try {
    const dispatchReport = realDispatch(root);
    const result = runApply(root, ["--task", "T001", "--activate", "T999"], dispatchReport);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.continuation_required, true);
    assert.equal(report.active_task, "T999");
    const state = readFileSync(join(goalDir, "state.yaml"), "utf8");
    assert.match(state, /active_task: T999/);
    assert.match(state, /summary: "widget adjusted"/);
    const t001 = state.slice(state.indexOf("- id: T001"), state.indexOf("- id: T999"));
    assert.match(t001, /status: done/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const status of ["violations", "unverifiable", "skipped_not_git"]) {
  test(`apply-receipt refuses a dispatch report with ${status} scope without changing the board`, () => {
    const { root, goalDir } = makeBoard();
    try {
      const before = readFileSync(join(goalDir, "state.yaml"));
      const result = runApply(root, ["--task", "T001", "--activate", "T999"], {
        ok: status === "skipped_not_git", receipt: DONE_RECEIPT, scope_check: { status },
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /not verified clean/);
      assert.deepEqual(readFileSync(join(goalDir, "state.yaml")), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

function realDispatch(root) {
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/widget.mjs"), "export const widget = 1;\n");
  const bin = join(root, "fake-bin");
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  fakeCommandBin(root, "codex", `fs.writeFileSync("src/widget.mjs", "export const widget = 2;\\n"); console.log(${JSON.stringify(JSON.stringify({ goalbuddy_receipt_v1: DONE_RECEIPT }))});`);
  const run = spawnSync(process.execPath, [resolve("goalbuddy/scripts/dispatch-task.mjs"), "docs/goals/one", "--to", "codex", "--timeout", "5", "--json"], { cwd: root, encoding: "utf8", timeout: 15000, env: fixtureEnv(bin) });
  assert.equal(run.status, 0, run.stdout || run.stderr);
  return JSON.parse(run.stdout);
}

for (const [name, mutate] of [
  ["wrapper task", report => { report.task_id = "T777"; }],
  ["receipt task", report => { report.receipt.task_id = "T777"; }],
  ["receipt board", report => { report.receipt.board_path = "unrelated/state.yaml"; }],
  ["receipt harness", report => { report.receipt.harness = "claude-code"; }],
  ["wrapper harness", report => { report.harness = "claude-code"; }],
  ["wrapper repository", report => { report.repository_root = resolve(report.repository_root, ".."); }],
  ["wrapper exit", report => { report.exit_status = 1; }],
  ["contradictory violations", report => { report.scope_check.violations = ["README.md"]; }],
  ["contradictory changed files", report => { report.scope_check.changed_files = ["README.md"]; }],
  ["missing revision", report => { delete report.authority_sha256; }],
  ["wrong role", report => { report.role = "judge"; }],
]) {
  test(`import rejects ${name} without altering board or report`, () => {
    const { root, goalDir } = makeBoard();
    try {
      const report = realDispatch(root); mutate(report);
      const before = readFileSync(join(goalDir, "state.yaml"));
      const result = runApply(root, ["--task", "T001", "--activate", "T999"], report);
      assert.equal(result.status, 1, result.stdout);
      assert.deepEqual(readFileSync(join(goalDir, "state.yaml")), before);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "receipt.json"))), report);
      assert.match(readFileSync(join(root, "src/widget.mjs"), "utf8"), /widget = 2/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("card edits invalidate the authority revision of a real dispatch report", () => {
  const { root, goalDir } = makeBoard();
  try {
    const report = realDispatch(root);
    const path = join(goalDir, "state.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("Adjust the widget.", "A different authorized outcome."));
    const current = readFileSync(path);
    const result = runApply(root, ["--task", "T001", "--activate", "T999"], report);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /authority is stale/);
    assert.deepEqual(readFileSync(path), current);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const envelope of [false, true]) {
  test(`legacy ${envelope ? "enveloped" : "bare"} receipts allow absent identity but reject supplied contradictions`, () => {
    const { root, goalDir } = makeBoard();
    try {
      const before = readFileSync(join(goalDir, "state.yaml"));
      const wrong = { ...DONE_RECEIPT, task_id: "T777" };
      assert.equal(runApply(root, ["--task", "T001", "--activate", "T999"], envelope ? { goalbuddy_receipt_v1: wrong } : wrong).status, 1);
      assert.deepEqual(readFileSync(join(goalDir, "state.yaml")), before);
      const bare = { ...DONE_RECEIPT }; delete bare.task_id; delete bare.harness;
      assert.equal(runApply(root, ["--task", "T001", "--activate", "T999"], envelope ? { goalbuddy_receipt_v1: bare } : bare).status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("duplicate JSON import members reject before identity stripping", () => {
  const { root, goalDir } = makeBoard();
  try {
    const path = join(root, "receipt.json");
    writeFileSync(path, JSON.stringify(DONE_RECEIPT).replace('"task_id":"T001"', '"task_id":"T777","task_id":"T001"'));
    const before = readFileSync(join(goalDir, "state.yaml"));
    const result = spawnSync(process.execPath, [script, goalDir, "--task", "T001", "--receipt", path, "--activate", "T999"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Duplicate JSON/);
    assert.deepEqual(readFileSync(join(goalDir, "state.yaml")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("receipt authority accepts canonical board aliases and rejects a different board", () => {
  const { root, goalDir } = makeBoard(), alias = root + "-alias";
  try {
    symlinkSync(realpathSync.native(root), alias, process.platform === "win32" ? "junction" : "dir");
    const report = realDispatch(root);
    report.cwd = alias; report.repository_root = alias;
    report.board_path = join(alias,"docs/goals/one/state.yaml");
    report.receipt.board_path = report.board_path;
    const before = readFileSync(join(goalDir,"state.yaml"));
    const wrong = {...report, board_path:join(alias,"docs/goals/one/goal.md")};
    const rejected = runApply(root, ["--task","T001","--activate","T999"], wrong);
    assert.equal(rejected.status,1); assert.match(rejected.stderr,/board_path/);
    assert.deepEqual(readFileSync(join(goalDir,"state.yaml")),before);
    const result = runApply(root, ["--task","T001","--activate","T999"], report);
    assert.equal(result.status,0,result.stdout || result.stderr);
  } finally { rmSync(alias,{recursive:true,force:true}); rmSync(root,{recursive:true,force:true}); }
});

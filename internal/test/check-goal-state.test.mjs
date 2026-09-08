import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { renderTaskPrompt, formatPrompt } from "../../goalbuddy/scripts/render-task-prompt.mjs";

const checker = resolve("goalbuddy/scripts/check-goal-state.mjs");

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-test-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "goal.md"), "# Sample Goal\n");
  return root;
}

function writeState(root, body) {
  writeFileSync(join(root, "state.yaml"), body.trimStart());
}

function runChecker(root) {
  const result = spawnSync(process.execPath, [checker, join(root, "state.yaml")], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

const validScoutBoard = `
version: 2

goal:
  title: "Improve this project"
  slug: "improve-this-project"
  kind: open_ended
  tranche: "discovery-then-first-safe-improvement"
  status: active

rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true

agents:
  scout: installed
  worker: installed
  judge: installed

active_task: T001

tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: active
    objective: "Map the repo and identify improvement candidates."
    inputs:
      - README.md
      - package.json
    constraints:
      - "Read-only."
    expected_output:
      - "Repo map"
      - "Candidate tasks"
    receipt: null
  - id: T002
    type: judge
    assignee: Judge
    status: queued
    objective: "Choose the first safe tranche."
    inputs:
      - "T001 receipt"
    constraints:
      - "Do not implement."
    expected_output:
      - "Decision"
    receipt: null

checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`;

test("accepts a valid v2 board with one active Scout task", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
    assert.equal(result.stdout.version, 2);
    assert.equal(result.stdout.active_task, "T001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects done goals with placeholder oracle proof", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Weak finish"
  slug: "weak-finish"
  kind: specific
  tranche: "prove completion"
  status: done
  oracle:
    signal: "<observable signal>"
    final_proof: "<receipt-backed final proof>"
  intake:
    completion_proof: "<observable completion proof>"
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
    objective: "Audit completion."
    receipt:
      result: done
      decision: complete
      full_outcome_complete: true
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: pass
    task: T999
    commands: []
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /done goals require concrete completion proof/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts explicit non-installed agent states with actionable warnings", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard
      .replace("scout: installed", "scout: bundled_not_installed")
      .replace("worker: installed", "worker: missing")
      .replace("judge: installed", "judge: unknown"));
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
    assert.deepEqual(result.stdout.agent_statuses, {
      scout: "bundled_not_installed",
      worker: "missing",
      judge: "unknown",
    });
    assert.match(result.stdout.warnings.join("\n"), /PM fallback/i);
    assert.match(result.stdout.warnings.join("\n"), /install channel with: agents/i);
    assert.match(result.stdout.warnings.join("\n"), /install channel with: install/i);
    assert.match(result.stdout.warnings.join("\n"), /install channel with: doctor/i);
    assert.match(result.stdout.warnings.join("\n"), /agents\.judge is unknown; \/goal must attempt the exact harness-specific Judge agent once/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts generated local visual board artifacts in goal roots", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    mkdirSync(join(root, ".goalbuddy-board"), { recursive: true });
    writeFileSync(join(root, ".goalbuddy-board", "index.html"), "<!doctype html>\n");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an active Worker only with scope, verification, and stop conditions", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Fix router coverage"
  slug: "fix-router-coverage"
  kind: specific
  tranche: "router regression coverage"
  status: active
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T004
tasks:
  - id: T004
    type: worker
    assignee: Worker
    status: active
    objective: "Add focused router dispatch regression coverage."
    allowed_files:
      - src/router/index.ts
      - test/router.test.ts
    verify:
      - git diff --check
      - npm test -- test/router.test.ts
    stop_if:
      - "Need files outside allowed_files."
      - "Verification fails twice."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warns on active micro Worker/Judge loops without breaking old boards", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Projection helper churn"
  slug: "projection-helper-churn"
  kind: existing_plan
  tranche: "backend foundation"
  status: active
  full_outcome_complete: false
rules:
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T004
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Create one narrow pure caller-input user_roles projection helper."
    allowed_files:
      - lib/db/user-role-projection.ts
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt:
      result: done
      changed_files:
        - lib/db/user-role-projection.ts
      commands:
        - cmd: npm test
          status: pass
      summary: "Added one helper."
  - id: T002
    type: judge
    assignee: Judge
    status: done
    objective: "Audit T001's pure caller-input user_roles projection helper."
    receipt:
      result: done
      decision: approved
  - id: T003
    type: worker
    assignee: Worker
    status: done
    objective: "Create one narrow pure caller-input connector_runs projection helper."
    allowed_files:
      - lib/db/connector-run-projection.ts
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt:
      result: done
      changed_files:
        - lib/db/connector-run-projection.ts
      commands:
        - cmd: npm test
          status: pass
      summary: "Added one helper."
  - id: T004
    type: judge
    assignee: Judge
    status: active
    objective: "Audit T003's pure caller-input connector_runs projection helper."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
    assert.match(result.stdout.warnings.join("\n"), /Board may be micro-slicing\. Prefer the largest safe useful slice/i);
    assert.match(result.stdout.warnings.join("\n"), /Micro Worker\/Judge loop detected/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function processHeavyBoard() {
  const pad = (value) => `T${String(value).padStart(3, "0")}`;
  const cards = [];
  let id = 0;
  cards.push(`  - id: ${pad(++id)}
    type: worker
    assignee: Worker
    status: done
    objective: "Ship the first outcome slice."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - package.json
      commands:
        - cmd: npm test
          status: pass
      summary: "Slice shipped."`);
  for (let index = 0; index < 8; index += 1) {
    cards.push(`  - id: ${pad(++id)}
    type: judge
    assignee: Judge
    status: done
    objective: "Audit micro-step ${id}."
    receipt:
      result: done
      decision: approved`);
    cards.push(`  - id: ${pad(++id)}
    type: pm
    assignee: PM
    status: done
    objective: "Plan micro-step ${id}."
    receipt:
      result: done
      summary: "Planned."`);
  }
  for (let index = 0; index < 13; index += 1) {
    cards.push(`  - id: ${pad(++id)}
    type: pm
    assignee: PM
    status: blocked
    objective: "Process follow-up ${id}."
    receipt:
      result: blocked
      summary: "Waiting on process."`);
  }
  return `
version: 2
goal:
  title: "Process heavy"
  slug: "process-heavy"
  kind: open_ended
  tranche: "consolidation"
  status: blocked
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
${cards.join("\n")}
`;
}

test("warns on process-heavy boards and blocked backlogs without failing them", () => {
  const root = makeRoot();
  try {
    writeState(root, processHeavyBoard());
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
    const joined = result.stdout.warnings.join("\n");
    assert.match(joined, /13 unfinished tasks on a blocked board with no active task/i);
    assert.match(joined, /29 PM\/Judge\/Scout tasks vs 1 Worker tasks/i);
    assert.match(joined, /consecutive planning, audit, or process-only tasks/i);
    assert.match(joined, /consolidate only future work into roughly 3-7 outcome-sized phases/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt renderer surfaces process-heavy warnings without failing the board", () => {
  const root = makeRoot();
  try {
    writeState(root, processHeavyBoard());
    const result = renderTaskPrompt({ goalRoot: root, taskId: "T030", json: true });
    const joined = result.payload.metadata.warnings.join("\n");
    assert.match(joined, /Board is process-heavy/i);
    assert.match(joined, /PM\/Judge\/Scout tasks vs 1 Worker tasks/i);
    assert.match(formatPrompt(result.payload), /Board is process-heavy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps normal small boards free of process-heavy warnings", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    const result = runChecker(root);
    assert.equal(result.stdout.ok, true);
    assert.doesNotMatch(result.stdout.warnings.join("\n"), /process-heavy/i);
    const rendered = renderTaskPrompt({ goalRoot: root, taskId: "T001", json: true });
    assert.doesNotMatch(rendered.payload.metadata.warnings.join("\n"), /process-heavy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid goal status and absent agent states", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Bad status"
  slug: "bad-status"
  kind: open_ended
  tranche: "truthful board"
  status: banana
rules:
  continuous_until_full_outcome: true
active_task: T001
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: active
    objective: "Map the repo."
    receipt: null
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /goal\.status must be active, blocked, or done/i);
    assert.match(result.stdout.errors.join("\n"), /agents\.scout must be one of installed, bundled_not_installed, missing, or unknown/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported agent states", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard.replace("scout: installed", "scout: maybe"));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /agents\.scout must be one of installed, bundled_not_installed, missing, or unknown; got maybe/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects task type and assignee mismatch", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard.replace("assignee: Scout", "assignee: Worker"));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /assignee must be Scout for type scout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects blocked task without receipt", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Blocked slice"
  slug: "blocked-slice"
  kind: open_ended
  tranche: "truthful blocking"
  status: active
rules:
  continuous_until_full_outcome: true
  missing_input_or_credentials_do_not_stop_goal: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T002
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: blocked
    objective: "Run the production-only command."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Need production access."
    receipt: null
  - id: T002
    type: scout
    assignee: Scout
    status: active
    objective: "Find a safe local workaround."
    receipt: null
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /blocked task T001 missing receipt/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects legacy v1 state with gate or units schema", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "evidence.jsonl"), "");
    mkdirSync(join(root, "units"), { recursive: true });
    writeState(root, `
goal: "Legacy"
status: green
active_unit: U-001
gate:
  status: green
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /legacy v1/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects more than one active task", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard.replace("status: queued", "status: active"));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /exactly one active task/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects done task without receipt", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard.replace(
      `status: active
    objective: "Map the repo and identify improvement candidates."`,
      `status: done
    objective: "Map the repo and identify improvement candidates."`,
    ));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /done task T001 missing receipt/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects root evidence, units, artifacts, or stray markdown", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    writeFileSync(join(root, "evidence.jsonl"), "");
    mkdirSync(join(root, "units"), { recursive: true });
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "scout-report.md"), "# Stray\n");
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /unexpected root entries/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts depth-1 subgoals inside the parent goal root", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "subgoals", "T003-child", "notes"), { recursive: true });
    writeFileSync(join(root, "subgoals", "T003-child", "goal.md"), "# Child\n");
    writeFileSync(join(root, "subgoals", "T003-child", "state.yaml"), `
version: 2
goal:
  title: "Child board"
  slug: "child-board"
  kind: specific
  tranche: "Child branch."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Do child work."
    allowed_files:
      - src/child.ts
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    writeState(root, `
version: 2
goal:
  title: "Parent board"
  slug: "parent-board"
  kind: specific
  tranche: "Parent with child."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T003
tasks:
  - id: T003
    type: worker
    assignee: Worker
    status: active
    objective: "Run a bounded child branch."
    allowed_files:
      - src/parent.ts
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    subgoal:
      status: active
      path: subgoals/T003-child/state.yaml
      owner: Worker
      created_from: T003
      depth: 1
      rollup_receipt: null
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects subgoals outside root, missing child files, and nested child subgoals", () => {
  const outside = makeRoot();
  try {
    writeState(outside, validScoutBoard.replace(
      "receipt: null",
      `subgoal:
      status: active
      path: ../outside/state.yaml
      owner: Worker
      depth: 1
    receipt: null`,
    ));
    const result = runChecker(outside);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /subgoal\.path must stay inside the goal root/i);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  const missing = makeRoot();
  try {
    writeState(missing, validScoutBoard.replace(
      "receipt: null",
      `subgoal:
      status: active
      path: subgoals/missing/state.yaml
      owner: Worker
      depth: 1
    receipt: null`,
    ));
    const result = runChecker(missing);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /subgoal state file not found/i);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }

  const nested = makeRoot();
  try {
    mkdirSync(join(nested, "subgoals", "T001-child", "subgoals", "T001-grandchild", "notes"), { recursive: true });
    mkdirSync(join(nested, "subgoals", "T001-child", "notes"), { recursive: true });
    writeFileSync(join(nested, "subgoals", "T001-child", "goal.md"), "# Child\n");
    writeFileSync(join(nested, "subgoals", "T001-child", "subgoals", "T001-grandchild", "goal.md"), "# Grandchild\n");
    writeFileSync(join(nested, "subgoals", "T001-child", "subgoals", "T001-grandchild", "state.yaml"), validScoutBoard);
    writeFileSync(join(nested, "subgoals", "T001-child", "state.yaml"), validScoutBoard.replace(
      "receipt: null",
      `subgoal:
      status: active
      path: subgoals/T001-grandchild/state.yaml
      owner: Worker
      depth: 1
    receipt: null`,
    ));
    writeState(nested, validScoutBoard.replace(
      "receipt: null",
      `subgoal:
      status: active
      path: subgoals/T001-child/state.yaml
      owner: Worker
      depth: 1
    receipt: null`,
    ));

    const result = runChecker(nested);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /child task T001 must not contain a nested subgoal/i);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test("accepts done goal only with final Judge or PM audit receipt", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Improve docs"
  slug: "improve-docs"
  kind: specific
  tranche: "docs cleanup"
  status: done
  oracle:
    signal: "README changed and git diff --check passes."
    final_proof: "T002 audit confirms docs cleanup after passing git diff --check."
  intake:
    completion_proof: "README changed and git diff --check passes."
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Update docs."
    allowed_files:
      - README.md
    verify:
      - git diff --check
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - README.md
      commands:
        - cmd: git diff --check
          status: pass
      summary: "Docs updated."
  - id: T002
    type: judge
    assignee: Judge
    status: done
    objective: "Audit tranche completion."
    receipt:
      result: done
      decision: complete
      summary: "Tranche complete with current verification."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T002
    commands:
      - cmd: git diff --check
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects done Worker receipts with failed commands or files outside scope", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "False green"
  slug: "false-green"
  kind: specific
  tranche: "truthful receipt"
  status: done
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Update README only."
    allowed_files:
      - README.md
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - README.md
        - package.json
      commands:
        - cmd: npm test
          status: fail
      summary: "Claimed done despite failed verification and widened scope."
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit completion."
    receipt:
      result: done
      decision: complete
      full_outcome_complete: true
      summary: "Incorrectly approved."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: fail
    task: T001
    commands:
      - cmd: npm test
        status: fail
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    const errors = result.stdout.errors.join("\n");
    assert.match(errors, /changed file outside allowed_files: package\.json/i);
    assert.match(errors, /non-passing command status: fail/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts done Worker changed files that match allowed_files globs", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Agent contract update"
  slug: "agent-contract-update"
  kind: specific
  tranche: "Update agent files."
  status: done
  oracle:
    signal: "Agent contract files are updated and npm test passes."
    final_proof: "T999 audit confirms changed files match allowed globs after npm test passes."
  intake:
    completion_proof: "Agent contract files are updated and npm test passes."
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Update agent contracts."
    allowed_files:
      - goalbuddy/agents/**
      - plugins/goalbuddy/**
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - goalbuddy/agents/goal_scout.toml
        - plugins/goalbuddy/agents/goal-scout.md
      commands:
        - cmd: npm test
          status: pass
      summary: "Agent contracts updated."
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit completion."
    receipt:
      result: done
      decision: complete
      summary: "Complete."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T001
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects done goal with unfinished Worker task", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Improve backend automation"
  slug: "improve-backend-automation"
  kind: open_ended
  tranche: "first safe backend automation slice"
  status: done
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: done
    objective: "Map backend automation gaps."
    receipt:
      result: done
      summary: "Found one safe automation slice."
      evidence:
        - package.json
  - id: T002
    type: worker
    assignee: Worker
    status: queued
    objective: "Implement the first safe automation slice."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt: null
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit tranche completion."
    receipt:
      result: done
      decision: complete
      summary: "Incorrectly claimed complete despite queued Worker."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T999
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /done goals must not leave queued or active Worker tasks: T002/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects continuous done goal without full outcome audit", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Build autonomous backend"
  slug: "build-autonomous-backend"
  kind: open_ended
  tranche: "continuous backend automation"
  status: done
  oracle:
    signal: "Backend automation outcome is implemented and npm test passes."
    final_proof: "T999 audit records full_outcome_complete after Worker receipt and passing npm test."
  intake:
    completion_proof: "Backend automation outcome is implemented and npm test passes."
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Implement the first safe backend slice."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - package.json
      commands:
        - cmd: npm test
          status: pass
      summary: "One slice completed."
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit slice completion."
    receipt:
      result: done
      decision: complete
      summary: "Current slice complete, but full outcome was not declared complete."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T001
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /full_outcome_complete: true/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts continuous done goal with full outcome audit", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Build autonomous backend"
  slug: "build-autonomous-backend"
  kind: open_ended
  tranche: "continuous backend automation"
  status: done
  oracle:
    signal: "Backend automation outcome is implemented and npm test passes."
    final_proof: "T999 audit records full_outcome_complete after Worker receipt and passing npm test."
  intake:
    completion_proof: "Backend automation outcome is implemented and npm test passes."
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Implement the complete backend automation outcome."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt:
      result: done
      changed_files:
        - package.json
      commands:
        - cmd: npm test
          status: pass
      summary: "Full outcome completed."
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit full outcome completion."
    receipt:
      result: done
      decision: complete
      full_outcome_complete: true
      summary: "Full original outcome complete."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T001
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects blocked continuous goal when missing input should not stop the goal", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Build autonomous backend"
  slug: "build-autonomous-backend"
  kind: open_ended
  tranche: "continuous backend automation"
  status: blocked
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
  continuous_until_full_outcome: true
  missing_input_or_credentials_do_not_stop_goal: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T002
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: blocked
    objective: "Run credentialed backend execute slice."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Need credentials."
    receipt:
      result: blocked
      changed_files:
        - package.json
      commands:
        - cmd: npm test
          status: pass
      summary: "Blocked on credentials."
  - id: T002
    type: worker
    assignee: Worker
    status: active
    objective: "Implement safe local workaround while credentials are missing."
    allowed_files:
      - package.json
    verify:
      - npm test
    stop_if:
      - "Verification fails twice."
    receipt: null
checks:
  dirty_fingerprint: dirty
  last_verification:
    result: pass
    task: T001
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout.errors.join("\n"), /missing input or credentials should block specific tasks/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts terminal approval wait when exact human approval is the only remaining action", () => {
  const root = makeRoot();
  try {
    writeState(root, `
version: 2
goal:
  title: "Run production migration"
  slug: "run-production-migration"
  kind: specific
  tranche: "Apply the approved migration after exact owner approval."
  status: blocked
rules:
  pm_owns_state: true
  one_active_task: true
  max_write_workers: 1
  no_implementation_without_worker_or_pm_task: true
  no_completion_without_judge_or_pm_audit: true
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
    objective: "Apply production migration after exact approval."
    allowed_files:
      - db/migrations/**
    verify:
      - npm test
    stop_if:
      - "Need exact production approval phrase."
    receipt:
      result: blocked
      waiting_for_user_approval: true
      required_reply: "approve 20260521234500"
      blocked_reason: "Production migration requires exact human approval before any destructive operation."
      summary: "Asked once for the exact approval phrase and stopped."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T001
    commands:
      - cmd: npm test
        status: pass
`);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.stdout));
    assert.equal(result.stdout.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a goal directory argument", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    const result = spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true, result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves # inside quoted scalars", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard.replace(
      'objective: "Map the repo and identify improvement candidates."',
      'objective: "#12 regression: map the repo."',
    ));
    const result = runChecker(root);
    assert.equal(result.stdout.ok, true, JSON.stringify(result.stdout.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a broken symlink in the goal root instead of crashing", () => {
  const root = makeRoot();
  try {
    writeState(root, validScoutBoard);
    symlinkSync(join(root, "does-not-exist"), join(root, "dangling"));
    const result = runChecker(root);
    assert.equal(typeof result.stdout.ok, "boolean", result.stderr);
    assert.equal(result.stdout.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const cli = resolve("internal/cli/goal-maker.mjs");
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

function runGoalMaker(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: testEnv(options.env || process.env),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function testEnv(env) {
  const result = { ...env };
  delete result.GITHUB_TOKEN;
  if (result.GOALBUDDY_TEST_DISABLE_CLAUDE_CLI === undefined) {
    result.GOALBUDDY_TEST_DISABLE_CLAUDE_CLI = "1";
  }
  return result;
}

function pathSuffixPattern(...segments) {
  return new RegExp(`${segments.map(escapeRegExp).join("[\\\\/]")}$`);
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function receiptContractSchema(agentPath) {
  const text = readFileSync(agentPath, "utf8");
  const match = text.match(/\{\s*"goalbuddy_receipt_v1":\s*(\{[\s\S]*?\n\s*\})\s*\n\}/);
  assert.ok(match, `missing goalbuddy_receipt_v1 contract in ${agentPath}`);
  return JSON.parse(match[1]);
}

function fakeCodexBin(root, { loggedIn = true, goalsEnabled = true } = {}) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const script = [
      "@echo off",
      "if \"%~1\"==\"--version\" echo codex-cli 0.128.0& exit /b 0",
      "if \"%~1\"==\"login\" if \"%~2\"==\"status\" (",
      loggedIn ? "  echo Logged in with ChatGPT& exit /b 0" : "  echo Not logged in& exit /b 1",
      ")",
      "if \"%~1\"==\"features\" if \"%~2\"==\"list\" (",
      `  echo goals                               under development  ${goalsEnabled ? "true" : "false"}& exit /b 0`,
      ")",
      "if \"%~1\"==\"plugin\" if \"%~2\"==\"marketplace\" if \"%~3\"==\"add\" echo Added marketplace goalbuddy& exit /b 0",
      "exit /b 2",
      "",
    ].join("\r\n");
    writeFileSync(join(bin, "codex.cmd"), script);
  } else {
    const script = [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.128.0\"; exit 0; fi",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
      loggedIn ? "  echo \"Logged in with ChatGPT\"; exit 0" : "  echo \"Not logged in\"; exit 1",
      "fi",
      "if [ \"$1\" = \"features\" ] && [ \"$2\" = \"list\" ]; then",
      `  echo "goals                               under development  ${goalsEnabled ? "true" : "false"}"; exit 0`,
      "fi",
      "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"marketplace\" ] && [ \"$3\" = \"add\" ]; then",
      "  echo \"Added marketplace goalbuddy\"; exit 0",
      "fi",
      "exit 2",
      "",
    ].join("\n");
    const path = join(bin, "codex");
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return bin;
}

function fakeCodexEnv(root, options = {}) {
  const fakeBin = fakeCodexBin(root, options);
  return {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
  };
}

test("doctor fails when a required bundled agent is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const install = runGoalMaker(["install", "--codex-home", codexHome], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    unlinkSync(join(codexHome, "agents", "goal_worker.toml"));

    const doctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);

    const report = JSON.parse(doctor.stdout);
    assert.equal(report.codex_install_model, "plugin");
    assert.equal(report.plugin.skill_installed, true);
    assert.equal(report.plugin.enabled, true);
    assert.equal(report.skill_installed, false);
    assert.equal(report.compatibility_skill_installed, false);
    assert.deepEqual(report.missing_agents, ["goal_worker.toml"]);
    assert.match(report.errors.join("\n"), /Missing GoalBuddy Codex agent: goal_worker\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor distinguishes fully removed and residual-agent Codex states", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);

    const fullyRemoved = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(fullyRemoved.status, 1, fullyRemoved.stderr || fullyRemoved.stdout);
    const fullyRemovedReport = JSON.parse(fullyRemoved.stdout);
    assert.equal(fullyRemovedReport.runtime_state, "fully-removed");
    assert.deepEqual(fullyRemovedReport.installed_agents, []);
    assert.deepEqual(fullyRemovedReport.residual_agents, []);
    assert.deepEqual(fullyRemovedReport.missing_agents, []);
    assert.match(fullyRemovedReport.errors.join("\n"), /fully removed/);

    const agentsDir = join(codexHome, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "goal_worker.toml"), readFileSync("goalbuddy/agents/goal_worker.toml", "utf8"));

    const residual = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(residual.status, 1, residual.stderr || residual.stdout);
    const residualReport = JSON.parse(residual.stdout);
    assert.equal(residualReport.runtime_state, "residual-agents-only");
    assert.deepEqual(residualReport.residual_agents, ["goal_worker.toml"]);
    assert.deepEqual(residualReport.missing_agents, ["goal_judge.toml", "goal_scout.toml"]);
    assert.match(residualReport.errors.join("\n"), /Residual GoalBuddy Codex agents remain/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor fails when a bundled agent is stale and update refreshes it", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const install = runGoalMaker(["install", "--codex-home", codexHome], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    writeFileSync(join(codexHome, "agents", "goal_worker.toml"), "stale\n");

    const staleDoctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(staleDoctor.status, 1, staleDoctor.stderr || staleDoctor.stdout);
    assert.deepEqual(JSON.parse(staleDoctor.stdout).stale_agents, ["goal_worker.toml"]);

    const update = runGoalMaker(["update", "--codex-home", codexHome], { env });
    assert.equal(update.status, 0, update.stderr || update.stdout);

    const refreshedDoctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(refreshedDoctor.status, 0, refreshedDoctor.stderr || refreshedDoctor.stdout);
    assert.deepEqual(JSON.parse(refreshedDoctor.stdout).stale_agents, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports native goal runtime readiness and supports strict goal-ready mode", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root, { loggedIn: false, goalsEnabled: false });

    const install = runGoalMaker(["install", "--codex-home", codexHome], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const doctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.goal_runtime.codex_cli_available, true);
    assert.equal(report.goal_runtime.logged_in, false);
    assert.equal(report.goal_runtime.goals_feature_enabled, false);
    assert.equal(report.goal_runtime.ready, false);

    const strictDoctor = runGoalMaker(["doctor", "--goal-ready", "--codex-home", codexHome], { env });
    assert.equal(strictDoctor.status, 1, strictDoctor.stderr || strictDoctor.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled agent contracts stay strict and receipt-shaped", () => {
  const scout = readFileSync("goalbuddy/agents/goal_scout.toml", "utf8");
  const judge = readFileSync("goalbuddy/agents/goal_judge.toml", "utf8");
  const worker = readFileSync("goalbuddy/agents/goal_worker.toml", "utf8");
  assert.match(scout, /model_reasoning_effort = "low"/);
  assert.match(scout, /Read only/);
  assert.match(scout, /goalbuddy_receipt_v1/);
  assert.match(judge, /Parallel Worker work is safe only with provably disjoint allowed_files/);
  assert.match(judge, /Choose the largest safe useful slice/);
  assert.match(judge, /Routine checks belong to the checker/);
  assert.match(worker, /model_reasoning_effort = "medium"/);
  assert.match(worker, /Edit only files matching allowed_files/);
  assert.match(worker, /Complete the whole assigned slice/);
  assert.match(worker, /verification_attempts/);

  assert.equal(readFileSync("plugins/goalbuddy/skills/goal-prep/agents/goal_scout.toml", "utf8"), scout);
  assert.equal(readFileSync("plugins/goalbuddy/skills/goal-prep/agents/goal_judge.toml", "utf8"), judge);
  assert.equal(readFileSync("plugins/goalbuddy/skills/goal-prep/agents/goal_worker.toml", "utf8"), worker);
});

test("install bundles the core local board surface into the skill", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const install = runGoalMaker(["install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const skillRoot = join(JSON.parse(install.stdout).cache_path, "skills", "goal-prep");
    assert.equal(existsSync(join(skillRoot, "surfaces", "local-goal-board", "scripts", "local-goal-board.mjs")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-update reports newer published GoalBuddy versions", () => {
  const env = {
    ...process.env,
    GOALBUDDY_TEST_NPM_LATEST_VERSION: "99.0.0",
    GOALBUDDY_TEST_UPDATE_COMMAND: "/plugin update goalbuddy@goalbuddy",
  };

  const result = runGoalMaker(["check-update", "--json"], { env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.current_version, packageVersion);
  assert.equal(report.latest_version, "99.0.0");
  assert.equal(report.update_available, true);
  assert.equal(report.update_command, "/plugin update goalbuddy@goalbuddy");

  const human = runGoalMaker(["check-update"], { env });
  assert.equal(human.status, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /GoalBuddy 99\.0\.0 is available/);
  assert.match(human.stdout, /Update with: \/plugin update goalbuddy@goalbuddy/);
});

test("check-update avoids guessing an unknown install channel", () => {
  const env = {
    GOALBUDDY_TEST_NPM_LATEST_VERSION: "99.0.0",
  };

  const result = runGoalMaker(["check-update", "--json"], { env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.update_command, "use the install channel that installed GoalBuddy");
});

test("prompt renders a compact active task prompt without dumping full state", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "goal");
    mkdirSync(goal, { recursive: true });
    writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "Prompt test"
  slug: "prompt-test"
  kind: specific
  tranche: "Render a prompt."
  status: active
  oracle:
    signal: "Prompt includes the active task contract without dumping old receipts."
    final_proof: "JSON and human prompt outputs include the goal oracle and active task."
rules:
  slice_policy:
    max_consecutive_tiny_tasks: 2
    prefer_vertical_slices: true
    judge_picks_largest_safe_slice: true
    worker_completes_whole_slice: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T002
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: done
    objective: "Old work."
    receipt:
      result: done
      summary: "A previous finding that should not force a full state dump."
      evidence:
        - README.md
  - id: T002
    type: worker
    assignee: Worker
    status: active
    objective: "Patch the prompt renderer."
    allowed_files:
      - goalbuddy/scripts/**
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const result = runGoalMaker(["prompt", goal, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.metadata.recommended_agent, "goal_worker");
    assert.equal(report.metadata.required_spawn_agent_type, "goal_worker");
    assert.equal(report.metadata.required_claude_subagent_type, "goal-worker");
    assert.equal(report.metadata.sandbox, "workspace-write");
    assert.deepEqual(report.metadata.goal_oracle, {
      signal: "Prompt includes the active task contract without dumping old receipts.",
      final_proof: "JSON and human prompt outputs include the goal oracle and active task.",
    });
    assert.deepEqual(report.metadata.slice_policy, {
      max_consecutive_tiny_tasks: 2,
      prefer_vertical_slices: true,
      judge_picks_largest_safe_slice: true,
      worker_completes_whole_slice: true,
    });
    assert.equal(report.task.id, "T002");
    assert.deepEqual(report.task.allowed_files, ["goalbuddy/scripts/**"]);
    assert.equal(report.receipt_schema.task_id, "<T###>");
    assert.equal(report.receipt_schema.board_path, "<path to state.yaml>");
    assert.equal(report.receipt_schema.stopped_because, null);
    assert.equal(Object.hasOwn(report.receipt_schema, "needs_judge"), false);
    assert.equal(Object.hasOwn(report.receipt_schema, "next_allowed_task"), false);
    assert.equal(result.stdout.includes("A previous finding that should not force a full state dump."), false);

    const human = runGoalMaker(["prompt", goal]);
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /Codex spawn_agent agent_type: goal_worker/);
    assert.match(human.stdout, /Claude Code Agent tool subagent_type: goal-worker/);
    assert.match(human.stdout, /Do not substitute generic scout, worker, judge, Explore, or general-purpose agents/);
    assert.match(human.stdout, /Native wait_agent timeouts are non-terminal 60-second observation windows/);
    assert.match(human.stdout, /live agent list or status \(Codex: list_agents\)/);
    assert.match(human.stdout, /Scout and Judge are read-only/);
    assert.match(human.stdout, /after 20 windows for Scout\/Judge or 30 for Worker/);
    assert.match(human.stdout, /one status request and at most five more windows/);
    assert.match(human.stdout, /only if there is still no reply or execution evidence/);
    assert.doesNotMatch(human.stdout, /After one wait_agent timeout/);
    assert.match(human.stdout, /goal_oracle/);
    assert.match(human.stdout, /slice_policy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt maps every GoalBuddy role for Codex and Claude Code", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-role-routing-"));
  try {
    const roles = [
      ["scout", "goal_scout", "goal-scout"],
      ["worker", "goal_worker", "goal-worker"],
      ["judge", "goal_judge", "goal-judge"],
      ["pm", null, null],
    ];

    for (const [role, codexType, claudeType] of roles) {
      const goal = join(root, role);
      mkdirSync(goal, { recursive: true });
      writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "${role} routing"
  slug: "${role}-routing"
  kind: specific
  tranche: "Route one task."
  status: active
agents:
  scout: unknown
  worker: unknown
  judge: unknown
active_task: T001
tasks:
  - id: T001
    type: ${role}
    assignee: ${role === "pm" ? "PM" : role[0].toUpperCase() + role.slice(1)}
    status: active
    objective: "Exercise ${role} routing."
    allowed_files: []
    verify: []
    stop_if: []
    receipt: null
`);

      const json = runGoalMaker(["prompt", goal, "--json"]);
      assert.equal(json.status, 0, json.stderr || json.stdout);
      const report = JSON.parse(json.stdout);
      assert.equal(report.metadata.required_spawn_agent_type, codexType);
      assert.equal(report.metadata.required_claude_subagent_type, claudeType);

      const human = runGoalMaker(["prompt", goal]);
      assert.equal(human.status, 0, human.stderr || human.stdout);
      assert.match(human.stdout, new RegExp(`Codex spawn_agent agent_type: ${codexType || "do not spawn; run as PM"}`));
      assert.match(human.stdout, new RegExp(`Claude Code Agent tool subagent_type: ${claudeType || "do not spawn; run as PM"}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt resolves relative goal paths without rewriting task ids", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "docs", "goals", "demo");
    mkdirSync(goal, { recursive: true });
    writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "Relative prompt test"
  slug: "relative-prompt-test"
  kind: specific
  tranche: "Render a relative prompt."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T002
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: done
    objective: "Inspect the relative board."
    receipt:
      result: done
      summary: "Mapped the board."
  - id: T002
    type: worker
    assignee: Worker
    status: active
    objective: "Patch the relative board."
    allowed_files:
      - internal/cli/**
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const cases = [
      ["prompt", "docs/goals/demo", "--task", "T001", "--json"],
      ["prompt", "docs/goals/demo", "--task=T001", "--json"],
      ["prompt", "--board", "docs/goals/demo/state.yaml", "--task", "T001", "--json"],
    ];
    for (const args of cases) {
      const result = runGoalMaker(args, { cwd: root });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.task.id, "T001", args.join(" "));
      assert.equal(report.metadata.board_path, join(realpathSync(goal), "state.yaml"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt receipt schemas mirror bundled agent receipt contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const cases = [
      {
        type: "scout",
        agent: "goal_scout",
        assignee: "Scout",
        extra: "",
      },
      {
        type: "judge",
        agent: "goal_judge",
        assignee: "Judge",
        extra: "",
      },
      {
        type: "worker",
        agent: "goal_worker",
        assignee: "Worker",
        extra: [
          "    allowed_files:",
          "      - goalbuddy/scripts/**",
          "    verify:",
          "      - npm test",
          "    stop_if:",
          "      - \"Need files outside allowed_files.\"",
        ].join("\n"),
      },
    ];

    for (const item of cases) {
      const goal = join(root, item.type);
      mkdirSync(goal, { recursive: true });
      writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "${item.type} prompt contract"
  slug: "${item.type}-prompt-contract"
  kind: specific
  tranche: "Render ${item.type} prompt."
  status: active
  oracle:
    signal: "Rendered prompt schema matches the bundled ${item.agent} receipt contract."
    final_proof: "Receipt schema object matches the agent contract object."
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T001
tasks:
  - id: T001
    type: ${item.type}
    assignee: ${item.assignee}
    status: active
    objective: "Render the ${item.type} task prompt."
${item.extra ? `${item.extra}\n` : ""}    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

      const result = runGoalMaker(["prompt", goal, "--json"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      const expectedSchema = receiptContractSchema(`goalbuddy/agents/${item.agent}.toml`);
      assert.deepEqual(report.receipt_schema, expectedSchema, item.agent);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt warns when the board may be micro-slicing", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "goal");
    mkdirSync(goal, { recursive: true });
    writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "Prompt warning test"
  slug: "prompt-warning-test"
  kind: existing_plan
  tranche: "Backend milestone."
  status: active
  first_milestone_complete: true
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
    objective: "Add one narrow projection helper."
    receipt:
      result: done
      summary: "Added one helper."
  - id: T002
    type: worker
    assignee: Worker
    status: done
    objective: "Add one narrow contract file."
    receipt:
      result: done
      summary: "Added one contract."
  - id: T003
    type: worker
    assignee: Worker
    status: done
    objective: "Add one narrow validation wrapper."
    receipt:
      result: done
      summary: "Added one wrapper."
  - id: T004
    type: worker
    assignee: Worker
    status: active
    objective: "Add one more projection helper."
    allowed_files:
      - lib/helper.ts
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const result = runGoalMaker(["prompt", goal, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.metadata.warnings.join("\n"), /Board may be micro-slicing\. Prefer the largest safe useful slice/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel-plan allows read-only active tasks and does not mutate state", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "goal");
    const child = join(goal, "subgoals", "T001-child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "state.yaml"), `version: 2
goal:
  title: "Child"
  slug: "child"
  kind: specific
  tranche: "Judge child."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T010
tasks:
  - id: T010
    type: judge
    assignee: Judge
    status: active
    objective: "Judge child evidence."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    const parentState = `version: 2
goal:
  title: "Parent"
  slug: "parent"
  kind: specific
  tranche: "Scout parent."
  status: active
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
    objective: "Scout parent evidence."
    subgoal:
      status: active
      path: subgoals/T001-child/state.yaml
      owner: Judge
      depth: 1
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`;
    writeFileSync(join(goal, "state.yaml"), parentState);

    const result = runGoalMaker(["parallel-plan", "goal", "--json"], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mutated, false);
    assert.equal(report.spawned_agents, false);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidates.every((candidate) => candidate.safe_to_parallelize), true);
    assert.equal(readFileSync(join(goal, "state.yaml"), "utf8"), parentState);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel-plan rejects overlapping active Worker write scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "goal");
    const child = join(goal, "subgoals", "T001-child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "state.yaml"), `version: 2
goal:
  title: "Child"
  slug: "child"
  kind: specific
  tranche: "Patch child."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T010
tasks:
  - id: T010
    type: worker
    assignee: Worker
    status: active
    objective: "Patch same area."
    allowed_files:
      - src/router.ts
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "Parent"
  slug: "parent"
  kind: specific
  tranche: "Patch parent."
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
    objective: "Patch broad area."
    allowed_files:
      - src/**
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    subgoal:
      status: active
      path: subgoals/T001-child/state.yaml
      owner: Worker
      depth: 1
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const result = runGoalMaker(["parallel-plan", goal, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidates.every((candidate) => candidate.safe_to_parallelize === false), true);
    assert.match(report.candidates[0].reason, /overlaps|cannot be compared/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel-plan treats overlapping Worker glob patterns as unsafe", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const goal = join(root, "goal");
    const child = join(goal, "subgoals", "T001-child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "state.yaml"), `version: 2
goal:
  title: "Child"
  slug: "child"
  kind: specific
  tranche: "Patch child."
  status: active
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T010
tasks:
  - id: T010
    type: worker
    assignee: Worker
    status: active
    objective: "Patch possible TypeScript peer."
    allowed_files:
      - src/foo.*
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);
    writeFileSync(join(goal, "state.yaml"), `version: 2
goal:
  title: "Parent"
  slug: "parent"
  kind: specific
  tranche: "Patch parent."
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
    objective: "Patch TypeScript files."
    allowed_files:
      - src/*.ts
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    subgoal:
      status: active
      path: subgoals/T001-child/state.yaml
      owner: Worker
      depth: 1
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const result = runGoalMaker(["parallel-plan", goal, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidates.every((candidate) => candidate.safe_to_parallelize === false), true);
    assert.match(report.candidates[0].reason, /overlaps|cannot be compared/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install adds marketplace, caches plugin, and enables config", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const fakeBin = fakeCodexBin(root);
    const env = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    };

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const report = JSON.parse(install.stdout);
    assert.equal(report.installed, true);
    assert.equal(report.plugin, "goalbuddy@goalbuddy");
    assert.equal(report.version, packageVersion);
    assert.match(report.cache_path, pathSuffixPattern("plugins", "cache", "goalbuddy", "goalbuddy", packageVersion));
    assert.match(report.config_path, /config\.toml$/);
    assert.equal(existsSync(join(report.cache_path, "skills", "goal-prep", "surfaces", "local-goal-board", "scripts", "local-goal-board.mjs")), true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.match(config, /\[plugins\."goalbuddy@goalbuddy"\]/);
    assert.match(config, /enabled = true/);

    const doctor = runGoalMaker(["doctor", "--target", "codex", "--goal-ready", "--codex-home", codexHome], { env });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.codex_install_model, "plugin");
    assert.equal(doctorReport.plugin.skill_installed, true);
    assert.equal(doctorReport.skill_installed, false);
    assert.equal(doctorReport.compatibility_skill_installed, false);
    assert.deepEqual(doctorReport.warnings, []);
    assert.deepEqual(doctorReport.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install removes stale personal Codex GoalBuddy skills", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const fakeBin = fakeCodexBin(root);
    const env = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    };

    const staleSkill = join(codexHome, "skills", "goalbuddy");
    const staleAlias = join(codexHome, "skills", "goal-maker");
    mkdirSync(staleSkill, { recursive: true });
    mkdirSync(staleAlias, { recursive: true });
    writeFileSync(join(staleSkill, "SKILL.md"), "stale GoalBuddy skill\n");
    writeFileSync(join(staleAlias, "SKILL.md"), "stale Goal Maker alias\n");

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const report = JSON.parse(install.stdout);
    assert.match(report.removed_legacy_skill_paths[0], pathSuffixPattern("skills", "goalbuddy"));
    assert.match(report.removed_legacy_skill_paths[1], pathSuffixPattern("skills", "goal-maker"));
    assert.equal(existsSync(staleSkill), false);
    assert.equal(existsSync(staleAlias), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset removes only GoalBuddy-owned Codex runtime surfaces", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, [
      '[plugins."goalbuddy@goalbuddy"]',
      "enabled = true",
      "",
      '[plugins."goalbuddy@goalbuddy".settings]',
      'token = "remove-me"',
      "",
      '[plugins."github@openai-curated"]',
      "enabled = true",
      "",
      "[marketplaces.goalbuddy]",
      'source = "tolimarchuk/goalbuddy"',
      'source_type = "git"',
      "",
      "[marketplaces.goalbuddy.settings]",
      'token = "remove-me-too"',
      "",
      "[marketplaces.other]",
      'source = "openai/curated"',
      "",
    ].join("\n"));

    const cacheRoot = join(codexHome, "plugins", "cache", "goalbuddy", "goalbuddy", packageVersion);
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(join(cacheRoot, "sentinel.txt"), "cached\n");

    const agentsRoot = join(codexHome, "agents");
    mkdirSync(agentsRoot, { recursive: true });
    for (const file of ["goal_judge.toml", "goal_scout.toml", "goal_worker.toml"]) {
      writeFileSync(join(agentsRoot, file), readFileSync(join("goalbuddy", "agents", file)));
    }
    writeFileSync(join(agentsRoot, "other.toml"), "unrelated user agent\n");

    const staleSkill = join(codexHome, "skills", "goalbuddy");
    const staleAlias = join(codexHome, "skills", "goal-maker");
    mkdirSync(staleSkill, { recursive: true });
    mkdirSync(staleAlias, { recursive: true });
    writeFileSync(join(staleSkill, "SKILL.md"), "stale GoalBuddy skill\n");
    writeFileSync(join(staleAlias, "SKILL.md"), "stale Goal Maker alias\n");

    const reset = runGoalMaker(["reset", "--target", "codex", "--codex-home", codexHome, "--json"]);
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    const report = JSON.parse(reset.stdout);
    assert.deepEqual(report.removed_config_sections, [
      '[plugins."goalbuddy@goalbuddy"]',
      "[marketplaces.goalbuddy]",
    ]);
    assert.match(report.removed_plugin_cache_paths[0], pathSuffixPattern("plugins", "cache", "goalbuddy"));
    assert.equal(report.removed_agents.length, 3);
    assert.equal(report.removed_legacy_skill_paths.length, 2);

    const config = readFileSync(configPath, "utf8");
    assert.doesNotMatch(config, /goalbuddy@goalbuddy/);
    assert.doesNotMatch(config, /\[marketplaces\.goalbuddy\]/);
    assert.doesNotMatch(config, /remove-me/);
    assert.doesNotMatch(config, /remove-me-too/);
    assert.match(config, /\[plugins\."github@openai-curated"\]/);
    assert.match(config, /\[marketplaces\.other\]/);
    assert.equal(existsSync(join(codexHome, "plugins", "cache", "goalbuddy")), false);
    assert.equal(existsSync(join(agentsRoot, "goal_worker.toml")), false);
    assert.equal(existsSync(join(agentsRoot, "other.toml")), true);
    assert.equal(existsSync(staleSkill), false);
    assert.equal(existsSync(staleAlias), false);

    const secondReset = runGoalMaker(["reset", "--codex-home", codexHome, "--json"]);
    assert.equal(secondReset.status, 0, secondReset.stderr || secondReset.stdout);
    const secondReport = JSON.parse(secondReset.stdout);
    assert.deepEqual(secondReport.removed_config_sections, []);
    assert.deepEqual(secondReport.removed_plugin_cache_paths, []);
    assert.deepEqual(secondReport.removed_agents, []);
    assert.deepEqual(secondReport.removed_legacy_skill_paths, []);

    const doctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env: fakeCodexEnv(root) });
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.deepEqual(doctorReport.installed_agents, []);
    assert.deepEqual(doctorReport.stale_agents, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install ignores non-version cache directories", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const fakeBin = fakeCodexBin(root);
    const env = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    };

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const stalePreservePath = join(codexHome, "plugins", "cache", "goalbuddy", "goalbuddy", ".goalbuddy-preserved-extend-123-456");
    mkdirSync(stalePreservePath, { recursive: true });

    const reinstall = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);
    assert.equal(JSON.parse(reinstall.stdout).version, packageVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install removes a newer stale version directory", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    // simulate a downgrade: a directory left behind by a newer install. Codex activates the highest
    // version it finds, so this would keep being served instead of the version just installed.
    const versionsRoot = join(codexHome, "plugins", "cache", "goalbuddy", "goalbuddy");
    const staleVersion = join(versionsRoot, "9.9.9");
    mkdirSync(staleVersion, { recursive: true });
    writeFileSync(join(staleVersion, "marker.txt"), "stale\n");

    const reinstall = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);

    const report = JSON.parse(reinstall.stdout);
    assert.ok(report.removed_stale_version_paths.includes(staleVersion), JSON.stringify(report.removed_stale_version_paths));
    assert.equal(existsSync(staleVersion), false);
    assert.deepEqual(readdirSync(versionsRoot).sort(), [packageVersion]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install leaves directories that are not plugin versions alone", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    // Codex only activates directories whose name is a valid version segment, so anything else is
    // not ours to delete.
    const versionsRoot = join(codexHome, "plugins", "cache", "goalbuddy", "goalbuddy");
    const unrelated = join(versionsRoot, "notes for me");
    mkdirSync(unrelated, { recursive: true });

    const reinstall = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);
    assert.equal(existsSync(unrelated), true);
    assert.deepEqual(JSON.parse(reinstall.stdout).removed_stale_version_paths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin reinstall does not leave empty preserved cache directories", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const fakeBin = fakeCodexBin(root);
    const env = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    };

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const reinstall = runGoalMaker(["plugin", "install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);

    const cacheRoot = join(codexHome, "plugins", "cache", "goalbuddy", "goalbuddy");
    const preservedDirs = readdirSync(cacheRoot).filter((entry) => entry.startsWith(".goalbuddy-preserved-"));
    assert.deepEqual(preservedDirs, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin install output points to Goal Prep and the local goal surface", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["plugin", "install", "--codex-home", codexHome], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /Agents: 3 installed/);
    assert.match(install.stdout, /\$goal-prep/);
    assert.match(install.stdout, /Goal surface/);
    assert.match(install.stdout, /npx goalbuddy board docs\/goals\/<slug>/);
    assert.doesNotMatch(install.stdout, /goalbuddy extend/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help on mutating commands prints help without installing", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");

    const pluginHelp = runGoalMaker(["plugin", "install", "--help", "--codex-home", codexHome]);
    assert.equal(pluginHelp.status, 0, pluginHelp.stderr || pluginHelp.stdout);
    assert.match(pluginHelp.stdout, /GoalBuddy Plugin/);
    assert.equal(existsSync(codexHome), false);

    const updateHelp = runGoalMaker(["update", "--help", "--codex-home", codexHome, "--claude-home", claudeHome]);
    assert.equal(updateHelp.status, 0, updateHelp.stderr || updateHelp.stdout);
    assert.match(updateHelp.stdout, /goalbuddy update/);
    assert.equal(existsSync(codexHome), false);
    assert.equal(existsSync(claudeHome), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default command installs the native Codex plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const report = JSON.parse(install.stdout);
    assert.equal(report.installed, true);
    assert.equal(report.plugin, "goalbuddy@goalbuddy");
    assert.equal(report.agents.length, 3);
    assert.equal(existsSync(join(codexHome, "skills", "goalbuddy", "SKILL.md")), false);
    assert.equal(existsSync(join(codexHome, "agents", "goal_worker.toml")), true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.match(config, /\[plugins\."goalbuddy@goalbuddy"\]/);
    assert.match(config, /enabled = true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default command installs Codex and Claude Code when both homes are provided", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["--codex-home", codexHome, "--claude-home", claudeHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const report = JSON.parse(install.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.codex.installed, true);
    assert.equal(report.claude.skill.status, "installed");
    assert.equal(existsSync(join(codexHome, "config.toml")), true);
    assert.equal(existsSync(join(claudeHome, "skills", "goal-prep", "SKILL.md")), true);
    assert.equal(existsSync(join(claudeHome, "agents", "goal-worker.md")), true);
    assert.equal(existsSync(join(claudeHome, "commands", "goalbuddy.md")), true);
    assert.equal(existsSync(join(claudeHome, "commands", "goal.md")), false);
    assert.equal(existsSync(join(claudeHome, "commands", "goal-prep.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install removes a pre-existing legacy ~/.claude/commands/goal-prep.md", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const claudeHome = join(root, "claude-home");
    const legacyCommand = join(claudeHome, "commands", "goal-prep.md");
    mkdirSync(join(claudeHome, "commands"), { recursive: true });
    writeFileSync(legacyCommand, "stale wrapper from older GoalBuddy install\n");

    const install = runGoalMaker(["install", "--target", "claude", "--claude-home", claudeHome, "--json"]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const report = JSON.parse(install.stdout);
    assert.equal(report.legacy_commands_cleanup.removed, true);
    assert.equal(existsSync(legacyCommand), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update refreshes Codex plugin and Claude Code install together", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    const env = fakeCodexEnv(root);

    const install = runGoalMaker(["--codex-home", codexHome, "--claude-home", claudeHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    writeFileSync(join(claudeHome, "agents", "goal-worker.md"), "stale\n");

    const update = runGoalMaker(["update", "--codex-home", codexHome, "--claude-home", claudeHome, "--json"], { env });
    assert.equal(update.status, 0, update.stderr || update.stdout);
    const report = JSON.parse(update.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.claude.agents.find((agent) => agent.file === "goal-worker.md").status, "updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install reports Codex plugin state in json mode", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const result = runGoalMaker(["install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.installed, true);
    assert.equal(report.plugin, "goalbuddy@goalbuddy");
    assert.match(report.cache_path, pathSuffixPattern("plugins", "cache", "goalbuddy", "goalbuddy", packageVersion));
    assert.equal(report.agents.length, 3);
    assert.equal(existsSync(join(codexHome, "skills", "goalbuddy")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy goal-maker invocation prints rebrand notice only for human output", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = {
      ...process.env,
      GOALBUDDY_INVOKED_AS: "goal-maker",
      PATH: `${fakeCodexBin(root)}${delimiter}${process.env.PATH}`,
    };

    const human = runGoalMaker(["--help"], { env });
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /GoalBuddy for Claude Code and Codex/);
    assert.match(human.stdout, /goalbuddy install/);
    assert.match(human.stderr, /goal-maker has been rebranded to goalbuddy/);
    assert.match(human.stderr, /Use: npx goalbuddy/);

    const json = runGoalMaker(["install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.equal(json.stderr, "");
    const report = JSON.parse(json.stdout);
    assert.equal(report.plugin, "goalbuddy@goalbuddy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install removes legacy skill folders and keeps plugin install authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const legacySkill = join(codexHome, "skills", "goal-maker");
    mkdirSync(legacySkill, { recursive: true });
    writeFileSync(join(legacySkill, ".goal-maker-install.json"), JSON.stringify({
      package_name: "goal-maker",
      package_version: "0.2.9",
    }));

    const install = runGoalMaker(["install", "--codex-home", codexHome, "--json"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const report = JSON.parse(install.stdout);
    assert.match(report.removed_legacy_skill_paths[0], pathSuffixPattern("skills", "goal-maker"));

    const doctor = runGoalMaker(["doctor", "--codex-home", codexHome], { env });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.plugin.skill_installed, true);
    assert.equal(doctorReport.skill_installed, false);
    assert.equal(doctorReport.compatibility_skill_installed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("board command launches the bundled local board surface", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-maker-cli-test-"));
  try {
    const codexHome = join(root, "codex-home");
    const env = fakeCodexEnv(root);
    const goalDir = join(root, "docs", "goals", "demo");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "goal.md"), "# Demo\n");
    writeFileSync(join(goalDir, "state.yaml"), `
version: 2
goal:
  title: "Demo"
  slug: "demo"
  kind: specific
  tranche: "demo"
  status: active
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
    objective: "Map the demo."
    receipt: null
checks:
  dirty_fingerprint: unknown
  last_verification:
    result: unknown
    task: null
    commands: []
`);

    const installCore = runGoalMaker(["install", "--codex-home", codexHome], { env });
    assert.equal(installCore.status, 0, installCore.stderr || installCore.stdout);

    const board = runGoalMaker([
      "board",
      join("docs", "goals", "demo"),
      "--codex-home",
      codexHome,
      "--once",
      "--json",
      "--port",
      "0",
    ], { cwd: root });
    assert.equal(board.status, 0, board.stderr || board.stdout);

    const report = JSON.parse(board.stdout);
    assert.equal(report.goalDir, realpathSync(goalDir));
    assert.equal(existsSync(join(goalDir, ".goalbuddy-board", "index.html")), true);
    assert.equal(report.board.goal.slug, "demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("errors when a path option is missing its value", () => {
  const result = runGoalMaker(["doctor", "--codex-home", "--json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing value for --codex-home/);
});

test("judge receipt contract includes worker_package in every surface", () => {
  const tomlSchema = receiptContractSchema("goalbuddy/agents/goal_judge.toml");
  const mdSchema = receiptContractSchema("plugins/goalbuddy/agents/goal-judge.md");
  assert.deepEqual(Object.keys(tomlSchema.worker_package), ["objective", "allowed_files", "verify", "stop_if"]);
  assert.deepEqual(mdSchema.worker_package, tomlSchema.worker_package);
});

test("installs the Claude skill as goal-prep and migrates the legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-skill-rename-"));
  try {
    const claudeHome = join(root, "claude");
    mkdirSync(join(claudeHome, "skills", "goalbuddy"), { recursive: true });
    writeFileSync(join(claudeHome, "skills", "goalbuddy", "SKILL.md"), "legacy\n");
    const result = runGoalMaker(["install", "--target", "claude", "--claude-home", claudeHome, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(claudeHome, "skills", "goal-prep", "SKILL.md")), true);
    assert.equal(existsSync(join(claudeHome, "skills", "goalbuddy")), false);

    const doctor = runGoalMaker(["doctor", "--target", "claude", "--claude-home", claudeHome]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.legacy_skill_present, false);
    assert.match(report.skill_path, pathSuffixPattern("skills", "goal-prep", "SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs /goalbuddy without shadowing Claude Code's native /goal", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-goal-command-"));
  try {
    const claudeHome = join(root, "claude");
    const result = runGoalMaker(["install", "--target", "claude", "--claude-home", claudeHome, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const command = readFileSync(join(claudeHome, "commands", "goalbuddy.md"), "utf8");
    assert.match(command, /GoalBuddy/);
    assert.match(command, /state\.yaml/);
    assert.equal(existsSync(join(claudeHome, "commands", "goal.md")), false);

    const doctor = runGoalMaker(["doctor", "--target", "claude", "--claude-home", claudeHome]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.goal_command_present, true);
    assert.equal(report.native_goal_available, true);
    assert.equal(report.legacy_goal_command_present, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install removes an old GoalBuddy-owned /goal command", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-goal-command-migration-"));
  try {
    const claudeHome = join(root, "claude");
    const legacyCommand = join(claudeHome, "commands", "goal.md");
    mkdirSync(join(claudeHome, "commands"), { recursive: true });
    const legacyBody = readFileSync("plugins/goalbuddy/commands/goalbuddy.md", "utf8")
      // Reconstruct the exact published LF artifact, independent of checkout EOLs.
      .replaceAll("\r\n", "\n")
      .replace("Run the GoalBuddy execution loop.\n", "Run the GoalBuddy `/goal` execution loop.\n");
    assert.equal(createHash("sha256").update(legacyBody).digest("hex"), "586a0839302239858cce64f954666e8690c5ddef036e397adfd9456eed4738e2");
    writeFileSync(legacyCommand, legacyBody);

    const result = runGoalMaker(["install", "--target", "claude", "--claude-home", claudeHome, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.legacy_goal_command_cleanup.removed, true);
    assert.equal(existsSync(legacyCommand), false);
    assert.equal(existsSync(join(claudeHome, "commands", "goalbuddy.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install preserves a user-authored /goal command and doctor reports the collision", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-user-goal-command-"));
  try {
    const claudeHome = join(root, "claude");
    const legacyCommand = join(claudeHome, "commands", "goal.md");
    mkdirSync(join(claudeHome, "commands"), { recursive: true });
    writeFileSync(legacyCommand, "My private GoalBuddy helper.\n");

    const result = runGoalMaker(["install", "--target", "claude", "--claude-home", claudeHome, "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.legacy_goal_command_cleanup.preserved, true);
    assert.match(report.warnings.join("\n"), /native \/goal may remain shadowed/);
    assert.equal(readFileSync(legacyCommand, "utf8"), "My private GoalBuddy helper.\n");

    const doctor = runGoalMaker(["doctor", "--target", "claude", "--claude-home", claudeHome]);
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.native_goal_available, false);
    assert.equal(doctorReport.legacy_goal_command_present, true);
    assert.equal(doctorReport.legacy_goal_command_owned, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an invalid --target value", () => {
  const result = runGoalMaker(["doctor", "--target", "bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid --target: bogus/);
});

test("emits JSON for early argument errors when --json is set", () => {
  const result = runGoalMaker(["doctor", "--codex-home", "--json"]);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.equal(report.ok, false);
  assert.match(report.error, /Missing value for --codex-home/);
});

test("repeated flags take the last value", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-last-wins-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const result = runGoalMaker(["install", "--target", "claude", "--claude-home", first, "--claude-home", second, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(second, "skills", "goal-prep", "SKILL.md")), true);
    assert.equal(existsSync(join(first, "skills")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeResumeGoal(repoRoot, slug, { active = true } = {}) {
  const goalDir = join(repoRoot, "docs", "goals", slug);
  mkdirSync(join(goalDir, "notes"), { recursive: true });
  writeFileSync(join(goalDir, "goal.md"), `# ${slug}\n`);
  writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "${slug} goal"
  slug: "${slug}"
  kind: specific
  tranche: "test"
  status: ${active ? "active" : "done"}
active_task: ${active ? "T001" : "null"}
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: ${active ? "active" : "done"}
    objective: "Fix the widget in ${slug}."
    allowed_files:
      - src/widget.mjs
    verify:
      - npm test
    stop_if:
      - "Need files outside allowed_files."
    receipt: ${active ? "null" : `
      result: done
      changed_files:
        - src/widget.mjs
      commands:
        - cmd: npm test
          status: pass
      summary: "done"`}
`);
  return goalDir;
}

test("resume lists boards and prints the handoff command for active goals", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-resume-"));
  try {
    writeResumeGoal(root, "one", { active: true });
    writeResumeGoal(root, "two", { active: false });

    const result = runGoalMaker(["resume"], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /one goal/);
    assert.match(result.stdout, /two goal/);
    assert.match(result.stdout, /T001 \(worker\) Fix the widget in one\./);
    assert.match(result.stdout, /Resume in Codex/);
    assert.match(result.stdout, /Resume in Claude Code/);
    assert.match(result.stdout, /\/goal Follow docs\/goals\/one\/goal\.md\./);
    assert.match(result.stdout, /\/goalbuddy Follow docs\/goals\/one\/goal\.md\./);
    assert.doesNotMatch(result.stdout, /\/goal Follow docs\/goals\/two\/goal\.md\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume --json returns structured boards", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-resume-json-"));
  try {
    writeResumeGoal(root, "one", { active: true });
    const result = runGoalMaker(["resume", "--json"], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.boards.length, 1);
    assert.equal(report.boards[0].slug, "one");
    assert.equal(report.boards[0].status, "active");
    assert.equal(report.boards[0].active_task.id, "T001");
    assert.equal(report.boards[0].run_command, "/goal Follow docs/goals/one/goal.md.");
    assert.equal(report.boards[0].claude_run_command, "/goalbuddy Follow docs/goals/one/goal.md.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume scoped to one goal dir and empty repos behave", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-resume-scoped-"));
  try {
    writeResumeGoal(root, "one", { active: true });
    writeResumeGoal(root, "two", { active: false });

    const scoped = runGoalMaker(["resume", "docs/goals/two", "--json"], { cwd: root });
    assert.equal(scoped.status, 0, scoped.stderr || scoped.stdout);
    const scopedReport = JSON.parse(scoped.stdout);
    assert.equal(scopedReport.boards.length, 1);
    assert.equal(scopedReport.boards[0].slug, "two");
    assert.equal(scopedReport.boards[0].active_task, null);

    const empty = mkdtempSync(join(tmpdir(), "goalbuddy-resume-empty-"));
    try {
      const none = runGoalMaker(["resume", "--json"], { cwd: empty });
      assert.equal(none.status, 0, none.stderr || none.stdout);
      assert.deepEqual(JSON.parse(none.stdout).boards, []);
      const human = runGoalMaker(["resume"], { cwd: empty });
      assert.match(human.stdout, /No GoalBuddy boards found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init scaffolds a working board from the bundled templates", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-init-"));
  try {
    const created = runGoalMaker(["init", "ship-widgets", "--json"], { cwd: root });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const report = JSON.parse(created.stdout);
    assert.equal(report.slug, "ship-widgets");
    assert.equal(report.run_command, "/goal Follow docs/goals/ship-widgets/goal.md.");
    assert.equal(report.claude_run_command, "/goalbuddy Follow docs/goals/ship-widgets/goal.md.");
    const state = readFileSync(join(root, "docs", "goals", "ship-widgets", "state.yaml"), "utf8");
    assert.match(state, /version: 2/);
    assert.match(state, /slug: "ship-widgets"/);
    assert.match(state, /title: "Ship Widgets"/);
    assert.equal(existsSync(join(root, "docs", "goals", "ship-widgets", "notes")), true);

    const resume = runGoalMaker(["resume", "--json"], { cwd: root });
    assert.equal(resume.status, 0, resume.stderr || resume.stdout);
    const boards = JSON.parse(resume.stdout).boards;
    assert.equal(boards[0].slug, "ship-widgets");
    assert.equal(boards[0].status, "active");

    const again = runGoalMaker(["init", "ship-widgets"], { cwd: root });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

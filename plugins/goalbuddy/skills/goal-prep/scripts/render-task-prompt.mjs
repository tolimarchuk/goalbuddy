#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGoalStateText } from "../surfaces/local-goal-board/scripts/lib/goal-board.mjs";

const ROLE_DEFAULTS = {
  scout: { agent: "goal_scout", reasoning: "low", sandbox: "read-only" },
  judge: { agent: "goal_judge", reasoning: "high", sandbox: "read-only" },
  worker: { agent: "goal_worker", reasoning: "medium", sandbox: "workspace-write" },
  pm: { agent: "PM", reasoning: "medium", sandbox: "workspace-write" },
};

if (isDirectRun()) {
  try {
    const result = renderTaskPrompt(parseArgs(process.argv.slice(2)));
    if (result.json) {
      console.log(JSON.stringify(result.payload, null, 2));
    } else {
      console.log(formatPrompt(result.payload));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export function renderTaskPrompt(options) {
  const boardPath = resolveBoardPath(options);
  const board = loadBoard(boardPath);
  const task = selectTask(board, options.taskId);
  const role = normalizeRole(task.type);
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.pm;
  const reasoning = normalizeReasoning(task.reasoning_hint, defaults.reasoning);
  const warnings = promptWarnings(board, task);

  return {
    json: options.json,
    payload: {
      metadata: {
        recommended_agent: defaults.agent,
        required_spawn_agent_type: defaults.agent === "PM" ? null : defaults.agent,
        required_claude_subagent_type: defaults.agent === "PM" ? null : defaults.agent.replaceAll("_", "-"),
        recommended_reasoning: reasoning,
        sandbox: defaults.sandbox,
        fork_context_allowed: role !== "worker",
        board_path: board.path,
        child_board_paths: childBoardPaths(board),
        goal_oracle: board.goal.oracle || null,
        slice_policy: board.document.rules?.slice_policy || null,
        warnings,
      },
      task: {
        id: task.id,
        type: role,
        assignee: task.assignee || defaults.agent,
        status: task.status,
        objective: task.objective || "",
        inputs: stringList(task.inputs),
        constraints: stringList(task.constraints),
        allowed_files: stringList(task.allowed_files),
        verify: stringList(task.verify),
        stop_if: stringList(task.stop_if),
        reasoning_hint: task.reasoning_hint || null,
        expected_output: stringList(task.expected_output),
      },
      receipt_schema: receiptSchema(role),
    },
  };
}

export function parseArgs(args) {
  const options = { goalRoot: "", boardPath: "", taskId: "", json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--task") {
      options.taskId = args[++index] || "";
    } else if (arg.startsWith("--task=")) {
      options.taskId = arg.slice("--task=".length);
    } else if (arg === "--board") {
      options.boardPath = args[++index] || "";
    } else if (arg.startsWith("--board=")) {
      options.boardPath = arg.slice("--board=".length);
    } else if (arg === "--parallel-plan") {
      options.parallelPlan = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!options.goalRoot) {
      options.goalRoot = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!options.goalRoot && !options.boardPath) {
    throw new Error("Usage: goalbuddy prompt <goal-root> [--task T###] [--board path/to/state.yaml]");
  }
  return options;
}

export function loadBoard(boardPath) {
  if (!existsSync(boardPath)) throw new Error(`state file not found: ${boardPath}`);
  const document = parseGoalStateText(readFileSync(boardPath, "utf8"));
  if (!document || Number(document.version) !== 2) {
    throw new Error(`unsupported GoalBuddy state version in ${boardPath}: expected top-level "version: 2". Start from templates/state.yaml bundled with the goal-prep skill.`);
  }
  if (!Array.isArray(document.tasks)) throw new Error(`state file has no tasks: ${boardPath}`);
  return {
    path: boardPath,
    root: dirname(boardPath),
    document,
    tasks: document.tasks,
    goal: document.goal || {},
    activeTask: document.active_task || "",
  };
}

export function resolveBoardPath(options) {
  const candidate = options.boardPath || options.goalRoot;
  if (!candidate) throw new Error("Missing goal root or board path.");
  const resolved = resolve(candidate);
  if (basename(resolved) === "state.yaml") return resolved;
  return resolve(resolved, "state.yaml");
}

export function selectTask(board, taskId = "") {
  const id = taskId || board.activeTask;
  if (!id) throw new Error(`No task selected and active_task is empty in ${board.path}`);
  const task = board.tasks.find((candidate) => candidate?.id === id);
  if (!task) throw new Error(`Task ${id} not found in ${board.path}`);
  return task;
}

export function childBoardPaths(board) {
  return board.tasks
    .map((task) => task?.subgoal?.path)
    .filter(Boolean)
    .map((childPath) => resolve(board.root, childPath));
}

function promptWarnings(board, task) {
  const warnings = [];
  const role = normalizeRole(task.type);
  if (task.id !== board.activeTask) warnings.push(`Task ${task.id} is not the active task on this board.`);
  if (isWeakProof(board.goal.oracle?.signal)) {
    warnings.push("goal.oracle.signal is missing or placeholder-like; keep the goal pressured by a concrete completion oracle.");
  }
  if (isWeakProof(board.goal.oracle?.final_proof)) {
    warnings.push("goal.oracle.final_proof is missing or placeholder-like; do not mark the goal complete without receipt-backed proof.");
  }
  if (role === "worker") {
    if (stringList(task.allowed_files).length === 0) warnings.push(`Worker task ${task.id} has no allowed_files.`);
    if (stringList(task.verify).length === 0) warnings.push(`Worker task ${task.id} has no verify commands.`);
    if (stringList(task.stop_if).length === 0) warnings.push(`Worker task ${task.id} has no stop_if conditions.`);
    if (isFalse(board.goal.full_outcome_complete)) {
      warnings.push(`full_outcome_complete is false and ${task.id} is an active Worker; do not stop after rendering or repairing the board. Execute the Worker unless a stop_if condition applies.`);
    }
  }
  for (const candidate of board.tasks) {
    if (candidate?.subgoal && Number(candidate.subgoal.depth) !== 1) {
      warnings.push(`Task ${candidate.id} has subgoal.depth ${candidate.subgoal.depth || "<missing>"}; only depth 1 is supported.`);
    }
  }
  warnings.push(...microSliceWarnings(board, task));
  warnings.push(...processHeavyWarnings(board.tasks.filter(Boolean), board.activeTask || null, board.goal.status));
  return warnings;
}

// Advisory process-heavy heuristics: they never fail a board and never rewrite completed
// history; only future work should be consolidated. Tune via PROCESS_HEAVY_THRESHOLDS:
// largeUnfinished (unfinished cards, including blocked boards with no active task),
// ratioMinTasks + processToWorkerRatio (PM/Judge/Scout cards vs Worker cards), and processRun
// (consecutive dispatched process-only cards since the last Worker card). Keep this function
// byte-identical to processHeavyWarnings in scripts/check-goal-state.mjs.
function processHeavyWarnings(tasks, activeTaskId, goalStatus) {
  const PROCESS_HEAVY_THRESHOLDS = {
    largeUnfinished: 12,
    ratioMinTasks: 12,
    processToWorkerRatio: 2,
    processRun: 4,
  };
  const { largeUnfinished, ratioMinTasks, processToWorkerRatio, processRun } = PROCESS_HEAVY_THRESHOLDS;
  const found = [];
  const consolidate = "Preserve completed history and consolidate only future work into roughly 3-7 outcome-sized phases. Duration alone is not a reason to use GoalBuddy; native Goal may fit a long single-owner sequential run better.";
  const isWorker = (task) => task.type?.toLowerCase() === "worker";
  const unfinished = tasks.filter((task) => task.status !== "done");
  if (unfinished.length >= largeUnfinished) {
    const stalled = goalStatus !== "active" && !activeTaskId ? " on a blocked board with no active task" : "";
    found.push(`Board is process-heavy: ${unfinished.length} unfinished tasks${stalled}. ${consolidate}`);
  }
  const workerCount = tasks.filter(isWorker).length;
  const processCount = tasks.length - workerCount;
  if (tasks.length >= ratioMinTasks && processCount > processToWorkerRatio * Math.max(workerCount, 1)) {
    found.push(`Board is process-heavy: ${processCount} PM/Judge/Scout tasks vs ${workerCount} Worker tasks. One task should normally include implementation, targeted tests, CI/readback, and proof when authority and risk stay the same. Reserve Scout for material uncertainty and Judge for phase, risk, rejected-verification, or final boundaries.`);
  }
  const dispatched = tasks.filter((task) => task.status !== "queued");
  let run = 0;
  for (let index = dispatched.length - 1; index >= 0; index -= 1) {
    if (isWorker(dispatched[index])) break;
    run += 1;
  }
  if (run >= processRun) {
    found.push(`Board is process-heavy: ${run} consecutive planning, audit, or process-only tasks since the last Worker task added no new verifiable capability. ${consolidate}`);
  }
  return found;
}

function microSliceWarnings(board, task) {
  const warnings = [];
  const doneTasks = board.tasks.filter((candidate) => candidate?.status === "done");
  const recentWorkers = board.tasks
    .filter((candidate) => normalizeRole(candidate?.type) === "worker")
    .slice(-5);
  const recentTinyWorkers = recentWorkers.filter((candidate) => isTinyTask(candidate));
  const activeRole = normalizeRole(task.type);
  const activeAllowedFiles = stringList(task.allowed_files);
  const firstMilestoneComplete = isTrue(board.goal.first_milestone_complete);
  const microWarning = "Board may be micro-slicing. Prefer the largest safe useful slice.";

  if (recentTinyWorkers.length >= 3) warnings.push(microWarning);
  if (doneTasks.length >= 10 && activeRole === "worker" && activeAllowedFiles.length > 0 && activeAllowedFiles.length <= 2) {
    warnings.push(`${microWarning} Active Worker ${task.id} has only ${activeAllowedFiles.length} allowed_files after ${doneTasks.length} completed tasks.`);
  }
  if (firstMilestoneComplete && activeRole === "worker" && isTinyTask(task)) {
    warnings.push(`${microWarning} The first milestone is complete, so the active Worker should move toward the next real milestone.`);
  }
  if (activeRole === "judge" && /pick small reviewable work|select one narrow next task/i.test(String(task.objective || "") + "\n" + stringList(task.constraints).join("\n"))) {
    warnings.push(`${microWarning} Judge instructions still ask for small or narrow work.`);
  }
  return [...new Set(warnings)];
}

function isTinyTask(task) {
  const text = [
    task?.objective,
    stringList(task?.constraints).join(" "),
    task?.receipt?.summary,
  ].join(" ").toLowerCase();
  return /\b(tiny|narrow|single helper|one helper|projection helper|projection function|contract file|read-only proof|doc note|validator|validation wrapper|pure helper|caller-input)\b/.test(text);
}

function normalizeRole(value) {
  const role = String(value || "pm").toLowerCase();
  return ROLE_DEFAULTS[role] ? role : "pm";
}

function normalizeReasoning(value, fallback) {
  const hint = String(value || "").toLowerCase();
  if (["low", "medium", "high", "xhigh"].includes(hint)) return hint;
  return fallback;
}

function isFalse(value) {
  return value === false || String(value).toLowerCase() === "false";
}

function isTrue(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function isWeakProof(value) {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === ""
    || normalized === "unknown"
    || normalized === "tbd"
    || normalized === "todo"
    || normalized === "none"
    || /^<.*>$/.test(normalized);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).map(String) : [];
}

function receiptSchema(role) {
  if (role === "worker") {
    return {
      result: "done | blocked",
      task_id: "<T###>",
      board_path: "<path to state.yaml>",
      changed_files: [],
      commands: [],
      summary: "<=120 words>",
      deviations: [],
      remaining_blockers: [],
      verification_attempts: 1,
      stopped_because: null,
    };
  }
  if (role === "judge") {
    return {
      result: "done | blocked",
      task_id: "<T###>",
      board_path: "<path to state.yaml>",
      decision: "approved | rejected | approve_subgoal | reject_subgoal | not_complete | complete",
      full_outcome_complete: false,
      rationale: "<=120 words>",
      worker_package: { objective: "", allowed_files: [], verify: [], stop_if: [] },
      evidence: [],
      subgoal_contract: null,
      parallel_safety: null,
      blocked_tasks: [],
      missing_evidence: [],
      required_board_updates: [],
    };
  }
  return {
    result: "done | blocked",
    task_id: "<T###>",
    board_path: "<path to state.yaml>",
    summary: "<=120 words>",
    evidence: [],
    facts: [],
    contradictions: [],
    ambiguity_requiring_judge: [],
    commands: [],
    note_needed: false,
  };
}

export function formatPrompt(payload, { includePmObservationContract = true } = {}) {
  const lines = [
    "GoalBuddy task prompt",
    "",
    "Metadata:",
    `- recommended_agent: ${payload.metadata.recommended_agent}`,
    `- required_spawn_agent_type: ${payload.metadata.required_spawn_agent_type || "PM fallback"}`,
    `- required_claude_subagent_type: ${payload.metadata.required_claude_subagent_type || "PM fallback"}`,
    `- recommended_reasoning: ${payload.metadata.recommended_reasoning}`,
    `- sandbox: ${payload.metadata.sandbox}`,
    `- fork_context_allowed: ${payload.metadata.fork_context_allowed}`,
    `- board_path: ${payload.metadata.board_path}`,
  ];
  if (payload.metadata.child_board_paths.length) {
    lines.push("- child_board_paths:");
    for (const path of payload.metadata.child_board_paths) lines.push(`  - ${path}`);
  }
  if (payload.metadata.goal_oracle) {
    lines.push(`- goal_oracle: ${JSON.stringify(payload.metadata.goal_oracle)}`);
  }
  if (payload.metadata.slice_policy) {
    lines.push(`- slice_policy: ${JSON.stringify(payload.metadata.slice_policy)}`);
  }
  if (payload.metadata.warnings.length) {
    lines.push("- warnings:");
    for (const warning of payload.metadata.warnings) lines.push(`  - ${warning}`);
  }

  lines.push(
    "",
    "Spawn contract:",
    `- Codex spawn_agent agent_type: ${payload.metadata.required_spawn_agent_type || "do not spawn; run as PM"}`,
    `- Claude Code Agent tool subagent_type: ${payload.metadata.required_claude_subagent_type || "do not spawn; run as PM"}`,
    "- Do not substitute generic scout, worker, judge, Explore, or general-purpose agents for GoalBuddy agents.",
    "- If the required GoalBuddy agent is unavailable, stop spawning and continue as PM fallback or install agents.",
  );
  if (includePmObservationContract) {
    lines.push(
      "- Native wait_agent timeouts are non-terminal 60-second observation windows; after each one, inspect delivered messages and the live agent list or status (Codex: list_agents).",
      "- Scout and Judge are read-only, so file changes are never their progress signal. Escalate after 20 windows for Scout/Judge or 30 for Worker with one status request and at most five more windows; then interrupt and use PM fallback only if there is still no reply or execution evidence.",
    );
  }
  lines.push(
    "",
    "Task:",
    `- id: ${payload.task.id}`,
    `- type: ${payload.task.type}`,
    `- assignee: ${payload.task.assignee}`,
    `- status: ${payload.task.status}`,
    `- objective: ${payload.task.objective}`,
  );
  addList(lines, "inputs", payload.task.inputs);
  addList(lines, "constraints", payload.task.constraints);
  addList(lines, "allowed_files", payload.task.allowed_files);
  addList(lines, "verify", payload.task.verify);
  addList(lines, "stop_if", payload.task.stop_if);
  addList(lines, "expected_output", payload.task.expected_output);
  lines.push("", "Expected receipt JSON shape:", JSON.stringify(payload.receipt_schema, null, 2));
  return lines.join("\n");
}

function addList(lines, label, values) {
  if (!values.length) return;
  lines.push(`- ${label}:`);
  for (const value of values) lines.push(`  - ${value}`);
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve, sep } from "node:path";

const inputPath = process.argv[2];
const isChildCheck = process.argv.includes("--child");

if (!inputPath) {
  console.error("Usage: node scripts/check-goal-state.mjs docs/goals/<slug>[/state.yaml]");
  process.exit(2);
}

const statePath = existsSync(inputPath) && statSync(inputPath).isDirectory()
  ? join(inputPath, "state.yaml")
  : inputPath;

if (!existsSync(statePath)) {
  console.error(JSON.stringify({ ok: false, errors: [`state file not found: ${statePath}`], warnings: [] }, null, 2));
  process.exit(1);
}

const root = dirname(statePath);
const text = readFileSync(statePath, "utf8");
const errors = [];
const warnings = [];

function clean(value) {
  if (value === undefined || value === null) return null;
  let cleaned = String(value).trim();
  const quoted = cleaned.match(/^"([^"]*)"\s*(?:#.*)?$|^'([^']*)'\s*(?:#.*)?$/);
  if (quoted) {
    cleaned = (quoted[1] ?? quoted[2]).trim();
  } else {
    cleaned = cleaned.replace(/(^|\s)#.*$/, "").trim();
  }
  if (cleaned === "" || cleaned === "null") return null;
  if (cleaned === "true") return true;
  if (cleaned === "false") return false;
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  return cleaned;
}

function topScalar(key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
  return match ? clean(match[1]) : null;
}

function nestedScalar(section, key) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^${section}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\S/.test(line)) break;
    if (inSection) {
      const match = line.match(new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*$`));
      if (match) return clean(match[1]);
    }
  }
  return null;
}

function pathScalar(path, key) {
  const lines = text.split(/\r?\n/);
  let depth = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    if (indent < depth * 2) depth = Math.floor(indent / 2);

    if (depth < path.length && indent === depth * 2 && new RegExp(`^\\s{${indent}}${path[depth]}:\\s*$`).test(line)) {
      depth += 1;
      continue;
    }

    if (depth === path.length && indent === depth * 2) {
      const match = line.match(new RegExp(`^\\s{${indent}}${key}:\\s*(.*?)\\s*$`));
      if (match) return clean(match[1]);
    }
  }
  return null;
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

function sectionText(section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${section}:\\s*$`).test(line));
  if (start === -1) return "";
  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

function parseTasks() {
  const body = sectionText("tasks");
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const tasks = [];
  let current = null;
  let currentLines = [];

  function finish() {
    if (!current) return;
    current.raw = currentLines.join("\n");
    tasks.push(current);
  }

  for (const line of lines) {
    const idMatch = line.match(/^\s{2}-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      finish();
      current = { id: clean(idMatch[1]) };
      currentLines = [line];
      continue;
    }
    if (current) currentLines.push(line);
  }
  finish();
  return tasks.map((task) => ({
    ...task,
    type: taskScalar(task, "type"),
    assignee: taskScalar(task, "assignee"),
    status: taskScalar(task, "status"),
    objective: taskScalar(task, "objective"),
    allowedFiles: taskList(task, "allowed_files"),
    verify: taskList(task, "verify"),
    stopIf: taskList(task, "stop_if"),
    receipt: taskReceipt(task),
    subgoal: taskSubgoal(task),
  }));
}

function taskScalar(task, key) {
  const match = task.raw.match(new RegExp(`^\\s{4}${key}:\\s*(.*?)\\s*$`, "m"));
  return match ? clean(match[1]) : null;
}

function taskList(task, key) {
  const lines = task.raw.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s{4}${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{4}\S/.test(lines[i])) break;
    const item = lines[i].match(/^\s{6}-\s*(.+?)\s*$/);
    if (item) values.push(clean(item[1]));
  }
  return values.filter((value) => value !== null);
}

function taskReceipt(task) {
  const lines = task.raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s{4}receipt:\s*/.test(line));
  if (start === -1) return { present: false, value: null, raw: "" };

  const inline = clean(lines[start].replace(/^\s{4}receipt:\s*/, ""));
  if (inline === null && !/^(\s{6}|\s{8})/.test(lines[start + 1] || "")) {
    return { present: true, value: null, raw: "" };
  }

  const receiptLines = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{4}\S/.test(lines[i])) break;
    receiptLines.push(lines[i]);
  }
  const raw = receiptLines.join("\n");
  return {
    present: true,
    value: inline || "object",
    raw,
    has: (key) => new RegExp(`^\\s{6}${key}:`, "m").test(raw),
    list: (key) => receiptList(raw, key),
    commandStatuses: () => receiptCommandStatuses(raw),
    scalar: (key) => {
      const match = raw.match(new RegExp(`^\\s{6}${key}:\\s*(.*?)\\s*$`, "m"));
      return match ? clean(match[1]) : null;
    },
  };
}

function taskSubgoal(task) {
  const lines = task.raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s{4}subgoal:\s*/.test(line));
  if (start === -1) return { present: false };

  const subgoalLines = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{4}\S/.test(lines[i])) break;
    subgoalLines.push(lines[i]);
  }
  const raw = subgoalLines.join("\n");
  const scalar = (key) => {
    const match = raw.match(new RegExp(`^\\s{6}${key}:\\s*(.*?)\\s*$`, "m"));
    return match ? clean(match[1]) : null;
  };

  return {
    present: true,
    raw,
    status: scalar("status"),
    path: scalar("path"),
    owner: scalar("owner"),
    depth: scalar("depth"),
  };
}

function receiptList(raw, key) {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s{6}${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{6}\S/.test(lines[i])) break;
    const item = lines[i].match(/^\s{8}-\s*(.+?)\s*$/);
    if (item) values.push(clean(item[1]));
  }
  return values.filter((value) => value !== null);
}

function receiptCommandStatuses(raw) {
  return [...raw.matchAll(/^\s{10}status:\s*(.*?)\s*$/gm)]
    .map((match) => clean(match[1]))
    .filter((value) => value !== null);
}

function rootEntryErrors() {
  const allowed = new Set(["goal.md", "state.yaml", "notes", ".goalbuddy-board", "subgoals"]);
  const unexpected = [];
  for (const entry of readdirSync(root).filter((item) => item !== ".DS_Store")) {
    const path = join(root, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      unexpected.push(`${entry} (unreadable)`);
      continue;
    }
    if (!allowed.has(entry)) {
      unexpected.push(entry);
    } else if ((entry === "notes" || entry === ".goalbuddy-board" || entry === "subgoals") && !stats.isDirectory()) {
      unexpected.push(`${entry} (must be a directory)`);
    } else if (!["notes", ".goalbuddy-board", "subgoals"].includes(entry) && !stats.isFile()) {
      unexpected.push(`${entry} (must be a file)`);
    }
  }
  return unexpected;
}

const version = topScalar("version");
const goalStatus = nestedScalar("goal", "status");
const activeTask = topScalar("active_task");
const agentStatuses = ["scout", "worker", "judge"].map((agent) => ({
  agent,
  status: nestedScalar("agents", agent),
}));
const allowedAgentStatuses = new Set(["installed", "bundled_not_installed", "missing", "unknown"]);
const continuousUntilFullOutcome = nestedScalar("rules", "continuous_until_full_outcome") === true;
const missingInputOrCredentialsDoNotStopGoal =
  nestedScalar("rules", "missing_input_or_credentials_do_not_stop_goal") === true;
const goalPressureRequiresOracle = nestedScalar("rules", "goal_pressure_requires_oracle") !== false;
const noCompletionOnWeakProof = nestedScalar("rules", "no_completion_on_weak_proof") !== false;
const completionProof = pathScalar(["goal", "intake"], "completion_proof");
const oracleSignal = pathScalar(["goal", "oracle"], "signal");
const oracleFinalProof = pathScalar(["goal", "oracle"], "final_proof");
const legacySignals = [
  /^gate:\s*$/m,
  /^artifact_policy:\s*$/m,
  /^active_unit:/m,
  /^evidence\.jsonl/m,
].some((pattern) => pattern.test(text)) || ["units", "artifacts", "evidence.jsonl"].some((entry) => existsSync(join(root, entry)));

if (version !== 2) {
  if (legacySignals) {
    errors.push("legacy v1 goal state detected; GoalBuddy v2 requires version: 2 with a task board. Create a new v2 goal or migrate manually.");
  } else {
    errors.push("state.yaml must declare version: 2");
  }
}

if (!["active", "blocked", "done"].includes(goalStatus)) {
  errors.push(`goal.status must be active, blocked, or done; got ${goalStatus || "<missing>"}`);
}

if (goalPressureRequiresOracle) {
  if (isWeakProof(oracleSignal)) {
    warnings.push("goal.oracle.signal is missing or placeholder-like; weak oracles make /goal finish too early.");
  }
  if (isWeakProof(oracleFinalProof)) {
    warnings.push("goal.oracle.final_proof is missing or placeholder-like; final completion needs receipt-backed proof.");
  }
}

if (isWeakProof(completionProof)) {
  warnings.push("goal.intake.completion_proof is missing or placeholder-like; record the observable signal that proves the full original outcome.");
}

function agentStatusWarning(agent, status) {
  const agentLabel = agent[0].toUpperCase() + agent.slice(1);
  if (status === "bundled_not_installed") {
    return `agents.${agent} is bundled_not_installed; /goal can continue through PM fallback, but dedicated ${agentLabel} delegation is unavailable until installed. If dedicated agents are required before /goal, run the GoalBuddy CLI through the user's install channel with: agents`;
  }
  if (status === "missing") {
    return `agents.${agent} is missing; /goal can continue through PM fallback, but dedicated ${agentLabel} delegation is unavailable. If dedicated agents are required before /goal, run the GoalBuddy CLI through the user's install channel with: install`;
  }
  return `agents.${agent} is unknown; /goal must attempt the exact harness-specific ${agentLabel} agent once, then use PM fallback only if the harness reports it unavailable or returns an error. To check before /goal, run the GoalBuddy CLI through the user's install channel with: doctor`;
}

for (const { agent, status } of agentStatuses) {
  if (!allowedAgentStatuses.has(status)) {
    errors.push(`agents.${agent} must be one of installed, bundled_not_installed, missing, or unknown; got ${status || "<missing>"}`);
  } else if (status !== "installed") {
    warnings.push(agentStatusWarning(agent, status));
  }
}

if (!existsSync(join(root, "goal.md"))) errors.push("missing goal.md");
if (!existsSync(join(root, "notes")) || !statSync(join(root, "notes")).isDirectory()) {
  errors.push("missing notes/ directory");
}

const unexpected = rootEntryErrors();
if (unexpected.length > 0) {
  errors.push(`unexpected root entries; v2 goal roots may contain only goal.md, state.yaml, notes/, subgoals/, and .goalbuddy-board/: ${unexpected.join(", ")}`);
}

const tasks = parseTasks();
const ids = new Set();
for (const task of tasks) {
  if (!task.id || !/^T\d{3}$/.test(task.id)) errors.push(`task id must use T### format; got ${task.id || "<missing>"}`);
  if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
  ids.add(task.id);
  if (!["scout", "judge", "worker", "pm"].includes(task.type)) {
    errors.push(`task ${task.id} type must be scout, judge, worker, or pm`);
  }
  if (!["Scout", "Judge", "Worker", "PM"].includes(task.assignee)) {
    errors.push(`task ${task.id} assignee must be Scout, Judge, Worker, or PM`);
  }
  const expectedAssignee = {
    scout: "Scout",
    judge: "Judge",
    worker: "Worker",
    pm: "PM",
  }[task.type];
  if (expectedAssignee && task.assignee !== expectedAssignee) {
    errors.push(`task ${task.id} assignee must be ${expectedAssignee} for type ${task.type}`);
  }
  if (!["queued", "active", "blocked", "done"].includes(task.status)) {
    errors.push(`task ${task.id} status must be queued, active, blocked, or done`);
  }
  if (!task.objective) errors.push(`task ${task.id} missing objective`);
}

if (tasks.length === 0) errors.push("tasks must contain at least one task");

const activeTasks = tasks.filter((task) => task.status === "active");
const terminalApprovalWait = isTerminalApprovalWait(tasks, activeTasks, activeTask);
if (goalStatus === "done") {
  if (activeTasks.length !== 0) errors.push("done goals must not have an active task");
  if (activeTask !== null) errors.push("done goals must set active_task: null");
  const unfinishedWorkers = tasks
    .filter((task) => task.type === "worker" && ["queued", "active"].includes(task.status))
    .map((task) => task.id);
  if (unfinishedWorkers.length > 0) {
    errors.push(`done goals must not leave queued or active Worker tasks: ${unfinishedWorkers.join(", ")}`);
  }
} else if (goalStatus === "blocked") {
  if (activeTasks.length > 1) errors.push("blocked goals may have at most one active task");
  if (continuousUntilFullOutcome && missingInputOrCredentialsDoNotStopGoal && !terminalApprovalWait) {
    errors.push("continuous goals must keep goal.status active; missing input or credentials should block specific tasks, not the whole goal");
  }
} else if (activeTasks.length !== 1) {
  errors.push(`exactly one active task is required while goal.status is active; found ${activeTasks.length}`);
}

if (activeTasks.length === 1 && activeTask !== activeTasks[0].id) {
  errors.push(`active_task must point to active task ${activeTasks[0].id}; got ${activeTask || "null"}`);
}
if (activeTask && !ids.has(activeTask)) errors.push(`active_task points to unknown task: ${activeTask}`);

for (const task of tasks) {
  if (task.subgoal.present) {
    validateSubgoal(task);
  }

  const hasReceipt = task.receipt.present && task.receipt.value !== null;
  const receiptResult = hasReceipt ? task.receipt.scalar("result") : null;
  if (task.status === "done" && !hasReceipt) {
    errors.push(`done task ${task.id} missing receipt`);
  }
  if (task.status === "done" && hasReceipt && receiptResult !== "done") {
    errors.push(`done task ${task.id} receipt must include result: done`);
  }
  if (task.status === "blocked" && !hasReceipt) {
    errors.push(`blocked task ${task.id} missing receipt`);
  }
  if (task.type === "worker" && task.status === "active") {
    if (task.allowedFiles.length === 0) errors.push(`active Worker task ${task.id} must include allowed_files`);
    if (task.verify.length === 0) errors.push(`active Worker task ${task.id} must include verify`);
    if (task.stopIf.length === 0) errors.push(`active Worker task ${task.id} must include stop_if`);
  }
  if (task.type === "worker" && task.status === "done" && hasReceipt) {
    for (const key of ["changed_files", "commands", "summary"]) {
      if (!task.receipt.has(key)) errors.push(`Worker receipt for ${task.id} missing ${key}`);
    }
    const changedFiles = task.receipt.list("changed_files");
    if (changedFiles.length === 0) {
      errors.push(`Worker receipt for ${task.id} changed_files must list at least one file`);
    }
    for (const changedFile of changedFiles) {
      if (!matchesAllowedFile(changedFile, task.allowedFiles)) {
        errors.push(`Worker receipt for ${task.id} changed file outside allowed_files: ${changedFile}`);
      }
    }
    const commandStatuses = task.receipt.commandStatuses();
    if (task.receipt.has("commands") && commandStatuses.length === 0) {
      errors.push(`Worker receipt for ${task.id} commands must include status fields`);
    }
    for (const status of commandStatuses) {
      if (status !== "pass") {
        errors.push(`Worker receipt for ${task.id} has non-passing command status: ${status}`);
      }
    }
    if (task.receipt.scalar("needs_judge") === true) {
      warnings.push(`Worker receipt for ${task.id} requests legacy needs_judge; GoalBuddy now lets the PM continue by default and reviews only at phase, risk, ambiguity, rejected-verification, or final-completion boundaries`);
    }
  }
  if (task.type === "scout" && task.status === "done" && hasReceipt) {
    if (!task.receipt.has("summary")) errors.push(`Scout receipt for ${task.id} missing summary`);
    if (!task.receipt.has("evidence") && !task.receipt.has("note")) {
      errors.push(`Scout receipt for ${task.id} must include evidence or note`);
    }
  }
  if (task.type === "judge" && task.status === "done" && hasReceipt && !task.receipt.has("decision")) {
    errors.push(`Judge receipt for ${task.id} missing decision`);
  }
}

warnings.push(...microSliceWarnings(tasks, activeTask, goalStatus));
warnings.push(...processHeavyWarnings(tasks, activeTask, goalStatus));

function isTerminalApprovalWait(tasks, activeTasks, activeTask) {
  if (goalStatus !== "blocked") return false;
  if (activeTask !== null) return false;
  if (activeTasks.length !== 0) return false;

  const unfinishedTasks = tasks.filter((task) => task.status !== "done");
  if (unfinishedTasks.length === 0) return false;
  if (unfinishedTasks.some((task) => task.status !== "blocked")) return false;

  return unfinishedTasks.some((task) => {
    if (!task.receipt.present || task.receipt.value === null) return false;
    return task.receipt.scalar("result") === "blocked"
      && task.receipt.scalar("waiting_for_user_approval") === true
      && Boolean(task.receipt.scalar("required_reply"));
  });
}

function validateSubgoal(task) {
  if (isChildCheck) {
    errors.push(`child task ${task.id} must not contain a nested subgoal`);
    return;
  }

  if (!["active", "blocked", "done"].includes(task.subgoal.status)) {
    errors.push(`task ${task.id} subgoal.status must be active, blocked, or done; got ${task.subgoal.status || "<missing>"}`);
  }
  if (task.subgoal.depth !== 1) {
    errors.push(`task ${task.id} subgoal.depth must be 1; got ${task.subgoal.depth || "<missing>"}`);
  }
  if (!task.subgoal.path) {
    errors.push(`task ${task.id} subgoal.path is required`);
    return;
  }

  const rootPath = resolve(root);
  const childStatePath = resolve(rootPath, task.subgoal.path);
  if (childStatePath !== rootPath && !childStatePath.startsWith(`${rootPath}${sep}`)) {
    errors.push(`task ${task.id} subgoal.path must stay inside the goal root: ${task.subgoal.path}`);
    return;
  }
  if (basename(childStatePath) !== "state.yaml") {
    errors.push(`task ${task.id} subgoal.path must point to a state.yaml file`);
    return;
  }
  if (!existsSync(childStatePath)) {
    errors.push(`task ${task.id} subgoal state file not found: ${task.subgoal.path}`);
    return;
  }

  const result = spawnSync(process.execPath, [process.argv[1], childStatePath, "--child"], {
    encoding: "utf8",
  });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    errors.push(`task ${task.id} subgoal checker produced invalid output for ${task.subgoal.path}`);
    return;
  }
  if (result.status !== 0 || !report.ok) {
    for (const childError of report.errors || ["unknown child state error"]) {
      errors.push(`task ${task.id} subgoal invalid: ${childError}`);
    }
  }
}

function microSliceWarnings(tasks, activeTaskId, goalStatus) {
  const found = [];
  const guidance = "Board may be micro-slicing. Prefer the largest safe useful slice.";
  const doneTasks = tasks.filter((task) => task.status === "done");
  const workerTasks = tasks.filter((task) => task.type === "worker");
  const recentTinyWorkers = workerTasks.slice(-5).filter((task) => isTinyTask(task));
  const firstMilestoneComplete = nestedScalar("goal", "first_milestone_complete") === true;

  if (recentTinyWorkers.length >= 3) {
    found.push(`${guidance} Three recent Worker tasks look tiny.`);
  }

  for (const task of tasks) {
    if (task.type === "judge" && /pick small reviewable work|select one narrow next task/i.test(task.raw)) {
      found.push(`${guidance} Judge instructions still ask for small or narrow work.`);
      break;
    }
  }

  if (goalStatus !== "active" || !activeTaskId) return [...new Set(found)];
  const activeIndex = tasks.findIndex((task) => task.id === activeTaskId);
  if (activeIndex === -1) return [...new Set(found)];
  const active = tasks[activeIndex];
  if (active.type === "worker") {
    if (doneTasks.length >= 10 && active.allowedFiles.length > 0 && active.allowedFiles.length <= 2) {
      found.push(`${guidance} Active Worker ${active.id} has only ${active.allowedFiles.length} allowed_files after ${doneTasks.length} completed tasks.`);
    }
    if (firstMilestoneComplete && isTinyTask(active)) {
      found.push(`${guidance} The first milestone is complete, so the active Worker should move toward the next real milestone.`);
    }
    if (isMicroWorkerTask(active)) {
      found.push(`${guidance} Active Worker ${active.id} looks like another helper-sized slice.`);
    }
  }
  if (active.type !== "judge") return [...new Set(found)];

  let pairs = 0;
  for (let index = activeIndex; index > 0; index -= 2) {
    const judge = tasks[index];
    const worker = tasks[index - 1];
    if (!isMicroJudgeForWorker(judge, worker)) break;
    pairs += 1;
  }
  if (pairs >= 2) {
    found.push(`${guidance} Micro Worker/Judge loop detected ending at ${active.id}.`);
  }
  return [...new Set(found)];
}

function isMicroJudgeForWorker(judge, worker) {
  if (!judge || !worker) return false;
  if (judge.type !== "judge" || worker.type !== "worker") return false;
  if (!["active", "queued", "done"].includes(judge.status) || worker.status !== "done") return false;
  const objective = String(judge.objective || "").toLowerCase();
  return objective.includes(worker.id.toLowerCase()) && /audit|review|approve/.test(objective) && isMicroWorkerTask(worker);
}

function isMicroWorkerTask(task) {
  if (!task || task.type !== "worker") return false;
  const objective = String(task.objective || "").toLowerCase();
  if (/collapsed|batch|package|tranche/.test(objective)) return false;
  return /one narrow|single helper|one helper|per[- ]helper|per[- ]table|projection helper/.test(objective);
}

function isTinyTask(task) {
  if (!task) return false;
  const text = [task.objective, task.raw, task.receipt?.raw].join(" ").toLowerCase();
  if (/collapsed|batch|package|tranche|vertical slice|milestone/.test(text)) return false;
  return /\b(tiny|narrow|single helper|one helper|projection helper|projection function|contract file|read-only proof|doc note|validator|validation wrapper|pure helper|caller-input)\b/.test(text);
}

// Advisory process-heavy heuristics: they never fail a board and never rewrite completed
// history; only future work should be consolidated. Tune via PROCESS_HEAVY_THRESHOLDS:
// largeUnfinished (unfinished cards, including blocked boards with no active task),
// ratioMinTasks + processToWorkerRatio (PM/Judge/Scout cards vs Worker cards), and processRun
// (consecutive dispatched process-only cards since the last Worker card). Keep this function
// byte-identical to processHeavyWarnings in scripts/render-task-prompt.mjs.
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

function matchesAllowedFile(file, allowedFiles) {
  return allowedFiles.some((pattern) => globMatch(pattern, file));
}

function globMatch(pattern, file) {
  const normalizedPattern = normalizePathPattern(pattern);
  const normalizedFile = normalizePathPattern(file);
  if (normalizedPattern === normalizedFile) return true;
  const token = "__GOALBUDDY_GLOBSTAR__";
  const regexSource = escapeRegExp(normalizedPattern)
    .replace(/\*\*/g, token)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(token, "g"), ".*");
  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(normalizedFile);
}

function normalizePathPattern(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

if (goalStatus === "done") {
  if (noCompletionOnWeakProof && (isWeakProof(completionProof) || isWeakProof(oracleSignal) || isWeakProof(oracleFinalProof))) {
    errors.push("done goals require concrete completion proof, goal.oracle.signal, and goal.oracle.final_proof; weak proof cannot close a goal");
  }
  const finalAudit = tasks.some((task) => {
    if (!["judge", "pm"].includes(task.type) || task.status !== "done") return false;
    if (!task.receipt.present || task.receipt.value === null) return false;
    const decision = task.receipt.scalar("decision");
    return decision === "complete" || decision === "done";
  });
  if (!finalAudit) {
    errors.push("completion requires a final done Judge or PM audit receipt with decision: complete");
  }
  if (continuousUntilFullOutcome) {
    const finalFullOutcomeAudit = tasks.some((task) => {
      if (!["judge", "pm"].includes(task.type) || task.status !== "done") return false;
      if (!task.receipt.present || task.receipt.value === null) return false;
      const decision = task.receipt.scalar("decision");
      const fullOutcomeComplete = task.receipt.scalar("full_outcome_complete");
      return (decision === "complete" || decision === "done") && fullOutcomeComplete === true;
    });
    if (!finalFullOutcomeAudit) {
      errors.push("continuous goals require a final done Judge or PM audit receipt with full_outcome_complete: true before goal.status: done");
    }
  }
}

const result = {
  ok: errors.length === 0,
  version,
  state_path: statePath,
  goal_status: goalStatus,
  active_task: activeTask,
  agent_statuses: Object.fromEntries(agentStatuses.map(({ agent, status }) => [agent, status])),
  task_count: tasks.length,
  errors,
  warnings,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

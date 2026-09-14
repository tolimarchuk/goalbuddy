#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBoardRevision, checkAcceptanceProof } from "./acceptance-proof.mjs";

import { parseBoard } from "./strict-data.mjs";
import { sha256 } from "./file-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const json = process.argv.includes("--json");

if (!inputPath) {
  failUsage("Usage: goalbuddy can-stop <docs/goals/slug> [--json]");
}

const goalPath = resolve(inputPath);
const statePath = existsSync(goalPath) && statSync(goalPath).isDirectory()
  ? join(goalPath, "state.yaml")
  : goalPath;
let revision;
try { revision = readFileSync(statePath); parseBoard(revision.toString("utf8")); }
catch (error) { emit({ ok: false, can_stop: false, reason: "invalid_goal_state", errors: [error.message] }, 1); }
const checker = join(__dirname, "check-goal-state.mjs");
const checked = spawnSync(process.execPath, [checker, statePath], {
  encoding: "utf8",
});

let state;
try {
  state = JSON.parse(checked.stdout || "{}");
} catch {
  emit({
    ok: false,
    can_stop: false,
    reason: "state_check_failed",
    state_path: statePath,
    errors: [checked.stderr.trim() || "Goal state checker returned unreadable output."],
  }, 1);
}

if (checked.status !== 0 || !state.ok || state.state_sha256 !== sha256(revision)) {
  emit({
    ok: false,
    can_stop: false,
    reason: "invalid_goal_state",
    state_path: statePath,
    goal_status: state.goal_status || null,
    active_task: state.active_task || null,
    errors: state.errors || [],
  }, 1);
}

if (state.goal_status === "active") {
  emit({
    ok: true,
    can_stop: false,
    reason: "runnable_work_remains",
    state_path: statePath,
    goal_status: state.goal_status,
    active_task: state.active_task,
    next: `Continue the active task ${state.active_task}. Do not report the goal as complete.`,
  }, 1);
}

if (state.goal_status === "blocked") {
  emit({
    ok: true,
    can_stop: true,
    reason: "validated_terminal_block",
    state_path: statePath,
    goal_status: state.goal_status,
    active_task: state.active_task,
  }, 0);
}

const acceptance = checkAcceptanceProof(statePath, revision);
if (!acceptance.ok) {
  emit({
    ok: false, can_stop: false, reason: "acceptance_not_proven",
    state_path: statePath, goal_status: state.goal_status, active_task: state.active_task,
    errors: acceptance.errors,
    next: "Preserve historical receipts. Repair or resume the outcome, then record a new authorized acceptance attempt while the final audit is active, then have its receipt consume that evidence. See references/goal-execution.md.",
  }, 1);
}

emit({
  ok: true,
  can_stop: true,
  reason: "full_outcome_complete",
  state_path: statePath,
  goal_status: state.goal_status,
  active_task: state.active_task,
  acceptance,
}, 0);

function emit(result, code) {
  if (result.can_stop) {
    try { assertBoardRevision(statePath, revision); result.board_revision = sha256(revision); }
    catch (error) { result = { ok: false, can_stop: false, reason: "board_revision_changed", errors: [error.message] }; code = 1; }
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.can_stop) {
    console.log(`GoalBuddy can stop: ${result.reason}.`);
  } else {
    console.error(`GoalBuddy cannot stop: ${result.reason}.`);
    if (result.next) console.error(result.next);
    for (const error of result.errors || []) console.error(`- ${error}`);
  }
  process.exit(code);
}

function failUsage(message) {
  if (json) console.error(JSON.stringify({ ok: false, can_stop: false, error: message }, null, 2));
  else console.error(message);
  process.exit(2);
}

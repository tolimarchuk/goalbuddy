#!/usr/bin/env node
// Apply a receipt, task status, and active_task transition to state.yaml atomically.
// Fail-closed: the result is validated with check-goal-state.mjs and reverted on errors.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBoard, parseJson } from "./strict-data.mjs";
import { validateDispatchReport, validateIdentity } from "./receipt-contract.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

if (isDirectRun()) {
  try {
    const options = parseApplyArgs(process.argv.slice(2));
    const report = applyReceipt(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.ok) {
      console.log(`Recorded ${report.task_id} as ${report.status}; active_task is now ${report.active_task}.`);
      if (report.continuation_required) {
        console.log(`Continuation required: ${report.next_action}`);
      } else {
        console.log(`Stop allowed: ${report.stop_reason}.`);
      }
    } else {
      console.log(`Transition rejected and reverted. Checker errors:\n- ${report.checker_errors.join("\n- ")}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export function parseApplyArgs(args) {
  const options = { goalRoot: "", taskId: "", receiptPath: "", status: "", activate: "", json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--task") options.taskId = args[++index] || "";
    else if (arg.startsWith("--task=")) options.taskId = arg.slice("--task=".length);
    else if (arg === "--receipt") options.receiptPath = args[++index] || "";
    else if (arg.startsWith("--receipt=")) options.receiptPath = arg.slice("--receipt=".length);
    else if (arg === "--status") options.status = args[++index] || "";
    else if (arg.startsWith("--status=")) options.status = arg.slice("--status=".length);
    else if (arg === "--activate") options.activate = args[++index] || "";
    else if (arg.startsWith("--activate=")) options.activate = arg.slice("--activate=".length);
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
    else if (!options.goalRoot) options.goalRoot = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.goalRoot || !options.taskId || !options.receiptPath) {
    throw new Error("Usage: node apply-receipt.mjs <goal-root> --task T### --receipt <file> [--status done|blocked] [--activate T###|none] [--json]");
  }
  return options;
}

export function applyReceipt(options) {
  const goalRoot = resolve(options.goalRoot);
  const statePath = basename(goalRoot) === "state.yaml" ? goalRoot : join(goalRoot, "state.yaml");
  if (!existsSync(statePath)) throw new Error(`state file not found: ${statePath}`);
  const original = readFileSync(statePath, "utf8");
  const board = parseBoard(original);
  const task = board.tasks.find(task => task.id === options.taskId);
  if (!task) throw new Error(`Task ${options.taskId} not found in state.yaml`);
  const { receipt, provenance } = loadReceipt(options.receiptPath, { taskId: options.taskId, boardPath: statePath, board, task, harness: task.harness });
  const status = options.status || (receipt.result === "done" ? "done" : "blocked");
  if (status !== receipt.result) throw new Error("Requested status contradicts the receipt result.");
  if (!["done", "blocked"].includes(status)) throw new Error(`Unsupported --status: ${status}`);

  let lines = original.replace(/\r\n/g, "\n").split("\n");

  lines = setTaskField(lines, options.taskId, "status", status);
  lines = setTaskReceipt(lines, options.taskId, receipt);
  if (options.activate && options.activate !== "none") {
    lines = setTaskField(lines, options.activate, "status", "active");
  }
  const nextActive = options.activate === "none" || !options.activate ? "null" : options.activate;
  lines = setTopLevel(lines, "active_task", nextActive);

  if (readFileSync(statePath, "utf8") !== original) throw new Error("Board changed during receipt validation; import was not applied.");
  const proposed = lines.join("\n");
  writeAtomic(statePath, proposed);

  const check = spawnSync(process.execPath, [join(scriptDir, "check-goal-state.mjs"), statePath], { encoding: "utf8" });
  let checkerReport = null;
  try {
    checkerReport = JSON.parse(check.stdout);
  } catch {
    checkerReport = { ok: false, errors: [`checker produced unreadable output: ${(check.stderr || check.stdout || "").slice(0, 300)}`] };
  }

  if (!checkerReport.ok || check.status !== 0) {
    if (readFileSync(statePath, "utf8") !== (proposed.endsWith("\n") ? proposed : `${proposed}\n`)) throw new Error("Concurrent board update preserved; failed transition requires PM recovery.");
    writeAtomic(statePath, original);
    return { ok: false, task_id: options.taskId, status, active_task: nextActive, reverted: true, checker_errors: checkerReport.errors || [] };
  }
  const stopCheck = spawnSync(process.execPath, [join(scriptDir, "check-can-stop.mjs"), statePath, "--json"], { encoding: "utf8" });
  let stopReport = null;
  try {
    stopReport = JSON.parse(stopCheck.stdout || stopCheck.stderr);
  } catch {
    stopReport = { can_stop: false, reason: "stop_gate_unreadable" };
  }
  return {
    ok: true,
    task_id: options.taskId,
    status,
    active_task: nextActive,
    reverted: false,
    checker_warnings: checkerReport.warnings || [],
    receipt_provenance: provenance,
    stop_allowed: stopReport.can_stop === true,
    continuation_required: stopReport.can_stop !== true,
    stop_reason: stopReport.reason || "unknown",
    next_action: stopReport.can_stop === true
      ? "The host turn may end."
      : stopReport.next || `Continue active task ${nextActive}; activation alone is not execution.`,
  };
}

function loadReceipt(receiptPath, context) {
  const parsed = parseJson(readFileSync(resolve(receiptPath), "utf8"));
  const report = parsed && ("scope_check" in parsed || "dispatch_version" in parsed || "receipt" in parsed);
  if (report) validateDispatchReport(parsed, context);
  const candidate = report ? parsed.receipt : parsed.goalbuddy_receipt_v1 ?? parsed;
  // Bare/enveloped v1 receipts remain a deliberate PM import path. Absence is
  // compatible; contradictory supplied identity is never stripped into validity.
  validateIdentity(candidate, context);
  const receipt = { ...candidate };
  delete receipt.board_path;
  delete receipt.task_id;
  return { receipt, provenance: report ? "verified_dispatch" : "pm_import_without_dispatch_observation" };
}

function taskBlockRange(lines, taskId) {
  const start = lines.findIndex((line) => new RegExp(`^  - id:\\s*"?${taskId}"?\\s*$`).test(line));
  if (start === -1) throw new Error(`Task ${taskId} not found in state.yaml`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  - id:/.test(lines[index]) || /^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return [start, end];
}

function setTaskField(lines, taskId, key, value) {
  const [start, end] = taskBlockRange(lines, taskId);
  for (let index = start; index < end; index += 1) {
    if (new RegExp(`^    ${key}:`).test(lines[index])) {
      lines[index] = `    ${key}: ${value}`;
      return lines;
    }
  }
  throw new Error(`Task ${taskId} has no "${key}" field to update.`);
}

function setTaskReceipt(lines, taskId, receipt) {
  const [start, end] = taskBlockRange(lines, taskId);
  let receiptLine = -1;
  for (let index = start; index < end; index += 1) {
    if (/^    receipt:/.test(lines[index])) {
      receiptLine = index;
      break;
    }
  }
  if (receiptLine === -1) throw new Error(`Task ${taskId} has no "receipt" field.`);

  let receiptEnd = receiptLine + 1;
  while (receiptEnd < end && (/^\s{5,}/.test(lines[receiptEnd]) || lines[receiptEnd].trim() === "")) {
    receiptEnd += 1;
  }

  const serialized = ["    receipt:", ...toYamlLines(receipt, 6)];
  return [...lines.slice(0, receiptLine), ...serialized, ...lines.slice(receiptEnd)];
}

function setTopLevel(lines, key, value) {
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index === -1) throw new Error(`state.yaml has no top-level "${key}" field.`);
  lines[index] = `${key}: ${value}`;
  return lines;
}

export function toYamlLines(value, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        lines.push(`${pad}${key}: []`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      for (const item of entry) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const pairs = Object.entries(item);
          pairs.forEach(([itemKey, itemValue], pairIndex) => {
            const prefix = pairIndex === 0 ? `${pad}  - ` : `${pad}    `;
            lines.push(`${prefix}${itemKey}: ${scalar(itemValue)}`);
          });
        } else {
          lines.push(`${pad}  - ${scalar(item)}`);
        }
      }
    } else if (entry && typeof entry === "object") {
      lines.push(`${pad}${key}:`);
      lines.push(...toYamlLines(entry, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${scalar(entry)}`);
    }
  }
  return lines;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (/^[A-Za-z0-9_.\/-]+$/.test(String(value)) && !["null", "true", "false"].includes(String(value))) return String(value);
  return JSON.stringify(String(value));
}

function writeAtomic(path, content) {
  const tempPath = `${path}.goalbuddy-tmp-${process.pid}`;
  writeFileSync(tempPath, content.endsWith("\n") ? content : `${content}\n`);
  renameSync(tempPath, path);
}

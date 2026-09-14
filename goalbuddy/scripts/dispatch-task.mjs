#!/usr/bin/env node
// Dispatch one board task to an external harness CLI and verify the result.
// Read-only toward state.yaml: prints the receipt and scope verdict; the PM records them.
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPrompt, loadBoard, renderTaskPrompt, resolveBoardPath, selectTask } from "./render-task-prompt.mjs";
import { gitSnapshot, goalControlPaths, insidePath, matchesPattern, portable } from "./file-snapshot.mjs";
import { existsSync, readFileSync, realpathSync } from "node:fs";

import { DuplicateKeyError, parseBoard, parseJson } from "./strict-data.mjs";
import { taskAuthority, validateIdentity } from "./receipt-contract.mjs";
export { matchesPattern } from "./file-snapshot.mjs";

const HARNESSES = new Set(["codex", "claude-code"]);
const READ_ONLY_ROLES = new Set(["scout", "judge"]);

if (isDirectRun()) {
  try {
    const options = parseDispatchArgs(process.argv.slice(2));
    const report = dispatchTask(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
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

export function parseDispatchArgs(args) {
  const options = { goalRoot: "", taskId: "", to: "", model: "", timeoutSeconds: 1200, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--task") options.taskId = args[++index] || "";
    else if (arg.startsWith("--task=")) options.taskId = arg.slice("--task=".length);
    else if (arg === "--to") options.to = args[++index] || "";
    else if (arg.startsWith("--to=")) options.to = arg.slice("--to=".length);
    else if (arg === "--model") options.model = args[++index] || "";
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else if (arg === "--timeout") options.timeoutSeconds = Number(args[++index] || 0) || 1200;
    else if (arg.startsWith("--timeout=")) options.timeoutSeconds = Number(arg.slice("--timeout=".length)) || 1200;
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
    else if (!options.goalRoot) options.goalRoot = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.goalRoot) {
    throw new Error("Usage: node dispatch-task.mjs <goal-root> --to codex|claude-code [--task T###] [--model <name>] [--timeout <seconds>] [--json]");
  }
  return options;
}

export function dispatchTask(options) {
  const boardPath = realpathSync.native(resolveBoardPath({ goalRoot: options.goalRoot }));
  const boardBytes = readFileSync(boardPath);
  const document = parseBoard(boardBytes.toString("utf8"));
  const board = loadBoard(boardPath);
  const task = selectTask(board, options.taskId);
  const to = options.to || cleanScalar(task.harness) || "";
  if (!HARNESSES.has(to)) {
    return failure(`Unknown or missing dispatch target "${to}". Use --to codex or --to claude-code (or set harness: on the task card).`, { task_id: task.id });
  }

  const rendered = renderTaskPrompt({ goalRoot: options.goalRoot, taskId: options.taskId, json: false });
  const role = rendered.payload.task.type;
  const prompt = [
    formatPrompt(rendered.payload, { includePmObservationContract: false }),
    "",
    "Dispatch notes:",
    `- Work only inside the current directory: ${process.cwd()}`,
    "- Do not edit state.yaml or any GoalBuddy control files; the PM records your receipt.",
    `- End your reply with exactly one goalbuddy_receipt_v1 JSON object, including "harness": "${to}".`,
  ].join("\n");

  if (task.harness && task.harness !== to) return failure("Dispatch target contradicts the task harness.", { task_id: task.id });
  const admitted = [...(task.allowed_files || []), ...(task.inputs || []).filter(path => typeof path === "string" && existsSync(resolve(path))), ...(task.acceptance?.artifacts || []), ...(task.acceptance?.inputs || [])];
  const before = gitSnapshot(process.cwd(), { boardPath, admitted });
  if (!before.ok || !insidePath(before.root, realpathSync.native(boardPath))) {
    return failure("Cannot establish dispatch scope; harness was not started.", {
      task_id: task.id, harness: to, role,
      scope_check: { status: "unverifiable", changed_files: [], violations: [], reason: before.error || "Board is outside the inspected repository." },
    });
  }
  if (!readFileSync(boardPath).equals(boardBytes)) {
    return failure("Board changed while preparing dispatch; harness was not started. Review the current task and scope before retrying.", {
      task_id: task.id, harness: to, role,
      scope_check: { status: "unverifiable", changed_files: [portable(relative(before.root, boardPath))], violations: [] },
    });
  }
  const authority = taskAuthority(document, document.tasks.find(candidate => candidate.id === task.id), boardPath, { harness: to, cwd: process.cwd(), repositoryRoot: before.root });
  const run = runHarness(to, prompt, { model: options.model, sandbox: rendered.payload.metadata.sandbox, role, timeoutSeconds: options.timeoutSeconds });
  const after = gitSnapshot(process.cwd(), { boardPath, admitted, previousPaths: before.sourcePaths });
  const scope = scopeCheck({ before, after, role, allowedFiles: rendered.payload.task.allowed_files, boardPath });
  if (run.error) {
    return failure(run.error, {
      task_id: task.id,
      harness: to,
      role,
      exit_status: run.status ?? null,
      timeout_semantics: run.timedOut ? "hard_execution_deadline" : null,
      scope_check: scope,
    });
  }

  let receipt = null, receiptError = null;
  try {
    receipt = extractReceipt(`${run.stdout}\n${run.stderr}`);
    if (receipt) {
      validateIdentity(receipt, { taskId: task.id, boardPath, harness: to });
      receipt = { ...receipt, task_id: task.id, board_path: boardPath, harness: to };
    }
  } catch (error) { receiptError = error.message; }

  const report = {
    ok: Boolean(receipt) && !receiptError && scope.status === "clean" && run.status === 0,
    dispatch_version: 1, repository_root: before.root, board_path: boardPath, cwd: process.cwd(), authority_sha256: authority,
    harness: to,
    task_id: task.id,
    role,
    exit_status: run.status,
    receipt: receipt || null,
    scope_check: scope,
  };
  if (receiptError) report.error = receiptError;
  if (!receipt) {
    report.error = receiptError || "No goalbuddy_receipt_v1 object found in the harness output.";
    report.output_tail = `${run.stdout}`.slice(-2000);
  }
  return report;
}

function failure(message, extra = {}) {
  return { ok: false, error: message, receipt: null, scope_check: { status: "skipped" }, ...extra };
}

function runHarness(to, prompt, { model, sandbox, role, timeoutSeconds }) {
  const command = harnessCommand(to, prompt, { model, sandbox, role });
  let executable = command.file, shell = false;
  if (process.platform === "win32") {
    const where = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), [executable], { encoding: "utf8", timeout: 5000 });
    executable = where.status === 0 ? where.stdout.split(/\r?\n/).find(path => /\.(?:exe|com|cmd|bat)$/i.test(path)) : "";
    if (!executable) return { error: `The ${to} CLI ("${command.file}") was not found on PATH. Install it or choose another --to target.` };
    shell = /\.(?:cmd|bat)$/i.test(executable);
  }
  const result = spawnSync(executable, command.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    shell,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    return { error: `The ${to} CLI ("${command.file}") was not found on PATH. Install it or choose another --to target.` };
  }
  if (result.error?.code === "ETIMEDOUT") {
    return {
      error: `The ${to} CLI hit its hard execution timeout after ${timeoutSeconds}s. Inspect the scope check and working tree for partial writes before fallback.`,
      status: result.status,
      timedOut: true,
    };
  }
  if (result.error) return { error: result.error.message };
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function harnessCommand(to, prompt, { model = "", sandbox = "workspace-write", role = "worker" } = {}) {
  if (to === "codex") {
    const args = ["exec", "--skip-git-repo-check", "-c", `sandbox_mode=${JSON.stringify(sandbox)}`];
    if (model) args.push("-c", `model=${JSON.stringify(model)}`);
    args.push(prompt);
    return { file: "codex", args };
  }
  const args = ["-p", prompt];
  if (model) args.push("--model", model);
  if (!READ_ONLY_ROLES.has(role)) args.push("--permission-mode", "acceptEdits");
  return { file: "claude", args };
}

export function extractReceipt(output) {
  const text = String(output || "").replace(/```[a-z]*\n?/gi, "");
  const key = '"goalbuddy_receipt_v1"';
  let searchFrom = 0;
  while (true) {
    const keyIndex = text.indexOf(key, searchFrom);
    if (keyIndex === -1) break;
    const start = text.lastIndexOf("{", keyIndex);
    if (start !== -1) {
      const candidate = parseBalancedObject(text, start);
      const receipt = candidate ? candidate.goalbuddy_receipt_v1 ?? candidate : null;
      if (isReceiptShaped(receipt)) return receipt;
    }
    searchFrom = keyIndex + key.length;
  }

  // Fallback: models often return the receipt bare, without the envelope.
  // Scan candidate objects from the end of the output (receipts come last).
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{" && (index === 0 || /[\s`:>]/.test(text[index - 1]))) starts.push(index);
  }
  for (let attempt = starts.length - 1, tried = 0; attempt >= 0 && tried < 50; attempt -= 1, tried += 1) {
    const candidate = parseBalancedObject(text, starts[attempt]);
    if (isReceiptShaped(candidate)) return candidate;
  }
  return null;
}

function parseBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return parseJson(text.slice(start, index + 1));
        } catch (error) {
          if (error instanceof DuplicateKeyError) throw error;
          return null;
        }
      }
    }
  }
  return null;
}

function isReceiptShaped(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  if (typeof candidate.result !== "string") return false;
  return ["task_id", "decision", "summary", "changed_files", "evidence"].some((field) => field in candidate);
}

export function scopeCheck({ before, after, role, allowedFiles, boardPath }) {
  if (!before?.ok || !after?.ok || before.root !== after.root || before.gitDir !== after.gitDir || before.commonDir !== after.commonDir) {
    return { status: "unverifiable", changed_files: [], violations: [], reason: before?.error || after?.error || "Repository identity changed or inspection was incomplete. Inspect partial writes before recovery." };
  }
  const changed = [...new Set([...before.files.keys(), ...after.files.keys()])]
    .filter((file) => before.files.get(file) !== after.files.get(file)).sort();
  const controls = goalControlPaths(boardPath).map(path => portable(relative(before.root, path)));
  const goalControl = file => file === ".git" || file.startsWith(".git/") || /(^|\/)docs\/goals(?:\/|$)/.test(file)
    || controls.some(path => file === path || file.startsWith(`${path}/`));
  const observation = { ...after.observation,
    excluded_ignored_paths: [...new Set([...before.observation.excluded_ignored_paths, ...after.observation.excluded_ignored_paths])].sort(),
    admitted_ignored_paths: [...new Set([...before.observation.admitted_ignored_paths, ...after.observation.admitted_ignored_paths])].sort(),
  };
  if (READ_ONLY_ROLES.has(role)) {
    return changed.length
      ? { status: "violations", observation, changed_files: changed, violations: changed, reason: `Read-only role "${role}" modified files. Changes were preserved for PM recovery.` }
      : { status: "clean", observation, changed_files: changed, violations: [] };
  }
  const violations = changed.filter((file) => goalControl(file)
    || !allowedFiles.some((pattern) => {
      const path = portable(relative(realpathSync.native(process.cwd()), resolve(before.root, file)));
      if (matchesPattern(path, pattern)) return true;
      // Creating/removing an ancestor directory is necessary for an exact file grant.
      const entry = after.files.get(file) || before.files.get(file);
      const directory = entry && !entry.includes("\nindex:") && JSON.parse(entry).type === "directory";
      return directory && (before.files.get(file) == null || after.files.get(file) == null)
        && String(pattern).startsWith(`${path}/`);
    }));
  return violations.length
    ? { status: "violations", observation, changed_files: changed, violations, reason: "Files changed outside allowed_files or in PM-owned goal controls. Changes were preserved for PM recovery." }
    : { status: "clean", observation, changed_files: changed, violations: [] };
}

function cleanScalar(value) {
  return typeof value === "string" ? value.trim() : "";
}

function printHumanReport(report) {
  if (report.error) console.log(`Dispatch failed: ${report.error}`);
  if (report.receipt) {
    console.log(`Receipt from ${report.harness} for ${report.task_id} (${report.role}): result ${report.receipt.result}`);
    console.log(JSON.stringify(report.receipt, null, 2));
  }
  if (report.scope_check) {
    console.log(`Scope check: ${report.scope_check.status}`);
    if (report.scope_check.violations?.length) {
      console.log(`Violations: ${report.scope_check.violations.join(", ")}`);
    }
  }
  console.log(report.ok
    ? "Dispatch ok. Record the receipt on the task card (state.yaml) as the PM."
    : "Dispatch NOT ok. Inspect the working tree and receipt before recording anything.");
}

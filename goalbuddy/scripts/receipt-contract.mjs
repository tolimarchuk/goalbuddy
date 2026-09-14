import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonical } from "./strict-data.mjs";
import { goalControlPaths, insidePath, matchesPattern, portable, sha256 } from "./file-snapshot.mjs";

export function taskAuthority(board, task, boardPath, { harness, cwd, repositoryRoot } = {}) {
  return sha256(canonical({ board_path: realpathSync.native(boardPath), goal: board.goal, rules: board.rules || {}, active_task: board.active_task, task, harness: harness || task.harness || null, cwd: realpathSync.native(cwd || process.cwd()), repository_root: realpathSync.native(repositoryRoot) }));
}

export function validateIdentity(receipt, { taskId, boardPath, harness, cwd = process.cwd() }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || !["done", "blocked"].includes(receipt.result)) throw new Error("Receipt requires result: done or blocked.");
  if ("task_id" in receipt && receipt.task_id !== taskId) throw new Error("Receipt task_id does not match the dispatched/imported task.");
  if ("board_path" in receipt) {
    if (typeof receipt.board_path !== "string" || !receipt.board_path) throw new Error("Receipt board_path is invalid.");
    let supplied;
    try { supplied = realpathSync.native(resolve(cwd, receipt.board_path)); } catch { throw new Error("Receipt board_path does not identify this board."); }
    if (supplied !== realpathSync.native(boardPath)) throw new Error("Receipt board_path does not match this board.");
  }
  if ("harness" in receipt && (typeof receipt.harness !== "string" || !receipt.harness || (harness && receipt.harness !== harness))) throw new Error("Receipt harness contradicts the expected harness.");
}

export function validateDispatchReport(report, context) {
  const scope = report.scope_check;
  if (report.ok !== true || report.exit_status !== 0 || !scope || scope.status !== "clean"
      || !Array.isArray(scope.violations) || scope.violations.length || !Array.isArray(scope.changed_files)
      || scope.observation?.policy !== "source-and-controls-v1") throw new Error("Dispatch was not verified clean or its exit/scope facts are inconsistent.");
  if (report.dispatch_version !== 1 || !["codex", "claude-code"].includes(report.harness)
      || typeof report.cwd !== "string" || report.role !== context.task.type
      || report.task_id !== context.task.id || typeof report.board_path !== "string") throw new Error("Dispatch identity/version is invalid.");
  validateIdentity({ result: "done", task_id: report.task_id, board_path: report.board_path, harness: report.harness }, { ...context, taskId: context.task.id, cwd: report.cwd });
  if (typeof report.repository_root !== "string" || report.authority_sha256 !== taskAuthority(context.board, context.task, context.boardPath, { harness: report.harness, cwd: report.cwd, repositoryRoot: report.repository_root })) throw new Error("Dispatch authority is stale: the task, repository or its goal/active authority changed.");
  const repositoryRoot = realpathSync.native(report.repository_root);
  const cwd = realpathSync.native(report.cwd);
  const observation = scope.observation;
  for (const key of ["excluded_ignored_paths", "admitted_ignored_paths", "git_exclusions"]) if (!Array.isArray(observation[key]) || observation[key].some(path => typeof path !== "string")) throw new Error("Dispatch observation boundary is malformed.");
  if (typeof report.repository_root !== "string" || !insidePath(repositoryRoot, realpathSync.native(context.boardPath)) || !insidePath(repositoryRoot, realpathSync.native(report.cwd))) throw new Error("Dispatch repository/cwd identity is inconsistent.");
  const controls = goalControlPaths(realpathSync.native(context.boardPath));
  for (const file of scope.changed_files) {
    if (typeof file !== "string") throw new Error("Dispatch changed_files is malformed.");
    const path = resolve(repositoryRoot, file);
    const name = portable(relative(cwd, path));
    if (!insidePath(repositoryRoot, path) || ["scout", "judge"].includes(report.role)
        || file === ".git" || file.startsWith(".git/") || /(^|\/)docs\/goals(?:\/|$)/.test(file)
        || controls.some(control => insidePath(control, path))
        || !(context.task.allowed_files || []).some(pattern => matchesPattern(name, pattern) || String(pattern).startsWith(`${name}/`))) throw new Error("Dispatch clean scope contradicts its changed_files.");
  }
  validateIdentity(report.receipt, { ...context, taskId: context.task.id, harness: report.harness, cwd: report.cwd });
}

#!/usr/bin/env node
// PM explicitly runs one authorized verification; the final audit consumes its evidence.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceContext, assertBoardRevision } from "./acceptance-proof.mjs";
import { canonical } from "./strict-data.mjs";
import { localPath, portable, sha256 } from "./file-snapshot.mjs";

function capture() {
  const hash = createHash("sha256");
  let bytes = 0, tail = Buffer.alloc(0);
  return {
    write(chunk) { bytes += chunk.length; hash.update(chunk); tail = Buffer.concat([tail, chunk]).subarray(-65536); },
    finish() {
      return { tail_base64: tail.toString("base64"), bytes, sha256: hash.digest("hex"), truncated: bytes > tail.length };
    },
  };
}

async function run(command, cwd, seconds) {
  const stdout = capture(), stderr = capture();
  return await new Promise(resolveRun => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: processGroup, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let error = null, timedOut = false, closed = false, settled = false;
    let exitStatus = null, exitSignal = null, cleanup = { status: "not_required" };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveRun({ exit_status: exitStatus, signal: exitSignal, error: timedOut ? `Acceptance exceeded authorized timeout (${seconds}s).${cleanup.status === "unproven" ? ` Cleanup unproven: ${cleanup.detail}` : ""}` : error,
        timed_out: timedOut, cleanup, stdout: stdout.finish(), stderr: stderr.finish() });
    };
    const terminate = signal => {
      // A package launcher can leave its validator holding these pipes open.
      // Terminate only this check's own process group, never a shared host group.
      try { if (processGroup && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (failure) { if (failure.code !== "ESRCH") error = failure.message; }
    };
    const groupRemains = () => {
      if (!processGroup || !child.pid) return true;
      try { process.kill(-child.pid, 0); return true; }
      catch (failure) {
        if (failure.code === "ESRCH") return false;
        error = failure.message; return true;
      }
    };
    const timer = setTimeout(async () => {
      timedOut = true; terminate("SIGTERM");
      // Direct-child close (including redirected descendant output) must not
      // cancel escalation. Only this invocation's private group is signaled.
      await new Promise(resolveGrace => setTimeout(resolveGrace, 1000));
      terminate("SIGKILL");
      const deadline = Date.now() + 1000;
      while (groupRemains() && Date.now() < deadline) await new Promise(resolvePoll => setTimeout(resolvePoll, 25));
      cleanup = !groupRemains()
        ? { status: "complete", scope: "private_process_group" }
        : { status: "unproven", scope: processGroup ? "private_process_group" : "direct_child", detail: error || "Could not establish that the task-owned process group exited after escalation." };
      // An escaped descendant or failed signal must not keep the recorder's
      // output pipes/event loop open indefinitely; report the bounded result.
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      finish();
    }, seconds * 1000);
    child.stdout.on("data", chunk => stdout.write(chunk));
    child.stderr.on("data", chunk => stderr.write(chunk));
    child.on("error", failure => { error = failure.message; });
    child.on("exit", (status, signal) => { exitStatus = status; exitSignal = signal; });
    child.on("close", (status, signal) => {
      closed = true; exitStatus = status; exitSignal = signal;
      if (!timedOut) { clearTimeout(timer); finish(); }
    });
  });
}

try {
  const args = process.argv.slice(2), separator = args.indexOf("--");
  if (separator !== 1 || args.length < 3) throw new Error("Usage: node record-acceptance.mjs <goal-root|state.yaml> -- <authorized-command> [args...]");
  const goal = resolve(args[0]), statePath = basename(goal) === "state.yaml" ? goal : join(goal, "state.yaml");
  const bytes = readFileSync(statePath);
  const check = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "check-goal-state.mjs"), statePath], { encoding: "utf8", timeout: 30000 });
  if (check.error || check.status !== 0 || JSON.parse(check.stdout).state_sha256 !== sha256(bytes)) throw new Error(`Repair/reload the board before recording acceptance: ${check.stdout || check.stderr}`);
  const before = acceptanceContext(statePath, bytes);
  if (before.board.goal.status !== "active" || before.board.active_task !== before.audit.id || before.audit.status !== "active" || before.audit.receipt != null) throw new Error("Run acceptance on the active final audit before its receipt/finalization; preserve historical receipts.");
  const command = args.slice(separator + 1);
  if (canonical(command) !== canonical(before.config.command)) throw new Error("Explicit command does not match the task's declared acceptance command; nothing was executed.");
  const started = new Date().toISOString();
  const observed = await run(before.launch.command, before.workspace, before.timeout);
  try {
    const after = acceptanceContext(statePath, bytes, before.audit.id);
    if (canonical(before.binding) !== canonical(after.binding)) observed.error = "Acceptance changed its outcome, validator, or declared inputs; evidence is stale.";
  } catch (failure) { observed.error = failure.message; }
  const proof = {
    version: 2, result: observed.exit_status === 0 && observed.signal === null && !observed.error && !observed.timed_out ? "pass" : "fail",
    command, binding: before.binding, recorded_board_sha256: sha256(bytes), timeout_seconds: before.timeout,
    started_at: started, finished_at: new Date().toISOString(), ...observed,
  };
  const proofPath = localPath(before.workspace, portable(relative(before.workspace, join(before.goalRoot, "notes", `acceptance-${before.audit.id}-${randomUUID()}.json`))));
  const serialized = `${JSON.stringify(proof, null, 2)}\n`;
  writeFileSync(proofPath, serialized, { flag: "wx" });
  let current = true;
  try { assertBoardRevision(statePath, bytes); } catch { current = false; }
  console.log(JSON.stringify({ ok: proof.result === "pass" && current, result: proof.result, error: current ? proof.error : "Board revision changed; preserve evidence and reload.", cleanup: proof.cleanup, proof_path: proofPath,
    audit_evidence: { acceptance_proof: portable(relative(before.goalRoot, proofPath)), acceptance_sha256: sha256(serialized) } }, null, 2));
  process.exitCode = proof.result === "pass" && current ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}

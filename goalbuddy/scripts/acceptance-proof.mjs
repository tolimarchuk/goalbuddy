import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, parseBoard, parseJson } from "./strict-data.mjs";
import { insidePath, localPath, portable, sha256, snapshotPaths } from "./file-snapshot.mjs";

export function assertBoardRevision(statePath, bytes) {
  if (!readFileSync(statePath).equals(Buffer.from(bytes))) throw new Error("Board revision changed during verification; retry against the current board.");
}

function subject(board, taskId) {
  const value = JSON.parse(JSON.stringify(board));
  delete value.goal.status;
  delete value.active_task;
  if (value.checks) { delete value.checks.last_verification; delete value.checks.dirty_fingerprint; }
  const audit = value.tasks.find(task => task.id === taskId);
  delete audit.status;
  delete audit.receipt;
  return value;
}

function packageScript(command) {
  // Deliberately small launcher grammar. Unknown configuration can redirect the
  // workspace or execution, so do not guess its arity or silently omit the script.
  let verb, script;
  for (let index = 1; index < command.length; index++) {
    const arg = command[index];
    if (arg === "--") {
      if (!verb) break;
      script ||= command[index + 1];
      break; // All remaining arguments belong to the script.
    }
    if (/^(?:-s|-q|--(?:silent|quiet|no-progress|no-color)(?:=(?:true|false))?)$/.test(arg)) continue;
    if (arg === "--loglevel" || arg.startsWith("--loglevel=")) {
      const level = arg === "--loglevel" ? command[++index] : arg.slice("--loglevel=".length);
      if (["silent", "error", "warn", "notice", "http", "info", "verbose", "silly"].includes(level)) continue;
      throw new Error("Unsupported package launcher loglevel; use an explicit supported command.");
    }
    if (arg.startsWith("-")) throw new Error(`Unsupported package launcher option ${arg}; use a direct local validator in the authorized workspace, or pass script arguments after --.`);
    if (!verb) {
      verb = arg;
      if (["run", "run-script"].includes(verb)) continue;
      if (!["test", "start", "stop", "restart"].includes(verb)) throw new Error("Package acceptance requires run/run-script or an explicit lifecycle script; use a direct local validator for other launcher forms.");
    }
    script ||= arg;
  }
  if (!script || script.startsWith("-")) throw new Error("Package acceptance requires an unambiguous script name.");
  return script;
}

function unresolvedEntry(detail) {
  throw new Error(`${detail} Use a direct local validator command with its concrete filename; declare additional dependencies in acceptance.inputs.`);
}

// Windows executable aliases ignore letter case; POSIX program names do not.
function nodeCommandName(executable, platform = process.platform) {
  const name = executable.split(/[\\/]/).at(-1);
  return (platform === "win32" ? /^node(?:\.exe)?$/i : /^node(?:\.exe)?$/).test(name);
}

// One literal shell command only, as used in package scripts. Quotes and escaped
// spaces are words, not separators. Only ASCII space/tab separate words;
// Unicode whitespace stays literal. Expansion/composition is deliberately absent.
export function literalCommand(text, platform = process.platform) {
  if (platform === "win32") return windowsLiteralCommand(text);
  const words = [];
  let word = "", quote = null, started = false;
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/[\r\n\0]/.test(char)) unresolvedEntry("Multiline package commands are unsupported.");
    if (quote === "'") { if (char === "'") quote = null; else word += char; continue; }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined || /[\r\n\0]/.test(next)) unresolvedEntry("Incomplete package-command escape.");
      // POSIX double quotes preserve backslashes except before these characters.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += char;
      else { word += next; index++; }
      started = true; continue;
    }
    if (char === quote) { quote = null; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; started = true; continue; }
    if (char === "$" || char === "`" || (!quote && /[;&|<>()*?\[\]{}~]/.test(char))) unresolvedEntry("Package-command expansion or composition is unsupported.");
    if (!quote && /[ \t]/.test(char)) { flush(); continue; }
    word += char; started = true;
  }
  if (quote) unresolvedEntry("Unclosed package-command quote.");
  flush();
  if (!words.length || words[0].includes("=")) unresolvedEntry("Package-command assignments or empty commands are unsupported.");
  return words;
}

// cmd.exe does not use POSIX single quotes or backslash escapes. Admit only
// whole literal words or whole double-quoted words, with no cmd expansion.
function windowsLiteralCommand(text) {
  if (/^[ \t]*"/.test(text)) unresolvedEntry("Native Windows npm scripts need an unquoted executable word such as node; quoted executable paths need direct Node argv.");
  if (/[\x00-\x08\x0a-\x1f%!'`$^&|<>()*?\[\]{}~;]/u.test(text)) unresolvedEntry("Unsupported native Windows package-command expansion, escaping, or composition.");
  const words = [];
  for (let index = 0; index < text.length;) {
    while (/[ \t]/.test(text[index] || "") && index < text.length) index++;
    if (index === text.length) break;
    let word = "";
    if (text[index] === '"') {
      index++;
      while (index < text.length && text[index] !== '"') word += text[index++];
      // A backslash before the closing quote has special argv meaning in Node.
      if (index === text.length || word.endsWith("\\")) unresolvedEntry("Unsupported native Windows package-command quote/escape.");
      index++;
      if (index < text.length && !/[ \t]/.test(text[index])) unresolvedEntry("Native Windows package-command quotes must enclose a whole word.");
    } else {
      while (index < text.length && !/[ \t]/.test(text[index])) {
        if (text[index] === '"') unresolvedEntry("Native Windows package-command quotes must enclose a whole word.");
        word += text[index++];
      }
      if (word.endsWith("\\")) unresolvedEntry("Unsupported native Windows package-command escape or directory operand.");
    }
    words.push(word);
  }
  if (!words.length || !words[0] || words[0].includes("=")) unresolvedEntry("Package-command assignments or empty commands are unsupported.");
  if (words[0].startsWith("@") || !nodeCommandName(words[0], "win32")) unresolvedEntry("Native Windows npm scripts must launch unquoted node or a path to node.exe; use direct argv for other local native executables.");
  return words;
}

const isPackageLauncher = command => /^(npm|pnpm|yarn)(\.cmd)?$/.test(basename(command[0]));

// Windows npm.cmd is not a native executable. Use this Node installation's npm
// JS entry with literal argv, and explicitly select the shell whose grammar we
// inspect. Other npm shims/managers need direct concrete Node argv recovery.
export function acceptanceLaunch(command, workspace) {
  if (process.platform !== "win32" || !isPackageLauncher(command)) return { command };
  if (!['npm', 'npm.cmd'].includes(command[0])) unresolvedEntry("Native Windows package acceptance supports the bundled npm launcher only.");
  const cli = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const shell = join(process.env.SystemRoot || "C:\\Windows", "System32/cmd.exe");
  if (!existsSync(cli) || !lstatSync(cli).isFile() || !existsSync(shell)) unresolvedEntry("Cannot establish bundled npm and native cmd.exe for acceptance.");
  // No shell handles these argv. Shell selection/workspace cannot be redirected
  // by a user/project npm config file; the declared launcher grammar rejects overrides.
  const argv = [process.execPath, cli, `--prefix=${workspace}`, "--global=false", "--workspaces=false", `--script-shell=${shell}`, ...command.slice(1)];
  return { command: argv, identity: { kind: "windows_bundled_npm", node: realpathSync.native(process.execPath), npm_cli: realpathSync.native(cli), npm_cli_sha256: sha256(readFileSync(cli)), argv, script_shell: realpathSync.native(shell) } };
}

function windowsScriptExecutable(executable, root, launch) {
  if (isAbsolute(executable) || /[\\/]/.test(executable)) {
    const path = resolve(root, executable);
    if (!existsSync(path) || !lstatSync(path).isFile()) unresolvedEntry("Native Windows package executable must name an exact file.");
    return path;
  }
  // npm prepends ancestor node_modules/.bin directories and its node-gyp bin.
  // Ask native where.exe to resolve that PATH (including cwd/PATHEXT), rather
  // than assuming that a literal `node` cannot be shadowed by a local shim.
  const bins = [];
  for (let dir = root;; dir = dirname(dir)) {
    bins.push(join(dir, "node_modules/.bin"));
    if (dirname(dir) === dir) break;
  }
  bins.push(resolve(dirname(launch.identity.npm_cli), "../node_modules/@npmcli/run-script/lib/node-gyp-bin"));
  const env = { ...process.env };
  const pathKeys = Object.keys(env).filter(key => /^path$/i.test(key));
  const paths = pathKeys.flatMap(key => env[key].split(delimiter));
  for (const key of pathKeys) delete env[key];
  env.PATH = [...bins, ...paths].join(delimiter);
  const located = spawnSync(join(dirname(launch.identity.script_shell), "where.exe"), [executable], { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  const first = located.stdout?.trim().split(/\r?\n/)[0];
  if (located.error || located.status !== 0 || !first || !existsSync(first)) unresolvedEntry("Cannot establish the native Windows package executable.");
  // Retain the lexical local path so source symlinks remain visible to snapshots.
  return first;
}

function localCommandFiles(command, root, launch) {
  const files = new Set();
  const local = value => {
    // Parent traversal can cross a source link before the OS resolves it.
    // Reject it rather than erase the link with lexical normalization.
    if (value.split(/[\\/]/).includes("..")) unresolvedEntry("An exact local command path cannot contain parent traversal.");
    const path = resolve(root, value);
    if (insidePath(root, path)) return path;
    // Absolute command paths can retain a different spelling of the workspace
    // (Windows 8.3 names, or a root directory alias). Resolve only the root
    // prefix; localPath must still inspect every source descendant for links.
    const parents = [];
    for (let parent = dirname(path);; parent = dirname(parent)) {
      parents.unshift(parent);
      if (dirname(parent) === parent) break;
    }
    // Outermost match matters: a link inside an aliased workspace back to its
    // root must remain a source link, not become another trusted root prefix.
    const alias = parents.find(parent => existsSync(parent) && realpathSync.native(parent) === root);
    return alias ? resolve(root, relative(alias, path)) : null;
  };
  const add = value => {
    if (typeof value !== "string" || !value || value.startsWith("-")) return false;
    const path = local(value);
    if (!path || !existsSync(path) || lstatSync(path).isDirectory()) return false;
    localPath(root, portable(relative(root, path)));
    files.add(portable(relative(root, path))); return true;
  };
  const nodeEntry = value => {
    if (!value) unresolvedEntry("Node needs a concrete entry point.");
    const path = local(value);
    if (!path) unresolvedEntry("Node entry point escapes the authorized workspace.");
    localPath(root, portable(relative(root, path)) || ".");
    // Bind exactly the file operand. Do not emulate Node's directory, main or
    // extension search (including a file that shadows a directory launch).
    if ((/[\\/]$/.test(value) && process.platform === "win32") || value.endsWith("/") || !existsSync(path) || !lstatSync(path).isFile()) unresolvedEntry(`Node entry point is not an exact local file: ${value}.`);
    add(path);
  };
  const collect = (argv, allowPackageLauncher = false, fromPackageScript = false) => {
    const addArguments = start => {
      for (const arg of argv.slice(start)) add(arg.includes("=") && arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1) : arg);
    };
    add(argv[0]);
    let executable = fromPackageScript && launch.identity ? windowsScriptExecutable(argv[0], root, launch) : argv[0];
    if (!executable.includes("/") && !isAbsolute(executable)) {
      for (const directory of (process.env.PATH || "").split(delimiter)) {
        const candidate = resolve(directory, executable);
        if (existsSync(candidate)) { executable = candidate; break; }
      }
    }
    if (process.platform === "win32" && !allowPackageLauncher && /\.(?:cmd|bat|sh)$/i.test(executable)) unresolvedEntry("Native Windows verification requires Node argv or an exact native executable, not a shell script.");
    const localExecutable = add(executable);
    const node = nodeCommandName(argv[0])
      || (existsSync(executable) && realpathSync.native(executable) === realpathSync.native(process.execPath));
    // Windows package admission already permits only Node; never let name
    // classification turn a different runtime into a generic executable.
    if (fromPackageScript && launch.identity && realpathSync.native(executable) !== realpathSync.native(process.execPath)) unresolvedEntry("Native Windows package Node is shadowed or differs from the recorder runtime.");
    if (!node) {
      addArguments(1);
      if (process.platform === "win32" && !allowPackageLauncher && !/\.(?:exe|com)$/i.test(executable)) unresolvedEntry("Native Windows verification requires Node argv or an exact native executable.");
      if (!localExecutable && !allowPackageLauncher) unresolvedEntry("Verification must launch Node, a supported package script, or an exact local executable.");
      return;
    }
    const printEqualsRecovery = "The Node --print= option is unsupported. Use separate --print <literal code> or --eval <literal code>, or node checks/run.mjs for a concrete validator.";
    let index = 1, inline = false;
    for (; index < argv.length; index++) {
      const arg = argv[index];
      if (["--no-warnings", "--trace-warnings"].includes(arg)) continue;
      if (arg === "--") { index++; break; }
      const inlineOption = ["-e", "--eval", "-p", "--print"].includes(arg);
      if (arg.startsWith("--print=") || (inlineOption && argv[index + 1]?.startsWith("--print="))) unresolvedEntry(printEqualsRecovery);
      // Literal inline code is already bound by argv/package metadata. Its
      // imports remain explicitly declared dependencies, not inferred entries.
      if (inlineOption) {
        if (typeof argv[index + 1] !== "string") unresolvedEntry("Missing literal Node inline code.");
        if (argv[index + 1].startsWith("-")) unresolvedEntry("Node inline verification needs a literal code operand; use --eval=<literal code> or node checks/run.mjs.");
        index++; inline = true;
        continue;
      }
      if (arg.startsWith("--eval=")) { inline = true; continue; }
      if (arg.startsWith("-")) {
        if (!inline) unresolvedEntry(`Unsupported Node entry-point option: ${arg}.`);
        // Keep the existing ordinary operand inference after inline code.
        if (arg.includes("=")) add(arg.slice(arg.indexOf("=") + 1));
        continue;
      }
      break;
    }
    if (inline) {
      // Unresolved post-inline option/operand pairs may still contain Node
      // options. Require an explicit -- before option-like argument data.
      const boundary = argv.indexOf("--", index);
      if (argv[index - 1] !== "--" && argv.slice(index, boundary < 0 ? argv.length : boundary).some(arg => arg.startsWith("--print="))) unresolvedEntry(printEqualsRecovery);
      addArguments(index);
    } else {
      nodeEntry(argv[index]);
      addArguments(index + 1);
    }
  };
  const packageLauncher = isPackageLauncher(command);
  collect(command, packageLauncher);
  // Common package launchers expose their local entry point in package.json.
  if (packageLauncher) {
    const pkg = parseJson(readFileSync(join(root, "package.json"), "utf8"));
    files.add("package.json");
    for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]) if (existsSync(join(root, name))) files.add(name);
    const script = packageScript(command);
    if (launch.identity && command.slice(1).some(arg => !/^[A-Za-z0-9_./:=+-]+$/.test(arg))) unresolvedEntry("Native Windows package launcher arguments must be literal option/script words.");
    if (typeof pkg.scripts?.[script] !== "string" || !pkg.scripts[script].trim()) throw new Error(`Package acceptance script ${script} must be explicitly declared in package.json; use a direct local validator for implicit launcher behavior.`);
    // Lifecycle hooks are also obvious local verification entry points. Binding
    // them conservatively is safe even when a launcher suppresses its hooks.
    for (const name of [`pre${script}`, script, `post${script}`]) {
      if (typeof pkg.scripts?.[name] === "string") collect(literalCommand(pkg.scripts[name]), false, true);
    }
  }
  return [...files].sort();
}

export function acceptanceContext(statePath, bytes, taskId) {
  statePath = realpathSync.native(statePath);
  const goalRoot = dirname(statePath);
  const board = parseBoard(Buffer.from(bytes).toString("utf8"));
  const audit = taskId ? board.tasks.find(task => task.id === taskId) : board.tasks.filter(task => ["judge", "pm"].includes(task.type)).at(-1);
  if (!audit || !["judge", "pm"].includes(audit.type)) throw new Error("Acceptance needs an existing final Judge/PM audit task.");
  const config = audit.acceptance;
  if (!config || !Array.isArray(config.command) || !config.command.length || config.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !config.command[0]
      || !Array.isArray(config.artifacts) || !config.artifacts.length || (config.inputs !== undefined && !Array.isArray(config.inputs))) {
    throw new Error("Missing task acceptance settings: exact command argv, artifacts, and optional local inputs.");
  }
  const timeout = config.timeout_seconds ?? 1200;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483) throw new Error("acceptance.timeout_seconds must be positive and at most 2147483.");
  if (config.max_age_seconds !== undefined && (!Number.isFinite(config.max_age_seconds) || config.max_age_seconds <= 0)) throw new Error("acceptance.max_age_seconds must be positive when supplied.");
  let workspace;
  if (config.workspace !== undefined) {
    if (typeof config.workspace !== "string" || !config.workspace) throw new Error("acceptance.workspace must name the authorized workspace relative to the goal directory.");
    workspace = realpathSync.native(resolve(goalRoot, config.workspace));
  } else {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: goalRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (git.error || git.status !== 0) throw new Error("Cannot establish acceptance workspace; non-Git goals must explicitly set task.acceptance.workspace.");
    workspace = realpathSync.native(git.stdout.trim());
  }
  if (!insidePath(workspace, goalRoot)) throw new Error("Goal must be inside the authorized acceptance workspace.");
  const launch = acceptanceLaunch(config.command, workspace);
  const code = localCommandFiles(config.command, workspace, launch);
  const taskInputs = (audit.inputs || []).filter(value => typeof value === "string" && existsSync(resolve(workspace, value)));
  const inputs = [...new Set([...config.artifacts, ...(config.inputs || []), ...taskInputs, ...code])].sort();
  const paths = inputs.map(path => {
    const absolute = localPath(workspace, path);
    if (insidePath(absolute, statePath) || insidePath(absolute, join(goalRoot, "notes"))) throw new Error(`Acceptance input includes mutable board/evidence controls: ${path}`);
    return absolute;
  });
  const snapshots = snapshotPaths(workspace, paths);
  if ([...snapshots.values()].some(entry => entry === null || JSON.parse(entry).type === "symlink")) throw new Error("Required acceptance inputs must exist and contain no symlinks.");
  const binding = {
    workspace, state_path: portable(relative(workspace, statePath)), task_id: audit.id,
    subject_sha256: sha256(canonical(subject(board, audit.id))),
    charter_sha256: sha256(readFileSync(localPath(goalRoot, "goal.md"))),
    ...(launch.identity ? { launcher: launch.identity } : {}),
    inputs, local_entry_points: code, inputs_sha256: sha256(canonical([...snapshots])),
  };
  assertBoardRevision(statePath, bytes);
  return { board, audit, config, timeout, workspace, goalRoot, binding, launch };
}

function validateOutput(output) {
  if (!output || typeof output.tail_base64 !== "string" || !Number.isSafeInteger(output.bytes) || output.bytes < 0
      || typeof output.truncated !== "boolean" || !/^[a-f0-9]{64}$/.test(output.sha256)) return false;
  const tail = Buffer.from(output.tail_base64, "base64");
  return tail.toString("base64") === output.tail_base64 && tail.length <= 65536
    && (output.truncated ? output.bytes > tail.length : output.bytes === tail.length && output.sha256 === sha256(tail));
}

export function checkAcceptanceProof(statePath, bytes) {
  try {
    const board = parseBoard(Buffer.from(bytes).toString("utf8"));
    const audit = board.tasks.filter(task => ["judge", "pm"].includes(task.type)).at(-1);
    const receipt = audit?.receipt;
    if (board.goal.status !== "done" || audit?.status !== "done" || receipt?.result !== "done" || !["complete", "done"].includes(receipt.decision) || receipt.full_outcome_complete !== true) throw new Error("Final audit must record full_outcome_complete: true and decision: complete.");
    for (const field of ["missing_evidence", "remaining_blockers", "contradictions", "blocked_tasks"]) if (receipt[field] != null && (!Array.isArray(receipt[field]) || receipt[field].length)) throw new Error(`Acceptance contradicts audit ${field}.`);
    const last = board.checks?.last_verification;
    if (last?.result !== "pass" || last.task !== audit.id) throw new Error("Acceptance contradicts missing/non-passing last_verification or its audit task.");
    for (const commands of [last.commands, receipt.commands]) if (commands !== undefined && (!Array.isArray(commands) || commands.some(command => command?.status !== "pass"))) throw new Error("Acceptance contradicts non-passing verification/audit commands.");
    if (typeof receipt.acceptance_proof !== "string" || !/^notes\/acceptance-[A-Za-z0-9_-]+\.json$/.test(receipt.acceptance_proof)) throw new Error("Missing final audit acceptance_proof; historical claims are unverified.");
    const proofPath = localPath(dirname(realpathSync.native(statePath)), receipt.acceptance_proof);
    const proofBytes = readFileSync(proofPath);
    const proof = parseJson(proofBytes.toString("utf8"));
    if (proof.version !== 2 || proof.result !== "pass" || proof.exit_status !== 0 || proof.signal !== null || proof.error !== null || proof.timed_out !== false
        || (proof.cleanup !== undefined && proof.cleanup?.status !== "not_required")
        || !validateOutput(proof.stdout) || !validateOutput(proof.stderr) || !/^[a-f0-9]{64}$/.test(proof.recorded_board_sha256)) throw new Error("Acceptance proof is failed, malformed, or missing required observed evidence.");
    if (receipt.acceptance_sha256 !== sha256(proofBytes)) throw new Error("Audit acceptance hash does not match the consumed evidence.");
    const context = acceptanceContext(statePath, bytes, audit.id);
    if (canonical(proof.command) !== canonical(context.config.command) || canonical(proof.binding) !== canonical(context.binding) || proof.timeout_seconds !== context.timeout) throw new Error("Acceptance proof is stale: outcome, task, validator, or declared inputs changed.");
    const start = typeof proof.started_at === "string" ? Date.parse(proof.started_at) : NaN;
    const end = typeof proof.finished_at === "string" ? Date.parse(proof.finished_at) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > Date.now()
        || (context.config.max_age_seconds && Date.now() - start > context.config.max_age_seconds * 1000)) throw new Error("Acceptance proof is stale or has invalid timestamps.");
    if (!readFileSync(proofPath).equals(proofBytes)) throw new Error("Acceptance proof changed while being read.");
    assertBoardRevision(statePath, bytes);
    return { ok: true, proof_path: proofPath, audit_task: audit.id };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

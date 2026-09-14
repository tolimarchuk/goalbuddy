#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "../..");
const canonicalProductName = "GoalBuddy";
const canonicalCliName = "goalbuddy";
const pluginName = "goalbuddy";
const canonicalSkillName = "goal-prep";
const canonicalSkillDirectory = "goalbuddy";
const legacyCliName = "goal-maker";
const legacySkillName = "goal-maker";
const legacyClaudeGoalCommandHashes = new Set([
  "586a0839302239858cce64f954666e8690c5ddef036e397adfd9456eed4738e2",
]);
const skillSource = join(packageRoot, canonicalSkillDirectory);
const claudePluginSource = join(packageRoot, "plugins", "goalbuddy");
const defaultMarketplaceSource = "tolimarchuk/goalbuddy";
const packageInfo = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const defaultCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const defaultClaudeHome = process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const requiredAgentFiles = [
  "goal_judge.toml",
  "goal_scout.toml",
  "goal_worker.toml",
];
const requiredClaudeAgentFiles = [
  "goal-scout.md",
  "goal-judge.md",
  "goal-worker.md",
];
const optionsWithValues = new Set([
  "--claude-home",
  "--codex-home",
  "--goal",
  "--host",
  "--port",
  "--source",
  "--target",
  "--task",
  "--board",
]);
const pathOptions = new Set(["--board", "--goal"]);

const args = process.argv.slice(2);
const command = args[0] === "--help" || args[0] === "-h"
  ? "help"
  : args[0] && !args[0].startsWith("-")
    ? args[0]
    : "default";
const invokedAs = invokedCommandName();

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  maybePrintLegacyNotice();
  switch (command) {
    case "default":
      if (installTargetMode() === "all") {
        await installEverywhere();
      } else if (installTargetMode() === "codex") {
        installPlugin();
      } else {
        await installClaudeAll();
      }
      break;
    case "install":
    case "update":
      if (wantsHelp()) {
        usage();
        break;
      }
      if (installTargetMode() === "all") {
        await installEverywhere();
      } else if (installTargetMode() === "codex") {
        installPlugin();
      } else {
        await installClaudeAll();
      }
      break;
    case "agents":
      if (wantsHelp()) {
        usage();
        break;
      }
      if (targetMode() === "codex") {
        installAgents();
      } else {
        installClaudeAgents();
      }
      break;
    case "doctor":
      if (wantsHelp()) {
        usage();
        break;
      }
      if (targetMode() === "codex") {
        doctor();
      } else {
        doctorClaude();
      }
      break;
    case "reset":
      if (wantsHelp()) {
        usage();
        break;
      }
      if (targetMode() === "codex") resetCodex();
      else resetClaude();
      break;
    case "check-update":
    case "update-check":
      checkUpdate();
      break;
    case "plugin":
      if (wantsHelp()) {
        pluginUsage();
        break;
      }
      plugin();
      break;
    case "board":
      await board();
      break;
    case "resume":
      if (wantsHelp()) {
        usage();
        break;
      }
      await resume();
      break;
    case "dispatch":
      if (wantsHelp()) {
        usage();
        break;
      }
      dispatchCli();
      break;
    case "receipt":
      if (wantsHelp()) {
        usage();
        break;
      }
      receiptCli();
      break;
    case "can-stop":
      if (wantsHelp()) {
        usage();
        break;
      }
      canStopCli();
      break;
    case "init":
      if (wantsHelp()) {
        usage();
        break;
      }
      initGoal();
      break;
    case "prompt":
      await prompt();
      break;
    case "parallel-plan":
      await parallelPlan();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      if (!hasFlag("--json")) usage();
      argumentError(`Unknown command: ${command}`);
  }
}

function invokedCommandName() {
  if (process.env.GOALBUDDY_INVOKED_AS) return process.env.GOALBUDDY_INVOKED_AS;
  return basename(process.argv[1] || "");
}

function invokedThroughLegacyName() {
  return invokedAs === legacyCliName;
}

function maybePrintLegacyNotice() {
  if (!invokedThroughLegacyName() || hasFlag("--json")) return;
  console.error(`${legacyCliName} has been rebranded to ${canonicalCliName}.`);
  console.error(`Use: npx ${canonicalCliName}`);
  console.error(`${legacyCliName} remains available temporarily for compatibility.`);
  console.error("");
}

function optionValue(name) {
  let value = null;
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        argumentError(`Missing value for ${name}`);
      }
      value = next;
      found = true;
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
      found = true;
    }
  }
  return found ? value : null;
}

function argumentError(message) {
  if (args.includes("--json")) {
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(2);
}

function hasFlag(name) {
  return args.includes(name);
}

function wantsHelp() {
  return hasFlag("--help") || hasFlag("-h");
}

function positional(index) {
  return positionalArgs()[index] || "";
}

function positionalArgs() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values;
}

/**
 * Resolve goal-related paths in raw args to absolute paths.
 * Child processes spawned with cwd=packageRoot cannot resolve
 * relative goal paths from the user's working directory.
 */
function resolveChildGoalArgs(rawArgs) {
  const out = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const joinedMatch = [...pathOptions].find((opt) => arg.startsWith(opt + "="));
    if (joinedMatch) {
      const value = arg.slice(joinedMatch.length + 1);
      out.push(`${joinedMatch}=${value ? resolve(value) : value}`);
    } else if (pathOptions.has(arg)) {
      out.push(arg);
      const value = rawArgs[++index] || "";
      out.push(value ? resolve(value) : value);
    } else if (optionsWithValues.has(arg)) {
      out.push(arg);
      out.push(rawArgs[++index] || "");
    } else if (!arg.startsWith("-")) {
      out.push(resolve(arg));
    } else {
      out.push(arg);
    }
  }
  return out;
}

function usage() {
  console.log(`${canonicalProductName} for Claude Code and Codex

Usage:
  ${canonicalCliName} [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--json]
  ${canonicalCliName} plugin install [--source <marketplace-source>] [--codex-home <path>] [--json]
  ${canonicalCliName} install [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--force] [--json]
  ${canonicalCliName} update [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--json]
  ${canonicalCliName} agents [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--force]
  ${canonicalCliName} doctor [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--goal-ready]
  ${canonicalCliName} reset [--target claude|codex] [--claude-home <path>] [--codex-home <path>] [--json]
  ${canonicalCliName} check-update [--json]
  ${canonicalCliName} board <docs/goals/slug> [--host <host>] [--port <port>] [--once] [--json]
  ${canonicalCliName} init <slug> [--title "<Goal title>"] [--json]
  ${canonicalCliName} resume [docs/goals/slug] [--json]
  ${canonicalCliName} dispatch <docs/goals/slug> --to codex|claude-code [--task T###] [--model <name>] [--timeout <seconds>] [--json]
  ${canonicalCliName} receipt <docs/goals/slug> --task T### --receipt <file> [--status done|blocked] [--activate T###|none] [--json]
  ${canonicalCliName} can-stop <docs/goals/slug> [--json]
  ${canonicalCliName} prompt <docs/goals/slug> [--task T###] [--board <path/to/state.yaml>] [--json]
  ${canonicalCliName} parallel-plan <docs/goals/slug> [--json]

Targets: by default, install/update prepares both Codex (~/.codex) and Claude Code (~/.claude). Use --target codex or --target claude to limit the command.

Default:
  ${canonicalCliName}                  Installs and enables Codex, then installs Claude Code skill + agents (skill surfaces /goal-prep).
  ${canonicalCliName} --target claude  Installs ${canonicalProductName} for Claude Code (skill + agents; skill surfaces /goal-prep).
  ${canonicalCliName} --target codex   Installs and enables the native Codex plugin.

Compatibility:
  ${legacyCliName} remains a temporary alias and prints the new npx command for human-facing use.

Environment:
  CODEX_HOME                         Overrides the default ~/.codex target.
  CLAUDE_HOME                        Overrides the default ~/.claude target (and selects Claude Code unless --target codex is set).
`);
}

function codexHome() {
  return resolve(optionValue("--codex-home") || defaultCodexHome);
}

function claudeHome() {
  return resolve(optionValue("--claude-home") || defaultClaudeHome);
}

function ensureResolvedHome(path, target) {
  try {
    if (existsSync(path) && !lstatSync(path).isDirectory()) {
      throw new Error(`${target} home is not a directory: ${path}`);
    }
    mkdirSync(path, { recursive: true });
    if (!lstatSync(path).isDirectory()) throw new Error(`${target} home is not a directory: ${path}`);
    return null;
  } catch (error) {
    return lifecycleResult({
      ok: false,
      action: lifecycleAction(),
      target,
      installModel: "none",
      proof: { state_source: path, checks: [{ name: "resolved-home", ok: false, detail: error.message }] },
      error: { code: "INVALID_HOME", message: error.message },
    });
  }
}

function lifecycleAction() {
  return command === "default" ? "install" : command;
}

function lifecycleResult({
  ok,
  action = lifecycleAction(),
  target,
  installModel,
  installedVersion = "",
  installedPath = "",
  proof,
  fallback = { used: false, reason: "" },
  error = null,
  warnings = [],
}) {
  return {
    ok,
    action,
    target,
    install_model: installModel,
    requested_version: packageInfo.version,
    installed_version: installedVersion,
    installed_path: installedPath,
    proof,
    fallback,
    error,
    warnings,
  };
}

function proofCheck(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail) };
}

function proofResult(stateSource, checks) {
  return { state_source: stateSource, checks };
}

function proofOk(proof) {
  return proof.checks.length > 0 && proof.checks.every((check) => check.ok);
}

function requestedTarget() {
  const raw = optionValue("--target");
  if (raw === null) return "";
  const value = raw.toLowerCase();
  if (value !== "codex" && value !== "claude") {
    argumentError(`Invalid --target: ${raw}. Use codex or claude.`);
  }
  return value;
}

function targetMode() {
  const value = requestedTarget();
  if (value) return value;
  // Explicit --claude-home or CLAUDE_HOME implies Claude target unless --target codex is set.
  if (optionValue("--claude-home") || process.env.CLAUDE_HOME) return "claude";
  return "codex";
}

function installTargetMode() {
  const value = requestedTarget();
  if (value) return value;

  const hasCodexHomeOption = Boolean(optionValue("--codex-home"));
  const hasClaudeHomeOption = Boolean(optionValue("--claude-home"));
  if (hasCodexHomeOption && !hasClaudeHomeOption) return "codex";
  if (hasClaudeHomeOption && !hasCodexHomeOption) return "claude";
  if (process.env.CLAUDE_HOME && !hasCodexHomeOption) return "claude";
  return "all";
}

function claudeSkillRoot() {
  return join(claudeHome(), "skills", canonicalSkillName);
}

function legacyClaudeSkillRoot() {
  return join(claudeHome(), "skills", canonicalSkillDirectory);
}

function claudeAgentsRoot() {
  return join(claudeHome(), "agents");
}

function legacyClaudeCommandPath() {
  return join(claudeHome(), "commands", "goal-prep.md");
}

function legacyClaudeGoalCommandPath() {
  return join(claudeHome(), "commands", "goal.md");
}

function claudePluginId() {
  return `${pluginName}@${pluginName}`;
}

function claudePluginsRoot() {
  const override = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  if (!override) return join(claudeHome(), "plugins");
  if (override === "~" || override.startsWith("~/")) return resolve(homedir() + override.slice(1));
  return resolve(override);
}

function claudeInstalledPluginsPath() {
  return join(claudePluginsRoot(), "installed_plugins.json");
}

function claudeKnownMarketplacesPath() {
  return join(claudePluginsRoot(), "known_marketplaces.json");
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function installedClaudePluginRecord() {
  const data = readJsonFile(claudeInstalledPluginsPath());
  const records = data?.plugins?.[claudePluginId()];
  if (!Array.isArray(records)) return null;
  return records.find((record) => record?.scope === "user") || records[0] || null;
}

function expectedClaudePluginCachePath() {
  return join(claudePluginsRoot(), "cache", pluginName, pluginName, packageInfo.version);
}

function claudeSpawnCommand(args, env) {
  if (process.platform !== "win32") return { file: "claude", args };
  const executable = resolveWindowsCommand("claude", env);
  if (!executable) return { file: "claude", args };
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    return {
      file: [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" "),
      args: [],
      shell: true,
    };
  }
  return { file: executable, args };
}

function runClaude(args) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome(), CLAUDE_HOME: claudeHome() };
  const spawned = claudeSpawnCommand(args, env);
  const result = spawnSync(spawned.file, spawned.args, {
    encoding: "utf8",
    env,
    shell: spawned.shell || false,
    timeout: 120000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function claudeCliAvailable() {
  if (process.env.GOALBUDDY_TEST_DISABLE_CLAUDE_CLI === "1") return false;
  return runClaude(["--version"]).ok;
}

function claudeLooseState() {
  const paths = [claudeSkillRoot(), legacyClaudeSkillRoot(), claudeGoalCommandPath(), legacyClaudeCommandPath()];
  paths.push(...requiredClaudeAgentFiles.map((file) => join(claudeAgentsRoot(), file)));
  return {
    present: paths.some((path) => existsSync(path)),
    paths: paths.filter((path) => existsSync(path)),
  };
}

function proofClaudePlugin() {
  const metadataPath = claudeInstalledPluginsPath();
  const record = installedClaudePluginRecord();
  const installPath = record?.installPath ? resolve(record.installPath) : "";
  const manifestPath = installPath ? join(installPath, ".claude-plugin", "plugin.json") : "";
  const manifest = manifestPath ? readJsonFile(manifestPath) : null;
  const skillPath = installPath ? join(installPath, "skills", canonicalSkillName) : "";
  const checks = [
    proofCheck("installed-metadata", Boolean(record), record ? metadataPath : `missing ${claudePluginId()} record`),
    proofCheck("install-path", Boolean(installPath && existsSync(installPath) && lstatSync(installPath).isDirectory()), installPath || "missing installPath"),
    proofCheck("exact-version", record?.version === packageInfo.version && manifest?.version === packageInfo.version, `metadata=${record?.version || "missing"}; manifest=${manifest?.version || "missing"}; expected=${packageInfo.version}`),
    proofCheck("goal-prep-payload", Boolean(skillPath && directoryMatches(skillPath, skillSource, installFingerprintExcludes())), skillPath || "missing install path"),
  ];
  for (const file of requiredClaudeAgentFiles) {
    const installed = installPath ? join(installPath, "agents", file) : "";
    checks.push(proofCheck(`agent:${file}`, fileMatches(installed, join(claudePluginSource, "agents", file)), installed || "missing install path"));
  }
  const installedCommand = installPath ? join(installPath, "commands", "goalbuddy.md") : "";
  checks.push(proofCheck("command:/goalbuddy", fileMatches(installedCommand, join(claudePluginSource, "commands", "goalbuddy.md")), installedCommand || "missing install path"));
  const proof = proofResult(metadataPath, checks);
  return { ok: proofOk(proof), proof, record, installPath };
}

function proofClaudeLoose() {
  const skillPath = claudeSkillRoot();
  const checks = [
    proofCheck("goal-prep-payload", directoryMatches(skillPath, skillSource, installFingerprintExcludes()), skillPath),
  ];
  for (const file of requiredClaudeAgentFiles) {
    const installed = join(claudeAgentsRoot(), file);
    checks.push(proofCheck(`agent:${file}`, fileMatches(installed, join(claudePluginSource, "agents", file)), installed));
  }
  checks.push(proofCheck("command:/goalbuddy", fileMatches(claudeGoalCommandPath(), join(claudePluginSource, "commands", "goalbuddy.md")), claudeGoalCommandPath()));
  const legacyGoal = legacyClaudeGoalCommandPath();
  const legacyGoalOwned = existsSync(legacyGoal) && fileIsLegacyGoalBuddyCommand(legacyGoal);
  checks.push(proofCheck("migration-state", !existsSync(legacyClaudeSkillRoot()) && !existsSync(legacyClaudeCommandPath()) && !legacyGoalOwned, existsSync(legacyGoal) && !legacyGoalOwned ? `preserved user file ${legacyGoal}` : "owned legacy paths absent"));
  const proof = proofResult(claudeHome(), checks);
  return { ok: proofOk(proof), proof, installedPath: claudeSkillRoot() };
}

function fileMatches(actual, expected) {
  return Boolean(actual && existsSync(actual) && existsSync(expected)
    && lstatSync(actual).isFile() && sha256(readFileSync(actual)) === sha256(readFileSync(expected)));
}

function directoryMatches(actual, expected, exclude = new Set()) {
  return Boolean(actual && existsSync(actual) && existsSync(expected)
    && lstatSync(actual).isDirectory()
    && directoryFingerprint(actual, { exclude }) === directoryFingerprint(expected, { exclude }));
}

function installClaudeSkill({ quiet = false } = {}) {
  const target = claudeSkillRoot();
  if (!existsSync(skillSource)) {
    console.error(`Skill payload not found: ${skillSource}`);
    process.exit(1);
  }

  const legacyTarget = legacyClaudeSkillRoot();
  const previousMetadata = readInstallMetadata(target) || readInstallMetadata(legacyTarget);
  const previousFingerprint = existsSync(target) ? directoryFingerprint(target, { exclude: installFingerprintExcludes() }) : "";

  mkdirSync(dirname(target), { recursive: true });
  atomicReplaceDirectory(skillSource, target, (staged) => writeInstallMetadata(staged, previousMetadata));

  const legacyRemoved = existsSync(legacyTarget);
  if (legacyRemoved) {
    rmSync(legacyTarget, { recursive: true, force: true });
    if (!quiet) console.log(`removed legacy ${legacyTarget} (skill now installs as ${canonicalSkillName})`);
  }

  const currentFingerprint = directoryFingerprint(target, { exclude: installFingerprintExcludes() });
  const status = previousFingerprint
    ? previousFingerprint === currentFingerprint ? "unchanged" : "updated"
    : "installed";
  if (!quiet) console.log(`Installed Claude Code ${canonicalProductName} skill to ${target}`);

  return {
    status,
    path: target,
    previous_version: previousMetadata?.package_version || "",
    current_version: packageInfo.version,
    removed_legacy_skill_path: legacyRemoved ? legacyTarget : "",
  };
}

function atomicReplaceDirectory(source, target, prepare = () => {}) {
  const parent = dirname(target);
  const nonce = `${process.pid}-${Date.now()}`;
  const staged = join(parent, `.${basename(target)}.goalbuddy-stage-${nonce}`);
  const backup = join(parent, `.${basename(target)}.goalbuddy-backup-${nonce}`);
  mkdirSync(parent, { recursive: true });
  try {
    cpSync(source, staged, { recursive: true, errorOnExist: true });
    prepare(staged);
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(staged, target);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

function installClaudeAgents({ quiet = false } = {}) {
  const source = join(claudePluginSource, "agents");
  const target = claudeAgentsRoot();
  const force = hasFlag("--force") || command === "update" || command === "install" || command === "default";
  mkdirSync(target, { recursive: true });

  const results = [];
  if (!existsSync(source)) return results;
  for (const file of readdirSync(source)) {
    if (!file.endsWith(".md")) continue;
    const dest = join(target, file);
    const sourceHash = sha256(readFileSync(join(source, file)));
    const previousHash = existsSync(dest) ? sha256(readFileSync(dest)) : "";
    if (existsSync(dest) && !force) {
      if (!quiet) console.log(`skip existing ${dest} (use --force to overwrite)`);
      results.push({ file, status: "skipped", path: dest });
      continue;
    }
    cpSync(join(source, file), dest);
    const status = previousHash ? previousHash === sourceHash ? "unchanged" : "updated" : "installed";
    if (!quiet) console.log(`installed ${dest}`);
    results.push({ file, status, path: dest });
  }
  return results;
}

function claudeGoalCommandPath() {
  return join(claudeHome(), "commands", "goalbuddy.md");
}

function installClaudeGoalCommand({ quiet = false } = {}) {
  const source = join(claudePluginSource, "commands", "goalbuddy.md");
  const target = claudeGoalCommandPath();
  if (!existsSync(source)) return { status: "missing_source", path: target };
  const sourceHash = sha256(readFileSync(source));
  const previousHash = existsSync(target) ? sha256(readFileSync(target)) : "";
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  const status = previousHash ? previousHash === sourceHash ? "unchanged" : "updated" : "installed";
  if (!quiet) console.log(`installed ${target}`);
  return { status, path: target };
}

function cleanupLegacyClaudeGoalCommand({ quiet = false } = {}) {
  const legacyPath = legacyClaudeGoalCommandPath();
  if (!existsSync(legacyPath)) {
    return { removed: false, preserved: false, owned_by_goalbuddy: false, path: legacyPath };
  }

  const ownedByGoalBuddy = fileIsLegacyGoalBuddyCommand(legacyPath);
  if (!ownedByGoalBuddy) {
    return { removed: false, preserved: true, owned_by_goalbuddy: false, path: legacyPath };
  }

  rmSync(legacyPath, { force: true });
  if (!quiet) console.log(`removed legacy ${legacyPath} (GoalBuddy now uses /goalbuddy)`);
  return { removed: true, preserved: false, owned_by_goalbuddy: true, path: legacyPath };
}

function fileIsLegacyGoalBuddyCommand(path) {
  try {
    return legacyClaudeGoalCommandHashes.has(sha256(readFileSync(path)));
  } catch {
    return false;
  }
}

function cleanupLegacyClaudeCommands({ quiet = false } = {}) {
  const legacyPath = legacyClaudeCommandPath();
  if (!existsSync(legacyPath)) return { removed: false, path: legacyPath };
  rmSync(legacyPath, { force: true });
  if (!quiet) console.log(`removed legacy ${legacyPath} (skill now surfaces /goal-prep)`);
  return { removed: true, path: legacyPath };
}

async function buildClaudeInstallReport() {
  const homeFailure = ensureResolvedHome(claudeHome(), "claude");
  if (homeFailure) return claudeFailureReport(homeFailure);

  const looseBefore = claudeLooseState();
  const pluginBefore = installedClaudePluginRecord();
  if (looseBefore.present && pluginBefore) {
    const result = lifecycleResult({
      ok: false,
      target: "claude",
      installModel: "conflict",
      proof: proofResult(claudeHome(), [proofCheck("single-install-model", false, "both Claude plugin metadata and loose files are present")]),
      error: { code: "MIXED_INSTALL_STATE", message: "Claude has both plugin and loose-file GoalBuddy state; resolve the conflict manually before continuing." },
    });
    return claudeFailureReport(result);
  }

  if (!looseBefore.present) {
    const native = installClaudeNative({ existingPlugin: Boolean(pluginBefore) });
    if (native.result.ok || pluginBefore) return native;
    const cleanup = removePartialClaudePlugin();
    if (!cleanup.ok) {
      native.result.error = { code: "PARTIAL_PLUGIN_STATE", message: "Claude native install was not proven and partial plugin state could not be proven absent." };
      return native;
    }
    return safeBuildClaudeLooseInstallReport({ fallbackReason: native.result.error?.message || "Claude native install was unavailable or unproven" });
  }

  return safeBuildClaudeLooseInstallReport();
}

function safeBuildClaudeLooseInstallReport(options = {}) {
  try {
    return buildClaudeLooseInstallReport(options);
  } catch (error) {
    const verified = proofClaudeLoose();
    const result = lifecycleResult({
      ok: false,
      target: "claude",
      installModel: "loose-files",
      installedVersion: verified.ok ? packageInfo.version : "",
      installedPath: verified.ok ? verified.installedPath : "",
      proof: verified.proof,
      fallback: { used: Boolean(options.fallbackReason), reason: options.fallbackReason || "" },
      error: { code: "LOOSE_COPY_FAILED", message: `Claude loose-file installation failed: ${error.message}` },
    });
    return claudeFailureReport(result);
  }
}

function installClaudeNative({ existingPlugin }) {
  const source = optionValue("--source") || defaultMarketplaceSource;
  const warnings = [];
  const previous = installedClaudePluginRecord();
  if (!claudeCliAvailable()) {
    const result = lifecycleResult({
      ok: false,
      target: "claude",
      installModel: "claude-cli",
      proof: proofResult(claudeInstalledPluginsPath(), [proofCheck("claude-cli", false, "claude CLI unavailable")]),
      error: { code: "CLI_UNAVAILABLE", message: "claude CLI is unavailable" },
      warnings,
    });
    return claudePluginReport(result, null, source, previous);
  }

  const marketplace = runClaude(["plugin", "marketplace", "add", source]);
  const marketplaceUpdate = marketplace.ok ? runClaude(["plugin", "marketplace", "update", pluginName]) : { ok: false, stdout: "", stderr: "marketplace add failed" };
  const operation = marketplace.ok
    ? runClaude(existingPlugin ? ["plugin", "update", claudePluginId(), "--scope", "user"] : ["plugin", "install", claudePluginId(), "--scope", "user"])
    : { ok: false, stdout: "", stderr: marketplace.stderr || marketplace.stdout };
  if (!marketplaceUpdate.ok) warnings.push(`Claude marketplace refresh did not complete: ${firstLine(marketplaceUpdate.stderr || marketplaceUpdate.stdout)}`);
  const verified = proofClaudePlugin();
  const ok = marketplace.ok && operation.ok && verified.ok;
  const error = ok ? null : {
    code: operation.ok ? "UNPROVEN_NATIVE_INSTALL" : "CLAUDE_CLI_FAILED",
    message: operation.ok
      ? "Claude CLI returned success but the exact installed plugin state was not proven."
      : `Claude CLI install/update failed: ${firstLine(operation.stderr || operation.stdout || marketplace.stderr || marketplace.stdout)}`,
  };
  const result = lifecycleResult({
    ok,
    target: "claude",
    installModel: "claude-cli",
    installedVersion: verified.record?.version || "",
    installedPath: verified.installPath,
    proof: verified.proof,
    error,
    warnings,
  });
  const cleanups = ok ? {
    legacy_goal_command_cleanup: cleanupLegacyClaudeGoalCommand({ quiet: true }),
    legacy_commands_cleanup: cleanupLegacyClaudeCommands({ quiet: true }),
  } : null;
  if (cleanups?.legacy_goal_command_cleanup.preserved) {
    warnings.push(`Preserved ${cleanups.legacy_goal_command_cleanup.path} because it is not GoalBuddy-authored.`);
    result.warnings = warnings;
  }
  return claudePluginReport(result, verified.record, source, previous, cleanups);
}

function removePartialClaudePlugin() {
  const before = installedClaudePluginRecord();
  const paths = new Set([expectedClaudePluginCachePath()]);
  if (before?.installPath) paths.add(resolve(before.installPath));
  const statePresent = Boolean(before) || [...paths].some((path) => existsSync(path));
  if (!statePresent) return { ok: true, detail: "no plugin metadata or expected cache path present" };
  if (!claudeCliAvailable()) return { ok: false, detail: "plugin metadata remains and claude CLI is unavailable" };
  const uninstall = runClaude(["plugin", "uninstall", claudePluginId(), "--scope", "user"]);
  const absent = !installedClaudePluginRecord();
  const pathsAbsent = [...paths].every((path) => !existsSync(path));
  return { ok: uninstall.ok && absent && pathsAbsent, detail: absent && pathsAbsent ? "plugin metadata and cache absent" : "plugin metadata or cache remains" };
}

function buildClaudeLooseInstallReport({ fallbackReason = "" } = {}) {
  const quiet = true;
  const report = {
    command,
    target: "claude",
    package: {
      name: packageInfo.name,
      current_version: packageInfo.version,
    },
    claude_home: claudeHome(),
    skill: installClaudeSkill({ quiet }),
    agents: installClaudeAgents({ quiet }),
    goal_command: installClaudeGoalCommand({ quiet }),
    legacy_goal_command_cleanup: cleanupLegacyClaudeGoalCommand({ quiet }),
    legacy_commands_cleanup: cleanupLegacyClaudeCommands({ quiet }),
    warnings: [],
  };

  report.package.previous_version = report.skill.previous_version;
  if (report.legacy_goal_command_cleanup.preserved) {
    report.warnings.push(
      `Preserved ${report.legacy_goal_command_cleanup.path} because it is not GoalBuddy-authored. Claude Code's native /goal may remain shadowed until you rename or remove that file.`,
    );
  }
  const verified = proofClaudeLoose();
  report.result = lifecycleResult({
    ok: verified.ok,
    target: "claude",
    installModel: "loose-files",
    installedVersion: verified.ok ? packageInfo.version : "",
    installedPath: verified.installedPath,
    proof: verified.proof,
    fallback: { used: Boolean(fallbackReason), reason: fallbackReason },
    error: verified.ok ? null : { code: "UNPROVEN_LOOSE_INSTALL", message: "Claude loose-file installation did not pass final-state proof." },
    warnings: report.warnings,
  });
  return report;
}

function claudePluginReport(result, record, source, previous = null, cleanups = null) {
  const installPath = record?.installPath || result.installed_path || "";
  return {
    command,
    target: "claude",
    mode: "plugin",
    package: { name: packageInfo.name, current_version: packageInfo.version, previous_version: previous?.version || "" },
    claude_home: claudeHome(),
    skill: record ? {
      status: previous ? "updated" : "installed",
      path: join(installPath, "skills", canonicalSkillName),
      previous_version: previous?.version || "",
      current_version: record.version || "",
      removed_legacy_skill_path: "",
    } : null,
    agents: record ? requiredClaudeAgentFiles.map((file) => ({ file, status: previous ? "updated" : "installed", path: join(installPath, "agents", file) })) : [],
    goal_command: record ? { status: previous ? "updated" : "installed", path: join(installPath, "commands", "goalbuddy.md") } : null,
    plugin: record ? {
      mode: "plugin",
      installed: result.ok,
      target: "claude",
      plugin: claudePluginId(),
      version: record.version || "",
      previous_version: previous?.version || "",
      claude_home: claudeHome(),
      marketplace_source: source,
      install_path: record.installPath || "",
      warnings: result.warnings,
    } : null,
    legacy_goal_command_cleanup: cleanups?.legacy_goal_command_cleanup || { removed: false, preserved: false, owned_by_goalbuddy: false, path: legacyClaudeGoalCommandPath() },
    legacy_commands_cleanup: cleanups?.legacy_commands_cleanup || { removed: false, path: legacyClaudeCommandPath() },
    loose_files: claudeLooseState().paths,
    warnings: result.warnings,
    result,
  };
}

function claudeFailureReport(result) {
  return {
    command,
    target: "claude",
    mode: result.install_model,
    package: { name: packageInfo.name, current_version: packageInfo.version, previous_version: "" },
    claude_home: claudeHome(),
    skill: null,
    agents: [],
    goal_command: null,
    warnings: result.warnings,
    result,
  };
}

async function installClaudeAll() {
  const report = await buildClaudeInstallReport();

  if (hasFlag("--json")) {
    printJson(report);
  } else {
    printClaudeInstallReport(report);
  }
  if (!report.result.ok) process.exit(1);
}

async function installEverywhere() {
  const report = {
    command,
    package: {
      name: packageInfo.name,
      current_version: packageInfo.version,
    },
    codex: null,
    claude: null,
    errors: [],
  };

  try {
    report.codex = installPlugin({ quiet: true });
    if (!report.codex.result?.ok) report.errors.push({ target: "codex", error: report.codex.result?.error?.message || "Codex install unproven" });
  } catch (error) {
    report.errors.push({ target: "codex", error: error.message });
    report.codex = {
      target: "codex",
      ok: false,
      error: error.message,
      result: lifecycleResult({
        ok: false,
        target: "codex",
        installModel: "none",
        proof: proofResult(codexHome(), [proofCheck("install-completed", false, error.message)]),
        error: { code: "INSTALL_FAILED", message: error.message },
      }),
    };
  }

  try {
    report.claude = await buildClaudeInstallReport();
    if (!report.claude.result?.ok) report.errors.push({ target: "claude", error: report.claude.result?.error?.message || "Claude install unproven" });
  } catch (error) {
    report.errors.push({ target: "claude", error: error.message });
    report.claude = {
      target: "claude",
      ok: false,
      error: error.message,
      result: lifecycleResult({
        ok: false,
        target: "claude",
        installModel: "none",
        proof: proofResult(claudeHome(), [proofCheck("install-completed", false, error.message)]),
        error: { code: "INSTALL_FAILED", message: error.message },
      }),
    };
  }

  report.ok = report.errors.length === 0 && report.codex?.result?.ok === true && report.claude?.result?.ok === true;

  if (hasFlag("--json")) {
    printJson(report);
  } else {
    printEverywhereInstallReport(report);
  }

  if (!report.ok) process.exit(1);
}

function doctorClaude() {
  const homeFailure = ensureResolvedHome(claudeHome(), "claude");
  if (homeFailure) {
    printJson({ target: "claude", claude_home: claudeHome(), result: { ...homeFailure, action: "doctor" } });
    process.exit(1);
  }
  const skillPath = join(claudeSkillRoot(), "SKILL.md");
  const agentsPath = claudeAgentsRoot();
  const installed = existsSync(skillPath);
  const agents = existsSync(agentsPath)
    ? readdirSync(agentsPath).filter((file) => file.startsWith("goal-") && file.endsWith(".md"))
    : [];
  const missingAgents = requiredClaudeAgentFiles.filter((file) => !agents.includes(file));
  const staleAgents = requiredClaudeAgentFiles.filter((file) => {
    const installedAgent = join(agentsPath, file);
    const bundledAgent = join(claudePluginSource, "agents", file);
    if (!existsSync(installedAgent) || !existsSync(bundledAgent)) return false;
    return sha256(readFileSync(installedAgent)) !== sha256(readFileSync(bundledAgent));
  });
  const legacyCommandPath = legacyClaudeCommandPath();
  const legacyCommandPresent = existsSync(legacyCommandPath);
  const legacySkillPath = legacyClaudeSkillRoot();
  const legacySkillPresent = existsSync(legacySkillPath);
  const goalCommandPath = claudeGoalCommandPath();
  const goalCommandPresent = existsSync(goalCommandPath);
  const legacyGoalCommandPath = legacyClaudeGoalCommandPath();
  const legacyGoalCommandPresent = existsSync(legacyGoalCommandPath);
  const legacyGoalCommandOwned = legacyGoalCommandPresent && fileIsLegacyGoalBuddyCommand(legacyGoalCommandPath);

  const loose = claudeLooseState();
  const plugin = installedClaudePluginRecord();
  let model = plugin ? "claude-cli" : loose.present ? "loose-files" : "none";
  let verified;
  let error = null;
  if (plugin && loose.present) {
    model = "conflict";
    verified = { ok: false, proof: proofResult(claudeHome(), [proofCheck("single-install-model", false, "both plugin and loose-file state present")]), installedPath: "", record: plugin };
    error = { code: "MIXED_INSTALL_STATE", message: "Claude has both plugin and loose-file GoalBuddy state." };
  } else if (plugin) {
    verified = proofClaudePlugin();
  } else if (loose.present) {
    verified = proofClaudeLoose();
  } else {
    verified = { ok: false, proof: proofResult(claudeHome(), [proofCheck("installed-state", false, "GoalBuddy is fully removed")]), installedPath: "", record: null };
    error = { code: "NOT_INSTALLED", message: "Claude GoalBuddy is fully removed." };
  }
  if (!verified.ok && !error) error = { code: "UNPROVEN_INSTALL", message: "Claude GoalBuddy installed state failed exact proof." };
  if (legacyGoalCommandPresent) {
    verified.proof.checks.push(proofCheck("native-goal-available", false, legacyGoalCommandOwned ? "owned legacy command remains" : "user-authored /goal command preserved"));
    verified.ok = false;
    if (!error) error = { code: "COMMAND_COLLISION", message: "Claude Code native /goal is shadowed by an existing command file." };
  }
  const result = lifecycleResult({
    ok: verified.ok,
    action: "doctor",
    target: "claude",
    installModel: model,
    installedVersion: verified.record?.version || (verified.ok && model === "loose-files" ? packageInfo.version : ""),
    installedPath: verified.installPath || verified.installedPath || "",
    proof: verified.proof,
    error,
    warnings: legacyGoalCommandPresent && !legacyGoalCommandOwned ? [`Preserved user-authored ${legacyGoalCommandPath}.`] : [],
  });

  console.log(JSON.stringify({
    target: "claude",
    claude_home: claudeHome(),
    skill_installed: installed,
    skill_path: skillPath,
    installed_agents: agents,
    missing_agents: missingAgents,
    stale_agents: staleAgents,
    goal_command_present: goalCommandPresent,
    goal_command_path: goalCommandPath,
    native_goal_available: !legacyGoalCommandPresent,
    legacy_goal_command_present: legacyGoalCommandPresent,
    legacy_goal_command_owned: legacyGoalCommandOwned,
    legacy_goal_command_path: legacyGoalCommandPath,
    legacy_command_present: legacyCommandPresent,
    legacy_command_path: legacyCommandPath,
    legacy_skill_present: legacySkillPresent,
    legacy_skill_path: legacySkillPath,
    result,
  }, null, 2));

  process.exit(result.ok ? 0 : 1);
}

function printClaudeInstallReport(report) {
  const verb = report.command === "update" ? "Updated" : "Installed";
  const previous = report.package.previous_version && report.package.previous_version !== report.package.current_version
    ? ` ${report.package.previous_version} -> ${report.package.current_version}`
    : ` ${report.package.current_version}`;
  console.log("");
  console.log(`${verb} ${canonicalProductName} for Claude Code${previous}`);
  console.log("");
  if (report.result?.install_model === "claude-cli") {
    console.log(`Plugin: ${report.result.ok ? "installed" : "not proven"} at ${report.result.installed_path || "unknown path"}`);
  } else if (report.skill) {
    console.log(`Skill: ${report.skill.status} at ${report.skill.path}`);
    console.log(`Agents: ${summarizeStatuses(report.agents)}`);
    console.log(`Command: /goalbuddy ${report.goal_command.status} at ${report.goal_command.path}`);
  } else {
    console.log(`Install: not completed (${report.result?.error?.message || "unknown error"})`);
  }
  if (report.legacy_goal_command_cleanup?.removed) {
    console.log(`Removed legacy GoalBuddy command: ${report.legacy_goal_command_cleanup.path}`);
  }
  if (report.legacy_commands_cleanup?.removed) {
    console.log(`Removed legacy command: ${report.legacy_commands_cleanup.path}`);
  }
  for (const warning of report.warnings) console.log(`Warning: ${warning}`);
  console.log("");
  console.log("Next:");
  console.log(`  Restart Claude Code, then run: /goal-prep`);
  console.log(`  Or invoke the skill: ${canonicalSkillName}`);
  console.log("");
  console.log("Also available for Codex:");
  console.log(`  npx ${canonicalCliName} --target codex`);
}

function installSkill({ force = true, quiet = false } = {}) {
  const target = installedSkillRoot();
  const legacyTarget = legacyInstalledSkillRoot();
  if (!existsSync(skillSource)) {
    console.error(`Skill payload not found: ${skillSource}`);
    process.exit(1);
  }

  const previousMetadata = readInstallMetadata(target) || readInstallMetadata(legacyTarget);
  const previousFingerprint = existsSync(target) ? directoryFingerprint(target, { exclude: installFingerprintExcludes() }) : "";

  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (!force) {
      console.error(`Refusing to overwrite existing skill: ${target}`);
      console.error("Use --force to overwrite.");
      process.exit(1);
    }
    rmSync(target, { recursive: true, force: true });
  }

  cpSync(skillSource, target, {
    recursive: true,
  });
  writeInstallMetadata(target, previousMetadata);

  mkdirSync(dirname(legacyTarget), { recursive: true });
  rmSync(legacyTarget, { recursive: true, force: true });
  mkdirSync(legacyTarget, { recursive: true });
  writeFileSync(join(legacyTarget, "SKILL.md"), compatibilitySkillBody());
  writeInstallMetadata(legacyTarget, previousMetadata);

  const currentFingerprint = directoryFingerprint(target, { exclude: installFingerprintExcludes() });
  const status = previousFingerprint
    ? previousFingerprint === currentFingerprint ? "unchanged" : "updated"
    : "installed";
  if (!quiet) console.log(`Installed Codex ${canonicalProductName} skill to ${target}`);

  return {
    status,
    path: target,
    compatibility_path: legacyTarget,
    previous_version: previousMetadata?.package_version || "",
    current_version: packageInfo.version,
  };
}

function compatibilitySkillBody() {
  return `---
name: ${legacySkillName}
description: Compatibility alias for GoalBuddy. Use $${canonicalSkillName} as the canonical skill.
---

# GoalBuddy Compatibility Alias

$${legacySkillName} is the previous name for $${canonicalSkillName}.

Use $${canonicalSkillName} for new work. This compatibility skill exists so older prompts and local installs do not fail after the rebrand.

When invoked through $${legacySkillName}:

1. Tell the user Goal Maker has been rebranded to GoalBuddy.
2. Show the canonical command: $${canonicalSkillName}.
3. If the user wants to continue immediately, follow the same workflow as $${canonicalSkillName}: run diagnostic intake, create or repair \`docs/goals/<slug>/goal.md\` and \`state.yaml\`, preserve one active task, and print the matching execution commands for Codex (\`/goal Follow docs/goals/<slug>/goal.md.\`) and Claude Code (\`/goalbuddy Follow docs/goals/<slug>/goal.md.\`) without starting either automatically.

This alias has the same invocation boundary as \`$${canonicalSkillName}\`: prepare the board only. Do not use or refresh named skills, inspect implementation files, browse references, research, generate assets, or perform the requested work until the user starts the printed \`/goal\` command.
`;
}

function installAgents({ quiet = false } = {}) {
  const source = join(skillSource, "agents");
  const target = join(codexHome(), "agents");
  const force = hasFlag("--force") || command === "update" || command === "install" || command === "default" || command === "plugin";
  mkdirSync(target, { recursive: true });

  const results = [];
  for (const file of readdirSync(source)) {
    if (!file.startsWith("goal_") || !file.endsWith(".toml")) continue;
    const dest = join(target, file);
    const sourceHash = sha256(readFileSync(join(source, file)));
    const previousHash = existsSync(dest) ? sha256(readFileSync(dest)) : "";
    if (existsSync(dest) && !force) {
      if (!quiet) console.log(`skip existing ${dest} (use --force to overwrite)`);
      results.push({ file, status: "skipped", path: dest });
      continue;
    }
    cpSync(join(source, file), dest);
    const status = previousHash ? previousHash === sourceHash ? "unchanged" : "updated" : "installed";
    if (!quiet) console.log(`installed ${dest}`);
    results.push({ file, status, path: dest });
  }
  return results;
}

async function installAll() {
  const quiet = true;
  const report = {
    command,
    package: {
      name: packageInfo.name,
      current_version: packageInfo.version,
    },
    codex_home: codexHome(),
    skill: installSkill({ force: true, quiet }),
    agents: installAgents({ quiet }),
    warnings: [],
  };

  report.package.previous_version = report.skill.previous_version;

  if (hasFlag("--json")) {
    printJson(report);
  } else {
    printInstallReport(report);
  }
}

function doctor() {
  const homeFailure = ensureResolvedHome(codexHome(), "codex");
  if (homeFailure) {
    printJson({ codex_home: codexHome(), result: { ...homeFailure, action: "doctor" } });
    process.exit(1);
  }
  const skillPath = join(installedSkillRoot(), "SKILL.md");
  const legacySkillPath = join(legacyInstalledSkillRoot(), "SKILL.md");
  const plugin = installedCodexPlugin();
  const agentsPath = join(codexHome(), "agents");
  const installed = existsSync(skillPath);
  const legacyInstalled = existsSync(legacySkillPath);
  const agents = existsSync(agentsPath)
    ? readdirSync(agentsPath).filter((file) => file.startsWith("goal_") && file.endsWith(".toml"))
    : [];
  const installSurfacePresent = plugin.skill_installed || installed || legacyInstalled;
  const residualAgents = installSurfacePresent ? [] : agents.filter((file) => requiredAgentFiles.includes(file));
  const missingAgents = installSurfacePresent || residualAgents.length > 0
    ? requiredAgentFiles.filter((file) => !agents.includes(file))
    : [];
  const staleAgents = requiredAgentFiles.filter((file) => {
    const installedAgent = join(agentsPath, file);
    const bundledAgent = join(skillSource, "agents", file);
    if (!existsSync(installedAgent) || !existsSync(bundledAgent)) return false;
    return sha256(readFileSync(installedAgent)) !== sha256(readFileSync(bundledAgent));
  });
  const runtimeState = codexInstallState({
    plugin,
    installed,
    legacyInstalled,
    residualAgents,
    missingAgents,
    staleAgents,
  });
  const goalRuntime = codexGoalRuntimeStatus();
  const warnings = [];
  const errors = [];
  if (!goalRuntime.ready) {
    warnings.push("native Codex /goal runtime is not ready; run `codex login` and `codex features enable goals` before using /goal.");
  }
  if (runtimeState === "fully-removed") {
    errors.push("Codex GoalBuddy is fully removed; run `npx goalbuddy --target codex` to install.");
  } else if (runtimeState === "residual-agents-only") {
    errors.push(`Residual GoalBuddy Codex agents remain without plugin cache/config: ${residualAgents.join(", ")}; run a GoalBuddy reset/cleanup before treating it as removed.`);
  } else if (!plugin.skill_installed && !installed) {
    errors.push("Codex GoalBuddy plugin is not installed; run `npx goalbuddy --target codex`.");
  }
  if (plugin.skill_installed && !plugin.enabled) {
    errors.push("Codex GoalBuddy plugin cache exists but is not enabled in config.toml; run `npx goalbuddy --target codex`.");
  }
  for (const file of missingAgents) {
    errors.push(`Missing GoalBuddy Codex agent: ${file}; run \`npx goalbuddy --target codex\`.`);
  }
  for (const file of staleAgents) {
    errors.push(`Stale GoalBuddy Codex agent: ${file}; run \`npx goalbuddy update --target codex\`.`);
  }
  if (hasFlag("--goal-ready") && !goalRuntime.ready) {
    errors.push("Native Codex /goal runtime is not ready. GoalBuddy $goal-prep and local boards are separate from OpenAI-gated native /goal.");
  }

  const exact = proofCodexInstall(packageInfo.version);
  if (hasFlag("--goal-ready")) {
    exact.proof.checks.push(proofCheck("native-goal-ready", goalRuntime.ready, goalRuntime.login_status || "native goal runtime unavailable"));
    exact.ok = proofOk(exact.proof);
  }
  const result = lifecycleResult({
    ok: exact.ok && errors.length === 0,
    action: "doctor",
    target: "codex",
    installModel: plugin.skill_installed ? readCodexInstallModel() : installed ? "bundled-copy" : "none",
    installedVersion: plugin.version || (installed ? packageInfo.version : ""),
    installedPath: plugin.cache_path || (installed ? installedSkillRoot() : ""),
    proof: exact.proof,
    error: exact.ok && errors.length === 0 ? null : { code: runtimeState === "fully-removed" ? "NOT_INSTALLED" : "UNPROVEN_INSTALL", message: errors[0] || "Codex GoalBuddy installed state failed exact proof." },
    warnings,
  });

  console.log(JSON.stringify({
    codex_home: codexHome(),
    codex_install_model: "plugin",
    expected_state: {
      plugin_cache: true,
      bundled_skill: "$goal-prep",
      standalone_personal_skill: false,
      compatibility_skill: false,
      agents: requiredAgentFiles,
      native_goal: "separate OpenAI-gated Codex feature",
    },
    plugin,
    skill_installed: installed,
    skill_path: skillPath,
    compatibility_skill_installed: legacyInstalled,
    compatibility_skill_path: legacySkillPath,
    runtime_state: runtimeState,
    installed_agents: agents,
    residual_agents: residualAgents,
    missing_agents: missingAgents,
    stale_agents: staleAgents,
    goal_runtime: goalRuntime,
    warnings,
    errors,
    result,
  }, null, 2));

  const pluginOk = plugin.skill_installed && plugin.enabled;
  const legacySkillOk = installed;
  const installOk = (pluginOk || legacySkillOk) && missingAgents.length === 0 && staleAgents.length === 0;
  const goalReadyOk = !hasFlag("--goal-ready") || goalRuntime.ready;
  process.exit(result.ok && installOk && goalReadyOk ? 0 : 1);
}

function codexInstallState({ plugin, installed, legacyInstalled, residualAgents, missingAgents, staleAgents }) {
  if (residualAgents.length > 0 && !plugin.skill_installed && !installed && !legacyInstalled) {
    return "residual-agents-only";
  }
  if (!plugin.skill_installed && !installed && !legacyInstalled) {
    return "fully-removed";
  }
  if (staleAgents.length > 0) return "stale-agents";
  if (missingAgents.length > 0) return "incomplete";
  if (plugin.skill_installed && !plugin.enabled) return "disabled";
  if ((plugin.skill_installed && plugin.enabled) || installed) return "installed";
  return "incomplete";
}

function checkUpdate() {
  const report = updateReport();

  if (hasFlag("--json")) {
    printJson(report);
    return;
  }

  if (report.check_status !== "ok") {
    console.log(`GoalBuddy update check unavailable: ${report.error}`);
  } else if (report.update_available) {
    console.log(`GoalBuddy ${report.latest_version} is available; installed version is ${report.current_version}.`);
    console.log(`Update with: ${report.update_command}`);
  } else {
    console.log(`GoalBuddy is up to date (${report.current_version}).`);
  }
}

function updateReport() {
  const report = {
    package: packageInfo.name,
    current_version: normalizeVersion(packageInfo.version),
    latest_version: null,
    update_available: false,
    check_status: "unknown",
    update_command: detectUpdateCommand(),
  };

  try {
    report.latest_version = latestPublishedVersion();
    report.update_available = compareVersions(report.current_version, report.latest_version) < 0;
    report.check_status = "ok";
  } catch (error) {
    report.check_status = "unavailable";
    report.error = error.message;
  }

  return report;
}

function detectUpdateCommand() {
  if (process.env.GOALBUDDY_TEST_UPDATE_COMMAND) return process.env.GOALBUDDY_TEST_UPDATE_COMMAND;
  if (process.env.CLAUDE_PLUGIN_ROOT || normalizedPath(__dirname).includes("/.claude/")) return `/plugin update ${pluginName}@${pluginName}`;

  const userAgent = process.env.npm_config_user_agent || "";
  if (/^pnpm\//.test(userAgent)) return `pnpm update -g ${canonicalCliName}`;
  if (/^bun\//.test(userAgent)) return `bun update -g ${canonicalCliName}`;
  if (process.env.MISE_EXE || process.env.MISE_SHELL || process.env.MISE_PROJECT_ROOT) return `mise upgrade npm:${canonicalCliName}`;
  if (/^npm\//.test(userAgent)) return `npx ${canonicalCliName}@latest`;

  return `use the install channel that installed ${canonicalProductName}`;
}

function normalizedPath(path) {
  return String(path).replace(/\\/g, "/");
}

function plugin() {
  const subcommand = positional(1) || "";
  if (wantsHelp()) {
    pluginUsage();
    return;
  }
  switch (subcommand) {
    case "install":
      installPlugin();
      break;
    case "help":
    case "--help":
    case "-h":
      pluginUsage();
      break;
    default:
      console.error(`Unknown plugin command: ${subcommand || "<missing>"}`);
      pluginUsage();
      process.exit(2);
  }
}

function pluginUsage() {
  console.log(`${canonicalProductName} Plugin

Usage:
  ${canonicalCliName} plugin install [--source <marketplace-source>] [--codex-home <path>] [--json]

Default source:
  tolimarchuk/goalbuddy
`);
}

function installPlugin({ quiet = false } = {}) {
  const source = optionValue("--source") || defaultMarketplaceSource;
  const pluginSource = join(packageRoot, "plugins", pluginName);
  const pluginManifestPath = join(pluginSource, ".codex-plugin", "plugin.json");
  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Plugin manifest not found: ${pluginManifestPath}`);
  }

  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  const pluginCachePath = pluginCacheRoot(pluginManifest.version);
  const homeFailure = ensureResolvedHome(codexHome(), "codex");
  if (homeFailure) {
    const failed = codexLegacyReport({ source, pluginManifest, pluginCachePath, result: homeFailure });
    if (hasFlag("--json") && !quiet) printJson(failed);
    if (!quiet) process.exitCode = 1;
    return failed;
  }

  let nativeReason = "";
  let nativeUsed = false;
  let protectedCachePaths;
  try {
    protectedCachePaths = inspectCodexCache(pluginManifest.version);
  } catch (error) {
    const result = lifecycleResult({
      ok: false,
      target: "codex",
      installModel: "none",
      proof: proofResult(codexHome(), [proofCheck("cache-inspection", false, error.message)]),
      error: { code: "CACHE_INSPECTION_FAILED", message: `Codex cache safety could not be proven; no installation attempted: ${error.message}` },
    });
    return finishCodexInstallReport(codexLegacyReport({ source, pluginManifest, pluginCachePath, result }), quiet);
  }
  if (protectedCachePaths.length) {
    nativeReason = `Native Codex install skipped to preserve cache entries: ${protectedCachePaths.join(", ")}`;
  }
  const cli = protectedCachePaths.length ? { ok: false } : runCodex(["--version"]);
  if (cli.ok) {
    nativeUsed = true;
    const marketplace = runCodex(["plugin", "marketplace", "add", source]);
    if (marketplace.ok) runCodex(["plugin", "marketplace", "upgrade", pluginName]);
    const installed = marketplace.ok
      ? runCodex(["plugin", "add", `${pluginName}@${pluginName}`])
      : { ok: false, stdout: "", stderr: marketplace.stderr || marketplace.stdout };
    if (installed.ok) installAgents({ quiet: true });
    const proof = proofCodexInstall(pluginManifest.version);
    if (marketplace.ok && installed.ok && proof.ok) {
      writeCodexInstallModel("codex-cli", proof.installedPath);
      const removedLegacySkillPaths = cleanupLegacyCodexSkills();
      const report = codexLegacyReport({
        source,
        pluginManifest,
        pluginCachePath: proof.installedPath,
        agents: describeInstalledCodexAgents(),
        removedLegacySkillPaths,
        removedStaleVersionPaths: [],
        result: lifecycleResult({
          ok: true,
          target: "codex",
          installModel: "codex-cli",
          installedVersion: pluginManifest.version,
          installedPath: proof.installedPath,
          proof: proof.proof,
        }),
      });
      return finishCodexInstallReport(report, quiet);
    }
    nativeReason = installed.ok
      ? "Codex CLI returned success but exact installed state was not proven"
      : `Codex CLI installation failed: ${firstLine(installed.stderr || installed.stdout || marketplace.stderr || marketplace.stdout)}`;
  } else if (!nativeReason) {
    nativeReason = "codex CLI unavailable";
  }

  try {
    atomicReplaceDirectory(pluginSource, pluginCachePath);
  } catch (error) {
    const existing = proofCodexInstall(pluginManifest.version);
    const result = lifecycleResult({
      ok: false,
      target: "codex",
      installModel: "bundled-copy",
      installedVersion: existing.ok ? pluginManifest.version : "",
      installedPath: existing.ok ? existing.installedPath : "",
      proof: existing.proof,
      fallback: { used: true, reason: nativeReason || "native install unavailable" },
      error: { code: "BUNDLED_COPY_FAILED", message: `Codex bundled-copy fallback failed: ${error.message}` },
    });
    return finishCodexInstallReport(codexLegacyReport({ source, pluginManifest, pluginCachePath, result }), quiet);
  }
  const removedStaleVersionPaths = pruneStalePluginVersions(pluginManifest.version);
  const removedLegacySkillPaths = cleanupLegacyCodexSkills();
  const configPath = enablePluginConfig();
  const agents = installAgents({ quiet: true });
  const verified = proofCodexInstall(pluginManifest.version);
  const result = lifecycleResult({
    ok: verified.ok,
    target: "codex",
    installModel: "bundled-copy",
    installedVersion: verified.ok ? pluginManifest.version : "",
    installedPath: verified.installedPath,
    proof: verified.proof,
    fallback: { used: true, reason: nativeReason || (nativeUsed ? "native install unproven" : "native install unavailable") },
    error: verified.ok ? null : { code: "UNPROVEN_BUNDLED_INSTALL", message: "Codex bundled-copy fallback did not pass final-state proof." },
  });
  if (result.ok) writeCodexInstallModel("bundled-copy", verified.installedPath);

  const report = {
    installed: true,
    target: "codex",
    plugin: `${pluginName}@${pluginName}`,
    version: pluginManifest.version,
    codex_home: codexHome(),
    marketplace_source: source,
    cache_path: pluginCachePath,
    config_path: configPath,
    agents,
    removed_legacy_skill_paths: removedLegacySkillPaths,
    removed_stale_version_paths: removedStaleVersionPaths,
    result,
  };

  return finishCodexInstallReport(report, quiet);
}

function finishCodexInstallReport(report, quiet) {
  if (hasFlag("--json") && !quiet) {
    printJson(report);
    if (!report.result.ok) process.exitCode = 1;
    return report;
  }
  if (quiet) return report;

  if (!report.result.ok) {
    console.error(`${canonicalProductName} Codex installation failed (${report.result.error.code}): ${report.result.error.message}`);
    console.error(`Codex home: ${report.codex_home}`);
    console.error("Review the reported cause and existing files before retrying.");
    process.exitCode = 1;
    return report;
  }

  console.log(`Installed ${canonicalProductName} Codex plugin ${report.version}`);
  console.log(`Marketplace: ${report.marketplace_source}`);
  console.log(`Cache: ${report.cache_path}`);
  console.log(`Config: ${report.config_path}`);
  console.log(`Agents: ${summarizeStatuses(report.agents)}`);
  if (report.removed_legacy_skill_paths.length) {
    console.log(`Removed legacy personal skills: ${report.removed_legacy_skill_paths.join(", ")}`);
  }
  if (report.removed_stale_version_paths.length) {
    console.log(`Removed stale plugin versions: ${report.removed_stale_version_paths.join(", ")}`);
  }
  console.log("");
  console.log("Restart Codex, then use:");
  console.log(`  $${canonicalSkillName}`);
  console.log("");
  console.log("Goal surface:");
  console.log(`  npx ${canonicalCliName} board docs/goals/<slug>`);
  return report;
}

function codexLegacyReport({ source, pluginManifest, pluginCachePath, agents = [], removedLegacySkillPaths = [], removedStaleVersionPaths = [], result }) {
  return {
    installed: result.ok,
    target: "codex",
    plugin: `${pluginName}@${pluginName}`,
    version: result.installed_version || pluginManifest.version,
    codex_home: codexHome(),
    marketplace_source: source,
    cache_path: pluginCachePath,
    config_path: join(codexHome(), "config.toml"),
    agents,
    removed_legacy_skill_paths: removedLegacySkillPaths,
    removed_stale_version_paths: removedStaleVersionPaths,
    result,
  };
}

function describeInstalledCodexAgents() {
  return requiredAgentFiles.map((file) => ({ file, status: "unchanged", path: join(codexHome(), "agents", file) }));
}

function codexInstallModelPath() {
  return join(pluginCacheOwnerRoot(), ".goalbuddy-install-model.json");
}

function writeCodexInstallModel(model, installedPath) {
  mkdirSync(pluginCacheOwnerRoot(), { recursive: true });
  writeFileAtomic(codexInstallModelPath(), `${JSON.stringify({ model, version: packageInfo.version, installed_path: installedPath }, null, 2)}\n`);
}

function readCodexInstallModel() {
  const state = readJsonFile(codexInstallModelPath());
  if (!state || !["codex-cli", "bundled-copy"].includes(state.model)) return "bundled-copy";
  if (state.version !== packageInfo.version || resolve(state.installed_path || "") !== pluginCacheRoot(packageInfo.version)) return "bundled-copy";
  return state.model;
}

function proofCodexInstall(expectedVersion) {
  const installedPath = pluginCacheRoot(expectedVersion);
  const manifestPath = join(installedPath, ".codex-plugin", "plugin.json");
  const manifest = readJsonFile(manifestPath);
  const checks = [
    proofCheck("resolved-home", existsSync(codexHome()) && lstatSync(codexHome()).isDirectory(), codexHome()),
    proofCheck("exact-cache-version", existsSync(installedPath) && lstatSync(installedPath).isDirectory(), installedPath),
    proofCheck("matching-manifest", manifest?.name === pluginName && manifest?.version === expectedVersion, `manifest=${manifest?.name || "missing"}@${manifest?.version || "missing"}; expected=${pluginName}@${expectedVersion}`),
    proofCheck("goal-prep-payload", directoryMatches(join(installedPath, "skills", canonicalSkillName), skillSource, installFingerprintExcludes()), join(installedPath, "skills", canonicalSkillName)),
    proofCheck("enabled-config", pluginConfigEnabled(join(codexHome(), "config.toml")), join(codexHome(), "config.toml")),
  ];
  for (const file of requiredAgentFiles) {
    const installed = join(codexHome(), "agents", file);
    checks.push(proofCheck(`agent:${file}`, fileMatches(installed, join(skillSource, "agents", file)), installed));
  }
  const proof = proofResult(codexHome(), checks);
  return { ok: proofOk(proof), proof, installedPath };
}

function legacyCodexSkillRoots() {
  return [installedSkillRoot(), legacyInstalledSkillRoot()];
}

function cleanupLegacyCodexSkills() {
  const removed = [];
  for (const path of legacyCodexSkillRoots()) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

function resetCodex() {
  const homeFailure = ensureResolvedHome(codexHome(), "codex");
  if (homeFailure) {
    const report = { reset: false, target: "codex", codex_home: codexHome(), result: { ...homeFailure, action: "reset" } };
    if (hasFlag("--json")) printJson(report);
    else console.error(homeFailure.error.message);
    process.exitCode = 1;
    return report;
  }
  // An agent name alone does not prove ownership after a user edits its contents.
  // Refuse the whole reset before changing config or cache so recovery stays intact.
  const preservedFiles = requiredAgentFiles
    .map((file) => ({ path: join(codexHome(), "agents", file), source: join(skillSource, "agents", file) }))
    .filter(({ path, source }) => existsSync(path) && !fileMatches(path, source))
    .map(({ path }) => path);
  if (preservedFiles.length) {
    const proof = proofResult(codexHome(), preservedFiles.map((path) => proofCheck("agent-ownership", false, path)));
    const report = {
      reset: false,
      target: "codex",
      codex_home: codexHome(),
      config_path: join(codexHome(), "config.toml"),
      removed_config_sections: [],
      removed_plugin_cache_paths: [],
      removed_agents: [],
      removed_legacy_skill_paths: [],
      preserved_files: preservedFiles,
      result: lifecycleResult({ ok: false, action: "reset", target: "codex", installModel: readCodexInstallModel(), proof, error: { code: "UNOWNED_FILE", message: "Codex reset preserved modified or unproven agents and made no changes. Review those files before retrying with the matching package version." } }),
    };
    if (hasFlag("--json")) printJson(report);
    else console.error(report.result.error.message);
    process.exitCode = 1;
    return report;
  }

  const configPath = join(codexHome(), "config.toml");
  const removedConfigSections = [];
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf8");
    let updated = existing;
    for (const header of [`[plugins."${pluginName}@${pluginName}"]`, `[marketplaces.${pluginName}]`]) {
      const next = removeTomlTable(updated, header);
      if (next !== updated) {
        removedConfigSections.push(header);
        updated = next;
      }
    }
    if (updated !== existing) writeFileAtomic(configPath, updated);
  }

  const removedPluginCachePaths = [];
  const cacheRoot = pluginCacheOwnerRoot();
  if (existsSync(cacheRoot)) {
    rmSync(cacheRoot, { recursive: true, force: true });
    removedPluginCachePaths.push(cacheRoot);
  }

  const removedAgents = [];
  const agentsRoot = join(codexHome(), "agents");
  for (const file of requiredAgentFiles) {
    const path = join(agentsRoot, file);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removedAgents.push(path);
  }

  const removedLegacySkillPaths = cleanupLegacyCodexSkills();
  const checks = [
    proofCheck("plugin-cache-absent", !existsSync(cacheRoot), cacheRoot),
    proofCheck("plugin-config-absent", !pluginConfigEnabled(configPath), configPath),
    ...requiredAgentFiles.map((file) => proofCheck(`agent-absent:${file}`, !existsSync(join(agentsRoot, file)), join(agentsRoot, file))),
    ...legacyCodexSkillRoots().map((path) => proofCheck(`legacy-skill-absent:${basename(path)}`, !existsSync(path), path)),
  ];
  const proof = proofResult(codexHome(), checks);
  const result = lifecycleResult({
    ok: proofOk(proof),
    action: "reset",
    target: "codex",
    installModel: "none",
    proof,
    error: proofOk(proof) ? null : { code: "RESET_INCOMPLETE", message: "Codex reset left GoalBuddy-owned runtime state behind." },
  });
  const report = {
    reset: result.ok,
    target: "codex",
    codex_home: codexHome(),
    config_path: configPath,
    removed_config_sections: removedConfigSections,
    removed_plugin_cache_paths: removedPluginCachePaths,
    removed_agents: removedAgents,
    removed_legacy_skill_paths: removedLegacySkillPaths,
    result,
  };

  if (hasFlag("--json")) {
    printJson(report);
    return report;
  }

  console.log(`Reset ${canonicalProductName} Codex-owned runtime files`);
  console.log(`Config sections: ${removedConfigSections.length ? removedConfigSections.join(", ") : "none"}`);
  console.log(`Plugin cache: ${removedPluginCachePaths.length ? removedPluginCachePaths.join(", ") : "none"}`);
  console.log(`Agents: ${removedAgents.length ? removedAgents.join(", ") : "none"}`);
  console.log(`Legacy personal skills: ${removedLegacySkillPaths.length ? removedLegacySkillPaths.join(", ") : "none"}`);
  if (!result.ok) process.exitCode = 1;
  return report;
}

function resetClaude() {
  const homeFailure = ensureResolvedHome(claudeHome(), "claude");
  if (homeFailure) {
    const report = { reset: false, target: "claude", claude_home: claudeHome(), result: { ...homeFailure, action: "reset" } };
    if (hasFlag("--json")) printJson(report);
    else console.error(homeFailure.error.message);
    process.exitCode = 1;
    return report;
  }

  const loose = claudeLooseState();
  const plugin = installedClaudePluginRecord();
  if (loose.present && plugin) {
    return finishClaudeReset({
      reset: false,
      target: "claude",
      claude_home: claudeHome(),
      cli_actions: [],
      removed_files: [],
      preserved_files: loose.paths,
      result: lifecycleResult({
        ok: false,
        action: "reset",
        target: "claude",
        installModel: "conflict",
        proof: proofResult(claudeHome(), [proofCheck("single-install-model", false, "both plugin and loose-file state present")]),
        error: { code: "MIXED_INSTALL_STATE", message: "Refusing to reset mixed Claude plugin and loose-file state." },
      }),
    });
  }

  if (plugin) return resetClaudePlugin();
  if (loose.present) return resetClaudeLoose();

  const proof = proofResult(claudeHome(), [proofCheck("installed-state-absent", true, "GoalBuddy already removed")]);
  return finishClaudeReset({
    reset: true,
    target: "claude",
    claude_home: claudeHome(),
    cli_actions: [],
    removed_files: [],
    preserved_files: [],
    result: lifecycleResult({ ok: true, action: "reset", target: "claude", installModel: "none", proof }),
  });
}

function resetClaudePlugin() {
  const original = installedClaudePluginRecord();
  const originalPath = original?.installPath ? resolve(original.installPath) : expectedClaudePluginCachePath();
  const preflight = proofClaudePlugin();
  if (!preflight.ok) {
    return finishClaudeReset({
      reset: false,
      target: "claude",
      claude_home: claudeHome(),
      cli_actions: [],
      removed_files: [],
      preserved_files: originalPath ? [originalPath] : [],
      result: lifecycleResult({ ok: false, action: "reset", target: "claude", installModel: "claude-cli", installedVersion: original?.version || "", installedPath: originalPath, proof: preflight.proof, error: { code: "UNPROVEN_PLUGIN", message: "Claude reset preserved a plugin install that did not pass exact ownership proof." } }),
    });
  }
  const actions = [];
  if (!claudeCliAvailable()) {
    const proof = proofClaudePlugin().proof;
    return finishClaudeReset({
      reset: false,
      target: "claude",
      claude_home: claudeHome(),
      cli_actions: actions,
      removed_files: [],
      preserved_files: [],
      result: lifecycleResult({ ok: false, action: "reset", target: "claude", installModel: "claude-cli", proof, error: { code: "CLI_UNAVAILABLE", message: "claude CLI is required to remove an existing plugin install." } }),
    });
  }
  const uninstall = runClaude(["plugin", "uninstall", claudePluginId(), "--scope", "user"]);
  actions.push({ action: "plugin-uninstall", ok: uninstall.ok, detail: firstLine(uninstall.stderr || uninstall.stdout) });
  const marketplace = runClaude(["plugin", "marketplace", "remove", pluginName]);
  actions.push({ action: "marketplace-remove", ok: marketplace.ok, detail: firstLine(marketplace.stderr || marketplace.stdout) });
  const removedFiles = [];
  if (uninstall.ok && existsSync(originalPath)) {
    const orphanExcludes = new Set([...installFingerprintExcludes(), ".orphaned_at"]);
    if (directoryMatches(originalPath, claudePluginSource, orphanExcludes)) {
      rmSync(originalPath, { recursive: true, force: true });
      removedFiles.push(originalPath);
    }
  }
  const pluginAbsent = !installedClaudePluginRecord();
  const marketplaceData = readJsonFile(claudeKnownMarketplacesPath());
  const marketplaceAbsent = !marketplaceData || !Object.hasOwn(marketplaceData, pluginName);
  const checks = [
    proofCheck("plugin-metadata-absent", pluginAbsent, claudeInstalledPluginsPath()),
    proofCheck("plugin-cache-absent", !existsSync(originalPath), originalPath),
    proofCheck("marketplace-absent", marketplaceAbsent, claudeKnownMarketplacesPath()),
    ...actions.map((action) => proofCheck(action.action, action.ok, action.detail || (action.ok ? "completed" : "failed"))),
  ];
  const proof = proofResult(claudeHome(), checks);
  const ok = proofOk(proof);
  return finishClaudeReset({
    reset: ok,
    target: "claude",
    claude_home: claudeHome(),
    cli_actions: actions,
    removed_files: removedFiles,
    preserved_files: existsSync(originalPath) ? [originalPath] : [],
    result: lifecycleResult({ ok, action: "reset", target: "claude", installModel: "none", proof, error: ok ? null : { code: "RESET_INCOMPLETE", message: "Claude plugin reset did not complete and prove every removal." } }),
  });
}

function resetClaudeLoose() {
  const candidates = [
    { path: claudeSkillRoot(), kind: "directory", source: skillSource, exclude: installFingerprintExcludes() },
    ...requiredClaudeAgentFiles.map((file) => ({ path: join(claudeAgentsRoot(), file), kind: "file", source: join(claudePluginSource, "agents", file) })),
    { path: claudeGoalCommandPath(), kind: "file", source: join(claudePluginSource, "commands", "goalbuddy.md") },
  ].filter((item) => existsSync(item.path));
  const unowned = candidates.filter((item) => item.kind === "directory"
    ? !directoryMatches(item.path, item.source, item.exclude)
    : !fileMatches(item.path, item.source));
  if (unowned.length) {
    const proof = proofResult(claudeHome(), unowned.map((item) => proofCheck(`owned:${basename(item.path)}`, false, `modified or unproven: ${item.path}`)));
    return finishClaudeReset({
      reset: false,
      target: "claude",
      claude_home: claudeHome(),
      cli_actions: [],
      removed_files: [],
      preserved_files: candidates.map((item) => item.path),
      result: lifecycleResult({ ok: false, action: "reset", target: "claude", installModel: "loose-files", proof, error: { code: "UNOWNED_FILE", message: "Claude reset preserved modified or unproven files and made no changes." } }),
    });
  }

  for (const item of candidates) rmSync(item.path, { recursive: item.kind === "directory", force: true });
  const checks = candidates.map((item) => proofCheck(`removed:${basename(item.path)}`, !existsSync(item.path), item.path));
  checks.push(proofCheck("plugin-metadata-absent", !installedClaudePluginRecord(), claudeInstalledPluginsPath()));
  const proof = proofResult(claudeHome(), checks.length ? checks : [proofCheck("installed-state-absent", true, "GoalBuddy already removed")]);
  const ok = proofOk(proof);
  return finishClaudeReset({
    reset: ok,
    target: "claude",
    claude_home: claudeHome(),
    cli_actions: [],
    removed_files: candidates.map((item) => item.path),
    preserved_files: [],
    result: lifecycleResult({ ok, action: "reset", target: "claude", installModel: "none", proof, error: ok ? null : { code: "RESET_INCOMPLETE", message: "Claude loose-file reset left owned state behind." } }),
  });
}

function finishClaudeReset(report) {
  if (hasFlag("--json")) printJson(report);
  else {
    console.log(`Reset ${canonicalProductName} Claude Code runtime files`);
    console.log(`Removed: ${report.removed_files.length ? report.removed_files.join(", ") : "none"}`);
    if (report.preserved_files.length) console.log(`Preserved: ${report.preserved_files.join(", ")}`);
  }
  if (!report.result.ok) process.exitCode = 1;
  return report;
}

function removeTomlTable(text, header) {
  const normalized = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  const lines = normalized.split("\n");
  const output = [];
  let skipping = false;
  let removed = false;
  const descendantPrefix = `${header.slice(0, -1)}.`;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header || trimmed.startsWith(descendantPrefix)) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) {
      skipping = trimmed.startsWith(descendantPrefix);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }

  if (!removed) return text;
  return output.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

// Inspect the native installer's sibling-removal boundary before permitting cache mutation.
function inspectCodexCache(installedVersion) {
  const versionsRoot = dirname(pluginCacheRoot(installedVersion));
  // Reject redirected or non-directory cache ancestors before either installer can mutate them.
  for (const path of [join(codexHome(), "plugins"), join(codexHome(), "plugins", "cache"), pluginCacheOwnerRoot(), versionsRoot]) {
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!info.isDirectory()) throw new Error(`Cache path is not a directory: ${path}`);
  }
  const protectedPaths = [];
  for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
    const path = join(versionsRoot, entry.name);
    if (entry.name === installedVersion && !entry.isDirectory()) {
      throw new Error(`Requested version path is not a directory: ${path}`);
    }
    // Native plugin add removes every sibling, including files and invalid version segments.
    // The bundled path only prunes version-shaped directories and leaves these entries alone.
    if (!entry.isDirectory() || !isPluginVersionSegment(entry.name)) protectedPaths.push(path);
  }
  return protectedPaths;
}

// Codex serves the highest version directory it finds under the plugin's cache root, so a directory
// left behind by a newer install keeps being served after a downgrade. Codex's own installer prunes
// siblings whenever it installs; this mirrors that so a hand-built cache cannot diverge.
function pruneStalePluginVersions(installedVersion) {
  const versionsRoot = dirname(pluginCacheRoot(installedVersion));
  if (!existsSync(versionsRoot)) return [];

  const removed = [];
  for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === installedVersion) continue;
    if (!isPluginVersionSegment(entry.name)) continue;
    const path = join(versionsRoot, entry.name);
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

// Mirrors Codex's validate_plugin_version_segment: non-empty, not a traversal, and limited to ASCII
// letters, digits, `.`, `+`, `_`, and `-`. Anything else is not a version directory Codex would
// activate, so it is left alone.
function isPluginVersionSegment(name) {
  if (!name || name === "." || name === "..") return false;
  return /^[A-Za-z0-9._+-]+$/.test(name);
}

function pluginCacheOwnerRoot() {
  return join(codexHome(), "plugins", "cache", pluginName);
}

function pluginCacheRoot(version) {
  return join(pluginCacheOwnerRoot(), pluginName, version);
}

function enablePluginConfig() {
  const configPath = join(codexHome(), "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  const header = `[plugins."${pluginName}@${pluginName}"]`;
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const updated = upsertTomlEnabled(existing, header);
  writeFileAtomic(configPath, updated);
  return configPath;
}

function writeFileAtomic(path, content) {
  const tempPath = `${path}.goalbuddy-tmp-${process.pid}`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, path);
}

function upsertTomlEnabled(text, header) {
  const normalized = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = normalized.trim() ? `${normalized}\n` : "";
    return `${prefix}${header}\nenabled = true\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }

  let sawEnabled = false;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*enabled\s*=/.test(lines[index])) {
      lines[index] = "enabled = true";
      sawEnabled = true;
      break;
    }
  }
  if (!sawEnabled) lines.splice(start + 1, 0, "enabled = true");

  return lines.join("\n").replace(/\n*$/, "\n");
}

function codexGoalRuntimeStatus() {
  const version = runCodex(["--version"]);
  const login = version.ok ? runCodex(["login", "status"]) : { ok: false, stdout: "", stderr: "codex CLI unavailable" };
  const features = version.ok ? runCodex(["features", "list"]) : { ok: false, stdout: "", stderr: "codex CLI unavailable" };
  const goalFeature = parseGoalFeature(features.stdout);
  const loggedIn = login.ok && !/not logged in/i.test(`${login.stdout}\n${login.stderr}`);

  return {
    codex_cli_available: version.ok,
    codex_version: firstLine(version.stdout),
    logged_in: loggedIn,
    login_status: firstLine(login.stdout || login.stderr),
    goals_feature_enabled: goalFeature.enabled,
    goals_feature_stage: goalFeature.stage,
    ready: version.ok && loggedIn && goalFeature.enabled,
  };
}

function runCodex(args) {
  const env = { ...process.env, CODEX_HOME: codexHome() };
  const command = codexSpawnCommand(args, env);
  const result = spawnSync(command.file, command.args, {
    encoding: "utf8",
    env,
    shell: command.shell || false,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function codexSpawnCommand(args, env) {
  if (process.platform !== "win32") return { file: "codex", args };

  const command = resolveWindowsCommand("codex", env);
  if (!command) return { file: "codex", args };
  if (/\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [quoteWindowsCommandArg(command), ...args.map(quoteWindowsCommandArg)].join(" ");
    return {
      file: commandLine,
      args: [],
      shell: true,
    };
  }
  return { file: command, args };
}

function resolveWindowsCommand(name, env) {
  const systemWhere = env.SystemRoot ? join(env.SystemRoot, "System32", "where.exe") : "";
  const whereCommand = systemWhere && existsSync(systemWhere) ? systemWhere : "where.exe";
  const where = spawnSync(whereCommand, [name], { encoding: "utf8", env });
  if (where.status !== 0) return "";
  const candidates = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => /\.(?:exe|cmd|bat)$/i.test(candidate)) || "";
}

function quoteWindowsCommandArg(value) {
  return `"${String(value).replace(/(["^&|<>()%])/g, "^$1")}"`;
}

function parseGoalFeature(output) {
  const line = output.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("goals"));
  if (!line) return { enabled: false, stage: "" };
  const parts = line.trim().split(/\s{2,}/);
  return {
    enabled: parts.at(-1) === "true",
    stage: parts.slice(1, -1).join(" "),
  };
}

function firstLine(value) {
  return (value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

async function board() {
  const goal = optionValue("--goal") || positional(1);
  if (!goal) {
    console.error(`Missing goal directory. Usage: ${canonicalCliName} board docs/goals/<slug>`);
    process.exit(2);
  }

  const absoluteGoal = resolve(goal);
  const script = ensureLocalBoardSurface();
  const scriptArgs = [script, "--goal", absoluteGoal];
  for (const option of ["--host", "--port"]) {
    const value = optionValue(option);
    if (value) scriptArgs.push(option, value);
  }
  if (hasFlag("--once")) scriptArgs.push("--once");
  if (hasFlag("--json")) scriptArgs.push("--json");

  const capture = hasFlag("--once") || hasFlag("--json");
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function initGoal() {
  const slug = positional(1);
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    argumentError(`Usage: ${canonicalCliName} init <slug> [--title "<Goal title>"] (slug: lowercase letters, digits, dashes)`);
  }
  const title = optionValue("--title") || slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  const goalDir = resolve("docs", "goals", slug);
  if (existsSync(join(goalDir, "state.yaml"))) {
    argumentError(`Board already exists: ${join(goalDir, "state.yaml")}`);
  }

  mkdirSync(join(goalDir, "notes"), { recursive: true });
  const templates = join(skillSource, "templates");
  writeFileSync(join(goalDir, "state.yaml"), readFileSync(join(templates, "state.yaml"), "utf8")
    .replaceAll("<Goal title>", title)
    .replaceAll("<goal-slug>", slug));
  writeFileSync(join(goalDir, "goal.md"), readFileSync(join(templates, "goal.md"), "utf8")
    .replaceAll("<Goal Title>", title)
    .replaceAll("<goal-slug>", slug)
    .replaceAll("<slug>", slug));

  const runCommand = `/goal Follow docs/goals/${slug}/goal.md.`;
  const claudeRunCommand = `/goalbuddy Follow docs/goals/${slug}/goal.md.`;
  if (hasFlag("--json")) {
    printJson({ created: goalDir, slug, title, run_command: runCommand, claude_run_command: claudeRunCommand });
    return;
  }
  console.log(`Created GoalBuddy board: docs/goals/${slug}/`);
  console.log("Next: refine the charter and intake with $goal-prep (Codex) or /goal-prep (Claude Code),");
  console.log(`or start execution in Codex: ${runCommand}`);
  console.log(`or start execution in Claude Code: ${claudeRunCommand}`);
}

function receiptCli() {
  const script = join(skillSource, "scripts", "apply-receipt.mjs");
  const result = spawnSync(process.execPath, [script, ...args.slice(1)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function canStopCli() {
  const script = join(skillSource, "scripts", "check-can-stop.mjs");
  const result = spawnSync(process.execPath, [script, ...resolveChildGoalArgs(args.slice(1))], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function dispatchCli() {
  const script = join(skillSource, "scripts", "dispatch-task.mjs");
  const result = spawnSync(process.execPath, [script, ...args.slice(1)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function resume() {
  const boardLib = pathToFileURL(join(skillSource, "surfaces", "local-goal-board", "scripts", "lib", "goal-board.mjs")).href;
  const { createBoardPayload } = await import(boardLib);
  const explicit = positional(1);
  const goalDirs = explicit ? [resolve(explicit)] : listGoalDirs(resolve("docs", "goals"));
  const boards = goalDirs.map((goalDir) => describeBoard(goalDir, createBoardPayload));

  if (hasFlag("--json")) {
    printJson({ boards });
    return;
  }

  if (!boards.length) {
    console.log("No GoalBuddy boards found under docs/goals.");
    console.log("Prepare one with $goal-prep (Codex) or /goal-prep (Claude Code).");
    return;
  }

  console.log("GoalBuddy boards:");
  for (const board of boards) {
    console.log("");
    console.log(`${board.title} — ${board.status} (${board.path})`);
    if (board.active_task) {
      console.log(`  Active task: ${board.active_task.id} (${board.active_task.type}) ${board.active_task.objective}`);
      console.log("  Resume in Codex:");
      console.log(`    ${board.run_command}`);
      console.log("  Resume in Claude Code:");
      console.log(`    ${board.claude_run_command}`);
      console.log(`  Full task prompt: npx ${canonicalCliName} prompt ${board.path}`);
    } else {
      console.log("  No active task.");
    }
  }
}

function listGoalDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, "state.yaml")))
    .sort();
}

function describeBoard(goalDir, createBoardPayload) {
  const path = relative(process.cwd(), goalDir).split(sep).join("/") || ".";
  try {
    const payload = createBoardPayload(goalDir);
    const activeTask = payload.tasks.find((task) => task.id === payload.goal.activeTask && task.active)
      || payload.tasks.find((task) => task.active)
      || null;
    return {
      path,
      slug: payload.goal.slug,
      title: payload.goal.title,
      status: payload.goal.status,
      active_task: activeTask ? { id: activeTask.id, type: activeTask.type, objective: activeTask.objective } : null,
      run_command: `/goal Follow ${path}/goal.md.`,
      claude_run_command: `/goalbuddy Follow ${path}/goal.md.`,
    };
  } catch (error) {
    return { path, slug: "", title: path, status: "unreadable", active_task: null, run_command: "", claude_run_command: "", error: error.message };
  }
}

async function prompt() {
  if (hasFlag("--parallel-plan")) {
    await parallelPlan();
    return;
  }

  const script = join(skillSource, "scripts", "render-task-prompt.mjs");
  const scriptArgs = [script, ...resolveChildGoalArgs(args.slice(1))];
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function parallelPlan() {
  const script = join(skillSource, "scripts", "parallel-plan.mjs");
  const scriptArgs = [script, ...resolveChildGoalArgs(args.slice(1).filter((arg) => arg !== "--parallel-plan"))];
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function ensureLocalBoardSurface() {
  const script = join(skillSource, "surfaces", "local-goal-board", "scripts", "local-goal-board.mjs");
  if (!existsSync(script)) {
    throw new Error(`Bundled GoalBuddy board surface is missing: ${script}`);
  }
  return script;
}

function installedSkillRoot() {
  return join(codexHome(), "skills", canonicalSkillDirectory);
}

function installedCodexPlugin() {
  const root = join(codexHome(), "plugins", "cache", pluginName, pluginName);
  const configPath = join(codexHome(), "config.toml");
  const base = {
    installed: false,
    enabled: pluginConfigEnabled(configPath),
    name: `${pluginName}@${pluginName}`,
    version: "",
    cache_path: "",
    manifest_path: "",
    skill_installed: false,
    skill_path: "",
    config_path: configPath,
  };
  if (!existsSync(root)) return base;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isSupportedVersion)
    .sort(compareVersions)
    .reverse();
  for (const version of versions) {
    const cachePath = join(root, version);
    const skillPath = [canonicalSkillName, canonicalSkillDirectory]
      .map((name) => join(cachePath, "skills", name))
      .find((path) => existsSync(join(path, "SKILL.md"))) || join(cachePath, "skills", canonicalSkillName);
    const manifestPath = join(cachePath, ".codex-plugin", "plugin.json");
    if (existsSync(join(skillPath, "SKILL.md"))) {
      return {
        ...base,
        installed: true,
        version,
        cache_path: cachePath,
        manifest_path: manifestPath,
        skill_installed: true,
        skill_path: skillPath,
      };
    }
  }
  return base;
}

function pluginConfigEnabled(configPath) {
  if (!existsSync(configPath)) return false;
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  const header = `[plugins."${pluginName}@${pluginName}"]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[")) break;
    if (/^enabled\s*=\s*true\b/.test(line)) return true;
    if (/^enabled\s*=/.test(line)) return false;
  }
  return false;
}

function legacyInstalledSkillRoot() {
  return join(codexHome(), "skills", legacySkillName);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function directoryFingerprint(root, { exclude = new Set() } = {}) {
  if (!existsSync(root)) return "";
  const hash = createHash("sha256");
  for (const file of listFiles(root, { exclude })) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(root, { exclude = new Set(), prefix = "" } = {}) {
  const entries = readdirSync(join(root, prefix), { withFileTypes: true })
    .filter((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return !exclude.has(relative) && !relative.split("/").some((segment) => exclude.has(segment));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, { exclude, prefix: relative }));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function installFingerprintExcludes() {
  return new Set([".goalbuddy-install.json", ".goal-maker-install.json", ".goalbuddy-board"]);
}

function installMetadataPath(target) {
  return join(target, ".goalbuddy-install.json");
}

function legacyInstallMetadataPath(target) {
  return join(target, ".goal-maker-install.json");
}

function readInstallMetadata(target) {
  for (const path of [installMetadataPath(target), legacyInstallMetadataPath(target)]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function writeInstallMetadata(target, previousMetadata) {
  writeFileSync(installMetadataPath(target), `${JSON.stringify({
    package_name: packageInfo.name,
    package_version: packageInfo.version,
    previous_package_version: previousMetadata?.package_version || "",
    installed_at: new Date().toISOString(),
  }, null, 2)}\n`);
}

function printInstallReport(report) {
  const verb = report.command === "update" ? "Updated" : "Installed";
  const previous = report.package.previous_version && report.package.previous_version !== report.package.current_version
    ? ` ${report.package.previous_version} -> ${report.package.current_version}`
    : ` ${report.package.current_version}`;
  console.log("");
  console.log(`${verb} ${canonicalProductName}${previous}`);
  console.log("");
  console.log(`Skill: ${report.skill.status} at ${report.skill.path}`);
  console.log(`Compatibility skill: ${report.skill.compatibility_path}`);
  const agentSummary = summarizeStatuses(report.agents);
  console.log(`Agents: ${agentSummary}`);

  console.log("");
  console.log("Next:");
  console.log(`  $${canonicalSkillName}`);
  console.log(`  ${canonicalCliName} board docs/goals/<slug>`);
  console.log(`  ${legacyCliName} remains a temporary compatibility alias.`);
}

function printEverywhereInstallReport(report) {
  const action = report.command === "update" ? "update" : "install";
  console.log("");
  console.log(`${canonicalProductName} ${action} for Codex and Claude Code ${report.package.current_version}`);
  console.log("");

  if (report.codex?.result?.ok === true) {
    console.log(`Codex: plugin ${report.codex.version} enabled at ${report.codex.cache_path}`);
  } else if (report.codex) {
    console.log(`Codex: not completed (${report.codex.result?.error?.message || report.codex.error || "unproven state"})`);
  }

  if (report.claude?.result?.ok === true && report.claude.result.install_model === "claude-cli") {
    console.log(`Claude Code: plugin ${report.claude.result.installed_version} installed at ${report.claude.result.installed_path}`);
  } else if (report.claude?.result?.ok === true && report.claude.skill) {
    console.log(`Claude Code: skill ${report.claude.skill.status} at ${report.claude.skill.path}`);
    console.log(`Claude Code agents: ${summarizeStatuses(report.claude.agents)}`);
    console.log(`Claude Code command: /goalbuddy ${report.claude.goal_command.status} at ${report.claude.goal_command.path}`);
    if (report.claude.legacy_goal_command_cleanup?.removed) {
      console.log(`Claude Code: removed legacy GoalBuddy command at ${report.claude.legacy_goal_command_cleanup.path}`);
    }
    if (report.claude.legacy_commands_cleanup?.removed) {
      console.log(`Claude Code: removed legacy command at ${report.claude.legacy_commands_cleanup.path}`);
    }
    for (const warning of report.claude.warnings || []) console.log(`Claude Code warning: ${warning}`);
  } else if (report.claude) {
    console.log(`Claude Code: not completed (${report.claude.result?.error?.message || "unproven state"})`);
  }

  if (report.errors.length) {
    console.log("");
    console.log("One or more targets need attention:");
    for (const error of report.errors) console.log(`  ${error.target}: ${error.error}`);
  }

  const codexReady = report.codex?.result?.ok === true;
  const claudeReady = report.claude?.result?.ok === true;
  if (codexReady || claudeReady) {
    console.log("");
    console.log("Next:");
    if (codexReady) console.log(`  Restart Codex, then use: $${canonicalSkillName}`);
    if (claudeReady) console.log("  Restart Claude Code, then run: /goal-prep");
  }
}

function summarizeStatuses(items) {
  const counts = items.reduce((memo, item) => {
    memo[item.status] = (memo[item.status] || 0) + 1;
    return memo;
  }, {});
  return Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function latestPublishedVersion() {
  if (process.env.GOALBUDDY_TEST_NPM_LATEST_VERSION) {
    return normalizeVersion(process.env.GOALBUDDY_TEST_NPM_LATEST_VERSION);
  }

  const result = spawnSync("npm", ["view", packageInfo.name, "version"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 5000,
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(output || `npm view exited with status ${result.status}`);
  }

  return normalizeVersion(result.stdout);
}

function normalizeVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`Unsupported version: ${value}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function isSupportedVersion(value) {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(value).trim());
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  const leftPre = String(left).includes("-");
  const rightPre = String(right).includes("-");
  if (leftPre !== rightPre) return leftPre ? -1 : 1;
  return 0;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

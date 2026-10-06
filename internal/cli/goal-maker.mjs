#!/usr/bin/env node
import {
  cpSync,
  existsSync,
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
const packageInfo = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const defaultCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const defaultClaudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
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
      if (targetMode() !== "codex") {
        console.error("Reset currently supports --target codex only.");
        process.exit(2);
      }
      resetCodex();
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
  ${canonicalCliName} reset --target codex [--codex-home <path>] [--json]
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
  rmSync(target, { recursive: true, force: true });
  cpSync(skillSource, target, { recursive: true });
  writeInstallMetadata(target, previousMetadata);

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
  return report;
}

async function installClaudeAll() {
  const report = await buildClaudeInstallReport();

  if (hasFlag("--json")) {
    printJson(report);
  } else {
    printClaudeInstallReport(report);
  }
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
  } catch (error) {
    report.errors.push({ target: "codex", error: error.message });
    report.codex = { target: "codex", ok: false, error: error.message };
  }

  try {
    report.claude = await buildClaudeInstallReport();
  } catch (error) {
    report.errors.push({ target: "claude", error: error.message });
    report.claude = { target: "claude", ok: false, error: error.message };
  }

  report.ok = report.errors.length === 0;

  if (hasFlag("--json")) {
    printJson(report);
  } else {
    printEverywhereInstallReport(report);
  }

  if (!report.ok) process.exit(1);
}

function doctorClaude() {
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
  }, null, 2));

  const installOk = installed && missingAgents.length === 0 && staleAgents.length === 0 && goalCommandPresent && !legacyGoalCommandPresent && !legacyCommandPresent && !legacySkillPresent;
  process.exit(installOk ? 0 : 1);
}

function printClaudeInstallReport(report) {
  const verb = report.command === "update" ? "Updated" : "Installed";
  const previous = report.package.previous_version && report.package.previous_version !== report.package.current_version
    ? ` ${report.package.previous_version} -> ${report.package.current_version}`
    : ` ${report.package.current_version}`;
  console.log("");
  console.log(`${verb} ${canonicalProductName} for Claude Code${previous}`);
  console.log("");
  console.log(`Skill: ${report.skill.status} at ${report.skill.path}`);
  console.log(`Agents: ${summarizeStatuses(report.agents)}`);
  console.log(`Command: /goalbuddy ${report.goal_command.status} at ${report.goal_command.path}`);
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
  }, null, 2));

  const pluginOk = plugin.skill_installed && plugin.enabled;
  const legacySkillOk = installed;
  const installOk = (pluginOk || legacySkillOk) && missingAgents.length === 0 && staleAgents.length === 0;
  const goalReadyOk = !hasFlag("--goal-ready") || goalRuntime.ready;
  process.exit(installOk && goalReadyOk && errors.length === 0 ? 0 : 1);
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
  const source = optionValue("--source") || "tolimarchuk/goalbuddy";
  const pluginSource = join(packageRoot, "plugins", pluginName);
  const pluginManifestPath = join(pluginSource, ".codex-plugin", "plugin.json");
  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Plugin manifest not found: ${pluginManifestPath}`);
  }

  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  const pluginCachePath = pluginCacheRoot(pluginManifest.version);
  const warnings = [];

  // Prefer Codex's own installer. It stages the tree into a temp directory and renames it into
  // place, prunes superseded version directories, migrates `commands/` into skills, and writes the
  // config enablement, none of which a plain copy does.
  const native = installPluginWithCodexCli(source);
  const removedStaleVersionPaths = [];
  if (!native.ok) {
    // Falling back to the bundled tree keeps the install working with no `codex` CLI and no network.
    // Codex loads a plugin from its cache directory plus the `[plugins]` config, both written below,
    // and consults the marketplace entry only to find the source again later.
    warnings.push(`Codex CLI install unavailable (${native.reason}). Installed the bundled copy directly; \`codex plugin add\` would also migrate the plugin's commands into skills.`);

    mkdirSync(dirname(pluginCachePath), { recursive: true });
    rmSync(pluginCachePath, { recursive: true, force: true });
    cpSync(pluginSource, pluginCachePath, { recursive: true });
    // Prune only after the new version is in place, so a failed copy cannot leave the cache empty.
    removedStaleVersionPaths.push(...pruneStalePluginVersions(pluginManifest.version));
  }

  const removedLegacySkillPaths = cleanupLegacyCodexSkills();
  // `codex plugin add` already enables the plugin, so only write config when it is not enabled yet.
  const configPath = join(codexHome(), "config.toml");
  if (!pluginConfigEnabled(configPath)) enablePluginConfig();
  // Codex plugins cannot bundle subagents, so the role files always install as loose config files.
  const agents = installAgents({ quiet: true });

  const report = {
    installed: true,
    target: "codex",
    plugin: `${pluginName}@${pluginName}`,
    version: pluginManifest.version,
    codex_home: codexHome(),
    install_model: native.ok ? "codex-cli" : "bundled-copy",
    marketplace_source: source,
    cache_path: pluginCachePath,
    config_path: configPath,
    agents,
    removed_legacy_skill_paths: removedLegacySkillPaths,
    removed_stale_version_paths: removedStaleVersionPaths,
    warnings,
  };

  if (hasFlag("--json") && !quiet) {
    printJson(report);
    return report;
  }

  if (quiet) return report;

  console.log(`Installed ${canonicalProductName} Codex plugin ${pluginManifest.version}`);
  console.log(`Marketplace: ${report.marketplace_source}`);
  console.log(`Cache: ${pluginCachePath}`);
  console.log(`Config: ${configPath}`);
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
  const report = {
    reset: true,
    target: "codex",
    codex_home: codexHome(),
    config_path: configPath,
    removed_config_sections: removedConfigSections,
    removed_plugin_cache_paths: removedPluginCachePaths,
    removed_agents: removedAgents,
    removed_legacy_skill_paths: removedLegacySkillPaths,
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

// Installs through the `codex` CLI so Codex owns staging, pruning, command migration, and config
// enablement. The marketplace is the published repository, the same source the docs and the in-app
// instructions name, so the entry written into the user's config stays portable. Returns
// `{ ok: false, reason }` when the CLI cannot do it, so the caller can fall back to copying the
// bundled tree.
function installPluginWithCodexCli(source) {
  if (!runCodex(["--version"]).ok) return { ok: false, reason: "codex CLI not found on PATH" };

  const marketplace = runCodex(["plugin", "marketplace", "add", source]);
  if (!marketplace.ok) {
    return { ok: false, reason: firstLine(marketplace.stderr || marketplace.stdout) || "marketplace add failed" };
  }

  const added = runCodex(["plugin", "add", `${pluginName}@${pluginName}`]);
  if (!added.ok) {
    return { ok: false, reason: firstLine(added.stderr || added.stdout) || "plugin add failed" };
  }
  return { ok: true, reason: "" };
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
    .filter((entry) => !exclude.has(prefix ? `${prefix}/${entry.name}` : entry.name))
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
  return new Set([".goalbuddy-install.json", ".goal-maker-install.json"]);
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
  const verb = report.command === "update" ? "Updated" : "Installed";
  console.log("");
  console.log(`${verb} ${canonicalProductName} for Codex and Claude Code ${report.package.current_version}`);
  console.log("");

  if (report.codex?.ok === false) {
    console.log(`Codex: not completed (${report.codex.error})`);
  } else if (report.codex) {
    console.log(`Codex: plugin ${report.codex.version} enabled at ${report.codex.cache_path}`);
  }

  if (report.claude?.ok === false) {
    console.log(`Claude Code: not completed (${report.claude.error})`);
  } else if (report.claude) {
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
  }

  if (report.errors.length) {
    console.log("");
    console.log("One or more targets need attention:");
    for (const error of report.errors) console.log(`  ${error.target}: ${error.error}`);
  }

  console.log("");
  console.log("Next:");
  console.log(`  Restart Codex, then use: $${canonicalSkillName}`);
  console.log("  Restart Claude Code, then run: /goal-prep");
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

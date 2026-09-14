import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { writeCliFixture } from "./helpers/installer-cli-fixture.mjs";

const cli = resolve("internal/cli/goal-maker.mjs");
const packageRoot = resolve(".");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function run(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function runHuman(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isolatedPath(root, kind) {
  const bin = join(root, `bin-${kind}`);
  mkdirSync(bin, { recursive: true });
  return bin;
}

function missingCliEnv(root, name) {
  const bin = isolatedPath(root, `missing-${name}`);
  writeCliFixture(bin, name, "process.exit(127);");
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function fixturePrelude(root, name, homeVariable) {
  return `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, `${name}-calls.jsonl`))}, JSON.stringify(args) + "\\n");
const home = process.env[${JSON.stringify(homeVariable)}];
const relative = home && path.relative(${JSON.stringify(root)}, home);
if (!home || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
  throw new Error("Fixture must operate inside its task-owned home");
}
const target = path.join(home, "plugins", "cache", "goalbuddy", "goalbuddy", ${JSON.stringify(version)});
`;
}

function nativeCodexEnv(root) {
  const bin = isolatedPath(root, "codex");
  writeCliFixture(bin, "codex", fixturePrelude(root, "codex", "CODEX_HOME") + `
if (args[0] === "--version") { console.log("codex-cli test"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "marketplace") process.exit(0);
if (args[0] === "plugin" && args[1] === "add") {
  fs.cpSync(${JSON.stringify(join(packageRoot, "plugins", "goalbuddy"))}, target, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), '[plugins."goalbuddy@goalbuddy"]\\nenabled = true\\n');
  process.exit(0);
}
if (args[0] === "login") { console.log("Logged in"); process.exit(0); }
if (args[0] === "features") { console.log("goals  test  true"); process.exit(0); }
process.exit(2);
`);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function nativeClaudeEnv(root) {
  const bin = isolatedPath(root, "claude");
  writeCliFixture(bin, "claude", fixturePrelude(root, "claude", "CLAUDE_CONFIG_DIR") + `
if (args[0] === "--version") { console.log("Claude Code test"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "marketplace") {
  fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
  if (args[2] === "remove") fs.writeFileSync(path.join(home, "plugins", "known_marketplaces.json"), "{}\\n");
  process.exit(0);
}
if (args[0] === "plugin" && ["install", "update"].includes(args[1])) {
  fs.cpSync(${JSON.stringify(join(packageRoot, "plugins", "goalbuddy"))}, target, { recursive: true });
  fs.writeFileSync(path.join(home, "plugins", "installed_plugins.json"), JSON.stringify({
    plugins: { "goalbuddy@goalbuddy": [{ scope: "user", installPath: target, version: ${JSON.stringify(version)} }] }
  }));
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "uninstall") {
  fs.rmSync(target, { recursive: true, force: true });
  fs.writeFileSync(path.join(home, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {} }));
  process.exit(0);
}
process.exit(2);
`);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function fixtureCalls(root, name) {
  return readFileSync(join(root, `${name}-calls.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function assertNativePayload(home) {
  const installed = join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version);
  for (const relative of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "skills/goal-prep/SKILL.md"]) {
    assert.deepEqual(readFileSync(join(installed, relative)), readFileSync(join(packageRoot, "plugins", "goalbuddy", relative)));
  }
}

function assertResult(result, { action, target, model, ok = true }) {
  assert.equal(result.ok, ok);
  assert.equal(result.action, action);
  assert.equal(result.target, target);
  assert.equal(result.install_model, model);
  assert.equal(result.requested_version, version);
  assert.equal(result.proof.checks.every((check) => check.ok), ok);
  assert.equal(typeof result.fallback.used, "boolean");
  assert.ok(Object.hasOwn(result, "error"));
  assert.ok(Array.isArray(result.warnings));
}

test("Codex native lifecycle proves install, update, doctor, reset, and removed state", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-codex-native-"));
  try {
    const home = join(root, "codex home");
    const env = nativeCodexEnv(root);
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "codex", "--codex-home", home, "--source", packageRoot], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "codex", model: "codex-cli" });
      assert.equal(response.json.result.fallback.used, false);
      assertNativePayload(home);
    }
    const doctor = run(["doctor", "--target", "codex", "--codex-home", home], env);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assertResult(doctor.json.result, { action: "doctor", target: "codex", model: "codex-cli" });
    const reset = run(["reset", "--target", "codex", "--codex-home", home], env);
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assertResult(reset.json.result, { action: "reset", target: "codex", model: "none" });
    assert.equal(existsSync(join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version)), false);
    assert.equal(fixtureCalls(root, "codex").filter((args) => args[0] === "plugin" && args[1] === "add").length, 2);
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex missing CLI uses and proves the atomic bundled-copy lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-codex-copy-"));
  try {
    const home = join(root, "codex");
    const env = missingCliEnv(root, "codex");
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "codex", "--codex-home", home], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "codex", model: "bundled-copy" });
      assert.equal(response.json.result.fallback.used, true);
    }
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 0);
    assert.equal(run(["reset", "--target", "codex", "--codex-home", home], env).status, 0);
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude native plugin lifecycle is exact and repeatable", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-native-"));
  try {
    const home = join(root, "claude home");
    const env = nativeClaudeEnv(root);
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "claude", "--claude-home", home, "--source", packageRoot], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "claude", model: "claude-cli" });
      assert.equal(response.json.result.fallback.used, false);
      assertNativePayload(home);
    }
    const doctor = run(["doctor", "--target", "claude", "--claude-home", home], env);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assertResult(doctor.json.result, { action: "doctor", target: "claude", model: "claude-cli" });
    const reset = run(["reset", "--target", "claude", "--claude-home", home], env);
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assertResult(reset.json.result, { action: "reset", target: "claude", model: "none" });
    assert.equal(existsSync(join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version)), false);
    for (const action of ["install", "update", "uninstall"]) {
      assert.ok(fixtureCalls(root, "claude").some((args) => args[0] === "plugin" && args[1] === action));
    }
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude missing CLI retains the loose-file lifecycle and ownership-safe reset", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-loose-"));
  try {
    const home = join(root, "claude");
    const env = missingCliEnv(root, "claude");
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "claude", "--claude-home", home], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "claude", model: "loose-files" });
      if (action === "install") assert.equal(response.json.result.fallback.used, true);
    }
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 0);
    assert.equal(run(["reset", "--target", "claude", "--claude-home", home], env).status, 0);
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-directory Codex and Claude homes fail with the shared result contract", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-invalid-home-"));
  try {
    const file = join(root, "not-a-directory");
    writeFileSync(file, "user data\n");
    const codex = run(["install", "--target", "codex", "--codex-home", file], missingCliEnv(root, "codex"));
    assert.equal(codex.status, 1);
    assertResult(codex.json.result, { action: "install", target: "codex", model: "none", ok: false });
    const claude = run(["install", "--target", "claude", "--claude-home", file], missingCliEnv(root, "claude"));
    assert.equal(claude.status, 1);
    assertResult(claude.json.result, { action: "install", target: "claude", model: "none", ok: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate failed targets never receive human success or next-step copy", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-aggregate-copy-"));
  try {
    const invalidCodex = join(root, "codex-file");
    const invalidClaude = join(root, "claude-file");
    writeFileSync(invalidCodex, "user data\n");
    writeFileSync(invalidClaude, "user data\n");
    for (const action of ["install", "update"]) {
      const args = [action, "--codex-home", invalidCodex, "--claude-home", invalidClaude];
      const human = runHuman(args, {});
      assert.equal(human.status, 1, human.stderr || human.stdout);
      assert.match(human.stdout, /Codex: not completed/);
      assert.match(human.stdout, /Claude Code: not completed/);
      assert.doesNotMatch(human.stdout, /\b(?:enabled|installed|updated|restart)\b/i);
      assert.doesNotMatch(human.stdout, /then (?:use|run):/i);
      assert.doesNotMatch(human.stdout, /^Next:$/m);

      const json = run(args, {});
      assert.equal(json.status, 1, json.stderr || json.stdout);
      assert.equal(json.json.ok, false);
      for (const target of [json.json.codex, json.json.claude]) {
        assert.equal(target.result.ok, false);
        assert.equal(typeof target.result.error.code, "string");
        assert.equal(typeof target.result.error.message, "string");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude mixed state is rejected without deleting either model", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-conflict-"));
  try {
    const home = join(root, "claude");
    const loose = run(["install", "--target", "claude", "--claude-home", home], missingCliEnv(root, "claude"));
    assert.equal(loose.status, 0, loose.stderr || loose.stdout);
    const plugins = join(home, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "goalbuddy@goalbuddy": [{ scope: "user", installPath: join(root, "missing-plugin"), version }] } }));
    const conflict = run(["update", "--target", "claude", "--claude-home", home], nativeClaudeEnv(root));
    assert.equal(conflict.status, 1);
    assert.equal(conflict.json.result.install_model, "conflict");
    assert.equal(conflict.json.result.error.code, "MIXED_INSTALL_STATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude zero-exit native install without state falls back only after absence proof", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-unproven-"));
  try {
    const bin = isolatedPath(root, "claude-zero");
    writeCliFixture(bin, "claude", fixturePrelude(root, "claude", "CLAUDE_CONFIG_DIR") + "process.exit(0);");
    const home = join(root, "claude");
    const response = run(["install", "--target", "claude", "--claude-home", home], { PATH: `${bin}${delimiter}${process.env.PATH}` });
    assert.equal(response.status, 0, response.stderr || response.stdout);
    assertResult(response.json.result, { action: "install", target: "claude", model: "loose-files" });
    assert.equal(response.json.result.fallback.used, true);
    assert.match(response.json.result.fallback.reason, /not proven/i);
    assert.ok(fixtureCalls(root, "claude").some((args) => args[0] === "plugin" && args[1] === "install"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude loose reset preserves every file when one file is modified", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-preserve-"));
  try {
    const home = join(root, "claude");
    const env = missingCliEnv(root, "claude");
    assert.equal(run(["install", "--target", "claude", "--claude-home", home], env).status, 0);
    const modified = join(home, "agents", "goal-worker.md");
    writeFileSync(modified, "user changes\n");
    const reset = run(["reset", "--target", "claude", "--claude-home", home], env);
    assert.equal(reset.status, 1);
    assert.equal(reset.json.result.error.code, "UNOWNED_FILE");
    assert.equal(readFileSync(modified, "utf8"), "user changes\n");
    assert.match(readFileSync(join(home, "skills", "goal-prep", "SKILL.md"), "utf8"), /name: goal-prep/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Codex reset preserves config, cache and agents when an agent is modified or unproven", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-codex-preserve-"));
  try {
    const home = join(root, "codex");
    const env = missingCliEnv(root, "codex");
    const installed = run(["install", "--target", "codex", "--codex-home", home], env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const config = join(home, "config.toml");
    const cacheManifest = join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version, ".codex-plugin", "plugin.json");
    const configBefore = readFileSync(config);
    const cacheBefore = readFileSync(cacheManifest);
    const modified = join(home, "agents", "goal_worker.toml");
    const original = readFileSync(modified);
    for (const directory of [false, true]) {
      if (directory) {
        rmSync(modified);
        mkdirSync(modified);
        writeFileSync(join(modified, "user.txt"), "user content\n");
      } else writeFileSync(modified, "user customization\n");
      const reset = run(["reset", "--target", "codex", "--codex-home", home], env);
      assert.equal(reset.status, 1);
      assert.equal(reset.json.reset, false);
      assert.equal(reset.json.result.error.code, "UNOWNED_FILE");
      assert.deepEqual(reset.json.preserved_files, [modified]);
      assert.deepEqual(reset.json.removed_agents, []);
      assert.deepEqual(readFileSync(config), configBefore);
      assert.deepEqual(readFileSync(cacheManifest), cacheBefore);
      assert.equal(readFileSync(directory ? join(modified, "user.txt") : modified, "utf8"), directory ? "user content\n" : "user customization\n");
    }
    rmSync(modified, { recursive: true });
    writeFileSync(modified, original);
    assert.equal(run(["reset", "--target", "codex", "--codex-home", home], env).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// Available native CLI model with the destructive sibling behavior observed in Codex 0.154.0.
function destructiveCodexEnv(root) {
  const bin = isolatedPath(root, "destructive-codex");
  const calls = join(root, "native-calls.jsonl");
  const script = writeCliFixture(bin, "codex", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("codex-cli fixture available"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "add") {
  const root = path.join(process.env.CODEX_HOME, "plugins", "cache", "goalbuddy", "goalbuddy");
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(${JSON.stringify(join(packageRoot, "plugins", "goalbuddy"))}, path.join(root, ${JSON.stringify(version)}), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), '[plugins."goalbuddy@goalbuddy"]\\nenabled = true\\n');
}
`);
  return { env: { PATH: `${bin}${delimiter}${process.env.PATH}` }, calls, script };
}

function installedFileSnapshot(root) {
  const files = {};
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      files[item] = { mode: statSync(item).mode, bytes: entry.isFile() ? readFileSync(item).toString("hex") : null };
      if (entry.isDirectory()) walk(item);
    }
  }
  walk(root);
  return files;
}

test("Codex cache conflicts explain failure without success instructions on every direct install route", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-human-failure-"));
  try {
    const home = join(root, "codex");
    const conflict = join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version);
    mkdirSync(resolve(conflict, ".."), { recursive: true });
    writeFileSync(conflict, "unrelated user file\n");
    chmodSync(conflict, 0o640);
    writeFileSync(join(home, "config.toml"), "# unrelated configuration\n");
    const before = installedFileSnapshot(home);
    for (const route of [[], ["install"], ["update"], ["plugin", "install"]]) {
      const args = [...route, "--target", "codex", "--codex-home", home];
      const human = runHuman(args, {});
      assert.equal(human.status, 1);
      assert.match(human.stderr, /Codex installation failed.*CACHE_INSPECTION_FAILED/);
      assert.match(human.stderr, /Requested version path is not a directory/);
      assert.ok(human.stderr.includes(conflict), "the cause must identify the conflicting user file");
      assert.match(human.stderr, /before retrying/);
      assert.doesNotMatch(human.stdout + human.stderr, /Installed GoalBuddy|Restart Codex|then use:|Goal surface:|\$goal-prep/);
      assert.equal(human.stdout, "");
      const json = run(args, {});
      assert.equal(json.status, 1);
      assert.equal(json.stderr, "", "human failure formatting must not leak into JSON output");
      assert.equal(json.json.installed, false);
      assert.equal(json.json.result.ok, false);
      assert.equal(json.json.result.error.code, "CACHE_INSPECTION_FAILED");
      assert.ok(human.stderr.includes(json.json.result.error.message));
      assert.deepEqual(installedFileSnapshot(home), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful Codex human installation still reports its installed payload and next steps", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-human-success-"));
  try {
    const home = join(root, "codex");
    const env = missingCliEnv(root, "codex");
    for (const action of ["install", "update"]) {
      const human = runHuman([action, "--target", "codex", "--codex-home", home], env);
      assert.equal(human.status, 0, human.stderr);
      assert.equal(human.stderr, "");
      assert.ok(human.stdout.includes(`Installed GoalBuddy Codex plugin ${version}`));
      assert.match(human.stdout, /Restart Codex, then use:\n  \$goal-prep/);
      assert.match(human.stdout, /Goal surface:/);
      assert.deepEqual(readFileSync(join(home, "plugins", "cache", "goalbuddy", "goalbuddy", version, "skills", "goal-prep", "SKILL.md")), readFileSync(join(packageRoot, "goalbuddy", "SKILL.md")));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("aggregate cache refusal stays quiet while a successful Claude target receives its own next steps", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-human-partial-"));
  try {
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    const conflict = join(codex, "plugins", "cache", "goalbuddy", "goalbuddy", version);
    mkdirSync(resolve(conflict, ".."), { recursive: true });
    writeFileSync(conflict, "unrelated user file\n");
    chmodSync(conflict, 0o640);
    const before = installedFileSnapshot(codex);
    const env = missingCliEnv(root, "claude");
    assert.equal(run(["install", "--target", "claude", "--claude-home", claude], env).status, 0);
    for (const route of [[], ["install"], ["update"]]) {
      const args = [...route, "--codex-home", codex, "--claude-home", claude];
      const human = runHuman(args, env);
      assert.equal(human.status, 1);
      assert.equal(human.stderr, "", "quiet Codex formatting belongs to the aggregate reporter");
      assert.match(human.stdout, /Codex: not completed/);
      assert.ok(human.stdout.includes(conflict));
      assert.doesNotMatch(human.stdout, /Installed GoalBuddy Codex|Restart Codex|\$goal-prep/);
      assert.match(human.stdout, /Restart Claude Code, then run: \/goal-prep/);
      const json = run(args, env);
      assert.equal(json.status, 1);
      assert.equal(json.stderr, "");
      assert.equal(json.json.ok, false);
      assert.equal(json.json.codex.result.error.code, "CACHE_INSPECTION_FAILED");
      assert.equal(json.json.claude.result.ok, true);
      assert.deepEqual(json.json.errors.map(({ target }) => target), ["codex"]);
      assert.deepEqual(installedFileSnapshot(codex), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("available native Codex cannot delete protected cache directories or sibling files", () => {
  for (const kind of ["invalid-directory", "invalid-file", "valid-segment-file"]) {
    const root = mkdtempSync(join(tmpdir(), "goalbuddy-cache-protection-"));
    try {
      const home = join(root, "codex");
      assert.equal(run(["install", "--target", "codex", "--codex-home", home], missingCliEnv(root, "codex")).status, 0);
      const native = destructiveCodexEnv(root);
      assert.equal(spawnSync(process.execPath, [native.script, "--version"]).status, 0);
      const versions = join(home, "plugins", "cache", "goalbuddy", "goalbuddy");
      const kept = join(versions, kind === "valid-segment-file" ? "scratch" : "notes for me");
      if (kind === "invalid-directory") mkdirSync(kept);
      const sentinel = kind === "invalid-directory" ? join(kept, "user.txt") : kept;
      writeFileSync(sentinel, "unrelated user bytes\n");
      chmodSync(sentinel, 0o640);
      const mode = statSync(sentinel).mode;
      // These are valid directory segments, including the word scratch; they remain pruneable.
      for (const stale of kind === "valid-segment-file" ? ["9.9.9"] : ["9.9.9", "scratch"]) {
        mkdirSync(join(versions, stale));
        writeFileSync(join(versions, stale, "stale.txt"), "old version\n");
      }
      writeFileSync(native.calls, "");
      const response = run(["update", "--target", "codex", "--codex-home", home], native.env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action: "update", target: "codex", model: "bundled-copy" });
      assert.equal(response.json.result.fallback.used, true);
      assert.match(response.json.result.fallback.reason, /skipped to preserve cache entries/);
      assert.ok(response.json.result.fallback.reason.includes(kept));
      assert.equal(readFileSync(native.calls, "utf8"), "", "native CLI must not be called before preservation is secured");
      assert.equal(readFileSync(sentinel, "utf8"), "unrelated user bytes\n");
      assert.equal(statSync(sentinel).mode, mode);
      assert.equal(existsSync(join(versions, "9.9.9")), false);
      if (kind !== "valid-segment-file") assert.equal(existsSync(join(versions, "scratch")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("unproven Codex cache inspection fails before native or bundled mutation", () => {
  for (const kind of ["version-file", "ancestor-file", "inspection-error"]) {
    const root = mkdtempSync(join(tmpdir(), "goalbuddy-cache-inspection-"));
    try {
      const home = join(root, "codex");
      assert.equal(run(["install", "--target", "codex", "--codex-home", home], missingCliEnv(root, "codex")).status, 0);
      const versions = join(home, "plugins", "cache", "goalbuddy", "goalbuddy");
      const native = destructiveCodexEnv(root);
      assert.equal(spawnSync(process.execPath, [native.script, "--version"]).status, 0);
      writeFileSync(native.calls, "");
      const env = { ...native.env };
      if (kind === "inspection-error") {
        const preload = join(root, "inspection-error.cjs");
        writeFileSync(preload, `const fs = require("node:fs"); const original = fs.readdirSync; fs.readdirSync = function(p, ...args) { if (p === ${JSON.stringify(versions)}) throw Object.assign(new Error("injected unreadable cache"), { code: "EACCES" }); return original.call(this, p, ...args); }; require("node:module").syncBuiltinESMExports();`);
        env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
      } else {
        const blocked = kind === "version-file" ? join(versions, version) : versions;
        rmSync(blocked, { recursive: true });
        writeFileSync(blocked, "unproven user data\n");
      }
      const before = installedFileSnapshot(home);
      const response = run(["update", "--target", "codex", "--codex-home", home], env);
      assert.equal(response.status, 1, response.stderr || response.stdout);
      assert.equal(response.json.installed, false);
      assert.equal(response.json.result.error.code, "CACHE_INSPECTION_FAILED");
      assert.equal(response.json.result.proof.checks[0].ok, false);
      assert.equal(readFileSync(native.calls, "utf8"), "");
      assert.deepEqual(installedFileSnapshot(home), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

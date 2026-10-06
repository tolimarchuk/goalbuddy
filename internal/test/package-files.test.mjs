import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const canonicalPrefix = "goalbuddy/";
const pluginPrefix = "plugins/goalbuddy/skills/goal-prep/";

test("release history stays in one running changelog", () => {
  assert.deepEqual(readdirSync("docs/releases").sort(), ["README.md"]);

  const changelog = readFileSync("CHANGELOG.md", "utf8");
  assert.match(changelog, /single, running release history/);
  assert.match(changelog, /Do not create separate versioned changelog files/);
  assert.match(changelog, /Never include client, customer, company, donor, or private project names/);

  for (const version of [
    "0.4.3", "0.4.2", "0.4.1", "0.4.0",
    "0.3.9", "0.3.8", "0.3.7", "0.3.6", "0.3.5", "0.3.2", "0.3.1", "0.3.0",
    "0.2.22", "0.2.21", "0.2.20", "0.2.19", "0.2.18", "0.2.17", "0.2.16",
    "0.2.15", "0.2.14", "0.2.13", "0.2.12", "0.2.11", "0.2.10",
  ]) {
    assert.match(changelog, new RegExp(`^## ${version}:`, "m"), `missing GoalBuddy ${version}`);
  }

  assert.match(changelog, /^## Goal Maker Package History$/m);
  for (const version of ["0.2.10", "0.2.9", "0.2.8", "0.2.7", "0.2.6", "0.2.5", "0.2.1", "0.2.0", "0.1.4", "0.1.3", "0.1.2", "0.1.1", "0.1.0"]) {
    assert.match(changelog, new RegExp(`^### ${version}:`, "m"), `missing Goal Maker ${version}`);
  }

  for (const image of [
    "goalbuddy-v0.4.0-release.png",
    "goalbuddy-v0.3.7-release.png",
    "goalbuddy-v0.3.5-release.png",
    "goalbuddy-v0.3.0-release.png",
  ]) {
    assert.match(changelog, new RegExp(`internal/assets/${image.replaceAll(".", "\\.")}`));
  }
});

test("packed canonical and plugin skill trees stay complete and aligned", () => {
  const pack = runNpm(["pack", "--dry-run", "--json"]);
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);

  const files = JSON.parse(pack.stdout)[0].files.map((file) => file.path);
  const canonicalFiles = relativePackedFiles(files, canonicalPrefix);
  const pluginFiles = relativePackedFiles(files, pluginPrefix);

  assert.ok(files.includes("goalbuddy/references/goal-execution.md"));
  assert.ok(canonicalFiles.includes("SKILL.md"));
  assert.ok(canonicalFiles.includes("scripts/render-task-prompt.mjs"));
  assert.deepEqual(canonicalFiles, pluginFiles);
});

test("the packed npm artifact ships the Claude plugin contract and role agents", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-packed-install-"));
  try {
    const pack = runNpm(["pack", "--json", "--pack-destination", root]);
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const tarball = resolve(root, JSON.parse(pack.stdout)[0].filename);
    const packageRoot = join(root, "package-root");
    const install = runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      packageRoot,
      tarball,
    ]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    // Claude Code installs GoalBuddy as a native plugin, so what matters is that the published
    // artifact carries a complete plugin tree for the `claude` CLI to install from.
    const extractedRoot = join(packageRoot, "node_modules", "goalbuddy");
    const pluginRoot = join(extractedRoot, "plugins", "goalbuddy");

    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "goalbuddy");
    assert.equal(manifest.version, JSON.parse(readFileSync(join(extractedRoot, "package.json"), "utf8")).version);

    assert.equal(existsSync(join(pluginRoot, "commands", "goalbuddy.md")), true);
    assert.equal(existsSync(join(pluginRoot, "commands", "goal.md")), false);

    const packedContract = join(pluginRoot, "skills", "goal-prep", "references", "goal-execution.md");
    assert.equal(existsSync(packedContract), true);
    assert.match(readFileSync(packedContract, "utf8"), /governs Codex `\/goal` and Claude Code `\/goalbuddy` runs/);
    for (const file of ["goal-judge.md", "goal-scout.md", "goal-worker.md"]) {
      assert.equal(existsSync(join(pluginRoot, "agents", file)), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function relativePackedFiles(files, prefix) {
  return files
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .sort();
}

function runNpm(args) {
  return spawnSync("npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, GOALBUDDY_SKIP_POSTINSTALL: "1" },
  });
}

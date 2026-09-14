import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { npmCliPath, spawnNpm } from "../cli/npm-command.mjs";

const script = resolve("internal/cli/check-package-identity.mjs");

for (const autocrlf of ["false", "true"]) {
  test(`package identity compares extracted file lists and SHA-256 hashes (core.autocrlf=${autocrlf})`, () => {
    const root = mkdtempSync(join(tmpdir(), "goalbuddy identity & shell; $test-"));
    try {
      writePackage(root, "tag content\n");
      git(root, "init");
      git(root, "config", "--local", "core.autocrlf", autocrlf);
      // These fixtures promise exact bytes. Git archive otherwise applies the
      // caller's text conversion and turns LF blobs into CRLF on Windows.
      writeFileSync(join(root, ".gitattributes"), "package.json -text\npayload.txt -text\n");
      git(root, "add", ".gitattributes", "package.json", "payload.txt");
      git(root, "-c", "user.name=GoalBuddy Tests", "-c", "user.email=tests@example.invalid", "commit", "-m", "fixture");
      git(root, "tag", "v1.0.0");

      const registry = join(root, "registry & literal; $spec");
      mkdirSync(registry);
      writePackage(registry, "tag content\n");
      const matching = check(root, registry);
      assert.equal(matching.status, 0, matching.stderr || matching.stdout);
      assert.equal(JSON.parse(matching.stdout).ok, true);

      for (const payload of ["tag content\r\n", "different registry content\n"]) {
        writeFileSync(join(registry, "payload.txt"), payload);
        const mismatching = check(root, registry);
        assert.equal(mismatching.status, 1, mismatching.stderr || mismatching.stdout);
        const report = JSON.parse(mismatching.stdout);
        assert.equal(report.ok, false);
        assert.deepEqual(report.only_in_package, []);
        assert.deepEqual(report.only_in_tag, []);
        assert.deepEqual(report.changed, [{
          path: "payload.txt",
          package_sha256: createHash("sha256").update(payload).digest("hex"),
          tag_sha256: createHash("sha256").update("tag content\n").digest("hex"),
        }]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("tarball manifest records every packaged file hash", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-manifest-test-"));
  try {
    writePackage(root, "candidate\n");
    const packed = spawnNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.error?.message || packed.stderr);
    const tarball = join(root, JSON.parse(packed.stdout)[0].filename);
    const manifest = join(root, "manifest.json");
    const result = spawnSync(process.execPath, [script, "--tarball", tarball, "--manifest", manifest], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const written = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(written.algorithm, "sha256");
    assert.deepEqual(written.files.map((file) => file.path), ["package.json", "payload.txt"]);
    assert.ok(written.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm launch works outside an npm lifecycle and preserves pack and spawn failures", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy npm & errors-"));
  try {
    const env = { ...process.env };
    delete env.npm_execpath;
    const version = spawnNpm(["--version"], { cwd: root, env, encoding: "utf8" });
    assert.equal(version.status, 0, version.error?.message || version.stderr);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const failed = spawnNpm(["pack", "--ignore-scripts", "--json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(typeof failed.status, "number", failed.error?.message);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /ENOENT|package\.json/);

    const missingCwd = spawnNpm(["--version"], { cwd: join(root, "absent"), env, encoding: "utf8" });
    assert.equal(missingCwd.status, null);
    assert.equal(missingCwd.error?.code, "ENOENT");

    const identity = check(root, root, env);
    assert.equal(identity.status, 1);
    assert.match(identity.stderr, /Package identity check failed: npm pack[\s\S]*package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm selection follows PATH order unless a valid lifecycle entry is explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy competing npm & tools-"));
  try {
    const actualNpm = npmCliPath();
    const calls = join(root, "calls.jsonl");
    // Two small installation layouts forward to real npm and record which entry
    // was executed. No alternate npm download or shell execution is needed.
    const entries = ["first", "second"].map((name) => {
      const bin = join(root, name);
      const entry = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, `require("node:fs").appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${name}\n`)});\nrequire(${JSON.stringify(actualNpm)});\n`);
      if (process.platform === "win32") writeFileSync(join(bin, "npm.cmd"), "@rem npm JS entry is adjacent under node_modules\\npm\\bin\r\n");
      else symlinkSync(entry, join(bin, "npm"));
      return { bin, entry: realpathSync(entry) };
    });
    const env = { ...process.env, PATH: entries.map(({ bin }) => bin).join(delimiter) };
    delete env.npm_execpath;
    for (const [expected, changes] of [
      [0, {}],
      [1, { PATH: [...entries].reverse().map(({ bin }) => bin).join(delimiter) }],
      [1, { npm_execpath: entries[1].entry }],
    ]) {
      const selectedEnv = { ...env, ...changes };
      assert.equal(npmCliPath(selectedEnv), entries[expected].entry);
      const result = spawnNpm(["--version"], { cwd: root, env: selectedEnv, encoding: "utf8" });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
    }
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["first", "second", "second"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function check(cwd, packageDir, env = process.env) {
  return spawnSync(process.execPath, [script, "--package", packageDir, "--git-ref", "v1.0.0"], { cwd, env, encoding: "utf8" });
}

function writePackage(root, payload) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "identity-fixture", version: "1.0.0", files: ["payload.txt"] }, null, 2)}\n`);
  writeFileSync(join(root, "payload.txt"), payload);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

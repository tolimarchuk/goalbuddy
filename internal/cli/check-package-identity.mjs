#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnNpm } from "./npm-command.mjs";

try {
  main();
} catch (error) {
  process.stderr.write(`Package identity check failed: ${error.message}\n`);
  process.exitCode = 1;
}

export function compareManifests(packageFiles, tagFiles) {
  const packageByPath = new Map(packageFiles.map((file) => [file.path, file]));
  const tagByPath = new Map(tagFiles.map((file) => [file.path, file]));
  const onlyInPackage = [...packageByPath.keys()].filter((path) => !tagByPath.has(path)).sort();
  const onlyInTag = [...tagByPath.keys()].filter((path) => !packageByPath.has(path)).sort();
  const changed = [...packageByPath.keys()]
    .filter((path) => tagByPath.has(path) && packageByPath.get(path).sha256 !== tagByPath.get(path).sha256)
    .sort()
    .map((path) => ({
      path,
      package_sha256: packageByPath.get(path).sha256,
      tag_sha256: tagByPath.get(path).sha256,
    }));
  return { only_in_package: onlyInPackage, only_in_tag: onlyInTag, changed };
}

function manifestTarball(tarball) {
  if (!lstatSync(tarball).isFile()) fail(`Not a tarball file: ${tarball}`);
  const extractRoot = mkdtempSync(join(tmpdir(), "goalbuddy-package-extract-"));
  try {
    run("tar", ["-xzf", tarball, "-C", extractRoot], process.cwd());
    const packageRoot = join(extractRoot, "package");
    if (!lstatSync(packageRoot).isDirectory()) fail(`Tarball has no package/ root: ${tarball}`);
    return walkFiles(packageRoot).map((path) => {
      const bytes = readFileSync(path);
      return {
        path: relative(packageRoot, path).split(sep).join("/"),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else fail(`Package contains unsupported non-file entry: ${path}`);
  }
  return files;
}

function packSpec(spec, destination, cwd) {
  mkdirSync(destination, { recursive: true });
  const result = run("npm", ["pack", spec, "--ignore-scripts", "--json", "--pack-destination", destination], cwd);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`npm pack did not return JSON for ${spec}:\n${result.stdout}`);
  }
  if (!Array.isArray(report) || report.length !== 1 || !report[0].filename) fail(`npm pack returned an unexpected result for ${spec}.`);
  return join(destination, basename(report[0].filename));
}

function writeManifest(path, manifest) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ algorithm: "sha256", files: manifest }, null, 2)}\n`);
}

function run(command, commandArgs, cwd) {
  const options = { cwd, encoding: "utf8", shell: false };
  const result = command === "npm" ? spawnNpm(commandArgs, options) : spawnSync(command, commandArgs, options);
  if (result.status !== 0) {
    const cause = result.error?.message || result.stderr || result.stdout || `signal ${result.signal || "unknown"}`;
    fail(`${command} ${commandArgs.join(" ")} failed (status ${result.status}):\n${cause}`);
  }
  return result;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--package", "--git-ref", "--tarball", "--manifest"].includes(flag) || !value) fail(`Unknown or incomplete option: ${flag}`);
    const key = flag === "--git-ref" ? "gitRef" : flag.slice(2);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function fail(message) {
  throw new Error(message);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.tarball) {
    const manifest = manifestTarball(resolve(args.tarball));
    if (args.manifest) writeManifest(resolve(args.manifest), manifest);
    process.stdout.write(`${JSON.stringify({ ok: true, tarball: resolve(args.tarball), files: manifest }, null, 2)}\n`);
    return;
  }
  if (!args.package || !args.gitRef) {
    fail("Usage: check-package-identity.mjs --package <npm-spec> --git-ref <ref> [--manifest <path>]\n       check-package-identity.mjs --tarball <path> --manifest <path>");
  }

  const scratch = mkdtempSync(join(tmpdir(), "goalbuddy-package-identity-"));
  try {
    const registryTarball = packSpec(args.package, join(scratch, "registry-pack"), process.cwd());
    const tagSource = join(scratch, "tag-source");
    mkdirSync(tagSource, { recursive: true });
    run("git", ["archive", "--format=tar", `--output=${join(scratch, "tag.tar")}`, args.gitRef], process.cwd());
    run("tar", ["-xf", join(scratch, "tag.tar"), "-C", tagSource], process.cwd());
    const tagTarball = packSpec(".", join(scratch, "tag-pack"), tagSource);

    const registry = manifestTarball(registryTarball);
    const tag = manifestTarball(tagTarball);
    const comparison = compareManifests(registry, tag);
    const report = {
      ok: comparison.only_in_package.length === 0 && comparison.only_in_tag.length === 0 && comparison.changed.length === 0,
      package_spec: args.package,
      git_ref: args.gitRef,
      package_file_count: registry.length,
      tag_file_count: tag.length,
      ...comparison,
    };
    if (args.manifest) writeManifest(resolve(args.manifest), registry);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

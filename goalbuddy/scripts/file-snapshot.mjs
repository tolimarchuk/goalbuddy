// Content/state observation within an explicit boundary; not a sandbox or attribution.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const portable = path => path.split(sep).join("/");
export function insidePath(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function localPath(root, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Expected a relative local path: ${path}`);
  const absolute = resolve(root, path);
  if (!insidePath(root, absolute)) throw new Error(`Path escapes root: ${path}`);
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path is not verifiable: ${path}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return absolute;
}

function hashFile(path) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try { for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

export function snapshotPaths(root, paths, { metadata = false, allowGit = false, recurse = true } = {}) {
  const files = new Map();
  function visit(path) {
    const name = portable(relative(root, path));
    if (files.has(name)) return;
    for (let parent = dirname(path); insidePath(root, parent) && parent !== root; parent = dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) throw new Error(`Symlink ancestor prevents source inspection: ${name}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!allowGit && name.split("/").includes(".git")) throw new Error(`Git metadata is not an artifact: ${name}`);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; files.set(name, null); return; }
    const entry = { mode: stat.mode };
    if (stat.isDirectory()) {
      entry.type = "directory";
      files.set(name, JSON.stringify(entry));
      if (recurse) for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      if (stat.isSymbolicLink()) { entry.type = "symlink"; entry.target = readlinkSync(path); }
      else if (stat.isFile()) { entry.type = "file"; entry.sha256 = hashFile(path); }
      else throw new Error(`Unsupported file state: ${name}`);
      if (metadata) Object.assign(entry, { mtime: stat.mtimeMs, ctime: stat.ctimeMs, inode: stat.ino, links: stat.nlink });
      files.set(name, JSON.stringify(entry));
    }
    const after = lstatSync(path);
    if (stat.ctimeMs !== after.ctimeMs || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error(`Path changed during inspection: ${name}`);
  }
  for (const path of paths) visit(path);
  return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function matchesPattern(file, pattern) {
  const normalized = String(pattern || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const source = normalized.split("**").map(part => part.split("*").map(value => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("[^/]*")).join(".*");
  return Boolean(normalized) && new RegExp(`^${source}$`).test(file);
}

export function goalControlPaths(boardPath) {
  const root = resolve(boardPath, "..");
  return ["state.yaml", "goal.md", "notes", "subgoals", ".goalbuddy-board"].map(name => join(root, name));
}

export function gitSnapshot(cwd = process.cwd(), { boardPath, admitted = [], previousPaths = [] } = {}) {
  try {
    // Native resolution expands Windows short names before comparing Git and
    // filesystem identities. Keep source symlink checks below lexical.
    cwd = realpathSync.native(cwd);
    if (boardPath) boardPath = realpathSync.native(boardPath);
    const git = args => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      if (result.error || result.status !== 0) throw new Error(`Git inspection failed (${args.join(" ")}): ${result.error?.message || result.stderr.trim()}`);
      return result.stdout;
    };
    const root = realpathSync.native(git(["rev-parse", "--show-toplevel"]).trim());
    const gitDir = realpathSync.native(git(["rev-parse", "--absolute-git-dir"]).trim());
    const commonDir = realpathSync.native(resolve(cwd, git(["rev-parse", "--git-common-dir"]).trim()));
    const semantics = () => ({
      head: git(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]),
      index: git(["ls-files", "--stage", "-v", "-z"]),
      refs: git(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    });
    const initial = semantics();
    const index = new Map();
    for (const line of initial.index.split("\0").filter(Boolean)) {
      const tab = line.indexOf("\t");
      if (tab < 0) throw new Error("Unreadable Git index entry.");
      if (/^. 160000 /.test(line)) throw new Error("Submodule contents require separate observation; scope is unproven.");
      const path = line.slice(tab + 1);
      index.set(path, `${index.get(path) || ""}${line.slice(0, tab)}\n`);
    }
    const others = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0").filter(Boolean);
    const paths = new Set([...index.keys(), ...others, ...previousPaths]);
    const patterns = admitted.filter(value => typeof value === "string").map(value => portable(relative(root, resolve(cwd, value))));
    const controls = boardPath ? goalControlPaths(boardPath) : [];
    const includedIgnored = new Set();
    // Only descend into ignored directories explicitly admitted by the card, or goal controls.
    function admit(path, force = false) {
      const name = portable(relative(root, path));
      if (!insidePath(root, path) || name.split("/").includes(".git")) throw new Error(`Admitted path is outside source observation: ${name}`);
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; paths.add(name); return; }
      const covered = force || patterns.some(pattern => matchesPattern(name, pattern));
      if (covered) { paths.add(name); includedIgnored.add(name); }
      const mayContainMatch = patterns.some(pattern => {
        const prefix = pattern.split("*")[0];
        return prefix.startsWith(`${name}/`) || name.startsWith(prefix);
      });
      if (stat.isDirectory() && (force || covered || mayContainMatch)) {
        for (const child of readdirSync(path)) admit(join(path, child), force);
      }
    }
    for (const path of controls) if (existsSync(path)) admit(path, true);
    // Other standard goal directories are PM-owned even if ignored.
    if (existsSync(join(root, "docs/goals"))) admit(join(root, "docs/goals"), true);
    for (const name of ignored) admit(join(root, name));
    for (const pattern of patterns) if (!pattern.includes("*")) admit(resolve(root, pattern), true);
    for (const name of [...paths]) {
      for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) paths.add(portable(parent));
    }
    const files = snapshotPaths(root, [...paths].map(path => join(root, path)), { metadata: true, recurse: false });
    // A disappearing required source path stays in the comparison, even if newly ignored.
    for (const [path, entry] of index) files.set(path, `${files.get(path) ?? "missing"}\nindex:${entry}`);
    files.set(".git/HEAD-semantics", initial.head);
    files.set(".git/refs-semantics", initial.refs);
    function control(base, name, label) {
      for (const [path, entry] of snapshotPaths(base, [join(base, name)], { allowGit: true })) files.set(`${label}/${path}`, entry);
    }
    for (const name of ["HEAD", "commondir", "config.worktree", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) control(gitDir, name, ".git/worktree");
    for (const name of ["config", "info/exclude", "info/attributes", "hooks"]) control(commonDir, name, ".git/common");
    const marker = join(root, ".git");
    if (existsSync(marker) && !lstatSync(marker).isDirectory()) for (const [, entry] of snapshotPaths(root, [marker], { metadata: true, allowGit: true })) files.set(".git", entry);
    if (JSON.stringify(initial) !== JSON.stringify(semantics())) throw new Error("Git semantics changed during inspection.");
    return { ok: true, root, gitDir, commonDir, files, sourcePaths: [...paths], observation: {
      policy: "source-and-controls-v1",
      claim: "No unauthorized changes in observed source/control paths and semantic Git state.",
      excluded_ignored_paths: ignored,
      admitted_ignored_paths: [...includedIgnored].filter(path => ignored.some(ignoredPath => path === ignoredPath || path.startsWith(ignoredPath))).sort(),
      git_exclusions: ["object database", "reflogs", "index stat cache", "other worktrees' private state"],
      external_paths: "not observed; symlink targets are not followed",
    } };
  } catch (error) { return { ok: false, error: error.message }; }
}

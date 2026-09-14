import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// npm.cmd is a shell script, not a spawnable Windows executable. Resolve npm's
// JS entry instead so package specs and paths remain separate, literal arguments.
export function npmCliPath(env = process.env) {
  const nodeBin = dirname(process.execPath);
  const candidates = [env.npm_execpath];
  const path = env.PATH ?? env.Path ?? "";
  for (const bin of path.split(delimiter).filter(Boolean)) {
    candidates.push(join(bin, "npm"), join(bin, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  // Honor the lifecycle/PATH toolchain before trying Node's bundled npm.
  candidates.push(
    join(nodeBin, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const resolved = realpathSync(candidate);
      if (basename(resolved) === "npm-cli.js" && statSync(resolved).isFile()) return resolved;
    } catch {
      // Try the other standard npm installation locations.
    }
  }
  throw new Error("Cannot locate npm-cli.js. Run through npm or use a Node installation that includes npm.");
}

export function spawnNpm(args, options = {}) {
  return spawnSync(process.execPath, [npmCliPath(options.env ?? process.env), ...args], { ...options, shell: false });
}

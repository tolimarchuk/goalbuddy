// Real native Node children stand in for harness/Git executables on every OS.
// No shell mutation language; the callback performs the filesystem operation.
import { appendFileSync, chmodSync, existsSync, constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function fakeCommandBin(root, name, body) {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  if (process.platform === 'win32') {
    if (!existsSync(executable)) copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE);
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, name + '.cjs'))} "$@"\n`);
    chmodSync(executable, 0o755);
  }
  writeFileSync(join(bin, 'bootstrap.cjs'), `const fs = require('node:fs'), path = require('node:path');
const body = path.join(__dirname, path.basename(process.execPath).replace(/\\.exe$/i, '') + '.cjs');
if (fs.existsSync(body)) { require(body); process.exit(process.exitCode || 0); }
`);
  writeFileSync(join(bin, name + '.cjs'), `const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const nativeFixture = path.basename(process.execPath) === ${JSON.stringify(name + '.exe')};
const args = process.argv.slice(nativeFixture ? 1 : 2);
// Node expands its script operand before preloads. The fake native tool's first
// operand is a subcommand, so restore that literal word before forwarding Git.
if (nativeFixture && args.length) args[0] = path.basename(args[0]);
const git = (args, options = {}) => { const r = cp.spawnSync('git', args, {encoding:'utf8', ...options}); if(r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message); return r.stdout; };
${body}\n`);
  // Native executable bytes are fixture infrastructure, not observed source.
  const located = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8' });
  if (located.status === 0) {
    const exclude = resolve(root, located.stdout.trim());
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!text.includes('/fake-bin/')) appendFileSync(exclude, '\n/fake-bin/\n');
  }
  return bin;
}

export function fixtureEnv(bin, extra = {}) {
  return { ...process.env, ...extra, PATH: `${bin}${delimiter}${extra.PATH ?? process.env.PATH}`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${join(bin, 'bootstrap.cjs').replaceAll('\\', '/')}"`.trim() };
}

export const realGit = (process.env.PATH || '').split(delimiter).map(dir => join(dir, process.platform === 'win32' ? 'git.exe' : 'git')).find(existsSync);
export const forwardGit = `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}); process.exit(r.status ?? 1);`;

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// File-management fixtures only: these are not native client/model canaries.
export function writeCliFixture(bin, name, body) {
  mkdirSync(bin, { recursive: true });
  const script = join(bin, `${name}.cjs`);
  writeFileSync(script, `${body}\n`);
  if (process.platform === "win32") {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const launcher = join(bin, name);
    writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return script;
}

# Release Process

The repository has one canonical, running release history: [CHANGELOG.md](../../CHANGELOG.md). Add every future release to the top of that file. Do not create a separate `docs/releases/<version>.md` file.

This directory contains the release process only. Published GitHub Releases remain immutable public snapshots and should use the matching section of `CHANGELOG.md` as their source copy.

Keep every changelog section and GitHub Release body client-safe. Describe the observed behavior generically and never include client, customer, company, donor, or private project names. Public contributor attribution is allowed.

GoalBuddy publishes the `goalbuddy` npm package from GitHub Actions using npm trusted publishing. This avoids long-lived npm write tokens and lets npm generate provenance for future releases.

## One-Time npm Setup

Configure this on npmjs.com for the `goalbuddy` package:

- Publisher: GitHub Actions
- GitHub owner/user: `tolimarchuk`
- Repository: `goalbuddy`
- Workflow filename: `npm-publish.yml`
- Package: `goalbuddy`

The workflow path in this repo is:

```text
.github/workflows/npm-publish.yml
```

Or configure the same trust relationship from the npm CLI:

```bash
npx --yes npm@^11.15.0 trust github goalbuddy \
  --repo tolimarchuk/goalbuddy \
  --file npm-publish.yml \
  --allow-publish \
  --yes
```

This command requires npm owner authentication and may print an `EOTP` browser/OTP URL. Complete that npm authentication step, then rerun the same command if needed. npm `11.15.0` or newer is required for `npm trust`, and `--allow-publish` explicitly limits the relationship to package publishing.

After the trusted publisher works, use npm package settings to require 2FA and disallow tokens for publishing. Keep `goal-maker` published during the migration window.

Starting in `0.3.0`, the installer is target-aware: `npx goalbuddy` installs into both `~/.codex/` and `~/.claude/`, and `goalbuddy update` refreshes both by default. Use `--target codex` or `--target claude` to narrow a command. Both targets share the same `goalbuddy/` skill payload and are exercised by the test suite under `internal/test/`.

## Release Flow

1. Confirm the version is unused with `npm view goalbuddy versions --json` and `npm view goalbuddy version`. Check safe owner access with `npm whoami`. Select the version locally; that does not authorize publishing. Update `package.json` and both plugin manifests together. The marketplaces use local plugin references and do not carry separate versions.
2. Add the candidate at the top of `CHANGELOG.md` with **Unreleased; publication pending**. Consolidate unpublished candidate notes into it; never invent a historical release or edit published sections. For 0.5.0, include the completion behavior change and [migration instructions](../../README.md#upgrading-to-050).
3. Run local checks, inspect the complete tarball file list and preserve its SHA-256 and extracted manifest:

```bash
npm run check
node internal/cli/sync-skill-tree.mjs
npm run pack:dry-run
node internal/cli/check-publish-version.mjs
npm pack --ignore-scripts --json --pack-destination <scratch>
node internal/cli/check-package-identity.mjs --tarball <scratch>/goalbuddy-0.5.0.tgz --manifest <scratch>/manifest.json
```

The identity gate compares packaged paths and SHA-256 content. Also inspect file modes, canonical/plugin parity, dependency-free runtime and exclusion of private/task/client artifacts. Check syntax for each JavaScript file individually. Test the declared Node 18 floor and workflow Node 24. The test workflow prepares Ubuntu and Windows jobs on Node 18 and Node 24. Require the actual candidate Windows jobs, including command-shim and installer checks, to pass before release; macOS tests do not establish Windows behavior.

4. Exercise the packed CLI with explicit `--codex-home <scratch>/codex` and `--claude-home <scratch>/claude`. Set native `CODEX_HOME` and `CLAUDE_CONFIG_DIR` to the same disposable targets, keep any plugin-cache override inside scratch, and verify isolation before native operations. Check install/update, fallback, exact contents/version, doctor, downgrade, partial failure and reset with unrelated/modified sentinels. No real-home installation is needed for release verification. File readback, native plugin reporting and a model loading the candidate are separate claims; an exit code or stale login status alone proves none of them.
5. Have the release owner review and commit the accepted source, retain contributor ancestry, and run the full suite on the exact commit. Before an authorized public tag exists, compare against that commit:

```bash
node internal/cli/check-package-identity.mjs --package <scratch>/goalbuddy-0.5.0.tgz --git-ref <accepted-release-commit>
```

A disposable private Git fixture can test an uncommitted candidate, but it is provisional evidence. It does not replace this exact-commit check or public tag identity.

6. Only with publication authority, push the accepted commit, create the matching immutable `v0.5.0` tag and publish the GitHub release from the changelog copy. The release-only workflow checks tag/version and package/tag identity before npm publication. Confirm its exact commit and Node 18/24 CI results. The date stays pending until npm publication is observed; record the actual publication date afterward in a follow-up changelog commit, without moving the tag or repacking the release.
7. Confirm the workflow and read back the immutable registry version against the tag:

```bash
npm view goalbuddy@0.5.0 name version dist repository bin --json
npm view goalbuddy dist-tags --json
node internal/cli/check-package-identity.mjs --package goalbuddy@0.5.0 --git-ref v0.5.0 --manifest <scratch>/published-manifest.json
```

Check public tag/commit, npm tarball integrity and provenance, `latest`, workflow result and installed CLI behavior. A published version with failed readback is a release-integrity incident, not a successful release. Close artifact-integrity issues only after this public evidence exists.

## Authentication and Recovery

An `E401` from `npm whoami`, or `E401`/`E403`/`E404` after a publish tarball is built, requires owner authentication/permission investigation first. The owner should run `npm login` for the correct account, verify `npm whoami`, and inspect the package's publisher permissions. Do not bump versions or repeatedly run plain `npm publish` to repair authentication. The package already declares public access.

Do not rewrite published versions, tags, receipts or completion evidence. If publication did not occur, repair and revalidate the pending candidate. Once a version is public, use a separately reviewed versioned forward fix; preserve the failed artifact and readback evidence. A downgrade can restore older code but cannot make historical completion claims satisfy the 0.5.0 protocol. Trusted-publisher changes and external recovery actions remain owner-authorized operations.

## Provenance Expectations

npm trusted publishing requires a GitHub-hosted runner, Node `22.14.0` or newer, npm `11.5.1` or newer, and `id-token: write` workflow permission. The release workflow uses Node 24 and grants the OIDC permission required by npm.

When publishing through trusted publishing from this public repo to the public `goalbuddy` package, npm should generate provenance automatically. The workflow intentionally runs `npm publish` without `NODE_AUTH_TOKEN`; npm exchanges the GitHub OIDC identity for a short-lived publish credential.

## Compatibility Package

Do not unpublish `goal-maker`. During the 60-90 day compatibility window, `npx goal-maker` should continue to work and point users to:

```bash
npx goalbuddy
```

After the compatibility window:

```bash
npm deprecate goal-maker "Renamed to goalbuddy. Use: npx goalbuddy"
```

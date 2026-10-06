# GoalBuddy Changelog

This is GoalBuddy's single, running release history. New releases go at the top. Do not create separate versioned changelog files under `docs/releases/`; that directory contains the release process only.

Dates are public npm publication dates. Historical entries describe the product as it behaved in that release, with explicit notes where a later release superseded the behavior.

Release history must describe product behavior with anonymized evidence. Never include client, customer, company, donor, or private project names. Public contributor handles may appear only for attribution.

## Unreleased

- **Codex installs through its own CLI.** `codex plugin add` now performs the install against the published marketplace, the same source the docs name, so the entry written into your `config.toml` stays portable. Codex stages the tree and renames it into place, prunes superseded versions, migrates the plugin's `commands/` into skills, and writes the config enablement, instead of GoalBuddy re-implementing those steps. When the `codex` CLI is missing or cannot install, the installer falls back to copying the bundled tree and says which model it used.
- **A downgrade no longer keeps the newer Codex plugin live.** Install removed only the version directory it was about to write, but Codex serves the highest version directory it finds under the plugin cache, so a directory left behind by a newer install kept being served. Install now prunes stale sibling version directories the way Codex's own installer does, and leaves directories that are not valid version segments alone.

## 0.4.3: Restore Claude's Native `/goal` (2026-08-05)

- **Claude Code keeps its native `/goal`.** GoalBuddy now installs its execution loop as `/goalbuddy`, removing the namespace collision introduced in 0.4.0.
- **Safe migration.** Install and update remove the old `~/.claude/commands/goal.md` only when its hash exactly matches the GoalBuddy-authored 0.4.0 through 0.4.2 command. Modified and user-authored files are preserved and reported as collisions for the owner to resolve.
- **Harness-specific handoffs.** Goal Prep, `init`, and `resume` now print Codex `/goal` and Claude Code `/goalbuddy` commands explicitly while both harnesses continue to share the same repo-native board.
- **Regression coverage.** Tests verify fresh installs, exact owned-command migration, user-file preservation, doctor collision detection, packed npm contents, and split continuation commands.
- **Published proof.** Node 18 and Node 24 CI passed, the trusted-publishing workflow completed, and npm promoted `goalbuddy@0.4.3` to `latest`.

Release: [v0.4.3](https://github.com/tolibear/goalbuddy/releases/tag/v0.4.3)

## 0.4.2: Honest Continuation State (2026-08-03)

- **Machine-checkable stop decisions.** `goalbuddy can-stop <goal>` fails closed while a valid active task remains and permits exit only for a receipt-backed complete outcome or the exact validated terminal approval wait.
- **Receipt transitions expose the continuation contract.** `goalbuddy receipt` returns `stop_allowed`, `continuation_required`, and `next_action` immediately after activating the next task.
- **The board no longer impersonates an executor.** The local surface identifies itself as a state viewer and reports executor status as `Not observed` unless the goal is complete or waiting. A healthy viewer is not evidence that work is running.
- **Native waits are durable and bounded.** A native `wait_agent` timeout is an observation window, not task failure. Role-aware windows keep live Scout, Judge, and Worker agents attached.
- **External deadlines remain terminal.** External CLI `dispatch --timeout` still terminates the child, reports failure, and includes post-timeout scope evidence so partial writes can be inspected safely.
- **Regression coverage.** Tests cover active-work stop rejection, complete and approval-wait exits, receipt-to-next-task continuation, honest board semantics, and the difference between native observation and external termination.

Release: [v0.4.2](https://github.com/tolibear/goalbuddy/releases/tag/v0.4.2)

## 0.4.1: Installed Contract Fixes (2026-07-18)

- **Complete npm skill payload.** The package ships the entire canonical `goalbuddy/` directory, including `references/goal-execution.md`, so npm and marketplace installs receive the same execution contract.
- **Packed-artifact verification.** Tests inspect npm's real packed file list, compare the canonical and plugin skill trees, install the tarball into a clean Claude home, and verify the contract is present.
- **Exact Claude Code role routing.** Prompts carry Codex `agent_type` and Claude Code `subagent_type` values for Scout, Worker, Judge, and PM. Generic `Explore` and `general-purpose` agents are not treated as substitutes.
- **Honest unknown state.** An `unknown` agent state requires one attempt with the exact harness-specific role before PM fallback.

Contributor thanks: `floke75` for reporting the npm omission and `Xpos587` for tracing Claude Code role routing.

Release: [v0.4.1](https://github.com/tolibear/goalbuddy/releases/tag/v0.4.1)

## 0.4.0: Cross-Harness Goals (2026-07-07)

![GoalBuddy 0.4.0: Cross-Harness Goals, one board, any agent](internal/assets/goalbuddy-v0.4.0-release.png)

- **Goals move between Codex and Claude Code.** The board is repo-native, `state.yaml` is the only truth, and `goalbuddy resume` discovers live boards without reconstructing state from chat history.
- **Mixed fleets.** `goalbuddy dispatch docs/goals/<slug> --to codex|claude-code` runs one task on another harness, extracts its receipt, and verifies that Worker changes stay inside `allowed_files` while read-only roles change nothing.
- **Field-tested workflow upgrades.** `goalbuddy init` scaffolds valid boards, `goalbuddy receipt` applies transitions atomically and fail-closed, Worker receipts record in-scope deviations, and judges copy planned file lists into `allowed_files` verbatim.
- **Prep and execution became explicit modes.** `SKILL.md` owns Goal Prep and the shared board model; `references/goal-execution.md` owns the execution loop.
- **Claude Code's skill name was corrected.** The install directory moved to `goal-prep`, matching `/goal-prep`, with automatic migration from the old `goalbuddy` skill directory.
- **Claude Code received a GoalBuddy `/goal` command.** This made the documented handoff concrete at the time, but it shadowed Claude's native `/goal`. Version 0.4.3 superseded this command with `/goalbuddy`.
- **Receipt contracts closed real failure gaps.** Done Worker receipts allow only passing commands, blocked receipts keep failing verification visible, Judge receipts can carry the next `worker_package`, and task IDs use the strict `T###` shape.
- **Board and CLI hardening.** Host and Origin checks guard local board access, degraded YAML remains visible, odd indentation can recover, settings merge safely, goal paths validate, config writes are atomic, and CLI option parsing is stricter across platforms.
- **Canonical skill drift guard.** `goalbuddy/` became canonical, `plugins/goalbuddy/skills/goal-prep/` became its generated byte-exact mirror, and CI began running on Node 18 and Node 24 for every push and pull request.

Release: [v0.4.0](https://github.com/tolibear/goalbuddy/releases/tag/v0.4.0)

## 0.3.9: Marketplace and Board Runtime Polish (2026-06-23)

- **Claude marketplace discovery.** A root `.claude-plugin/marketplace.json` made the existing plugin installable through Claude Code's marketplace flow.
- **Install-channel-neutral Goal Prep.** Model-invoked board, prompt, update, and parallel-plan operations use scripts bundled with the installed skill instead of assuming a shell-level `goalbuddy` binary.
- **Calmer live transitions.** Board watching coalesces rapid `state.yaml` writes so ordinary task switches do not flash transient active-task errors.
- **Parallel work stays visible.** The local board renders multiple active tasks while the stricter checker remains available for validation.
- **Exact approval waits.** A terminal waiting shape records `waiting_for_user_approval: true` and the precise required reply.
- **PM-owned board health.** The runtime guidance limits health repairs to GoalBuddy control files unless an active task explicitly permits product changes.

Release: [v0.3.9](https://github.com/tolibear/goalbuddy/releases/tag/v0.3.9)

## 0.3.8: Runtime Cleanup and Board Polish (2026-06-03)

- **Multi-board hub guardrails.** A missing `/slug/` route no longer implies that port `41737` is stale. Agents check `/api/boards` and register the new goal before considering process cleanup.
- **Readable board history.** Completed cards sort newest first, task cards use compact titles while retaining their complete objectives, and stale packaged examples were removed.
- **Safer CLI path handling.** Relative goal paths become absolute before child processes run, while non-path option values remain unchanged.
- **Runtime cleanup.** Codex reset removes only GoalBuddy-owned runtime surfaces, doctor distinguishes a fully removed install from residual agents, and prompt receipt schemas match the shipped agent contracts.

Release: [v0.3.8](https://github.com/tolibear/goalbuddy/releases/tag/v0.3.8)

## 0.3.7: Goalmaxxed (2026-05-19)

![GoalBuddy 0.3.7: Goalmaxxed](internal/assets/goalbuddy-v0.3.7-release.png)

Goalmaxxed narrowed the product to one durable loop:

```text
Intent -> Oracle -> Surface -> Loop -> Proof
```

- **Goal oracles became first-class.** Serious goals need an observable completion signal such as tests, a walkthrough, an artifact, a benchmark, a source-backed answer, a release check, or a final human decision.
- **Completion requires proof.** A finished active task is not a finished goal. Final Judge or PM audit evidence must map receipts and verification back to the oracle.
- **Larger useful slices.** Judge and Worker favor bounded, verified vertical results instead of safe-looking helper files, contracts, or proof notes that do not advance the owner outcome.
- **The local board became core.** The board moved from the extension story into the built-in GoalBuddy surface.
- **The extension catalog was removed.** Custom GitHub, Linear, Slack, and release integrations became ordinary repo work rather than installable GoalBuddy catalog items.
- **Smaller public promise.** GoalBuddy prepares and pressures goal runs. It stays local, file-backed, and intentionally avoids hosted state, automatic scheduling, or UI-owned workflow truth.

Release: [v0.3.7](https://github.com/tolibear/goalbuddy/releases/tag/v0.3.7)

## 0.3.6: Codex Install and Runtime Hardening (2026-05-14)

- Codex install and update adopted the canonical plugin-only skill path and removed stale personal GoalBuddy skills.
- Doctor began validating plugin cache, enabled config, bundled Goal Prep, required agents, and native `/goal` readiness as separate facts.
- Mutating commands such as `plugin install --help` and `update --help` became safe help-only operations.
- Spawn prompts exposed exact GoalBuddy agent types.
- Board parsing normalized legacy complete statuses and tolerated malformed deep receipt metadata without blanking the full board.

Published as `goalbuddy@0.3.6`; the 0.3.5 GitHub release was updated with the patch notes.

## 0.3.5: Subgoals, Parallel Agents, and Dark Mode (2026-05-12)

![GoalBuddy 0.3.5: Subgoals, parallel agents, and dark mode](internal/assets/goalbuddy-v0.3.5-release.png)

- **Depth-1 subgoals.** Parent tasks can link to one contained child board under `subgoals/`. The checker rejects outside-root paths, missing state, invalid child boards, and recursive nesting.
- **Parallel-agent-ready boards.** `goalbuddy parallel-plan` reports safe read-only Scout and Judge handoffs and permits Worker parallelism only for provably disjoint write scopes. It reports recommendations without mutating state or spawning agents.
- **Deterministic task prompts.** `goalbuddy prompt` renders compact, task-specific handoffs with scope, verification, stop conditions, reasoning hints, recommended roles, and expected receipt shape.
- **Dark mode and viewer settings.** The local board gained system/light/dark themes, density controls, completed-column preferences, board-opening preferences, and reduced-motion support.
- **One local multi-board hub.** Multiple boards register with `goalbuddy.localhost:41737`, use separate slug routes, and update parent views when child boards change.
- **Sharper agent contracts.** Scout maps, Judge gates, Worker patches, receipts prove, and `state.yaml` decides.

Release: [v0.3.5](https://github.com/tolibear/goalbuddy/releases/tag/v0.3.5)

## 0.3.2: Harden Codex Plugin Cache Updates (2026-05-12)

- Ignored non-version cache directories such as `.goalbuddy-preserved-extend-*` when resolving the active Codex plugin version.
- Stopped creating empty preservation directories during plugin reinstall when no custom extension existed.

## 0.3.1: Fix Duplicate `/goal-prep` Entry (2026-05-12)

- Removed the redundant `commands/goal-prep.md` wrapper so Claude Code's skill is the single `/goal-prep` surface.
- Install and update migrate the legacy command automatically, while doctor reports and fails on any leftover duplicate.

## 0.3.0: Claude Code Support (2026-05-12)

![GoalBuddy 0.3.0: Claude Code support](internal/assets/goalbuddy-v0.3.0-release.png)

- **One command for both targets.** `npx goalbuddy` installs Codex and Claude Code by default, with `--target codex|claude` for a single target.
- **Claude Code became first-class.** The package added a Claude plugin scaffold, markdown Scout/Judge/Worker agents, and `/goal-prep` beside the Codex plugin.
- **Target-aware install, update, and doctor.** `--codex-home` and `--claude-home` allow isolated installs and diagnostics.
- **Compatibility.** `npx goal-maker` remained as a temporary alias and existing Codex-only automation could keep using explicit Codex targeting.
- **Verification.** The release passed 46 tests, packed 97 files, and passed the publish-version guard.

Release: [v0.3.0](https://github.com/tolibear/goalbuddy/releases/tag/v0.3.0)

## 0.2.22: Built-In Visual Board Payload (2026-05-11)

- Bundled the visual board backends with Goal Prep, polished the public presentation, and kept agent-availability behavior explicit.

## 0.2.21: Update and Escalation Guidance (2026-05-08)

- Added update detection, user-facing upgrade paths, and clearer escalation guidance for unavailable agents or external dependencies.

## 0.2.20: Constrain Extension Sync (2026-05-07)

- Limited GitHub Projects synchronization to the GoalBuddy board view instead of allowing extension state to become broader workflow truth.

## 0.2.19: Install Flow Documentation (2026-05-07)

- Documented the GoalBuddy install model and aligned the package, site, and extension guidance.

## 0.2.18: Install Extensions Into the Plugin Skill (2026-05-07)

- Moved installed extension payloads under the plugin skill so the native plugin remained the authoritative Codex installation.

## 0.2.17: Goal Prep Discovery (2026-05-07)

- Made install output surface Goal Prep clearly, simplified extension discovery, and suggested optional integrations after installation.

## 0.2.16: Rename the Skill to Goal Prep (2026-05-07)

- Renamed the user-facing skill from GoalBuddy to Goal Prep while keeping the GoalBuddy product and plugin identity.

## 0.2.15: One Plugin Install Command (2026-05-07)

- Consolidated the GoalBuddy plugin installation path into one command and kept plugin internals out of composer prompts.

## 0.2.14: One-Command Codex Install (2026-05-07)

- Added the direct one-command Codex plugin install path and enabled GoalBuddy by default after marketplace registration.

## 0.2.13: Codex Plugin Marketplace (2026-05-07)

- Exposed GoalBuddy through a Codex plugin marketplace and added the first-party marketplace metadata.

## 0.2.12: Strict Goal Prep Boundary (2026-05-06)

- Made Goal Prep prepare the board and print the execution command without beginning implementation, browsing, research, skill loading, or asset generation.
- Generated the temporary Goal Maker compatibility skill during install rather than packaging a duplicate payload.
- Added regression coverage for canonical, plugin, and compatibility behavior.

Release: [v0.2.12](https://github.com/tolibear/goalbuddy/releases/tag/v0.2.12)

## 0.2.11: Trusted Publishing Repair (2026-05-06)

- Fixed npm's trusted-publishing command and shipped a provenance-backed patch after local check, pack, and publish-version verification.

Release: [v0.2.11](https://github.com/tolibear/goalbuddy/releases/tag/v0.2.11)

## 0.2.10: GoalBuddy Package Launch (2026-05-06)

- Rebranded the npm package from Goal Maker to GoalBuddy.
- Added the npm publish-version guard so an already-published or older version could not be released accidentally.
- Kept `goal-maker` as a compatibility command during migration.

Release tag: [v0.2.10](https://github.com/tolibear/goalbuddy/releases/tag/v0.2.10)

## Goal Maker Package History

Before the GoalBuddy package launched, this repository published as `goal-maker`. These entries preserve that product's running history without maintaining a second changelog.

### 0.2.10: Extension Workflows and Publish Guard (2026-05-06)

- Added receipt-aligned onboarding, planning, review, recovery, release, and GitHub pull-request extension workflows.
- Added the publish-version guard before the GoalBuddy package rebrand.

### 0.2.9: Simpler Extension Output (2026-05-06)

- Simplified extension command output for more readable install and discovery flows.

### 0.2.8: Extension Discovery (2026-05-06)

- Improved extension metadata and install-time discovery, including the GitHub pull-request workflow extension.

### 0.2.7: Full-Outcome Continuation (2026-05-05)

- Required Goal Maker to keep running until the original outcome, not merely the active task, was complete.

### 0.2.6: Package Positioning (2026-05-05)

- Refined the package positioning and public assets around local Scout/Judge/Worker boards, receipts, and verification.

### 0.2.5: EXTEND (2026-05-04)

- Introduced the GitHub-hosted extension catalog and `goal-maker extend` discovery, install, dry-run, and doctor commands.
- Moved package-only implementation under `internal/` and kept the installable skill payload focused.
- Added completed example workflows demonstrating the task-board and extension model.

Release: [v0.2.5](https://github.com/tolibear/goalbuddy/releases/tag/v0.2.5)

### 0.2.1: Documentation and Diagram Refresh (2026-05-03)

- Refreshed the README and generated flow diagram for the task-board model.

### 0.2.0: Task-Board Architecture (2026-05-03)

- Rebuilt Goal Maker around a local task board with one active task, role-specific Scout/Judge/Worker work, receipts, and `state.yaml` truth.

### 0.1.4: Setup-First Flow (2026-05-03)

- Shifted the product into a setup-first workflow that prepares durable local state before execution.

### 0.1.3: Codex Skill Invocation (2026-05-03)

- Documented the Codex skill invocation contract.

### 0.1.2: Install and Contribution Docs (2026-05-03)

- Clarified installation and contribution guidance.

### 0.1.1: Agents Installed by Default (2026-05-03)

- Installed the bundled role agents by default.

### 0.1.0: Initial npm Package (2026-05-03)

- Prepared the first `npx goal-maker` package and normalized its executable path.

# GoalBuddy

<p align="center">
  <a href="https://goalbuddy.dev">
    <img src="internal/assets/goalbuddy-readme-hero.png" alt="GoalBuddy local board and agent workflow." width="100%">
  </a>
</p>

<p align="center">
  <strong>A simple operating loop for long goal runs.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/goalbuddy"><img alt="npm" src="https://img.shields.io/npm/v/goalbuddy?style=flat-square&color=684cff"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-071236?style=flat-square"></a>
  <a href="https://goalbuddy.dev"><img alt="goalbuddy.dev" src="https://img.shields.io/badge/site-goalbuddy.dev-684cff?style=flat-square"></a>
</p>

GoalBuddy helps Codex and Claude Code stay oriented during long coding tasks by giving each harness's execution command a finish line, a live work surface, and a proof loop.

It gives a goal run a small local workspace: a charter, a goal oracle, a board, notes, receipts, and a clear next task. The work stays in your repo, so a run can pause, resume, verify, and keep going without re-inventing the plan every turn.

## Start Here

Run one command:

```bash
npx goalbuddy
```

Restart Codex or Claude Code.

Then prepare a goal:

```text
$goal-prep
```

In Claude Code, use:

```text
/goal-prep
```

Goal Prep creates the board and prints the exact command to run next. That is the whole path.

In Codex, native `/goal` runs the board. In Claude Code, GoalBuddy installs `/goalbuddy` so Claude's own `/goal` command remains untouched.

## Cross-Harness Goals

<p align="center">
  <img src="internal/assets/goalbuddy-v0.4.0-release.png" alt="GoalBuddy 0.4.0: Cross-Harness Goals — one board, any agent" width="100%">
</p>

Harnesses churn; repos persist. A GoalBuddy board lives in your repo as plain files, so the goal outlives whichever tool started it: begin a goal in Codex, resume it in Claude Code tomorrow, or the other way around, using the command for that harness.

```bash
npx goalbuddy resume
```

`resume` lists every live board in the repo with its status, active task, and both continuation commands: Codex `/goal Follow docs/goals/<slug>/goal.md.` and Claude Code `/goalbuddy Follow docs/goals/<slug>/goal.md.`. Receipts can record which harness performed each task, so the board's history survives the handoff intact.

Boards can also mix vendors within a single run — a Claude judge and a Codex worker on the same board:

```bash
npx goalbuddy dispatch docs/goals/<slug> --to codex
```

`dispatch` renders the active task's prompt, runs the target CLI headless (`codex` or `claude-code`), extracts the returned receipt, and compares source contents/state and semantic Git state before and after, including existing dirty and untracked work in linked worktrees. Workers must stay inside `allowed_files`; Scout/Judge must change nothing. Goal controls are protected; the report explicitly lists ignored/generated and Git-storage exclusions. Failed required inspection leaves scope unproven. Changes are preserved for PM recovery. See the [execution contract](goalbuddy/references/goal-execution.md) for inspection limits and receipt handling.

## Codex Install Model

For Codex, the canonical install is the native plugin plus bundled agents:

```text
~/.codex/plugins/cache/goalbuddy/goalbuddy/<version>/
~/.codex/agents/goal_judge.toml
~/.codex/agents/goal_scout.toml
~/.codex/agents/goal_worker.toml
```

The Codex plugin bundles `$goal-prep`; a clean Codex install should not need personal `~/.codex/skills/goalbuddy` or `~/.codex/skills/goal-maker` folders. Native Codex `/goal` is a separate OpenAI-gated feature. GoalBuddy prepares local boards and handoff prompts for it, but it does not enable or replace native `/goal`.

Install and update inspect the Codex cache before invoking its native installer. Non-version sibling directories and sibling files select the verified bundled path, preserving their contents and modes. Unproven cache inspection fails before installation; ordinary caches retain native installation. The result reports why fallback was selected.

To verify a Codex install:

```bash
npx goalbuddy doctor --target codex --goal-ready
```

To remove GoalBuddy-owned Codex runtime surfaces:

```bash
npx goalbuddy reset --target codex
```

Codex reset preserves modified or unproven agent files and returns a failure before changing configuration or cache. Review those files and use the package version matching the installed agents before retrying. Native `codex plugin remove goalbuddy@goalbuddy` only removes the native plugin surface. GoalBuddy also owns the `goal_*.toml` agent files it installed, its Codex plugin cache, its marketplace entry, and old personal skill folders from earlier installs. Use `goalbuddy reset --target codex` when you want those GoalBuddy-owned files removed too.

## Claude Code Install Model

GoalBuddy uses Claude Code's native plugin installer for a clean home when the `claude` CLI can prove the exact bundled version, skill, agents, and `/goalbuddy` command. Existing loose-file installs continue updating in place, and a clean home falls back to the same loose-file layout when the CLI is unavailable. GoalBuddy never mixes the two models automatically; `doctor` reports mixed or incomplete state as a failure.

```bash
npx goalbuddy doctor --target claude
npx goalbuddy reset --target claude
```

Reset removes a native plugin through the Claude Code CLI. For loose installs, it removes only files whose contents still match GoalBuddy's bundled files; modified or unproven files are preserved and reported.

Installer JSON remains backward compatible and now includes a `result` object for each requested target. Its `ok` value comes from final filesystem and configuration readback, so a CLI exit code or metadata record by itself is never reported as a completed install.

## Upgrading to 0.5.0

0.5.0 is an unreleased candidate; npm latest remains 0.4.3 until publication. After release, use `npx goalbuddy@0.5.0 update --target codex` or `npx goalbuddy@0.5.0 update --target claude`, then restart the client and run the matching `doctor` command. An older marketplace copy can trigger a verified bundled Codex fallback. Claude falls back to loose files only when partial plugin state is proven absent; otherwise installation fails with the remaining state reported. Read `result.ok`, `fallback`, `warnings` and `error`; a partial or failed target makes the command fail even if the other target succeeds.

Completion now requires observed evidence for the original outcome. Preserve historical receipts and verification attempts. If a final audit was already finalized, authorize a fresh final-audit task; do not edit old proof to make it pass. On the active audit, declare the exact check and every additional local dependency it needs, for example:

```yaml
acceptance:
  command: ["node", "test/acceptance.mjs"]
  artifacts: ["src"]
  inputs: ["test/helpers.mjs", "config/test.json"]
```

Paths must exist in the authorized workspace. With `<skill-path>` pointing to the installed `goal-prep` skill, run the declared argv once:

```bash
node <skill-path>/scripts/record-acceptance.mjs docs/goals/<slug> -- node test/acceptance.mjs
```

Use the returned `acceptance_proof` and `acceptance_sha256` in the final receipt, then apply it through `goalbuddy receipt`; the stop check consumes that observation without rerunning the validator. A failed observation leaves the outcome incomplete. Repair the cause and obtain fresh evidence under the audit contract. `node .`, `node checks/` and shell composition are not concrete validators: name the actual file, and declare its imports/configuration in `inputs`.

The recorder binds local files and declared inputs and displays exclusions. It cannot infer every dependency, observe all external state, or decide whether a passing test satisfies the person's intent. See the [execution contract](goalbuddy/references/goal-execution.md#one-observed-final-verification) for authorization, receipt fields and recovery.

## What It Creates

```text
docs/goals/<your-goal>/
  goal.md
  state.yaml
  notes/
  .goalbuddy-board/ # generated local board files
  subgoals/        # optional depth-1 child boards
```

`goal.md` says what you want.

`state.yaml` tracks the board.

`notes/` keeps longer findings out of the main thread.

`subgoals/` holds optional child boards when one parent task needs a bounded branch of work.

## How It Thinks

```text
Intent -> Oracle -> Surface -> Loop -> Proof
```

The oracle is the observable signal that says whether the original owner outcome is actually true: a test suite, browser walkthrough, demo transcript, generated artifact, benchmark, source-backed answer, release check, or final human decision.

No oracle, no serious goal.

The local board is the default work surface. It is not an extension marketplace; it is the built-in view of the `state.yaml` truth.

The receipt and task-card format is specified in [docs/spec/receipt-v1.md](docs/spec/receipt-v1.md) — harness-neutral, plain YAML, machine-validated.

Scout maps the repo.

Judge chooses the largest safe useful slice.

Worker completes the whole assigned slice and leaves a receipt.

The execution command keeps the loop honest until a final Judge/PM audit maps receipts and verification back to the oracle and records the full outcome complete.

Completion uses one authorized verification on the active final-audit task through `record-acceptance.mjs`; the final audit consumes its evidence without rerunning the command. The stop gate checks current outcome, validator/input bindings and board revision. This changes completion behavior: historical unverified claims stay intact but no longer authorize stopping. See the [verification and rollout contract](goalbuddy/references/goal-execution.md#one-observed-final-verification). Valid terminal blocks remain distinct from completion.

## Slice Sizing

Safe does not mean small. Safe means bounded, explicit, verified, and reversible.

GoalBuddy should not optimize for tiny safe tasks. It should optimize for the largest safe useful slice: a working screen, working API path, data pipeline step, backend vertical slice, real bug fix, or milestone review. The board warns when it sees safe-looking work that keeps adding helpers, contracts, proof files, or doc notes without moving the outcome.

## Goalmaxxed

GoalBuddy keeps the model small:

- `state.yaml` is the source of truth.
- A board is a view of one `state.yaml`.
- The local hub is a switchboard for many boards.
- A subgoal is one depth-1 `state.yaml` linked from a parent task.
- Settings are viewer preferences, not workflow state.

Use subgoals for bounded child work that belongs to a parent task. Use multiple local boards when parallel agents or separate goal runs are active at the same time. Keep the board open in light or dark mode while the work moves.

## Execution Quality

GoalBuddy can prepare safe parallel work; it does not run a parallel org chart or install arbitrary extension packs.

Use `goalbuddy prompt docs/goals/<slug>` to render a compact prompt for the active task without dumping the whole state file. The prompt includes exact role identifiers for both harnesses: Codex uses `required_spawn_agent_type` (`goal_scout`, `goal_worker`, or `goal_judge`), while Claude Code uses `required_claude_subagent_type` (`goal-scout`, `goal-worker`, or `goal-judge`). PMs should use the exact GoalBuddy role instead of a generic agent. Use `goalbuddy parallel-plan docs/goals/<slug>` to inspect read-only or disjoint write-scope work that can be handed to native Codex or Claude Code agent flows. The command reports recommendations only; it does not mutate state or spawn agents.

## Update

When a new GoalBuddy version ships:

```bash
npx goalbuddy update
```

That updates both Codex and Claude Code.

## Live Boards

GoalBuddy opens a local board while the work is running, so you can see the plan, active task, receipts, subgoals, and verification status without digging through the chat.

Multiple local boards reuse one readable `goalbuddy.localhost` hub with an in-header board switcher. When sharing a board in chat or docs, use a real Markdown link such as `[Open GoalBuddy board](http://goalbuddy.localhost:41737/<slug>/)` so the URL is clickable. The viewer also supports dark mode, compact mode, completed-task collapse, active-work motion, and reduced-motion handling.

Custom external integrations should be built as ordinary repo work with a concrete implementation plan, not installed from a GoalBuddy catalog.

See the [running changelog](CHANGELOG.md) for the complete release history. The latest published snapshot is [GoalBuddy 0.4.3: Restore Claude's Native /goal](https://github.com/tolimarchuk/goalbuddy/releases/tag/v0.4.3).

<p align="center">
  <img src="internal/assets/goalbuddy-live-board.jpg" alt="GoalBuddy local live board open next to Codex while Scout, Judge, and Worker tasks populate." width="100%">
</p>

## Good For

- broad project improvements
- release prep
- bug hunts that need evidence
- refactors with verification steps
- anything too large for one prompt

## For This Repo

GoalBuddy is MIT licensed and published on npm.

The implementation lives in this repo, but the happy path is intentionally tiny: install it, run Goal Prep, then use the printed Codex `/goal` or Claude Code `/goalbuddy` command.

For release process details, see [docs/releases](docs/releases/README.md).

## Star History

<a href="https://www.star-history.com/?repos=tolimarchuk%2Fgoalbuddy&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tolimarchuk/goalbuddy&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=tolimarchuk/goalbuddy&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=tolimarchuk/goalbuddy&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

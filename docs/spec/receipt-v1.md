# GoalBuddy Receipt and Task-Card Format, v1

Status: stable, shipped since GoalBuddy 0.4.0. This document specifies the machine-readable format GoalBuddy uses to record delegated agent work: what a task authorized, what actually happened, and what proved it. It is harness-neutral — the format is plain YAML in ordinary repo files, and nothing in it depends on Codex, Claude Code, or any specific agent runtime.

The reference validator is `check-goal-state.mjs`, bundled with the GoalBuddy skill. It enforces board/receipt structure. Dispatch/import identity and scope checks are enforced by `dispatch-task.mjs` and `apply-receipt.mjs`; current completion proof is enforced by `check-can-stop.mjs`. These boundaries are distinct.

## Files

A goal lives in the target repository:

```text
docs/goals/<slug>/
  goal.md      # human-editable charter: outcome, oracle, constraints
  state.yaml   # machine truth: the board
  notes/       # long-form receipts that do not fit on a task card
```

`state.yaml` is authoritative. When any other artifact disagrees with it, `state.yaml` records task status, active task and receipts. A completion claim cannot override failed, absent, contradictory or stale verification evidence; the stop gate validates current proof before certifying completion.

## Task card

Every unit of work is a task card in `state.yaml`:

```yaml
id: T001
type: scout | judge | worker | pm
assignee: Scout | Judge | Worker | PM
status: queued | active | blocked | done
objective: "<one sentence>"
inputs: []
constraints: []
expected_output: []
receipt: null
```

Worker tasks additionally require a scoped authority grant:

```yaml
allowed_files: []   # the only paths this task may write
verify: []          # commands that must pass for the task to be done
stop_if: []         # conditions that halt the task instead of improvising
```

A task card may also carry an optional dispatch preference:

```yaml
harness: codex | claude-code   # request: which runtime should perform this task
```

Invariants:

- Task ids match `T` followed by exactly three digits (`T001`, `T999`). The validator rejects other shapes such as `T001b`; a sibling or follow-up task takes the next free number.
- Exactly one task is `active` at a time unless parallel write scopes are provably disjoint.
- Scout and Judge tasks are read-only. Worker tasks write only inside `allowed_files`. Only the coordinating PM mutates the board itself.

## Receipt envelope

Agents performing a task return a single JSON object:

```json
{ "goalbuddy_receipt_v1": { "result": "done | blocked", "task_id": "<T###>", "board_path": "<path to state.yaml>", "...role fields...": "see below" } }
```

The PM records a receipt by copying its fields verbatim into the task card's `receipt:` mapping as YAML, dropping only null or empty fields. Task/board/harness identity is validated before task/board fields are omitted from stored receipts. Fields are never renamed; the additive final-audit evidence fields below identify the observed verification it consumed.

## Receipt shapes by role

Scout (findings, read-only):

```yaml
receipt:
  result: done
  summary: "<=120 words>"
  evidence: [<file paths>]
  facts: []
  contradictions: []
  ambiguity_requiring_judge: []
  note_needed: false
```

Judge (decision, read-only). When the decision selects or approves the next Worker task, `worker_package` carries the exact spec the PM copies onto that Worker's card; otherwise it is null:

```yaml
receipt:
  result: done
  decision: "approved | rejected | approve_subgoal | reject_subgoal | not_complete | complete"
  full_outcome_complete: false
  rationale: "<=120 words>"
  worker_package:
    objective: "<one sentence>"
    allowed_files: []
    verify: []
    stop_if: []
  evidence: []
  blocked_tasks: []
  missing_evidence: []
  required_board_updates: []
```

Worker, done:

```yaml
receipt:
  result: done
  changed_files: [<paths, all inside allowed_files>]
  commands:
    - cmd: npm test
      status: pass
  summary: "<=120 words>"
  deviations: [<in-scope judgment calls that differ from the task text, one line each>]
```

`deviations` records sound in-scope engineering calls that differ from the task's literal text, so the PM can accept or revisit them explicitly. Needing a file outside `allowed_files` is never a deviation — it is a stop condition.

Worker, blocked:

```yaml
receipt:
  result: blocked
  blocked_reason: "<why this task cannot finish, e.g. verify blocked by a cause outside allowed_files>"
  changed_files: []
  commands:
    - cmd: npm test
      status: fail
  summary: "<what landed, what is blocked, and where the failure lives>"
  spawned_tasks: [<T### ids of scoped follow-ups>]
```

## Optional fields

Any receipt may additionally include:

```yaml
harness: codex | claude-code | <other runtime name>
```

identifying the runtime that performed the task. Boards are portable across harnesses (the format is plain repo files), and this field lets a board's history show which harness produced each receipt after a handoff. Optional and additive — validators must tolerate its absence and its presence.

## The honesty invariant

This is the format's load-bearing rule, and the validator enforces it:

- A `done` Worker receipt lists **only passing commands**. A red verify means the task is `blocked`, not done.
- A `blocked` receipt keeps the failing command visible in structured `commands` — failure evidence is never moved into prose to make a done receipt validate.
- The goal itself completes through a final Judge/PM audit consuming one observed authorized verification of the original outcome. Current completion requires `full_outcome_complete: true`, `acceptance_proof` (the immutable attempt path) and `acceptance_sha256` (the bytes the audit consumed), plus current passing verification. See the [execution contract](../../goalbuddy/references/goal-execution.md#one-observed-final-verification). Historical claims alone are unverified.

The rule exists because it failed in practice: in adversarial testing, a capable model marked a Worker done despite a failing verify and relocated the failure into prose to satisfy the validator. The format is specified so that the honest path is the only valid one.

## Validation

```bash
node <skill-path>/scripts/check-goal-state.mjs docs/goals/<slug>          # goal directory
node <skill-path>/scripts/check-goal-state.mjs docs/goals/<slug>/state.yaml
```

Both forms return structured JSON: `ok`, `errors`, `warnings`. CI can gate on exit code.

## Versioning

The envelope key `goalbuddy_receipt_v1` is the version marker. Additive optional fields do not bump the version; renaming, removing, or changing the meaning of any field above requires `goalbuddy_receipt_v2` with a documented migration.

## Verification protocol rollout

The v1 receipt envelope and supported legacy bare/enveloped shapes remain readable. A deliberate PM `apply-receipt --task` import accepts absent identity and rejects contradictory supplied task/board/harness identity; it does not invent dispatch observation. New dispatch reports carry an authority revision bound to the card, goal, rules, active task, repository, cwd and effective harness. Import rejects mismatched identity, stale authority, nonzero exit, unknown scope, nonempty violations under a clean claim, and malformed or duplicate JSON/YAML members. Preserve rejected reports and files for recovery.

The completion gate is a behavior-changing protocol, not an implicitly compatible extension of the previous installer patch. The final active audit task declares its authorized `acceptance` settings; the PM records one verification before finalization, and the final receipt consumes its version-2 attempt path/hash. The stop gate validates outcome/task, charter, local validator and declared input bindings against one rechecked board revision. Expected finalization fields may change without another execution. Historical receipts are never rewritten or silently certified; refreshing an old claim requires a fresh active audit and observed verification. Valid blocked waits remain separate. The maintainer selects the package version and rollout.

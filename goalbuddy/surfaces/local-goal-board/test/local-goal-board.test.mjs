import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildColumns, createBoardPayload, parseGoalStateText, writeBoardApp } from "../scripts/lib/goal-board.mjs";
import { toYamlLines } from "../../../scripts/apply-receipt.mjs";
import { parseArgs, startBoardServer } from "../scripts/local-goal-board.mjs";

test("normalizes a dense goal into local board columns", () => {
  const payload = createBoardPayload(resolve("goalbuddy/surfaces/local-goal-board/examples/sample-goal"));

  assert.equal(payload.goal.title, "Local Goal Board Surface");
  assert.equal(payload.goal.activeTask, "");
  assert.equal(payload.executor.status, "not-observed");
  assert.equal(payload.counts.total, 14);
  assert.equal(payload.counts.todo, 0);
  assert.equal(payload.counts.inProgress, 0);
  assert.equal(payload.counts.blocked, 5);
  assert.equal(payload.counts.completed, 9);
  assert.deepEqual(payload.columns.map((column) => column.title), ["Todo", "In Progress", "Blocked", "Completed"]);

  const scout = payload.tasks.find((task) => task.id === "T001");
  assert.equal(scout.receipt.summary, "T001 completed during the progressive board motion demo.");
});

test("orders completed cards newest first while preserving queued order", () => {
  const columns = buildColumns([
    { id: "T001", column: "completed", status: "done" },
    { id: "T002", column: "todo", status: "queued" },
    { id: "T003", column: "completed", status: "done" },
    { id: "T004", column: "todo", status: "queued" },
  ]);

  assert.deepEqual(columns.find((column) => column.id === "todo").tasks.map((task) => task.id), ["T002", "T004"]);
  assert.deepEqual(columns.find((column) => column.id === "completed").tasks.map((task) => task.id), ["T003", "T001"]);
});

test("renders multiple active tasks in the in-progress column", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-multiple-active-"));
  try {
    const goalDir = join(root, "parallel-workers");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Parallel workers"
  slug: "parallel-workers"
  kind: specific
  tranche: "Render disjoint active workers."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker A
    status: active
    objective: "Patch the board parser."
    allowed_files:
      - goalbuddy/surfaces/local-goal-board/scripts/lib/goal-board.mjs
    verify:
      - node --test goalbuddy/surfaces/local-goal-board/test/local-goal-board.test.mjs
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
  - id: T002
    type: worker
    assignee: Worker B
    status: active
    objective: "Patch the board tests."
    allowed_files:
      - goalbuddy/surfaces/local-goal-board/test/local-goal-board.test.mjs
    verify:
      - node --test goalbuddy/surfaces/local-goal-board/test/local-goal-board.test.mjs
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
`);

    const payload = createBoardPayload(goalDir);
    assert.equal(payload.goal.activeTask, "T001");
    assert.equal(payload.executor.status, "not-observed");
    assert.match(payload.executor.detail, /does not prove that an executor is running/i);
    assert.equal(payload.counts.inProgress, 2);
    assert.deepEqual(
      payload.columns.find((column) => column.id === "in-progress").tasks.map((task) => task.id),
      ["T001", "T002"],
    );
    assert.deepEqual(payload.tasks.filter((task) => task.active).map((task) => task.id), ["T001", "T002"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads depth-1 subgoal boards into parent task payloads", () => {
  const payload = createBoardPayload(resolve("goalbuddy/surfaces/local-goal-board/examples/subgoal-parent"));
  const parentTask = payload.tasks.find((task) => task.id === "T004");

  assert.equal(parentTask.subgoal.status, "active");
  assert.equal(parentTask.subgoal.path, "subgoals/T004-board-view/state.yaml");
  assert.equal(parentTask.subgoal.depth, 1);
  assert.equal(parentTask.subgoal.board.goal.title, "T004 Board View Subgoal");
  assert.equal(parentTask.subgoal.board.goal.activeTask, "T002");
  assert.equal(parentTask.subgoal.board.counts.total, 3);
  assert.equal(parentTask.subgoal.board.tasks.find((task) => task.id === "T002").active, true);
  assert.equal(parentTask.subgoal.board.tasks.find((task) => task.id === "T002").subgoal, null);
});

test("uses readable card titles while preserving full objectives", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-readable-titles-"));
  try {
    const goalDir = join(root, "readable-titles");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Compact titles"
  slug: "compact-titles"
  kind: specific
  tranche: "Title display."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Implement a read-only fixture-backed /admin/enrichment-qa queue slice. Use only admin_seed_metrics.enrichment_qa plus existing contacts, companies, users, evidence_items, and facts. Do not create new APIs."
    receipt: null
  - id: T002
    type: worker
    assignee: Worker
    status: blocked
    objective: "Implement the read-only fixture-backed /contacts/con_aaron_keller route as the next first-milestone slice. Add a clickable path from the Coinbase chat answer matched contact row/name to Aaron Keller's profile."
    receipt: null
  - id: T003
    title: "Human-friendly release title"
    type: pm
    assignee: PM
    status: queued
    objective: "This objective can stay much more detailed because it belongs in the modal, not on the card face."
    receipt: null
  - id: T004
    title: "Run installed-Cursor runtime proof for a named model request through the local BYOK bridge"
    type: worker
    assignee: Worker
    status: queued
    objective: "Run installed-Cursor runtime proof for a named model request through the local BYOK bridge."
    receipt: null
`);

    const payload = createBoardPayload(goalDir);
    assert.equal(payload.tasks.find((task) => task.id === "T001").title, "Implement /admin/enrichment-qa queue slice");
    assert.equal(payload.tasks.find((task) => task.id === "T001").objective.includes("admin_seed_metrics.enrichment_qa"), true);
    assert.equal(payload.tasks.find((task) => task.id === "T002").title, "Implement /contacts/con_aaron_keller route");
    assert.equal(payload.tasks.find((task) => task.id === "T003").title, "Human-friendly release title");
    assert.equal(
      payload.tasks.find((task) => task.id === "T004").title,
      "Run installed-Cursor runtime proof for a named model request through the local BYOK bridge",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps board rendering when deep receipt YAML is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-board-subset-parser-"));
  try {
    const goalDir = join(root, "subset-parser");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Subset parser"
  slug: "subset-parser"
  kind: specific
  tranche: "Recover shallow board fields."
  status: active
active_task: T003
checks:
  last_verification:
    status: pass
    raw:
      malformed nested checker output
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: completed
    objective: "Ship a completed worker slice."
    receipt:
      result: done
      summary: "Worker finished."
      raw:
        malformed nested receipt output
  - id: T002
    type: judge
    assignee: Judge
    status: complete
    objective: "Approve the result."
    receipt: null
  - id: T003
    type: scout
    assignee: Scout
    status: active
    objective: "Inspect what is left."
    receipt: null
`);

    const payload = createBoardPayload(goalDir);
    assert.equal(payload.goal.title, "Subset parser");
    assert.equal(payload.goal.activeTask, "T003");
    assert.equal(payload.counts.completed, 2);
    assert.equal(payload.counts.inProgress, 1);
    assert.equal(payload.tasks.find((task) => task.id === "T001").status, "done");
    assert.equal(payload.tasks.find((task) => task.id === "T002").status, "done");
    assert.equal(payload.tasks.find((task) => task.id === "T001").receipt.summary, "Worker finished.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loudly when a linked subgoal state file is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-missing-subgoal-"));
  try {
    const goalDir = join(root, "parent");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Missing child"
  slug: "missing-child"
  kind: specific
  tranche: "Missing child."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Render child."
    subgoal:
      status: active
      path: subgoals/missing/state.yaml
      owner: Worker
      depth: 1
    receipt: null
`);

    assert.throws(
      () => createBoardPayload(goalDir),
      /Missing sub-goal state for T001: subgoals\/missing\/state\.yaml/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to render subgoal boards outside the parent goal root", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-outside-subgoal-"));
  try {
    const goalDir = join(root, "parent");
    const outsideDir = join(root, "outside");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "state.yaml"), `version: 2
goal:
  title: "Outside child"
  slug: "outside-child"
  kind: specific
  tranche: "Outside."
  status: active
active_task: T001
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: active
    objective: "Read."
    receipt: null
`);
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Outside child parent"
  slug: "outside-child-parent"
  kind: specific
  tranche: "Reject outside child."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Render child."
    subgoal:
      status: active
      path: ../outside/state.yaml
      owner: Worker
      depth: 1
    receipt: null
`);

    assert.throws(
      () => createBoardPayload(goalDir),
      /Invalid sub-goal path for T001: \.\.\/outside\/state\.yaml must stay inside the goal root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes a minimal GoalBuddy web app into the goal directory", () => {
  const appDir = writeBoardApp(resolve("goalbuddy/surfaces/local-goal-board/examples/sample-goal"));
  const html = readFileSync(join(appDir, "index.html"), "utf8");
  const css = readFileSync(join(appDir, "styles.css"), "utf8");
  const js = readFileSync(join(appDir, "app.js"), "utf8");
  const logo = readFileSync(join(appDir, "goalbuddy-mark.png"));

  assert.match(html, /goalbuddy-mark\.png/);
  assert.match(html, /class="topbar-primary"/);
  assert.match(html, /class="board-switcher is-empty"/);
  assert.match(html, /class="github-stars"/);
  assert.match(html, /id="settings-button"/);
  assert.match(html, /id="settings-popover"/);
  assert.match(css, /--canvas: #f7f6f3/);
  assert.match(css, /\.topbar-primary/);
  assert.match(css, /\.board-switcher\.is-empty \{\n  display: none;/);
  assert.match(css, /active-card-orbit/);
  assert.match(css, /:root\[data-motion="reduce"\] \.task-card\.is-active::before/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root\[data-density="compact"\] \.task-card/);
  assert.match(css, /:root\[data-completed-visibility="collapse"\]/);
  assert.match(css, /-webkit-line-clamp: 5/);
  assert.match(css, /\.subgoal-board/);
  assert.match(css, /\.board-error/);
  assert.match(css, /\.board-warning/);
  assert.match(js, /new EventSource\("\.\/events"\)/);
  assert.match(js, /fetch\("\.\.\/api\/boards"/);
  assert.match(js, /fetch\("\.\.\/api\/settings"/);
  assert.match(js, /fetch\("https:\/\/api\.github\.com\/repos\/tolimarchuk\/goalbuddy"/);
  assert.match(js, /goalbuddy\.localBoardSettings\.v1/);
  assert.match(js, /document\.documentElement\.dataset\.theme/);
  assert.match(js, /rememberCurrentBoard/);
  assert.match(js, /settingsButtonEl\.setAttribute\("aria-label"/);
  assert.match(js, /animateCardMoves/);
  assert.match(js, /card\.animate/);
  assert.match(js, /highlightMovingCards/);
  assert.match(js, /renderSubgoal/);
  assert.match(js, /renderBoardError/);
  assert.match(js, /renderBoardWarning/);
  assert.match(js, /parseWarning/);
  assert.match(js, /"badge harness"/);
  assert.match(css, /\.badge\.harness/);
  assert.match(js, /boardOptionLabel/);
  assert.match(js, /duration: changedColumn \? 980 : 520/);
  assert.equal(logo.subarray(1, 4).toString("ascii"), "PNG");
});

test("serves global local board settings with defensive normalization", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-settings-"));
  const goalDir = join(root, "settings-goal");
  const settingsPath = join(root, "settings.json");
  const previousSettingsPath = process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH;
  try {
    process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH = settingsPath;
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "Settings Goal", slug: "settings-goal" }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const initialResponse = await fetch(`${server.hubUrl}api/settings`);
      assert.equal(initialResponse.status, 200);
      assert.deepEqual((await initialResponse.json()).settings, {
        theme: "system",
        density: "comfortable",
        completedVisibility: "show",
        boardOpenBehavior: "last",
        motion: "system",
        lastBoardPath: "",
      });

      const updateResponse = await fetch(`${server.hubUrl}api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            theme: "dark",
            density: "compact",
            completedVisibility: "collapse",
            boardOpenBehavior: "newest",
            motion: "reduce",
            lastBoardPath: "/settings-goal/",
            unexpected: "ignored",
          },
        }),
      });
      assert.equal(updateResponse.status, 200);
      assert.deepEqual((await updateResponse.json()).settings, {
        theme: "dark",
        density: "compact",
        completedVisibility: "collapse",
        boardOpenBehavior: "newest",
        motion: "reduce",
        lastBoardPath: "/settings-goal/",
      });
      assert.match(readFileSync(settingsPath, "utf8"), /"theme": "dark"/);

      const partialResponse = await fetch(`${server.hubUrl}api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { theme: "light" } }),
      });
      assert.equal(partialResponse.status, 200);
      assert.deepEqual((await partialResponse.json()).settings, {
        theme: "light",
        density: "compact",
        completedVisibility: "collapse",
        boardOpenBehavior: "newest",
        motion: "reduce",
        lastBoardPath: "/settings-goal/",
      });

      const invalidResponse = await fetch(`${server.hubUrl}api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { theme: "neon", density: "tiny", motion: "allow" } }),
      });
      assert.equal(invalidResponse.status, 200);
      assert.deepEqual((await invalidResponse.json()).settings, {
        theme: "light",
        density: "compact",
        completedVisibility: "collapse",
        boardOpenBehavior: "newest",
        motion: "allow",
        lastBoardPath: "/settings-goal/",
      });
    } finally {
      await server.close();
    }
  } finally {
    if (previousSettingsPath === undefined) {
      delete process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH;
    } else {
      process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH = previousSettingsPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses CLI options", () => {
  assert.equal(parseArgs(["--goal", "docs/goals/demo"]).port, 41737);
  assert.equal(parseArgs(["--goal", "docs/goals/demo"]).host, "127.0.0.1");
  assert.equal(parseArgs(["--goal", "docs/goals/demo"]).publicHost, "goalbuddy.localhost");
  assert.deepEqual(parseArgs(["--goal", "docs/goals/demo", "--port", "0", "--once", "--json"]), {
    goal: "docs/goals/demo",
    host: "127.0.0.1",
    publicHost: "goalbuddy.localhost",
    port: 0,
    once: true,
    json: true,
  });
  assert.deepEqual(parseArgs(["--goal", "docs/goals/demo", "--host", "localhost"]), {
    goal: "docs/goals/demo",
    host: "localhost",
    publicHost: "localhost",
    port: 41737,
    once: false,
    json: false,
  });
});

test("advertises goalbuddy.localhost while binding to loopback", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-public-host-"));
  const goalDir = join(root, "goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "Public Host Goal", slug: "public-host-goal" }));

    const server = await startBoardServer({ goalDir, port: 0 });
    try {
      const url = new URL(server.url);
      assert.equal(url.hostname, "goalbuddy.localhost");
      assert.equal(url.pathname, "/public-host-goal/");

      const loopbackResponse = await fetch(`http://127.0.0.1:${url.port}/api/boards`);
      assert.equal(loopbackResponse.status, 200);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs when installed under a symlinked temp path", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-direct-"));
  try {
    cpSync("goalbuddy/surfaces/local-goal-board/scripts", join(root, "scripts"), { recursive: true });
    cpSync("goalbuddy/surfaces/local-goal-board/assets", join(root, "assets"), { recursive: true });

    const result = spawnSync(process.execPath, [
      join(root, "scripts", "local-goal-board.mjs"),
      "--goal",
      resolve("goalbuddy/surfaces/local-goal-board/examples/sample-goal"),
      "--once",
      "--json",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.board.goal.title, "Local Goal Board Surface");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serves board JSON and streams live state changes over SSE", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-"));
  const goalDir = join(root, "demo-goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active"));
    writeFileSync(join(goalDir, "notes", "T001-note.md"), "# Live Note\n\nInitial note.\n");

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      assert.match(server.url, /\/live-board\/$/);
      const boardResponse = await fetch(`${server.url}api/board`);
      assert.equal(boardResponse.status, 200);
      const board = await boardResponse.json();
      assert.equal(board.tasks[0].status, "active");

      const controller = new AbortController();
      const events = await fetch(`${server.url}events`, { signal: controller.signal });
      assert.equal(events.status, 200);
      const reader = events.body.getReader();

      await readUntil(reader, /"status":"active"/);
      writeFileSync(join(goalDir, "state.yaml"), stateYaml("blocked"));
      const update = await readUntil(reader, /"status":"blocked"/);
      assert.match(update, /"title":"Blocked"/);

      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coalesces transient active-task violations during multi-write transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-transition-"));
  const goalDir = join(root, "transition-goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), transitionStateYaml({
      activeTask: "T001",
      firstStatus: "active",
      secondStatus: "queued",
    }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const controller = new AbortController();
      const events = await fetch(`${server.url}events`, { signal: controller.signal });
      assert.equal(events.status, 200);
      const reader = events.body.getReader();

      await readUntil(reader, /"activeTask":"T001"/);
      writeFileSync(join(goalDir, "state.yaml"), transitionStateYaml({
        activeTask: "T002",
        firstStatus: "active",
        secondStatus: "active",
      }));
      await delay(120);
      writeFileSync(join(goalDir, "state.yaml"), transitionStateYaml({
        activeTask: "T002",
        firstStatus: "done",
        secondStatus: "active",
      }));

      const update = await readUntil(reader, /"activeTask":"T002"/);
      assert.doesNotMatch(update, /more than one active task/i);

      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streams parent board updates when linked child subgoal state changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-subgoal-live-"));
  const goalDir = join(root, "parent-goal");
  const childDir = join(goalDir, "subgoals", "T001-child");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    mkdirSync(join(childDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), parentWithSubgoalYaml());
    writeFileSync(join(childDir, "state.yaml"), stateYaml("active", { title: "Child Goal", slug: "child-goal" }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const controller = new AbortController();
      const events = await fetch(`${server.url}events`, { signal: controller.signal });
      assert.equal(events.status, 200);
      const reader = events.body.getReader();

      await readUntil(reader, /"title":"Child Goal"/);
      writeFileSync(join(childDir, "state.yaml"), stateYaml("blocked", { title: "Child Goal", slug: "child-goal" }));
      const update = await readUntil(reader, /"status":"blocked"/);
      assert.match(update, /"Child Goal"/);

      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serves multiple local boards from one shared hub URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-hub-"));
  const firstGoalDir = join(root, "first-goal");
  const secondGoalDir = join(root, "second-goal");
  const previousSettingsPath = process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH;
  try {
    process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH = join(root, "hub-settings.json");
    mkdirSync(join(firstGoalDir, "notes"), { recursive: true });
    mkdirSync(join(secondGoalDir, "notes"), { recursive: true });
    writeFileSync(join(firstGoalDir, "state.yaml"), stateYaml("active", { title: "First Goal", slug: "first-goal" }));
    writeFileSync(join(secondGoalDir, "state.yaml"), stateYaml("blocked", { title: "Second Goal", slug: "second-goal" }));

    const server = await startBoardServer({ goalDir: firstGoalDir, host: "127.0.0.1", port: 0 });
    try {
      const registerResponse = await fetch(server.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalDir: secondGoalDir }),
      });
      assert.equal(registerResponse.status, 200);
      const second = await registerResponse.json();

      const firstUrl = new URL(server.url);
      const secondUrl = new URL(second.url);
      assert.equal(secondUrl.origin, firstUrl.origin);
      assert.equal(firstUrl.pathname, "/first-goal/");
      assert.equal(secondUrl.pathname, "/second-goal/");

      const hubResponse = await fetch(server.hubUrl, { redirect: "manual" });
      assert.equal(hubResponse.status, 302);
      assert.equal(hubResponse.headers.get("location"), `${firstUrl.origin}/first-goal/`);

      const noSlashResponse = await fetch(`${secondUrl.origin}/second-goal`, { redirect: "manual" });
      assert.equal(noSlashResponse.status, 302);
      assert.equal(noSlashResponse.headers.get("location"), `${secondUrl.origin}/second-goal/`);

      const boardsResponse = await fetch(server.apiUrl);
      assert.equal(boardsResponse.status, 200);
      const boards = await boardsResponse.json();
      assert.deepEqual(boards.boards.map((board) => board.title), ["First Goal", "Second Goal"]);

      const newestSettingsResponse = await fetch(`${firstUrl.origin}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { boardOpenBehavior: "newest" } }),
      });
      assert.equal(newestSettingsResponse.status, 200);
      const newestHubResponse = await fetch(server.hubUrl, { redirect: "manual" });
      assert.equal(newestHubResponse.status, 302);
      assert.equal(newestHubResponse.headers.get("location"), `${firstUrl.origin}/second-goal/`);

      const lastSettingsResponse = await fetch(`${firstUrl.origin}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { boardOpenBehavior: "last", lastBoardPath: "/first-goal/" } }),
      });
      assert.equal(lastSettingsResponse.status, 200);
      const lastHubResponse = await fetch(server.hubUrl, { redirect: "manual" });
      assert.equal(lastHubResponse.status, 302);
      assert.equal(lastHubResponse.headers.get("location"), `${firstUrl.origin}/first-goal/`);

      const secondBoardResponse = await fetch(`${second.url}api/board`);
      assert.equal(secondBoardResponse.status, 200);
      const secondBoard = await secondBoardResponse.json();
      assert.equal(secondBoard.goal.title, "Second Goal");
    } finally {
      await server.close();
    }
  } finally {
    if (previousSettingsPath === undefined) {
      delete process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH;
    } else {
      process.env.GOALBUDDY_LOCAL_BOARD_SETTINGS_PATH = previousSettingsPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("unregistered board paths explain hub reuse instead of stale-port cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-unregistered-"));
  const goalDir = join(root, "first-goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "First Goal", slug: "first-goal" }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const baseUrl = new URL(server.url).origin;
      const missingResponse = await fetch(`${baseUrl}/unregistered-example-board/`);
      assert.equal(missingResponse.status, 404);
      const message = await missingResponse.text();
      assert.match(message, /board path is not registered/i);
      assert.match(message, /multi-board hub/i);
      assert.match(message, /Do not stop it just because a \/<slug>\/ board URL returned 404/);
      assert.match(message, /npx goalbuddy board <goal-dir>/);
      assert.match(message, /First Goal/);
      assert.match(message, /\/api\/boards/);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function readUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (pattern.test(text)) return text;
  }

  assert.fail(`Timed out waiting for ${pattern}. Received:\n${text}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parentWithSubgoalYaml() {
  return `version: 2
goal:
  title: "Parent Goal"
  slug: "parent-goal"
  kind: specific
  tranche: "Verify child live updates."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: active
    objective: "Watch child state."
    subgoal:
      status: active
      path: subgoals/T001-child/state.yaml
      owner: Worker
      depth: 1
    receipt: null
`;
}

function transitionStateYaml({ activeTask, firstStatus, secondStatus }) {
  return `version: 2
goal:
  title: "Transition Goal"
  slug: "transition-goal"
  kind: specific
  tranche: "Verify multi-write task transition."
  status: active
active_task: ${activeTask}
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: ${firstStatus}
    objective: "Map transition."
    receipt:
      result: done
      summary: "Mapped transition."
  - id: T002
    type: worker
    assignee: Worker
    status: ${secondStatus}
    objective: "Implement transition."
    allowed_files:
      - goalbuddy/surfaces/local-goal-board/**
    verify:
      - npm run check
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
`;
}

test("flags degraded parses with a warning instead of silently dropping data", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-degraded-parse-"));
  try {
    const goalDir = join(root, "degraded");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Degraded goal"
  slug: "degraded-goal"
  status: active
active_task: T001
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: active
    objective: |
      Block scalars force the fallback parser.
    receipt: null
`);
    const payload = createBoardPayload(goalDir);
    assert.equal(payload.tasks[0].id, "T001");
    assert.match(payload.parseWarning, /fallback/i);
    assert.match(payload.tasks[0].objective, /Block scalars force the fallback parser/);
    assert.notEqual(payload.tasks[0].title, "|");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers odd-indentation boards through the fallback parser", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-odd-indent-"));
  try {
    const goalDir = join(root, "odd-indent");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
   title: "Odd indent goal"
   slug: "odd-indent-goal"
   status: active
active_task: T001
tasks:
  - id: T001
    type: scout
    assignee: Scout
    status: active
    objective: "Three-space indentation is valid YAML."
    receipt: null
`);
    const payload = createBoardPayload(goalDir);
    assert.equal(payload.tasks[0].id, "T001");
    assert.match(payload.parseWarning, /fallback/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicated board paths report matching slugs", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-dedup-slug-"));
  try {
    const goalA = join(root, "goal-a");
    const goalB = join(root, "goal-b");
    for (const goalDir of [goalA, goalB]) {
      mkdirSync(join(goalDir, "notes"), { recursive: true });
      writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "Dup Goal", slug: "dup-goal" }));
    }

    const server = await startBoardServer({ goalDir: goalA, host: "127.0.0.1", port: 0 });
    try {
      const port = new URL(server.apiUrl).port;
      const registration = await fetch(`http://127.0.0.1:${port}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalDir: goalB }),
      });
      assert.equal(registration.status, 200);
      const second = await registration.json();
      assert.match(second.url, /\/dup-goal-2\/$/);
      assert.equal(second.slug, "dup-goal-2");

      const boards = (await (await fetch(`http://127.0.0.1:${port}/api/boards`)).json()).boards;
      assert.deepEqual(boards.map((board) => board.slug).sort(), ["dup-goal", "dup-goal-2"]);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task payloads carry the harness that did or will do the work", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-harness-badge-"));
  try {
    const goalDir = join(root, "fleet");
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "Fleet goal"
  slug: "fleet"
  kind: specific
  tranche: "test"
  status: active
active_task: T002
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: done
    objective: "Done by codex."
    receipt:
      result: done
      harness: codex
      summary: "done"
      changed_files:
        - src/widget.mjs
      commands:
        - cmd: npm test
          status: pass
  - id: T002
    type: scout
    assignee: Scout
    status: active
    harness: gemini
    objective: "Assigned to gemini."
    receipt: null
`);
    const payload = createBoardPayload(goalDir);
    assert.equal(payload.tasks.find((task) => task.id === "T001").harness, "codex");
    assert.equal(payload.tasks.find((task) => task.id === "T002").harness, "gemini");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects requests with a non-local Host header", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-host-check-"));
  const goalDir = join(root, "goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "Host Check Goal", slug: "host-check-goal" }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const port = new URL(server.apiUrl).port;
      const rebound = await rawRequest(port, { headers: { Host: "evil.example" } });
      assert.equal(rebound.status, 403);

      const allowed = await fetch(`http://127.0.0.1:${port}/api/boards`);
      assert.equal(allowed.status, 200);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects cross-site POST /api/boards", async () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-local-board-origin-check-"));
  const goalDir = join(root, "goal");
  try {
    mkdirSync(join(goalDir, "notes"), { recursive: true });
    writeFileSync(join(goalDir, "state.yaml"), stateYaml("active", { title: "Origin Check Goal", slug: "origin-check-goal" }));

    const server = await startBoardServer({ goalDir, host: "127.0.0.1", port: 0 });
    try {
      const port = new URL(server.apiUrl).port;
      const crossSite = await fetch(`http://127.0.0.1:${port}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
        body: JSON.stringify({ goalDir }),
      });
      assert.equal(crossSite.status, 403);

      const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ goalDir }),
      });
      assert.equal(sameOrigin.status, 200);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function rawRequest(port, { method = "GET", path = "/api/boards", headers = {}, body = "" } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode, body: data }));
    });
    request.on("error", rejectRequest);
    if (body) request.write(body);
    request.end();
  });
}

function stateYaml(status, { title = "Live board", slug = "live-board" } = {}) {
  return `version: 2
goal:
  title: "${title}"
  slug: "${slug}"
  kind: specific
  tranche: "Verify live updates."
  status: active
active_task: T001
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: ${status}
    objective: "Render live changes."
    receipt:
      result: done
      summary: "Rendered safely."
      note: notes/T001-note.md
`;
}


for (const value of [
  String.raw`C:\hostedtoolcache\windows\node\18.20.8\x64\node.exe`,
  String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\node checks\run.mjs`,
  String.raw`\\server\share\node`, "ends with a slash\\", '\\n literal versus \n newline',
  'quoted "value" and \\"slash"', "\b\f\n\r\t\u0000\u001f", "\ud800", "Unicode \u00a0\u2028\ufeff",
]) {
  test(`scalar decoder preserves JSON.stringify and serializer round trips: ${JSON.stringify(value)}`, () => {
    for (const strict of [false, true]) {
      assert.equal(parseGoalStateText(`value: ${JSON.stringify(value)}\n`, { strict }).value, value);
      assert.equal(parseGoalStateText(`value: ${JSON.stringify(value)} # outside comment\n`, { strict }).value, value);
      const text = 'tasks:\n  - id: T999\n' + toYamlLines({ acceptance: { command: [value, "acceptance.mjs"] } }, 4).join("\n");
      assert.deepEqual(parseGoalStateText(text, { strict }).tasks[0].acceptance.command, [value, "acceptance.mjs"]);
      assert.deepEqual(parseGoalStateText(`values: [${JSON.stringify(value)}, "next"] # outside comment`, { strict }).values, [value, "next"]);
    }
  });
}

test("scalar decoder preserves supported legacy single quotes and literal unknown escapes", () => {
  assert.equal(parseGoalStateText("value: 'it''s C:\\node'", { strict: true }).value, "it's C:\\node");
  assert.equal(parseGoalStateText(String.raw`value: "legacy \q and \U unchanged"`, { strict: true }).value, String.raw`legacy \q and \U unchanged`);
});

for (const scalar of ['"unterminated', "'unterminated", String.raw`"trailing\"`, '"inner"quote"', "'inner'quote'", String.raw`"bad\u12XZ"`]) {
  test(`scalar decoder rejects malformed quoted scalar: ${scalar}`, () => {
    assert.throws(() => parseGoalStateText(`value: ${scalar}`, { strict: true }), /quoted|escape/i);
  });
}

test("scalar decoder retains strict mapping duplicate rejection and display recovery", () => {
  for (const continuation of ["    status: pass", "      status: pass", "    status : pass"]) {
    const text = `tasks:\n  - status: fail\n${continuation}\n`;
    assert.throws(() => parseGoalStateText(text, { strict: true }), /Duplicate YAML key: status/);
    assert.equal(parseGoalStateText(text).tasks[0].status, "pass");
  }
});

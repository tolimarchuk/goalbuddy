import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_STATUSES = new Set(["queued", "active", "blocked", "done"]);
const COLUMN_ORDER = ["todo", "in-progress", "blocked", "completed"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const surfaceRoot = resolve(__dirname, "../..");
const logoAssetPath = join(surfaceRoot, "assets", "goalbuddy-mark.png");

export class GoalBoardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoalBoardError";
  }
}

export async function loadGoalBoard(goalDir) {
  const root = resolve(goalDir);
  const statePath = join(root, "state.yaml");
  if (!existsSync(statePath)) {
    throw new GoalBoardError(`Missing state.yaml: ${statePath}`);
  }
  const text = await readFile(statePath, "utf8");
  return normalizeGoalBoard(parseGoalStateText(text), root);
}

export function createBoardPayload(goalDir, options = {}) {
  const includeSubgoals = options.includeSubgoals !== false;
  const root = resolve(goalDir);
  const statePath = join(root, "state.yaml");
  if (!existsSync(statePath)) {
    throw new GoalBoardError(`Missing state.yaml: ${statePath}`);
  }

  const document = parseGoalStateText(readFileSync(statePath, "utf8"));
  const parseWarning = document.__parseWarning || "";
  const board = normalizeGoalBoard(document, root);
  const noteIndex = loadNotes(root);
  const tasks = board.tasks
    .map((task) => attachTaskNote(task, noteIndex))
    .map((task) => includeSubgoals ? attachTaskSubgoal(task, root) : task);
  const columns = buildColumns(tasks);
  const stateStat = statSync(statePath);

  return {
    generatedAt: new Date().toISOString(),
    ...(parseWarning ? { parseWarning } : {}),
    source: {
      goalDir: root,
      statePath,
      stateMtimeMs: stateStat.mtimeMs,
      notesDir: join(root, "notes"),
    },
    goal: {
      title: board.title,
      slug: board.slug,
      kind: board.kind,
      status: board.status,
      tranche: board.tranche,
      activeTask: board.activeTask,
    },
    executor: executorObservation(board),
    counts: {
      total: tasks.length,
      todo: columns.find((column) => column.id === "todo").tasks.length,
      inProgress: columns.find((column) => column.id === "in-progress").tasks.length,
      blocked: columns.find((column) => column.id === "blocked").tasks.length,
      completed: columns.find((column) => column.id === "completed").tasks.length,
    },
    columns,
    tasks,
    notes: Object.values(noteIndex).map(({ path, title, mtimeMs }) => ({ path, title, mtimeMs })),
  };
}

function executorObservation(board) {
  if (board.status === "done") {
    return { status: "complete", label: "Complete", observed: false };
  }
  if (board.status === "blocked") {
    return { status: "waiting", label: "Waiting", observed: false };
  }
  return {
    status: "not-observed",
    label: "Not observed",
    observed: false,
    detail: "The local board displays state. It does not prove that an executor is running.",
  };
}

export function normalizeGoalBoard(document, goalDir = "<memory>") {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new GoalBoardError("Goal state must be a YAML mapping.");
  }
  if (Number(document.version) !== 2) {
    throw new GoalBoardError('Only GoalBuddy v2 state.yaml files are supported: the board is missing top-level "version: 2". Start from templates/state.yaml bundled with the goal-prep skill.');
  }
  if (!document.goal || typeof document.goal !== "object") {
    throw new GoalBoardError("Missing goal metadata.");
  }
  if (!Array.isArray(document.tasks) || document.tasks.length === 0) {
    throw new GoalBoardError("Missing non-empty tasks list.");
  }

  const tasks = document.tasks.map((task, index) => normalizeTask(task, index));
  const activeTasks = tasks.filter((task) => task.status === "active");

  return {
    goalDir,
    title: cleanText(document.goal.title || "Untitled goal"),
    slug: cleanText(document.goal.slug || "untitled-goal"),
    kind: cleanText(document.goal.kind || "open_ended"),
    tranche: cleanText(document.goal.tranche || ""),
    status: cleanText(document.goal.status || "active"),
    activeTask: cleanText(document.active_task || activeTasks[0]?.id || ""),
    tasks,
  };
}

export function normalizeTask(task, index) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new GoalBoardError(`Task ${index + 1} must be a mapping.`);
  }

  const id = cleanText(task.id);
  const status = normalizeTaskStatus(task.status);
  if (!id) throw new GoalBoardError(`Task ${index + 1} is missing id.`);
  if (!VALID_STATUSES.has(status)) {
    throw new GoalBoardError(`Task ${id} has unsupported status "${status}".`);
  }

  return {
    id,
    title: titleForTask(task),
    objective: cleanText(task.objective || ""),
    status,
    column: columnForStatus(status),
    type: cleanText(task.type || "pm"),
    assignee: cleanText(task.assignee || ""),
    harness: cleanText(task.receipt?.harness || task.harness || ""),
    active: status === "active",
    inputs: normalizeStringList(task.inputs),
    constraints: normalizeStringList(task.constraints),
    expectedOutput: normalizeStringList(task.expected_output),
    allowedFiles: normalizeStringList(task.allowed_files),
    verify: normalizeStringList(task.verify),
    stopIf: normalizeStringList(task.stop_if),
    subgoal: normalizeSubgoal(task.subgoal),
    receipt: normalizeReceipt(task.receipt),
  };
}

export function buildColumns(tasks) {
  const byColumn = new Map(COLUMN_ORDER.map((id) => [id, []]));
  for (const task of tasks) {
    byColumn.get(task.column).push(task);
  }

  for (const [columnId, columnTasks] of byColumn.entries()) {
    columnTasks.sort((left, right) => compareColumnTasks(columnId, left, right));
  }

  return [
    { id: "todo", title: "Todo", description: "Queued work ready to pull", tasks: byColumn.get("todo") },
    { id: "in-progress", title: "In Progress", description: "Active task work", tasks: byColumn.get("in-progress") },
    { id: "blocked", title: "Blocked", description: "Needs unblock or a smaller slice", tasks: byColumn.get("blocked") },
    { id: "completed", title: "Completed", description: "Receipted work", tasks: byColumn.get("completed") },
  ];
}

export function writeBoardApp(goalDir) {
  const appDir = join(resolve(goalDir), ".goalbuddy-board");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), `${boardHtml()}\n`);
  writeFileSync(join(appDir, "styles.css"), `${boardCss()}\n`);
  writeFileSync(join(appDir, "app.js"), `${boardJs()}\n`);
  copyFileSync(logoAssetPath, join(appDir, "goalbuddy-mark.png"));
  return appDir;
}

function attachTaskNote(task, noteIndex) {
  const notePath = task.receipt.note || "";
  if (!notePath) return task;
  const normalized = notePath.replaceAll("\\", "/").replace(/^\.?\//, "");
  return {
    ...task,
    note: noteIndex[normalized] || null,
  };
}

function attachTaskSubgoal(task, goalDir) {
  if (!task.subgoal) return task;
  const childStatePath = resolve(goalDir, task.subgoal.path);
  validateChildSubgoalPath(task, goalDir, childStatePath);
  const childGoalDir = dirname(childStatePath);
  if (!existsSync(childStatePath)) {
    throw new GoalBoardError(`Missing sub-goal state for ${task.id}: ${task.subgoal.path}`);
  }

  return {
    ...task,
    subgoal: {
      ...task.subgoal,
      board: createBoardPayload(childGoalDir, { includeSubgoals: false }),
    },
  };
}

function validateChildSubgoalPath(task, goalDir, childStatePath) {
  if (task.subgoal.depth !== 1) {
    throw new GoalBoardError(`Invalid sub-goal depth for ${task.id}: only depth 1 is supported.`);
  }
  const childRelativePath = relative(goalDir, childStatePath);
  if (!isInsideRoot(childRelativePath)) {
    throw new GoalBoardError(`Invalid sub-goal path for ${task.id}: ${task.subgoal.path} must stay inside the goal root.`);
  }
  const parts = childRelativePath.split(/[\\/]+/);
  if (parts.length !== 3 || parts[0] !== "subgoals" || parts[2] !== "state.yaml") {
    throw new GoalBoardError(`Invalid sub-goal path for ${task.id}: ${task.subgoal.path} must be subgoals/<slug>/state.yaml.`);
  }
}

function isInsideRoot(relativePath) {
  return relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function loadNotes(goalDir) {
  const notesDir = join(goalDir, "notes");
  if (!existsSync(notesDir)) return {};

  const notes = {};
  for (const entry of readdirSync(notesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = `notes/${entry.name}`;
    const absolute = join(notesDir, entry.name);
    const content = readFileSync(absolute, "utf8");
    notes[path] = {
      path,
      title: noteTitle(content, entry.name),
      content,
      mtimeMs: statSync(absolute).mtimeMs,
    };
  }
  return notes;
}

function noteTitle(content, filename) {
  const heading = content.split(/\r?\n/).find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() : basename(filename, ".md");
}

function normalizeReceipt(receipt) {
  if (!receipt) return { present: false, summary: "", result: "", note: "" };
  if (typeof receipt === "string") {
    return { present: true, summary: cleanText(receipt), result: "", note: "" };
  }
  if (Array.isArray(receipt) || typeof receipt !== "object") {
    return { present: true, summary: cleanText(receipt), result: "", note: "" };
  }
  return {
    present: true,
    result: cleanText(receipt.result || ""),
    summary: cleanText(receipt.summary || receipt.decision || receipt.note || receipt.result || ""),
    decision: cleanText(receipt.decision || ""),
    note: cleanText(receipt.note || ""),
    changedFiles: normalizeStringList(receipt.changed_files),
    commands: normalizeCommands(receipt.commands),
    evidence: normalizeStringList(receipt.evidence),
  };
}

function normalizeSubgoal(subgoal) {
  if (!subgoal || typeof subgoal !== "object" || Array.isArray(subgoal)) return null;
  return {
    status: cleanText(subgoal.status || ""),
    path: cleanText(subgoal.path || ""),
    owner: cleanText(subgoal.owner || ""),
    createdFrom: cleanText(subgoal.created_from || ""),
    depth: Number(subgoal.depth || 0),
    rollupReceipt: cleanText(subgoal.rollup_receipt || ""),
    board: null,
  };
}

function normalizeCommands(commands) {
  if (!commands) return [];
  if (!Array.isArray(commands)) return [cleanText(commands)].filter(Boolean).map((cmd) => ({ cmd, status: "" }));
  return commands.map((command) => {
    if (typeof command === "string") return { cmd: cleanText(command), status: "" };
    return {
      cmd: cleanText(command?.cmd || ""),
      status: cleanText(command?.status || ""),
    };
  }).filter((command) => command.cmd || command.status);
}

function titleForTask(task) {
  if (task.title) return compactTaskTitle(task.title);
  const objective = cleanText(task.objective || "Untitled task");
  return compactTaskTitle(objective);
}

function compactTaskTitle(value) {
  const text = cleanText(value).replace(/\.$/, "");
  const routeMatch = text.match(/^Implement\b.*?\s(\/[A-Za-z0-9_./:-]+)\s+(route|queue slice|slice)\b/i);
  if (routeMatch) return `Implement ${routeMatch[1]} ${routeMatch[2]}`;

  const firstClause = text
    .split(/(?<=[.!?])\s+|\s+(?:Use only|Add|Match|Render|Clearly label|Do not)\b/i)[0]
    .replace(/\bas the next first-milestone slice\b/gi, "")
    .replace(/\bblocker documentation\b/gi, "blocker docs")
    .replace(/\benv\/setup notes\b/gi, "setup notes")
    .replace(/\s+/g, " ")
    .replace(/[.;:,]\s*$/, "")
    .trim();

  return firstClause || text;
}

function columnForStatus(status) {
  if (status === "blocked") return "blocked";
  if (status === "done") return "completed";
  if (status === "queued") return "todo";
  return "in-progress";
}

function taskSortKey(task) {
  const rank = task.status === "active" ? "0" : task.status === "queued" ? "1" : task.status === "blocked" ? "2" : "3";
  return `${rank}:${task.id}`;
}

function compareColumnTasks(columnId, left, right) {
  const order = taskSortKey(left).localeCompare(taskSortKey(right));
  if (columnId === "completed") return -order;
  return order;
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return [cleanText(value)].filter(Boolean);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeTaskStatus(value) {
  const status = cleanText(value);
  if (status === "complete" || status === "completed") return "done";
  return status;
}

export function parseGoalStateText(text, { strict = false } = {}) {
  try {
    const lines = tokenizeYaml(text);
    if (!lines.length) throw new GoalBoardError("Goal state is empty.");
    const [value, nextIndex] = parseBlock(lines, 0, lines[0].indent, strict);
    if (nextIndex < lines.length) {
      throw new GoalBoardError(`Could not parse line ${lines[nextIndex].number}.`);
    }
    return value;
  } catch (error) {
    if (!strict && error instanceof GoalBoardError && canRecoverBoardSubset(error)) {
      const document = parseGoalBoardSubset(text);
      document.__parseWarning = `Strict parse failed (${error.message}) Showing a best-effort fallback view; fields the fallback parser cannot read are omitted. Fix state.yaml formatting to see the full board.`;
      return document;
    }
    throw error;
  }
}

function canRecoverBoardSubset(error) {
  return /Could not parse line|Expected key\/value pair|Expected mapping|Block scalar YAML|Unsupported odd indentation/.test(error.message);
}

function parseGoalBoardSubset(text) {
  const tasks = parseTaskSubsets(text);
  if (!tasks.length) throw new GoalBoardError("Missing non-empty tasks list.");
  return {
    version: parseYamlScalar(findTopLevelScalar(text, "version") || "2"),
    goal: {
      title: parseYamlScalar(findNestedScalar(text, "goal", "title") || "Untitled goal"),
      slug: parseYamlScalar(findNestedScalar(text, "goal", "slug") || "untitled-goal"),
      kind: parseYamlScalar(findNestedScalar(text, "goal", "kind") || "open_ended"),
      tranche: parseYamlScalar(findNestedScalar(text, "goal", "tranche") || ""),
      status: parseYamlScalar(findNestedScalar(text, "goal", "status") || "active"),
    },
    active_task: parseYamlScalar(findTopLevelScalar(text, "active_task") || ""),
    tasks,
  };
}

function parseTaskSubsets(text) {
  const tasksText = findTopLevelSection(text, "tasks");
  if (!tasksText) return [];
  const taskBlocks = [];
  let current = [];
  for (const line of tasksText.split("\n")) {
    if (/^  - id:/.test(line)) {
      if (current.length) taskBlocks.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) taskBlocks.push(current.join("\n"));
  return taskBlocks.map((block) => ({
    id: parseYamlScalar(findTaskScalar(block, "id") || ""),
    type: parseYamlScalar(findTaskScalar(block, "type") || "pm"),
    assignee: parseYamlScalar(findTaskScalar(block, "assignee") || ""),
    harness: parseYamlScalar(findTaskScalar(block, "harness") || ""),
    status: parseYamlScalar(findTaskScalar(block, "status") || "queued"),
    title: parseYamlScalar(findTaskScalar(block, "title") || ""),
    objective: parseYamlScalar(findTaskScalar(block, "objective") || ""),
    inputs: findTaskList(block, "inputs"),
    constraints: findTaskList(block, "constraints"),
    expected_output: findTaskList(block, "expected_output"),
    allowed_files: findTaskList(block, "allowed_files"),
    verify: findTaskList(block, "verify"),
    stop_if: findTaskList(block, "stop_if"),
    subgoal: findTaskSubgoal(block),
    receipt: findTaskReceipt(block),
  }));
}

function findTopLevelScalar(text, key) {
  return findScalar(text, new RegExp(`^${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "m"));
}

function findNestedScalar(text, section, key) {
  return findScalar(findTopLevelSection(text, section), new RegExp(`^  ${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "m"));
}

function findTaskScalar(text, key) {
  if (key === "id") return findScalar(text, /^  - id:\s*(.*?)\s*$/m);
  return findScalar(text, new RegExp(`^    ${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "m"));
}

function findScalar(text, pattern) {
  const source = String(text || "");
  const match = source.match(pattern);
  if (!match) return "";
  if (!/^[|>][+-]?$/.test(match[1])) return match[1];
  return blockScalarText(source, match.index, match[0]);
}

function blockScalarText(source, matchIndex, matchedLine) {
  const keyIndent = matchedLine.match(/^ */)[0].length;
  const following = source.slice(matchIndex + matchedLine.length).split("\n").slice(1);
  const collected = [];
  for (const line of following) {
    if (!line.trim()) continue;
    if (line.match(/^ */)[0].length <= keyIndent) break;
    collected.push(line.trim());
  }
  return collected.join(" ");
}

function findTopLevelSection(text, key) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return "";
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    section.push(line);
  }
  return section.join("\n");
}

function findIndentedSection(text, key, indent) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const prefix = " ".repeat(indent);
  const start = lines.findIndex((line) => line.trim() === `${key}:` && line.startsWith(prefix));
  if (start === -1) return "";
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith(`${prefix}  `)) break;
    section.push(line);
  }
  return section.join("\n");
}

function findTaskList(text, key) {
  const inline = findTaskScalar(text, key);
  if (inline) {
    const parsed = parseYamlScalar(inline);
    if (Array.isArray(parsed)) return parsed.map(cleanText).filter(Boolean);
    return cleanText(parsed) ? [cleanText(parsed)] : [];
  }
  const section = findIndentedSection(text, key, 4);
  return section
    .split("\n")
    .map((line) => line.match(/^      -\s*(.*?)\s*$/)?.[1] || "")
    .map(parseYamlScalar)
    .map(cleanText)
    .filter(Boolean);
}

function findTaskSubgoal(text) {
  const inline = findTaskScalar(text, "subgoal");
  if (inline && parseYamlScalar(inline) === null) return null;
  const section = findIndentedSection(text, "subgoal", 4);
  if (!section) return null;
  return {
    status: parseYamlScalar(findScalar(section, /^      status:\s*(.*?)\s*$/m) || "active"),
    path: parseYamlScalar(findScalar(section, /^      path:\s*(.*?)\s*$/m) || ""),
    owner: parseYamlScalar(findScalar(section, /^      owner:\s*(.*?)\s*$/m) || ""),
    created_from: parseYamlScalar(findScalar(section, /^      created_from:\s*(.*?)\s*$/m) || ""),
    depth: parseYamlScalar(findScalar(section, /^      depth:\s*(.*?)\s*$/m) || "1"),
    rollup_receipt: parseYamlScalar(findScalar(section, /^      rollup_receipt:\s*(.*?)\s*$/m) || "null"),
  };
}

function findTaskReceipt(text) {
  const inline = findTaskScalar(text, "receipt");
  if (inline && parseYamlScalar(inline) === null) return null;
  const section = findIndentedSection(text, "receipt", 4);
  if (!section) return null;
  return {
    result: parseYamlScalar(findScalar(section, /^      result:\s*(.*?)\s*$/m) || ""),
    summary: parseYamlScalar(findScalar(section, /^      summary:\s*(.*?)\s*$/m) || ""),
    decision: parseYamlScalar(findScalar(section, /^      decision:\s*(.*?)\s*$/m) || ""),
    note: parseYamlScalar(findScalar(section, /^      note:\s*(.*?)\s*$/m) || ""),
    changed_files: findReceiptList(section, "changed_files"),
    commands: findReceiptCommands(section),
    evidence: [],
  };
}

function findReceiptList(text, key) {
  const section = findIndentedSection(text, key, 6);
  return section
    .split("\n")
    .map((line) => line.match(/^        -\s*(.*?)\s*$/)?.[1] || "")
    .map(parseYamlScalar)
    .map(cleanText)
    .filter(Boolean);
}

function findReceiptCommands(text) {
  const section = findIndentedSection(text, "commands", 6);
  const blocks = [];
  let current = [];
  for (const line of section.split("\n")) {
    if (/^        - cmd:/.test(line)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.map((block) => ({
    cmd: parseYamlScalar(findScalar(block, /^        - cmd:\s*(.*?)\s*$/m) || ""),
    status: parseYamlScalar(findScalar(block, /^          status:\s*(.*?)\s*$/m) || ""),
    note: parseYamlScalar(findScalar(block, /^          note:\s*(.*?)\s*$/m) || ""),
  }));
}

function parseYamlScalar(value) {
  const text = stripComment(String(value ?? "")).trim();
  if (!text) return "";
  try {
    return parseScalar(text);
  } catch {
    if (
      (text.startsWith("\"") && text.endsWith("\"")) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      return text.slice(1, -1);
    }
    return text;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeYaml(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, index) => {
      const withoutComments = stripComment(raw).replace(/\s+$/, "");
      if (!withoutComments.trim()) return null;
      const indent = withoutComments.match(/^ */)[0].length;
      if (indent % 2 !== 0) {
        throw new GoalBoardError(`Unsupported odd indentation at line ${index + 1}.`);
      }
      return {
        number: index + 1,
        indent,
        text: withoutComments.trimStart(),
      };
    })
    .filter(Boolean);
}

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = line[index - 1];
    if (quote === '"' && char === "\\") { index++; continue; }
    if (quote === "'" && char === "'" && line[index + 1] === "'") { index++; continue; }
    if (char === "\"" || char === "'") {
      quote = quote === char ? null : quote || char;
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(previous))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseBlock(lines, index, indent, strict) {
  if (index >= lines.length) return [{}, index];
  if (lines[index].indent < indent) return [{}, index];
  if (lines[index].text.startsWith("- ")) return parseArray(lines, index, indent, strict);
  return parseObject(lines, index, indent, strict);
}

function assignMapping(object, key, value, strict) {
  if (strict) {
    if (Object.hasOwn(object, key)) throw new GoalBoardError(`Duplicate YAML key: ${key}.`);
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    object[key] = value;
  }
}

function parseObject(lines, index, indent, strict) {
  const object = {};
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent || line.text.startsWith("- ")) break;

    const { key, valueText } = splitKeyValue(line);
    index += 1;

    if (valueText === "") {
      if (index < lines.length && lines[index].indent > indent) {
        const [child, nextIndex] = parseBlock(lines, index, lines[index].indent, strict);
        assignMapping(object, key, child, strict);
        index = nextIndex;
      } else {
        assignMapping(object, key, {}, strict);
      }
    } else {
      assignMapping(object, key, parseScalar(valueText), strict);
    }
  }
  return [object, index];
}

function parseArray(lines, index, indent, strict) {
  const array = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent !== indent || !line.text.startsWith("- ")) break;

    const content = line.text.slice(2).trim();
    index += 1;

    if (content === "") {
      if (index < lines.length && lines[index].indent > indent) {
        const [child, nextIndex] = parseBlock(lines, index, lines[index].indent, strict);
        array.push(child);
        index = nextIndex;
      } else {
        array.push(null);
      }
      continue;
    }

    if (isInlineMapping(content)) {
      const object = {};
      const { key, valueText } = splitKeyValue({ text: content, number: line.number });
      assignMapping(object, key, valueText === "" ? {} : parseScalar(valueText), strict);
      if (index < lines.length && lines[index].indent > indent) {
        const [child, nextIndex] = parseBlock(lines, index, lines[index].indent, strict);
        if (child && typeof child === "object" && !Array.isArray(child)) {
          for (const [childKey, value] of Object.entries(child)) assignMapping(object, childKey, value, strict);
        } else {
          throw new GoalBoardError(`Expected mapping below line ${line.number}.`);
        }
        index = nextIndex;
      }
      array.push(object);
    } else {
      array.push(parseScalar(content));
    }
  }
  return [array, index];
}

function splitKeyValue(line) {
  const separator = line.text.indexOf(":");
  if (separator <= 0) {
    throw new GoalBoardError(`Expected key/value pair at line ${line.number}.`);
  }
  return {
    key: line.text.slice(0, separator).trim(),
    valueText: line.text.slice(separator + 1).trim(),
  };
}

function isInlineMapping(text) {
  return /^[A-Za-z0-9_.-]+:\s*/.test(text);
}

function parseScalar(text) {
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArray(inner).map(parseScalar);
  }
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);
  if (text === "|" || text === ">") {
    throw new GoalBoardError("Block scalar YAML is not supported by this lightweight parser.");
  }
  return text;
}

function unquote(text) {
  const quote = text[0];
  if (text.length < 2 || text.at(-1) !== quote) throw new GoalBoardError("Unclosed quoted scalar.");
  let value = "";
  // Consume each escape once. Chained replacements reinterpret the literal
  // backslash in JSON.stringify's "\\\\node" as a newline escape.
  const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index];
    if (char === quote) {
      if (quote === "'" && text[index + 1] === "'" && index + 1 < text.length - 1) { value += "'"; index++; continue; }
      throw new GoalBoardError("Unexpected quote in quoted scalar.");
    }
    if (quote === '"' && char === "\\") {
      if (++index >= text.length - 1) throw new GoalBoardError("Incomplete quoted scalar escape.");
      const escaped = text[index];
      if (escaped === "u") {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) throw new GoalBoardError("Malformed quoted scalar Unicode escape.");
        value += String.fromCharCode(parseInt(hex, 16)); index += 4;
      } else {
        // Unknown legacy escapes were literal; keep that supported shape.
        value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : `\\${escaped}`;
      }
    } else value += char;
  }
  return value;
}

function splitInlineArray(text) {
  const values = [];
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === "\\") { index++; continue; }
    if (quote === "'" && char === "'" && text[index + 1] === "'") { index++; continue; }
    if (char === "\"" || char === "'") {
      quote = quote === char ? null : quote || char;
      continue;
    }
    if (char === "," && !quote) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) throw new GoalBoardError("Unclosed quoted scalar in inline array.");
  values.push(text.slice(start).trim());
  return values;
}

function boardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GoalBuddy Board</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header class="topbar">
    <div class="topbar-primary">
      <div class="brand" aria-label="Goal Buddy">
        <img class="brand-mark" src="./goalbuddy-mark.png" alt="GoalBuddy">
        <span class="brand-name">Goal Buddy</span>
        <span class="live-dot" id="live-dot" aria-hidden="true"></span>
      </div>
      <nav class="board-switcher is-empty" aria-label="Local GoalBuddy boards">
        <label for="board-switcher">Board</label>
        <select id="board-switcher" aria-label="Switch local board"></select>
      </nav>
    </div>
    <div class="header-tools">
      <a class="github-stars" href="https://github.com/tolimarchuk/goalbuddy" target="_blank" rel="noreferrer" aria-label="Open GoalBuddy on GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.84 5.76 6.36.92-4.6 4.48 1.08 6.34L12 17.32 6.32 20.3l1.08-6.34-4.6-4.48 6.36-.92L12 2.8Z"></path></svg>
        <span id="github-stars">Stars</span>
      </a>
      <div class="settings-wrap">
        <button class="settings-button" id="settings-button" type="button" aria-expanded="false" aria-controls="settings-popover">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12.2 2.75h-.4a1.6 1.6 0 0 0-1.58 1.36l-.18 1.18c-.46.16-.9.34-1.31.56l-1.02-.64a1.6 1.6 0 0 0-2.08.31l-.28.28a1.6 1.6 0 0 0-.31 2.08l.64 1.02c-.22.42-.4.86-.56 1.31l-1.18.18A1.6 1.6 0 0 0 2.58 12v.4A1.6 1.6 0 0 0 3.94 14l1.18.18c.16.46.34.9.56 1.31l-.64 1.02a1.6 1.6 0 0 0 .31 2.08l.28.28a1.6 1.6 0 0 0 2.08.31l1.02-.64c.42.22.86.4 1.31.56l.18 1.18a1.6 1.6 0 0 0 1.58 1.36h.4a1.6 1.6 0 0 0 1.58-1.36l.18-1.18c.46-.16.9-.34 1.31-.56l1.02.64a1.6 1.6 0 0 0 2.08-.31l.28-.28a1.6 1.6 0 0 0 .31-2.08l-.64-1.02c.22-.42.4-.86.56-1.31l1.18-.18a1.6 1.6 0 0 0 1.36-1.58V12a1.6 1.6 0 0 0-1.36-1.58l-1.18-.18a7.2 7.2 0 0 0-.56-1.31l.64-1.02a1.6 1.6 0 0 0-.31-2.08l-.28-.28a1.6 1.6 0 0 0-2.08-.31l-1.02.64c-.42-.22-.86-.4-1.31-.56l-.18-1.18a1.6 1.6 0 0 0-1.58-1.39Z"></path>
            <circle cx="12" cy="12.2" r="3.15"></circle>
          </svg>
          <span class="visually-hidden" id="live-state">Connecting</span>
        </button>
        <section class="settings-popover" id="settings-popover" aria-label="Local board settings" hidden>
          <div class="settings-heading">
            <p class="eyebrow">Board settings</p>
            <h2>Local preferences</h2>
          </div>
          <div class="setting-row">
            <label for="setting-theme">Theme</label>
            <select id="setting-theme" data-setting="theme">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="setting-density">Density</label>
            <select id="setting-density" data-setting="density">
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="setting-completed">Completed</label>
            <select id="setting-completed" data-setting="completedVisibility">
              <option value="show">Show</option>
              <option value="collapse">Collapse</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="setting-board-open">Open boards</label>
            <select id="setting-board-open" data-setting="boardOpenBehavior">
              <option value="last">Last viewed</option>
              <option value="newest">Newest active</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="setting-motion">Motion</label>
            <select id="setting-motion" data-setting="motion">
              <option value="system">System</option>
              <option value="reduce">Reduce</option>
              <option value="allow">Allow</option>
            </select>
          </div>
        </section>
      </div>
    </div>
  </header>
  <main class="shell">
    <section class="goal-header" aria-labelledby="goal-title">
      <div>
        <p class="eyebrow">Local state viewer</p>
        <h1 id="goal-title">GoalBuddy Board</h1>
        <p id="goal-tranche" class="goal-tranche"></p>
      </div>
      <dl class="goal-meta">
        <div><dt>Status</dt><dd id="goal-status">Unknown</dd></div>
        <div><dt>Active</dt><dd id="goal-active">None</dd></div>
        <div><dt>Executor</dt><dd id="goal-executor">Not observed</dd></div>
        <div><dt>Updated</dt><dd id="goal-updated">Waiting</dd></div>
      </dl>
    </section>
    <section class="board" id="board" aria-label="Goal task board"></section>
  </main>
  <div class="modal" id="task-modal" hidden>
    <button class="modal-scrim" type="button" data-close-modal aria-label="Close task detail"></button>
    <article class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <div>
          <p class="eyebrow" id="modal-kicker">Task</p>
          <h2 id="modal-title">Task detail</h2>
        </div>
        <button class="icon-button" type="button" data-close-modal aria-label="Close task detail">x</button>
      </header>
      <div class="modal-body" id="modal-body"></div>
    </article>
  </div>
  <script src="./app.js" type="module"></script>
</body>
</html>`;
}

function boardCss() {
  return `:root {
  color-scheme: light;
  --canvas: #f7f6f3;
  --surface: #ffffff;
  --surface-muted: #fbfbfa;
  --ink: #111111;
  --muted: #787774;
  --line: #eaeaea;
  --blue-bg: #e1f3fe;
  --blue-text: #1f6c9f;
  --green-bg: #edf3ec;
  --green-text: #346538;
  --red-bg: #fdebec;
  --red-text: #9f2f2d;
  --yellow-bg: #fbf3db;
  --yellow-text: #956400;
  --active-surface: #fbfdfe;
  font-family: "SF Pro Display", "Geist Sans", "Helvetica Neue", Arial, sans-serif;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #07101f;
  --surface: #101a2d;
  --surface-muted: #0c1525;
  --ink: #f7f9fc;
  --muted: #9aa7bf;
  --line: #26334a;
  --blue-bg: #173653;
  --blue-text: #9ed8ff;
  --green-bg: #143929;
  --green-text: #a6e8bf;
  --red-bg: #3a1d22;
  --red-text: #ffb2b9;
  --yellow-bg: #3a3014;
  --yellow-text: #f6d878;
  --active-surface: #0f2031;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    color-scheme: dark;
    --canvas: #07101f;
    --surface: #101a2d;
    --surface-muted: #0c1525;
    --ink: #f7f9fc;
    --muted: #9aa7bf;
    --line: #26334a;
    --blue-bg: #173653;
    --blue-text: #9ed8ff;
    --green-bg: #143929;
    --green-text: #a6e8bf;
    --red-bg: #3a1d22;
    --red-text: #ffb2b9;
    --yellow-bg: #3a3014;
    --yellow-text: #f6d878;
    --active-surface: #0f2031;
  }

  :root[data-theme="system"] .topbar {
    border-color: rgba(61, 76, 108, 0.86);
    background: rgba(13, 23, 41, 0.84);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  }

  :root[data-theme="system"] .brand {
    color: var(--ink);
  }

  :root[data-theme="system"] .board-switcher select,
  :root[data-theme="system"] .github-stars,
  :root[data-theme="system"] .settings-button {
    border-color: rgba(61, 76, 108, 0.9);
    background: rgba(16, 26, 45, 0.78);
    color: var(--ink);
  }

  :root[data-theme="system"] .settings-popover {
    border-color: rgba(61, 76, 108, 0.96);
    background: rgba(16, 26, 45, 0.96);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
  }

  :root[data-theme="system"] .setting-row select {
    background: var(--surface);
    color: var(--ink);
  }

  :root[data-theme="system"] .goal-tranche,
  :root[data-theme="system"] .task-title,
  :root[data-theme="system"] .setting-row select {
    color: var(--ink);
  }

  :root[data-theme="system"] .task-card.is-active {
    background: linear-gradient(var(--active-surface), var(--active-surface)) padding-box,
      linear-gradient(110deg, #78d7ff, #6c63ff, #78f2b9, #78d7ff) border-box;
  }

  :root[data-theme="system"] .task-card.is-active::after {
    background: var(--active-surface);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--canvas);
  color: var(--ink);
}

button,
input,
textarea {
  font: inherit;
}

a {
  color: inherit;
  text-decoration: none;
}

select,
button {
  font: inherit;
}

.topbar {
  position: sticky;
  top: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: min(1392px, calc(100% - 48px));
  min-height: 64px;
  margin: 0 auto;
  padding: 10px 12px 10px 18px;
  border: 1px solid rgba(219, 226, 240, 0.86);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 18px 48px rgba(30, 40, 72, 0.1);
  backdrop-filter: blur(22px);
}

:root[data-theme="dark"] .topbar {
  border-color: rgba(61, 76, 108, 0.86);
  background: rgba(13, 23, 41, 0.84);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}

.topbar-primary {
  display: inline-flex;
  align-items: center;
  gap: 24px;
  min-width: 0;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #071236;
  font-weight: 800;
  min-width: fit-content;
}

:root[data-theme="dark"] .brand {
  color: var(--ink);
}

.brand-mark {
  display: block;
  width: 38px;
  height: 38px;
  filter: drop-shadow(0 8px 13px rgba(87, 76, 210, 0.18));
}

.brand-name {
  font-size: 18px;
  letter-spacing: 0;
}

.board-switcher {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
}

.board-switcher label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.board-switcher select {
  width: min(280px, 100%);
  min-width: 0;
  min-height: 38px;
  border: 1px solid rgba(219, 226, 240, 0.9);
  border-radius: 999px;
  padding: 0 34px 0 14px;
  background: rgba(255, 255, 255, 0.72);
  color: #2f3c59;
  font-weight: 700;
  font-size: 14px;
}

:root[data-theme="dark"] .board-switcher select,
:root[data-theme="dark"] .github-stars,
:root[data-theme="dark"] .settings-button {
  border-color: rgba(61, 76, 108, 0.9);
  background: rgba(16, 26, 45, 0.78);
  color: var(--ink);
}

.board-switcher.is-empty {
  display: none;
}

.header-tools {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: fit-content;
}

.github-stars,
.settings-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border: 1px solid rgba(219, 226, 240, 0.9);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: #2f3c59;
  font-weight: 800;
  transition: transform 180ms ease, color 180ms ease, border-color 180ms ease, background 180ms ease;
}

.github-stars {
  gap: 7px;
  padding: 0 15px;
  font-size: 14px;
  white-space: nowrap;
}

.github-stars:hover,
.settings-button:hover {
  transform: translateY(-2px);
  color: #071236;
  border-color: rgba(79, 70, 216, 0.26);
  background: #fff;
}

.github-stars svg {
  width: 16px;
  height: 16px;
  color: #4f46d8;
  fill: currentColor;
}

.settings-wrap {
  position: relative;
}

.settings-button {
  position: relative;
  gap: 8px;
  width: 44px;
  padding: 0;
  cursor: pointer;
}

.settings-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linejoin: round;
}

.live-dot {
  width: 8px;
  height: 8px;
  border: 2px solid #fff;
  border-radius: 999px;
  background: #1f9d69;
  box-shadow: 0 0 0 4px rgba(31, 157, 105, 0.12);
}

.live-dot.offline {
  background: var(--yellow-text);
  box-shadow: 0 0 0 4px rgba(149, 100, 0, 0.12);
}

.settings-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  width: min(320px, calc(100vw - 32px));
  padding: 16px;
  border: 1px solid rgba(219, 226, 240, 0.96);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 24px 64px rgba(30, 40, 72, 0.16);
  backdrop-filter: blur(20px);
}

:root[data-theme="dark"] .settings-popover {
  border-color: rgba(61, 76, 108, 0.96);
  background: rgba(16, 26, 45, 0.96);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
}

.settings-popover[hidden] {
  display: none;
}

.settings-heading {
  margin-bottom: 12px;
}

.settings-heading .eyebrow {
  margin-bottom: 6px;
}

.settings-heading h2 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0;
}

.setting-row {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.setting-row label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}

.setting-row select {
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 10px;
  background: #fff;
  color: #2f3437;
}

:root[data-theme="dark"] .setting-row select {
  background: var(--surface);
  color: var(--ink);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: var(--blue-bg);
  color: var(--blue-text);
}

.live-state.offline {
  background: var(--yellow-bg);
  color: var(--yellow-text);
}

.shell {
  width: min(1440px, 100%);
  margin: 0 auto;
  padding: 28px 24px 40px;
}

.goal-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: end;
  padding: 8px 0 24px;
  border-bottom: 1px solid var(--line);
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 10px;
  max-width: 900px;
  font-size: clamp(34px, 5vw, 68px);
  line-height: 0.95;
  letter-spacing: 0;
}

.goal-tranche {
  max-width: 860px;
  margin-bottom: 0;
  color: #2f3437;
  line-height: 1.55;
}

:root[data-theme="dark"] .goal-tranche,
:root[data-theme="dark"] .task-title,
:root[data-theme="dark"] .setting-row select {
  color: var(--ink);
}

.goal-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(94px, auto));
  gap: 1px;
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--line);
}

.goal-meta div {
  min-width: 0;
  padding: 12px 14px;
  background: var(--surface);
}

.goal-meta dt {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.goal-meta dd {
  margin: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  padding-top: 18px;
}

.column {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-muted);
}

.column-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
}

.column-header h2 {
  margin: 0 0 4px;
  font-size: 16px;
  line-height: 1.2;
}

.column-header p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.4;
}

.column-count {
  color: var(--muted);
  font-family: "Geist Mono", "SF Mono", monospace;
  font-size: 13px;
}

.card-list {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.task-card {
  position: relative;
  width: 100%;
  min-height: 138px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: transform 160ms ease, border-color 160ms ease;
  will-change: transform, opacity;
}

.task-card > * {
  position: relative;
  z-index: 1;
}

.task-card:hover {
  border-color: #d1d0cc;
  transform: translateY(-1px);
}

.task-card:focus-visible,
.icon-button:focus-visible {
  outline: 2px solid #2f3437;
  outline-offset: 2px;
}

.task-card.is-active {
  border-color: transparent;
  background: linear-gradient(#fbfdfe, #fbfdfe) padding-box,
    linear-gradient(110deg, #78d7ff, #4f46d8, #78f2b9, #78d7ff) border-box;
  box-shadow: 0 14px 38px rgba(31, 108, 159, 0.12);
}

.task-card.is-active::before {
  position: absolute;
  inset: -2px;
  z-index: 0;
  content: "";
  background: conic-gradient(from 0deg, transparent 0 58%, rgba(79, 70, 216, 0.28), rgba(120, 215, 255, 0.44), transparent 78% 100%);
  opacity: 0.86;
  animation: active-card-orbit 2.8s linear infinite;
}

.task-card.is-active::after {
  position: absolute;
  inset: 2px;
  z-index: 0;
  content: "";
  border-radius: 6px;
  background: #fbfdfe;
}

:root[data-theme="dark"] .task-card.is-active {
  background: linear-gradient(var(--active-surface), var(--active-surface)) padding-box,
    linear-gradient(110deg, #78d7ff, #6c63ff, #78f2b9, #78d7ff) border-box;
}

:root[data-theme="dark"] .task-card.is-active::after {
  background: var(--active-surface);
}

:root[data-density="compact"] .shell {
  padding-top: 20px;
}

:root[data-density="compact"] .board {
  gap: 12px;
}

:root[data-density="compact"] .column-header {
  padding: 12px;
}

:root[data-density="compact"] .card-list {
  gap: 8px;
  padding: 10px;
}

:root[data-density="compact"] .task-card {
  min-height: 110px;
  gap: 9px;
  padding: 11px;
}

:root[data-density="compact"] .task-title {
  font-size: 14px;
}

:root[data-completed-visibility="collapse"] .column[data-column-id="completed"] .card-list {
  display: none;
}

:root[data-completed-visibility="collapse"] .column[data-column-id="completed"] {
  max-height: 80px;
  overflow: hidden;
}

@keyframes active-card-orbit {
  to { transform: rotate(360deg); }
}

.task-card.is-moving {
  border-color: #c2b8ff;
}

.card-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-id {
  color: var(--muted);
  font-family: "Geist Mono", "SF Mono", monospace;
  font-size: 12px;
}

.task-title {
  margin: 0;
  color: #2f3437;
  display: -webkit-box;
  font-size: 15px;
  line-height: 1.35;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
}

.card-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}

.badge.status-active,
.badge.status-queued { background: var(--blue-bg); color: var(--blue-text); }
.badge.status-done { background: var(--green-bg); color: var(--green-text); }
.badge.status-blocked { background: var(--red-bg); color: var(--red-text); }
.badge.role { background: var(--yellow-bg); color: var(--yellow-text); }
.badge.harness { background: var(--blue-bg); color: var(--blue-text); font-family: ui-monospace, monospace; }
.badge.subgoal { background: #ece8ff; color: #5c43c6; }
.badge.subgoal.status-blocked { background: var(--red-bg); color: var(--red-text); }
.badge.subgoal.status-done { background: var(--green-bg); color: var(--green-text); }

:root[data-theme="dark"] .badge.subgoal {
  background: #263052;
  color: #c7d2ff;
}

.empty {
  padding: 18px;
  color: var(--muted);
  font-size: 14px;
}

.board-error {
  grid-column: 1 / -1;
  padding: 18px;
  border: 1px solid var(--red-border);
  border-radius: 8px;
  background: var(--red-bg);
  color: var(--text);
}

.board-warning {
  grid-column: 1 / -1;
  padding: 12px 16px;
  border: 1px solid var(--amber-border, #d9b64a);
  border-radius: 8px;
  background: var(--amber-bg, #fdf6e0);
  color: var(--text);
  font-size: 13px;
}

:root[data-theme="dark"] .board-warning {
  border-color: #8a6d1f;
  background: #33290f;
}

.board-error h2 {
  margin: 0 0 8px;
  font-size: 16px;
}

.board-error p {
  margin: 0;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .github-stars,
  .settings-button,
  .task-card {
    transition: none;
  }

  .task-card.is-active::before {
    animation: none;
    opacity: 0.26;
  }
}

:root[data-motion="reduce"] .github-stars,
:root[data-motion="reduce"] .settings-button,
:root[data-motion="reduce"] .task-card {
  transition: none;
}

:root[data-motion="reduce"] .task-card.is-active::before {
  animation: none;
  opacity: 0.26;
}

.modal[hidden] {
  display: none;
}

.modal {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
}

.modal-scrim {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(17, 17, 17, 0.32);
}

.modal-panel {
  position: relative;
  width: min(1080px, 100%);
  max-height: min(760px, calc(100vh - 48px));
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}

.modal-header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.modal-header h2 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: 0;
}

.icon-button {
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: #2f3437;
  cursor: pointer;
}

.modal-body {
  display: grid;
  gap: 18px;
  padding: 20px;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--line);
}

.detail-item {
  min-width: 0;
  padding: 12px;
  background: var(--surface-muted);
}

.detail-item dt {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.detail-item dd {
  margin: 0;
  line-height: 1.45;
}

.detail-section {
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.detail-section h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.detail-section ul {
  margin: 0;
  padding-left: 18px;
  color: var(--ink);
  line-height: 1.55;
}

.detail-section li {
  color: var(--ink);
}

.subgoal-section {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  background: var(--surface-muted);
}

.subgoal-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.subgoal-title {
  margin: 0 0 4px;
  font-size: 15px;
}

.subgoal-meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.subgoal-board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.subgoal-column {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}

.subgoal-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}

.subgoal-column-header h4 {
  margin: 0;
  font-size: 12px;
}

.subgoal-card-list {
  display: grid;
  gap: 8px;
  padding: 8px;
}

.subgoal-task-card {
  min-height: 74px;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 9px;
  background: var(--surface);
}

.subgoal-task-card.is-active {
  border-color: #8e9cff;
  background: var(--active-surface);
}

.subgoal-task-title {
  margin: 6px 0 0;
  color: var(--ink);
  font-size: 12px;
  line-height: 1.35;
}

pre.note {
  overflow: auto;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--canvas);
  color: var(--ink);
  font-family: "Geist Mono", "SF Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}

@media (max-width: 980px) {
  .goal-header {
    grid-template-columns: 1fr;
  }

  .goal-meta {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .board {
    grid-template-columns: 1fr;
  }

  .subgoal-board {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .topbar {
    align-items: flex-start;
  }

  .topbar-primary {
    flex: 1;
    flex-wrap: wrap;
    gap: 10px 14px;
  }

  .board-switcher select {
    width: 100%;
  }

  .shell {
    padding-left: 14px;
    padding-right: 14px;
  }

  .goal-meta,
  .detail-grid {
    grid-template-columns: 1fr;
  }

  h1 {
    font-size: 38px;
  }
}`;
}

function boardJs() {
  return `let currentBoard = null;
let eventSource = null;
let currentSettings = null;

const boardEl = document.getElementById("board");
const liveStateEl = document.getElementById("live-state");
const liveDotEl = document.getElementById("live-dot");
const boardSwitcherEl = document.getElementById("board-switcher");
const settingsButtonEl = document.getElementById("settings-button");
const settingsPopoverEl = document.getElementById("settings-popover");
const githubStarsEl = document.getElementById("github-stars");
const modalEl = document.getElementById("task-modal");
const modalTitleEl = document.getElementById("modal-title");
const modalKickerEl = document.getElementById("modal-kicker");
const modalBodyEl = document.getElementById("modal-body");
const settingsStorageKey = "goalbuddy.localBoardSettings.v1";
const settingsDefaults = {
  theme: "system",
  density: "comfortable",
  completedVisibility: "show",
  boardOpenBehavior: "last",
  motion: "system",
  lastBoardPath: "",
};
const settingsOptions = {
  theme: new Set(["system", "light", "dark"]),
  density: new Set(["comfortable", "compact"]),
  completedVisibility: new Set(["show", "collapse"]),
  boardOpenBehavior: new Set(["last", "newest"]),
  motion: new Set(["system", "reduce", "allow"]),
};

document.addEventListener("click", (event) => {
  const card = event.target.closest("[data-task-id]");
  if (card) openTask(card.dataset.taskId);
  if (event.target.matches("[data-close-modal]")) closeModal();
  if (settingsPopoverEl.hidden) return;
  if (!event.target.closest(".settings-wrap")) closeSettings();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
    closeSettings();
  }
});

boardSwitcherEl.addEventListener("change", () => {
  if (boardSwitcherEl.value && boardSwitcherEl.value !== window.location.href) {
    window.location.href = boardSwitcherEl.value;
  }
});

settingsButtonEl.addEventListener("click", () => {
  if (settingsPopoverEl.hidden) {
    openSettings();
  } else {
    closeSettings();
  }
});

settingsPopoverEl.addEventListener("change", (event) => {
  const control = event.target.closest("[data-setting]");
  if (!control) return;
  saveSettings({ ...currentSettings, [control.dataset.setting]: control.value });
});

async function loadBoard() {
  const response = await fetch("./api/board", { cache: "no-store" });
  if (!response.ok) throw new Error("Board request failed");
  renderBoard(await response.json());
}

async function loadBoardSwitcher() {
  const response = await fetch("../api/boards", { cache: "no-store" });
  if (!response.ok) return;
  const payload = await response.json();
  renderBoardSwitcher(payload.boards || []);
}

async function loadSettings() {
  try {
    const response = await fetch("../api/settings", { cache: "no-store" });
    if (!response.ok) throw new Error("Settings request failed");
    const payload = await response.json();
    currentSettings = normalizeSettings(payload.settings);
    window.localStorage?.setItem(settingsStorageKey, JSON.stringify(currentSettings));
  } catch {
    currentSettings = readStoredSettings();
  }
  applySettings(currentSettings);
}

async function saveSettings(nextSettings) {
  currentSettings = normalizeSettings(nextSettings);
  window.localStorage?.setItem(settingsStorageKey, JSON.stringify(currentSettings));
  applySettings(currentSettings);
  try {
    const response = await fetch("../api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: currentSettings }),
    });
    if (!response.ok) throw new Error("Settings save failed");
    const payload = await response.json();
    currentSettings = normalizeSettings(payload.settings);
    window.localStorage?.setItem(settingsStorageKey, JSON.stringify(currentSettings));
    applySettings(currentSettings);
  } catch {
    // Keep the localStorage fallback active when the local settings API is unavailable.
  }
  return currentSettings;
}

function readStoredSettings() {
  try {
    return normalizeSettings(JSON.parse(window.localStorage?.getItem(settingsStorageKey) || "{}"));
  } catch {
    return { ...settingsDefaults };
  }
}

function normalizeSettings(settings) {
  const normalized = { ...settingsDefaults };
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return normalized;
  for (const [key, allowed] of Object.entries(settingsOptions)) {
    if (allowed.has(settings[key])) normalized[key] = settings[key];
  }
  if (typeof settings.lastBoardPath === "string" && /^\\/[a-z0-9][a-z0-9-]*\\/$/.test(settings.lastBoardPath)) {
    normalized.lastBoardPath = settings.lastBoardPath;
  }
  return normalized;
}

function applySettings(settings) {
  const normalized = normalizeSettings(settings);
  document.documentElement.dataset.theme = normalized.theme;
  document.documentElement.dataset.density = normalized.density;
  document.documentElement.dataset.completedVisibility = normalized.completedVisibility;
  document.documentElement.dataset.boardOpenBehavior = normalized.boardOpenBehavior;
  document.documentElement.dataset.motion = normalized.motion;
  for (const control of settingsPopoverEl.querySelectorAll("[data-setting]")) {
    control.value = normalized[control.dataset.setting] || settingsDefaults[control.dataset.setting];
  }
}

function rememberCurrentBoard() {
  const boardPath = normalizePath(window.location.pathname);
  if (!/^\\/[a-z0-9][a-z0-9-]*\\/$/.test(boardPath)) return;
  const nextSettings = normalizeSettings({ ...currentSettings, lastBoardPath: boardPath });
  currentSettings = nextSettings;
  window.localStorage?.setItem(settingsStorageKey, JSON.stringify(nextSettings));
  fetch("../api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: nextSettings }),
  }).catch(() => {});
}

function openSettings() {
  settingsPopoverEl.hidden = false;
  settingsButtonEl.setAttribute("aria-expanded", "true");
  settingsPopoverEl.querySelector("[data-setting]")?.focus();
}

function closeSettings() {
  settingsPopoverEl.hidden = true;
  settingsButtonEl.setAttribute("aria-expanded", "false");
}

function formatStars(count) {
  if (count >= 1000) return \`\${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k\`;
  return String(count);
}

async function loadGithubStars() {
  if (!githubStarsEl) return;
  try {
    const response = await fetch("https://api.github.com/repos/tolimarchuk/goalbuddy", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error("GitHub API unavailable");
    const repo = await response.json();
    githubStarsEl.textContent = \`\${formatStars(repo.stargazers_count)} stars\`;
  } catch {
    githubStarsEl.textContent = "GitHub";
  }
}

function connectEvents() {
  eventSource = new EventSource("./events");
  eventSource.addEventListener("board", (event) => {
    setLiveState("Live", true);
    renderBoard(JSON.parse(event.data));
  });
  eventSource.addEventListener("error", () => {
    setLiveState("Reconnecting", false);
  });
}

function renderBoard(board) {
  const previousPositions = measureCards();
  const previousColumns = new Map();
  for (const column of currentBoard?.columns || []) {
    for (const task of column.tasks) previousColumns.set(task.id, column.id);
  }
  const movingTaskIds = tasksChangingColumns(board, previousColumns);
  if (movingTaskIds.size) highlightMovingCards(movingTaskIds);
  currentBoard = board;
  document.getElementById("goal-title").textContent = board.goal.title;
  document.title = board.goal.title ? board.goal.title + " - GoalBuddy Board" : "GoalBuddy Board";
  document.getElementById("goal-tranche").textContent = board.goal.tranche || "";
  document.getElementById("goal-status").textContent = board.goal.status;
  document.getElementById("goal-active").textContent = board.goal.activeTask || "None";
  document.getElementById("goal-executor").textContent = board.executor?.label || "Not observed";
  document.getElementById("goal-executor").title = board.executor?.detail || "";
  document.getElementById("goal-updated").textContent = new Date(board.generatedAt).toLocaleTimeString();

  if (board.error) {
    boardEl.replaceChildren(renderBoardError(board.error));
    return;
  }

  const delay = movingTaskIds.size ? 260 : 0;
  window.setTimeout(() => {
    const children = board.columns.map(renderColumn);
    if (board.parseWarning) children.unshift(renderBoardWarning(board.parseWarning));
    boardEl.replaceChildren(...children);
    animateCardMoves(previousPositions, movingTaskIds);
  }, delay);
}

function renderBoardWarning(message) {
  const node = el("section", "board-warning");
  node.append(
    el("strong", "", "Degraded board view. "),
    el("span", "", message),
  );
  return node;
}

function renderBoardError(message) {
  const node = el("section", "board-error");
  node.append(
    el("h2", "", "GoalBuddy could not parse this board"),
    el("p", "", message),
  );
  return node;
}

function renderBoardSwitcher(boards) {
  boardSwitcherEl.closest(".board-switcher").classList.toggle("is-empty", boards.length <= 1);
  const currentPath = normalizePath(window.location.pathname);
  const options = boards.map((board) => {
    const option = document.createElement("option");
    option.value = board.url;
    option.textContent = boardOptionLabel(board);
    const boardPath = normalizePath(new URL(board.url, window.location.href).pathname);
    if (boardPath === currentPath) option.selected = true;
    return option;
  });
  boardSwitcherEl.replaceChildren(...options);
}

function renderColumn(column) {
  const section = el("section", "column");
  section.dataset.columnId = column.id;
  const header = el("header", "column-header");
  const titleWrap = el("div");
  titleWrap.append(el("h2", "", column.title), el("p", "", column.description));
  header.append(titleWrap, el("span", "column-count", String(column.tasks.length)));

  const list = el("div", "card-list");
  if (column.tasks.length === 0) {
    list.append(el("p", "empty", "No cards"));
  } else {
    for (const task of column.tasks) list.append(renderCard(task));
  }

  section.append(header, list);
  return section;
}

function renderCard(task) {
  const button = el("button", \`task-card \${task.active ? "is-active" : ""}\`);
  button.type = "button";
  button.dataset.taskId = task.id;
  button.dataset.status = task.status;

  const topline = el("div", "card-topline");
  topline.append(el("span", "task-id", task.id), statusBadge(task.status));

  const footer = el("div", "card-footer");
  footer.append(el("span", "badge role", task.assignee || task.type || "PM"));
  if (task.harness) footer.append(el("span", "badge harness", task.harness));
  if (task.subgoal) footer.append(subgoalBadge(task.subgoal));
  if (task.receipt?.present) footer.append(el("span", "badge status-done", "Receipt"));

  button.append(topline, el("h3", "task-title", task.title), footer);
  return button;
}

function measureCards() {
  const positions = new Map();
  for (const card of boardEl.querySelectorAll("[data-task-id]")) {
    const rect = card.getBoundingClientRect();
    positions.set(card.dataset.taskId, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      columnId: card.closest("[data-column-id]")?.dataset.columnId || "",
    });
  }
  return positions;
}

function tasksChangingColumns(board, previousColumns) {
  const moving = new Set();
  for (const column of board.columns) {
    for (const task of column.tasks) {
      const previousColumn = previousColumns.get(task.id);
      if (previousColumn && previousColumn !== column.id) moving.add(task.id);
    }
  }
  return moving;
}

function highlightMovingCards(taskIds) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const card of boardEl.querySelectorAll("[data-task-id]")) {
    if (!taskIds.has(card.dataset.taskId)) continue;
    card.classList.add("is-moving");
    card.animate([
      { transform: "scale(1)", borderColor: "#eaeaea" },
      { transform: "scale(1.025)", borderColor: "#9d8cff" },
      { transform: "scale(1)", borderColor: "#c2b8ff" },
    ], {
      duration: 240,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  }
}

function animateCardMoves(previousPositions, movingTaskIds = new Set()) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const card of boardEl.querySelectorAll("[data-task-id]")) {
    const previous = previousPositions.get(card.dataset.taskId);
    const current = card.getBoundingClientRect();
    const columnId = card.closest("[data-column-id]")?.dataset.columnId || "";

    if (!previous) {
      card.animate([
        { opacity: 0, transform: "translateY(10px) scale(0.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ], {
        duration: 260,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
      continue;
    }

    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

    const changedColumn = previous.columnId !== columnId;
    const wasSelected = movingTaskIds.has(card.dataset.taskId);
    card.animate([
      {
        transform: \`translate(\${dx}px, \${dy}px) scale(\${changedColumn ? "1.015" : "1"})\`,
        opacity: changedColumn ? 0.9 : 1,
        borderColor: wasSelected ? "#9d8cff" : "#eaeaea",
      },
      {
        transform: "translate(0, 0) scale(1)",
        opacity: 1,
        borderColor: "#eaeaea",
      },
    ], {
      duration: changedColumn ? 980 : 520,
      easing: "cubic-bezier(0.19, 1, 0.22, 1)",
    });
  }
}

function openTask(taskId) {
  const task = currentBoard?.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return;

  modalKickerEl.textContent = \`\${task.id} · \${task.status}\`;
  modalTitleEl.textContent = task.title;
  modalBodyEl.replaceChildren(renderTaskDetail(task));
  modalEl.hidden = false;
}

function closeModal() {
  modalEl.hidden = true;
}

function renderTaskDetail(task) {
  const root = el("div");
  const grid = el("dl", "detail-grid");
  for (const [label, value] of [
    ["Status", task.status],
    ["Assignee", task.assignee || "Unassigned"],
    ["Type", task.type],
    ["Receipt", task.receipt?.summary || "None"],
  ]) {
    const item = el("div", "detail-item");
    item.append(el("dt", "", label), el("dd", "", value));
    grid.append(item);
  }
  root.append(grid);
  if (task.subgoal) root.append(renderSubgoal(task.subgoal));
  root.append(detailText("Objective", task.objective));
  root.append(detailList("Inputs", task.inputs));
  root.append(detailList("Constraints", task.constraints));
  root.append(detailList("Expected Output", task.expectedOutput));
  root.append(detailList("Allowed Files", task.allowedFiles));
  root.append(detailList("Verify", task.verify));
  root.append(detailList("Stop If", task.stopIf));
  if (task.receipt?.decision) root.append(detailText("Decision", task.receipt.decision));
  if (task.receipt?.changedFiles?.length) root.append(detailList("Changed Files", task.receipt.changedFiles));
  if (task.receipt?.commands?.length) {
    root.append(detailList("Commands", task.receipt.commands.map((command) => command.status ? \`\${command.status}: \${command.cmd}\` : command.cmd)));
  }
  if (task.note?.content) {
    const section = el("section", "detail-section");
    section.append(el("h3", "", task.note.title || task.note.path), el("pre", "note", task.note.content));
    root.append(section);
  }
  return root;
}

function renderSubgoal(subgoal) {
  const section = el("section", "detail-section subgoal-section");
  const header = el("div", "subgoal-header");
  const titleWrap = el("div");
  const board = subgoal.board;
  titleWrap.append(
    el("h3", "subgoal-title", board?.goal?.title || "Sub-goal"),
    el("p", "subgoal-meta", [
      subgoal.path,
      subgoal.owner ? \`owner: \${subgoal.owner}\` : "",
      subgoal.depth ? \`depth: \${subgoal.depth}\` : "",
    ].filter(Boolean).join(" · ")),
  );
  header.append(titleWrap, subgoalBadge(subgoal));
  section.append(header);

  if (!board?.columns?.length) {
    section.append(el("p", "", "No child board payload."));
    return section;
  }

  const boardEl = el("div", "subgoal-board");
  for (const column of board.columns) {
    const columnEl = el("section", "subgoal-column");
    const columnHeader = el("header", "subgoal-column-header");
    columnHeader.append(el("h4", "", column.title), el("span", "column-count", String(column.tasks.length)));
    const list = el("div", "subgoal-card-list");
    if (column.tasks.length === 0) {
      list.append(el("p", "empty", "No cards"));
    } else {
      for (const task of column.tasks) list.append(renderSubgoalTask(task));
    }
    columnEl.append(columnHeader, list);
    boardEl.append(columnEl);
  }
  section.append(boardEl);

  if (subgoal.rollupReceipt) {
    section.append(detailText("Roll-up Receipt", subgoal.rollupReceipt));
  }

  return section;
}

function renderSubgoalTask(task) {
  const card = el("article", \`subgoal-task-card \${task.active ? "is-active" : ""}\`);
  const topline = el("div", "card-topline");
  topline.append(el("span", "task-id", task.id), statusBadge(task.status));
  const footer = el("div", "card-footer");
  footer.append(el("span", "badge role", task.assignee || task.type || "PM"));
  if (task.receipt?.present) footer.append(el("span", "badge status-done", "Receipt"));
  card.append(topline, el("h4", "subgoal-task-title", task.title), footer);
  return card;
}

function detailText(title, value) {
  const section = el("section", "detail-section");
  section.append(el("h3", "", title), el("p", "", value || "None"));
  return section;
}

function detailList(title, values) {
  const section = el("section", "detail-section");
  section.append(el("h3", "", title));
  if (!values?.length) {
    section.append(el("p", "", "None"));
    return section;
  }
  const list = el("ul");
  for (const value of values) list.append(el("li", "", value));
  section.append(list);
  return section;
}

function statusBadge(status) {
  const label = status === "done" ? "Completed" : status === "active" ? "Active" : status === "blocked" ? "Blocked" : "Queued";
  return el("span", \`badge status-\${status}\`, label);
}

function subgoalBadge(subgoal) {
  return el("span", \`badge subgoal status-\${subgoal.status}\`, \`Sub-goal \${subgoal.status || "linked"}\`);
}

function setLiveState(text, live) {
  liveStateEl.textContent = text;
  liveDotEl.classList.toggle("offline", !live);
  settingsButtonEl.setAttribute("aria-label", \`Settings. Board status: \${text}\`);
  settingsButtonEl.title = \`Settings · \${text}\`;
}

function normalizePath(pathname) {
  return pathname.endsWith("/") ? pathname : pathname + "/";
}

function boardOptionLabel(board) {
  const title = board.title || board.slug || board.goalDir || "GoalBuddy board";
  return /[/\\\\]subgoals[/\\\\]/.test(board.goalDir || "") ? \`Child: \${title}\` : title;
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

loadSettings()
  .then(loadBoard)
  .then(() => {
    setLiveState("Live", true);
    rememberCurrentBoard();
    loadGithubStars();
    loadBoardSwitcher();
    window.setInterval(loadBoardSwitcher, 5000);
    connectEvents();
  })
  .catch((error) => {
    setLiveState("Offline", false);
    boardEl.textContent = error.message;
  });
`;
}

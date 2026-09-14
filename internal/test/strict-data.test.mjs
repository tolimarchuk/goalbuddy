import test from "node:test";
import assert from "node:assert/strict";
import { parseBoard, parseJson } from "../../goalbuddy/scripts/strict-data.mjs";
import { parseGoalStateText } from "../../goalbuddy/surfaces/local-goal-board/scripts/lib/goal-board.mjs";

for (const indent of [4, 6, 8]) {
  for (const key of ["status", "status ", "status\t"]) {
    test(`strict sequence merge rejects ${JSON.stringify(key)} at indentation ${indent}`, () => {
      const text = `commands:\n  - status: fail\n${" ".repeat(indent)}${key}: pass\n${" ".repeat(indent)}cmd: check\n`;
      assert.equal(parseGoalStateText(text).commands[0].status, "pass", "Default display parsing stays compatible.");
      assert.throws(() => parseBoard(text), /Duplicate YAML key: status/);
    });
  }
}

test("strict nested mappings share the actual assignment boundary", () => {
  assert.throws(() => parseBoard("tasks:\n  - id: T999\n    receipt:\n      commands:\n        - status: fail\n            status: pass\n"), /Duplicate YAML key: status/);
  assert.throws(() => parseBoard("tasks:\n  - id: T999\n    receipt:\n      result: fail\n      result : pass\n"), /Duplicate YAML key: result/);
  assert.throws(() => parseBoard("tasks:\n  - id: T999\n    id: T001\n"), /Duplicate YAML key: id/);
});

for (const indent of [4, 6, 8]) {
  test(`ordinary sequence mappings remain supported at indentation ${indent}`, () => {
    const text = `commands:\n  - status: pass\n${" ".repeat(indent)}cmd: first\n  - cmd: second\n${" ".repeat(indent)}status: pass\n`;
    assert.deepEqual(parseBoard(text), { commands: [{ status: "pass", cmd: "first" }, { cmd: "second", status: "pass" }] });
  });
}

test("ordinary nested sequence mappings and repeated keys in separate scopes remain supported", () => {
  const text = "tasks:\n  - id: T001\n    receipt:\n      result: done\n      commands:\n        - cmd: first\n          status: pass\n        - cmd: second\n          status: pass\n  - id: T999\n    receipt:\n      result: done\n";
  assert.deepEqual(parseBoard(text), parseGoalStateText(text));
  assert.equal(parseBoard(text).tasks[1].id, "T999");
});

test("strict opt-in rejects parser recovery while the default display preserves it", () => {
  const text = "version: 2\ngoal:\n   status: active\ntasks:\n  - id: T001\n    type: worker\n    status: active\n";
  assert.match(parseGoalStateText(text).__parseWarning, /fallback/);
  assert.throws(() => parseBoard(text), /Unsupported odd indentation/);
});

test("decoded JSON duplicate keys still reject", () => {
  assert.throws(() => parseJson('{"result":"fail","\\u0072esult":"pass"}'), /Duplicate JSON member/);
  assert.deepEqual(parseJson('{"a":{"result":"pass"},"b":{"result":"fail"}}'), { a: { result: "pass" }, b: { result: "fail" } });
});

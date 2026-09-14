// Strict trust-boundary readers; display-only recovery remains in the board UI.
import { parseGoalStateText } from "../surfaces/local-goal-board/scripts/lib/goal-board.mjs";

export class DuplicateKeyError extends Error {}

export function parseJson(text) {
  // Let JSON.parse enforce the grammar, then walk the same strings/objects to detect
  // repeated decoded member names (including escaped spellings such as \u0072esult).
  const value = JSON.parse(text);
  let index = 0;
  const space = () => { while (/\s/.test(text[index] || "") && index < text.length) index++; };
  function string() {
    const start = index++;
    while (text[index] !== '"') { if (text[index] === "\\") index++; index++; }
    index++;
    return JSON.parse(text.slice(start, index));
  }
  function walk() {
    space();
    if (text[index] === '"') { string(); return; }
    if (text[index] === "{" || text[index] === "[") {
      const object = text[index++] === "{";
      const end = object ? "}" : "]";
      const keys = new Set();
      space();
      while (text[index] !== end) {
        if (object) {
          const key = string();
          if (keys.has(key)) throw new DuplicateKeyError(`Duplicate JSON member: ${key}`);
          keys.add(key); space(); index++; // colon, already grammar-validated
        }
        walk(); space();
        if (text[index] !== ",") break;
        index++; space();
      }
      index++;
    } else {
      while (index < text.length && !/[\s,}\]]/.test(text[index])) index++;
    }
  }
  walk();
  return value;
}

export function parseBoard(text) {
  return parseGoalStateText(text, { strict: true });
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

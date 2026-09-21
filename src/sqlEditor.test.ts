import { expect, test } from "bun:test";
import { isSavedConsole } from "./SqlEditor.tsx";

const tab = { id: "t1", name: "Console 1", sql: "SELECT 1" };

test("isSavedConsole rejects malformed history entries", () => {
  const good = { id: "h1", sql: "SELECT 1", ranAt: 1, ms: 2, ok: true };
  expect(isSavedConsole({ tabs: [tab], activeId: "t1", history: [good] })).toBe(true);
  // Every rendered field must be typed — a shallow shape check would let a
  // corrupt entry reach render and throw.
  for (const bad of [
    { sql: "SELECT 1", ranAt: 1, ms: 2, ok: true },
    { id: "h1", sql: "SELECT 1", ranAt: "today", ms: 2, ok: true },
    { id: "h1", sql: "SELECT 1", ranAt: 1, ms: "2", ok: true },
    { id: "h1", sql: "SELECT 1", ranAt: 1, ms: 2 },
    null,
  ]) {
    expect(isSavedConsole({ tabs: [tab], activeId: "t1", history: [bad] })).toBe(false);
  }
});

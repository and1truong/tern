import { expect, test } from "bun:test";
import { boundConsoleHistory } from "./consoleHistory.ts";

test("history fits persisted state without truncating SQL, including JSON escapes", () => {
  const tabs = [{ id: "a", sql: '\\"\n'.repeat(90_000) }];
  const history = Array.from({ length: 100 }, (_, id) => ({ id, sql: '\\"\n'.repeat(40_000) }));
  const state = { tabs, activeId: "a", history };
  const bounded = boundConsoleHistory(state);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2_000_000);
  expect(bounded.tabs).toBe(tabs);
  expect(bounded.history.length).toBeGreaterThan(0);
  expect(bounded.history).toEqual(history.slice(0, bounded.history.length));
  const edited = boundConsoleHistory({ ...bounded, tabs: [{ id: "a", sql: 'x'.repeat(1_990_000) }] });
  expect(edited.history).toEqual([]);
  expect(edited.tabs[0].sql.length).toBe(1_990_000);
});

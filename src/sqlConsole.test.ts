import { describe, expect, test } from "bun:test";
import { firstSqlVerb, isWriteSql, splitSqlStatements, sqlToRun } from "./sqlConsole.ts";

describe("SQL console statement selection", () => {
  test("splits scripts without breaking quoted or commented semicolons", () => {
    const sql = `SELECT ';'; -- keep ;\nSELECT $$a;b$$; /* ; */ UPDATE t SET n = 1;`;
    expect(splitSqlStatements(sql).map((statement) => statement.sql)).toEqual([
      `SELECT ';'`,
      `-- keep ;\nSELECT $$a;b$$`,
      `/* ; */ UPDATE t SET n = 1`,
    ]);
  });

  test("runs selection, current statement, or all", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    expect(sqlToRun(sql, { from: 12, to: 12 }, false)).toEqual(["SELECT 2"]);
    expect(sqlToRun(sql, { from: 0, to: 8 }, false)).toEqual(["SELECT 1"]);
    expect(sqlToRun(sql, { from: 0, to: 0 }, true)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("runs the final statement after its terminating semicolon", () => {
    for (const sql of ["SELECT 1;", "SELECT 1; SELECT 2;", "SELECT 1; SELECT 2;\n  "]) {
      expect(sqlToRun(sql, { from: sql.length, to: sql.length }, false)).toEqual([sql.includes("SELECT 2") ? "SELECT 2" : "SELECT 1"]);
    }
  });

  test("finds the first verb after comments", () => {
    expect(firstSqlVerb("-- note\n/* plan */ UPDATE users SET n=1")).toBe("UPDATE");
  });

  test("detects writes inside CTEs without matching comments or strings", () => {
    expect(isWriteSql("WITH changed AS (UPDATE users SET active = 1 RETURNING *) SELECT * FROM changed")).toBe(true);
    expect(isWriteSql("SELECT 'DELETE', \"UPDATE\" FROM users -- DROP TABLE users")).toBe(false);
  });
});

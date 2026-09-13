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

  test("routes procedural and metadata commands through writable execution", () => {
    for (const sql of ["CALL refresh_data()", "DO $$ BEGIN NULL; END $$", "COMMENT ON TABLE users IS 'Users'"]) {
      expect(isWriteSql(sql)).toBe(true);
    }
    expect(isWriteSql("SELECT 'CALL DO COMMENT'")).toBe(false);
  });

  test("finds the first verb after comments", () => {
    expect(firstSqlVerb("-- note\n/* plan */ UPDATE users SET n=1")).toBe("UPDATE");
  });

  test("detects writes inside CTEs without matching comments or strings", () => {
    expect(isWriteSql("WITH changed AS (UPDATE users SET active = 1 RETURNING *) SELECT * FROM changed")).toBe(true);
    expect(isWriteSql("SELECT 'DELETE', \"UPDATE\" FROM users -- DROP TABLE users")).toBe(false);
  });
});

test('read-query identifiers are not metadata commands', () => {
  expect(isWriteSql('SELECT comment FROM posts')).toBe(false);
  expect(isWriteSql('WITH rows AS (SELECT merge FROM posts) SELECT merge FROM rows')).toBe(false);
  expect(isWriteSql('WITH rows AS (SELECT 1) UPDATE posts SET comment = 1')).toBe(true);
  expect(isWriteSql('WITH rows AS (SELECT comment FROM posts) SELECT comment FROM rows')).toBe(false);
});

test('SQLite trigger bodies stay intact for Run and Run all', () => {
  const trigger = `CREATE TEMP TRIGGER audit AFTER INSERT ON posts BEGIN
    UPDATE posts SET comment = CASE WHEN new.id = 1 THEN 'a;b' ELSE 'c' END;
    INSERT INTO logs VALUES ('done');
  END`;
  const script = `${trigger}; SELECT 1;`;
  expect(splitSqlStatements(script).map(s => s.sql)).toEqual([trigger, 'SELECT 1']);
  expect(sqlToRun(script, { from: script.indexOf('INSERT INTO logs'), to: script.indexOf('INSERT INTO logs') }, false)).toEqual([trigger]);
});

test('non-read operations use writable execution without a verb allowlist', () => {
  for (const sql of ['ANALYZE users', 'CLUSTER users', 'REFRESH MATERIALIZED VIEW summary', 'SET search_path TO public', 'REASSIGN OWNED BY old TO new']) expect(isWriteSql(sql)).toBe(true);
  for (const sql of ['SHOW search_path', 'SELECT analyze FROM users', 'VALUES (1)', '-- empty']) expect(isWriteSql(sql)).toBe(false);
});

test('PRAGMA mutations use exec while catalog argument forms remain reads', () => {
  for (const sql of ['PRAGMA user_version = 7', 'PRAGMA journal_mode = WAL', 'PRAGMA main.user_version(7)', 'PRAGMA foreign_keys(ON)']) expect(isWriteSql(sql)).toBe(true);
  for (const sql of ['PRAGMA user_version', "PRAGMA table_info('users')", 'PRAGMA main.index_list(users)', "PRAGMA table_info('a=b')"]) expect(isWriteSql(sql)).toBe(false);
});

import { describe, expect, test } from "bun:test";
import { assertReadOnlyScript, assertReadOnlySql, boundReadSql, sqlTokens } from "./sqlSafety.ts";
import { DbError } from "./types.ts";

describe("SQL read-only safety", () => {
  test("ignores keywords and semicolons in strings, identifiers, and comments", () => {
    expect(sqlTokens(`/* DELETE; */ SELECT 'UPDATE;' AS "DROP"`)).toEqual(["SELECT", "AS"]);
    expect(assertReadOnlySql(`/* inspect */ SELECT 'value;';`)).toBe(`/* inspect */ SELECT 'value;'`);
  });

  test("ignores PostgreSQL dollar-quoted bodies", () => {
    expect(assertReadOnlySql("SELECT $$ DELETE; UPDATE $$ AS body")).toBe("SELECT $$ DELETE; UPDATE $$ AS body");
    expect(assertReadOnlySql("SELECT $tag$ DROP TABLE x; $tag$ AS body")).toContain("SELECT");
  });

  test("ignores nested PostgreSQL block-comment content", () => {
    const sql = "SELECT /* outer /* DELETE; */ UPDATE; still outer */ 1";
    expect(sqlTokens(sql)).toEqual(["SELECT"]);
    expect(assertReadOnlySql(sql)).toBe(sql);
  });

  test("rejects write operations nested under WITH and EXPLAIN", () => {
    expect(() => assertReadOnlySql("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"))
      .toThrow(DbError);
    expect(() => assertReadOnlySql("EXPLAIN ANALYZE UPDATE t SET n = 1"))
      .toThrow(DbError);
  });

  test("rejects multiple statements but accepts one trailing terminator", () => {
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2"))
      .toThrow(DbError);
    expect(assertReadOnlySql("SELECT 1;")).toBe("SELECT 1");
    expect(assertReadOnlySql("SELECT 1; -- done")).toBe("SELECT 1 -- done");
  });

  test("wraps row-producing reads with one look-ahead row", () => {
    expect(boundReadSql("SELECT * FROM t", 50, 100)).toBe(
      `SELECT * FROM (SELECT * FROM t\n) AS "__tern_query" LIMIT 51 OFFSET 100`,
    );
  });

  test("allows catalog PRAGMAs but rejects state-changing PRAGMAs", () => {
    expect(boundReadSql("PRAGMA table_info(users)", 10)).toBe("PRAGMA table_info(users)");
    expect(() => assertReadOnlySql("PRAGMA foreign_keys = OFF")).toThrow(DbError);
    expect(() => assertReadOnlySql("PRAGMA writable_schema")).toThrow(DbError);
  });
});

test('read expressions do not become write operations', () => {
  for (const sql of ["SELECT replace('abc', 'a', 'z')", 'WITH x AS (SELECT replace(name, name, name) FROM t) SELECT * FROM x', "EXPLAIN SELECT replace('a','b','c')"]) {
    expect(assertReadOnlySql(sql)).toBe(sql);
  }
  expect(() => assertReadOnlySql('WITH x AS (SELECT 1) DELETE FROM t')).toThrow(DbError);
});

test('SHOW bypasses the subquery wrapper without allowing multiple statements', () => {
  expect(boundReadSql('SHOW search_path', 10)).toBe('SHOW search_path');
  expect(() => boundReadSql('SHOW search_path; DELETE FROM t', 10)).toThrow(DbError);
});

test('ordinary backslashes cannot conceal a transaction command', () => {
  const script = "INSERT INTO t VALUES (1); SELECT '\\'; COMMIT; SELECT '';";
  expect(sqlTokens(script)).toContain('COMMIT');
  expect(() => assertReadOnlySql("SELECT '\\'; COMMIT; SELECT '';" )).toThrow(DbError);
  expect(assertReadOnlySql("SELECT E'escaped \\\' COMMIT; text' AS value")).toContain('SELECT');
});

test('PostgreSQL TABLE shorthand uses bounded read queries', () => {
  expect(boundReadSql('TABLE public.users', 5, 2, 'postgres')).toBe('SELECT * FROM (TABLE public.users\n) AS "__tern_query" LIMIT 6 OFFSET 2');
  expect(() => assertReadOnlySql('TABLE public.users', 'sqlite')).toThrow();
});

describe("assertReadOnlyScript", () => {
  test("allows transaction batches of reads", () => {
    expect(() => assertReadOnlyScript("BEGIN READ ONLY; SELECT 1; COMMIT", "postgres")).not.toThrow();
    expect(() => assertReadOnlyScript("BEGIN; SELECT 1; SELECT 2; COMMIT;", "sqlite")).not.toThrow();
    expect(() => assertReadOnlyScript("START TRANSACTION ISOLATION LEVEL SERIALIZABLE; SHOW search_path; COMMIT", "postgres")).not.toThrow();
  });

  test("rejects write statements anywhere in the script", () => {
    expect(() => assertReadOnlyScript("BEGIN; INSERT INTO t VALUES (1); COMMIT")).toThrow(DbError);
    expect(() => assertReadOnlyScript("SELECT 1; DELETE FROM t")).toThrow(DbError);
    expect(() => assertReadOnlyScript("BEGIN; PRAGMA user_version = 7; COMMIT", "sqlite")).toThrow(DbError);
  });

  test("rejects read-write transaction starts", () => {
    expect(() => assertReadOnlyScript("BEGIN READ WRITE; SELECT 1; COMMIT")).toThrow(DbError);
    expect(() => assertReadOnlyScript("START TRANSACTION READ WRITE; COMMIT", "postgres")).toThrow(DbError);
  });

  test("semicolons in strings, comments, and E-strings do not split statements", () => {
    expect(() => assertReadOnlyScript("SELECT E'a;b' AS v; SELECT 1", "postgres")).not.toThrow();
    expect(() => assertReadOnlyScript("/* one; two */ SELECT 'three; four'")).not.toThrow();
    expect(() => assertReadOnlyScript("SELECT E'a;b'; DELETE FROM t")).toThrow(DbError);
  });

  test("rejects empty scripts", () => {
    expect(() => assertReadOnlyScript(";;")).toThrow(DbError);
    expect(() => assertReadOnlyScript("")).toThrow(DbError);
  });
});

import { expect, test } from "bun:test";
import { validateViewQuery } from "./DatabaseCreateViewModal.tsx";

test("view bodies accept one read query and reject scripts or writable CTEs", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    for (const body of ["", "-- comment", "SELECT 1; DROP TABLE users", "DELETE FROM users", "WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone"]) {
      expect(() => validateViewQuery(body, dialect)).toThrow("exactly one read-only");
    }
    expect(validateViewQuery("SELECT '; DROP TABLE users' AS text; -- comment", dialect)).toBe("SELECT '; DROP TABLE users' AS text");
    expect(validateViewQuery("WITH t AS (SELECT 1 AS id) SELECT * FROM t", dialect)).toStartWith("WITH");
  }
  expect(validateViewQuery("/* outer /* nested */ comment */ SELECT 1;", "postgres")).toEndWith("SELECT 1");
  expect(() => validateViewQuery("SELECT '\\'; DROP TABLE users; SELECT '';", "sqlite")).toThrow();
});

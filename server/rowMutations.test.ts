import { describe, expect, test } from "bun:test";
import { compileRowChange, compileRowChanges, toPostgresMutationSql } from "./rowMutations.ts";
import { DbError } from "../shared.ts";

describe("structured row mutations", () => {
  test("compiles an optimistic update with a qualified relation", () => {
    const statement = compileRowChange({
      kind: "update",
      table: { schema: "audit", name: "events" },
      key: { id: 7 },
      expected: { id: 7, name: "before", note: null },
      values: { name: "after" },
    });
    expect(statement.sql).toBe(
      `UPDATE "audit"."events" SET "name" = ? WHERE "id" IS ? AND "name" IS ? AND "note" IS ?`,
    );
    expect(statement.params).toEqual(["after", 7, "before", null]);
    expect(toPostgresMutationSql(statement.sql)).toBe(
      `UPDATE "audit"."events" SET "name" = $1 WHERE "id" IS NOT DISTINCT FROM $2 AND "name" IS NOT DISTINCT FROM $3 AND "note" IS NOT DISTINCT FROM $4`,
    );
  });

  test("compiles inserts and deletes without interpolating values", () => {
    expect(compileRowChange({
      kind: "insert", table: { name: "users" }, values: { name: `O'Reilly`, active: true },
    })).toEqual({
      kind: "insert",
      sql: `INSERT INTO "users" ("name", "active") VALUES (?, ?)`,
      params: [`O'Reilly`, true],
    });
    expect(compileRowChange({
      kind: "delete", table: { name: "users" }, key: { id: 1 }, expected: { id: 1 },
    }).sql).toBe(`DELETE FROM "users" WHERE "id" IS ?`);
    expect(compileRowChange({ kind: "insert", table: { name: "users" }, values: {} })).toEqual({
      kind: "insert", sql: `INSERT INTO "users" DEFAULT VALUES`, params: [],
    });
  });

  test("rejects unsafe unidentifiable or empty batches", () => {
    expect(() => compileRowChanges([])).toThrow(DbError);
    expect(() => compileRowChange({
      kind: "delete", table: { name: "users" }, key: {}, expected: {},
    })).toThrow(DbError);
  });
});

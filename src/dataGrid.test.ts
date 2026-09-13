import { describe, expect, test } from "bun:test";
import { buildRowChanges, coerceCellValue, editKey, orderBySql, rowsToCsv, toggleSort } from "./dataGrid.ts";
import type { DbTable } from "../shared.ts";
import { encodeDbValue } from "../binaryValues.ts";

describe("data-grid query helpers", () => {
  test("cycles a primary sort through asc, desc, and off", () => {
    const asc = toggleSort([], "created_at", false);
    expect(asc).toEqual([{ column: "created_at", direction: "asc" }]);
    const desc = toggleSort(asc, "created_at", false);
    expect(desc).toEqual([{ column: "created_at", direction: "desc" }]);
    expect(toggleSort(desc, "created_at", false)).toEqual([]);
  });

  test("adds and removes secondary sorts without disturbing the first", () => {
    const first = [{ column: "team", direction: "asc" as const }];
    const both = toggleSort(first, "score", true);
    expect(orderBySql(both)).toBe(` ORDER BY "team" ASC, "score" ASC`);
    expect(toggleSort(toggleSort(both, "score", true), "score", true)).toEqual(first);
  });

  test("serializes selected values as RFC-style CSV", () => {
    expect(rowsToCsv(["name", "note", "meta"], [{
      name: "Ada, Inc.", note: `said "hi"\nnext`, meta: { ok: true },
    }])).toBe(`name,note,meta\n"Ada, Inc.","said ""hi""\nnext","{""ok"":true}"`);
  });

  test("unwraps escaped JSON values when copying CSV", () => {
    const value = { __dbmWire: { kind: "binary", base64: "AA==" } };
    expect(rowsToCsv(["payload"], [{ payload: encodeDbValue(value) }])).toBe(
      'payload\n"{""__dbmWire"":{""kind"":""binary"",""base64"":""AA==""}}"',
    );
  });
});

describe("staged row changes", () => {
  const table: DbTable = {
    name: "users", schema: "public", type: "table", rowCount: -1, ddl: "",
    columns: [
      { name: "id", type: "integer", notNull: true, pk: true, fk: null },
      { name: "name", type: "text", notNull: true, pk: false, fk: null },
    ],
  };

  test("builds optimistic updates, deletes, and inserts", () => {
    const rows = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];
    expect(buildRowChanges(
      table,
      rows,
      { [editKey(0, "name")]: "Augusta" },
      new Set([1]),
      [{ id: 3, name: "Lin" }],
    )).toEqual([
      { kind: "update", table: { schema: "public", name: "users" }, key: { id: 1 }, expected: rows[0], values: { name: "Augusta" } },
      { kind: "delete", table: { schema: "public", name: "users" }, key: { id: 2 }, expected: rows[1] },
      { kind: "insert", table: { schema: "public", name: "users" }, values: { id: 3, name: "Lin" } },
    ]);
  });

  test("coerces explicit NULL, numeric, and boolean values", () => {
    expect(coerceCellValue("NULL", "text")).toBeNull();
    expect(coerceCellValue("42", "INTEGER")).toBe(42);
    expect(coerceCellValue("9007199254740993", "BIGINT")).toBe("9007199254740993");
    expect(coerceCellValue("12345678901234567890.12345", "NUMERIC(30, 5)")).toBe("12345678901234567890.12345");
    expect(coerceCellValue("false", "BOOLEAN")).toBe(false);
  });

  test("uses a non-null unique key when a table has no primary key", () => {
    const uniqueTable: DbTable = {
      name: "accounts", type: "table", rowCount: -1, ddl: "", uniqueKeys: [["email"]],
      columns: [
        { name: "email", type: "text", notNull: true, pk: false, fk: null },
        { name: "name", type: "text", notNull: false, pk: false, fk: null },
      ],
    };
    const row = { email: "ada@example.com", name: "Ada" };
    expect(buildRowChanges(uniqueTable, [row], { [editKey(0, "name")]: "Augusta" }, new Set(), [])).toEqual([
      { kind: "update", table: { name: "accounts" }, key: { email: "ada@example.com" }, expected: row, values: { name: "Augusta" } },
    ]);
  });

  test("omits non-comparable PostgreSQL columns from optimistic predicates", () => {
    const jsonTable: DbTable = {
      name: "events", schema: "public", type: "table", rowCount: -1, ddl: "",
      columns: [
        { name: "id", type: "integer", notNull: true, pk: true, fk: null },
        { name: "name", type: "text", notNull: true, pk: false, fk: null },
        { name: "payload", type: "json", notNull: true, pk: false, fk: null },
      ],
    };
    const row = { id: 1, name: "before", payload: { ok: true } };
    expect(buildRowChanges(jsonTable, [row], { [editKey(0, "name")]: "after" }, new Set(), [], new Set(["payload"]))[0]).toEqual({
      kind: "update", table: { schema: "public", name: "events" }, key: { id: 1 },
      expected: { id: 1, name: "before" }, values: { name: "after" },
    });
    expect(buildRowChanges(jsonTable, [row], {}, new Set([0]), [], new Set(["payload"]))[0]).toEqual({
      kind: "delete", table: { schema: "public", name: "events" }, key: { id: 1 },
      expected: { id: 1, name: "before" },
    });
  });
});

test('noncomparable columns cannot become unguarded updates', () => {
  const table: DbTable = { name: 't', schema: 'public', type: 'table', rowCount: 1, ddl: '', columns: [
    { name: 'id', type: 'integer', pk: true, notNull: true, fk: null },
    { name: 'document', type: 'xml', pk: false, notNull: false, fk: null, comparable: false },
  ] };
  expect(buildRowChanges(table, [{ id: 1, document: '<old/>' }], { [editKey(0, 'document')]: '<new/>' }, new Set(), [], new Set(['document']))).toEqual([]);
});

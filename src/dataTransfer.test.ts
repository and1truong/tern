import { expect, test } from "bun:test";
import { parseCsv, serializeRows } from "./dataTransfer.ts";
import type { DbTable } from "../shared.ts";
import { encodeDbValue } from "../binaryValues.ts";

const table: DbTable = { name: "users", schema: "public", type: "table", columns: [], rowCount: -1, ddl: "" };

test("exports result sets as CSV, JSON, Markdown, and executable INSERTs", () => {
  const rows = [{ id: 1, name: "Ada, Inc.", note: null }];
  expect(serializeRows("csv", ["id", "name", "note"], rows)).toBe('id,name,note\n1,"Ada, Inc.",');
  expect(serializeRows("json", ["id", "name", "note"], rows)).toContain('"name": "Ada, Inc."');
  expect(serializeRows("markdown", ["id", "name"], rows)).toContain("| 1 | Ada, Inc. |");
  expect(serializeRows("sql", ["id", "name", "note"], rows, table)).toBe('INSERT INTO "public"."users" ("id", "name", "note") VALUES (1, \'Ada, Inc.\', NULL);\n');
});

test("parses quoted CSV including commas, escaped quotes, and newlines", () => {
  expect(parseCsv('id,name,note\r\n1,"Ada, Inc.","said ""hi"""\r\n2,Grace,"two\nlines"')).toEqual({
    columns: ["id", "name", "note"],
    rows: [
      { id: "1", name: "Ada, Inc.", note: 'said "hi"' },
      { id: "2", name: "Grace", note: "two\nlines" },
    ],
  });
  expect(() => parseCsv("id,id\n1,2")).toThrow();
});

test("exports stored JSON instead of its collision-escape envelope", () => {
  const value = { __dbmWire: { kind: "binary", base64: "AA==" } };
  const rows = [{ payload: encodeDbValue(value) }];
  expect(JSON.parse(serializeRows("json", ["payload"], rows))).toEqual([{ payload: value }]);
  expect(serializeRows("sql", ["payload"], rows, table)).toContain(JSON.stringify(value));
});

test("exports reversible binary literals for SQLite and PostgreSQL", () => {
  const rows = [{ payload: encodeDbValue(new Uint8Array([0, 127, 255])) }];
  const sqliteTable: DbTable = { ...table, schema: undefined };
  expect(serializeRows("sql", ["payload"], rows, sqliteTable)).toContain("X'007FFF'");
  expect(serializeRows("sql", ["payload"], rows, table)).toContain("decode('007FFF', 'hex')");
});

test("omits generated columns from SQL exports", () => {
  const generatedTable: DbTable = {
    ...table,
    columns: [
      { name: "base", type: "integer", notNull: true, pk: false, fk: null },
      { name: "doubled", type: "integer", notNull: true, pk: false, fk: null, generated: true },
    ],
  };
  expect(serializeRows("sql", ["base", "doubled"], [{ base: 3, doubled: 6 }], generatedTable)).toBe(
    'INSERT INTO "public"."users" ("base") VALUES (3);\n',
  );
});

test("omits identity columns and falls back to default-only inserts", () => {
  const identityTable: DbTable = {
    ...table,
    columns: [{ name: "id", type: "integer", notNull: true, pk: true, fk: null, identity: true }],
  };
  expect(serializeRows("sql", ["id"], [{ id: 7 }, { id: 8 }], identityTable)).toBe(
    'INSERT INTO "public"."users" DEFAULT VALUES;\nINSERT INTO "public"."users" DEFAULT VALUES;\n',
  );
});

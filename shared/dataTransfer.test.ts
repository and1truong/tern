import { expect, test } from "bun:test";
import { parseCsv, serializeRows } from "./dataTransfer.ts";
import type { DbTable } from "./types.ts";
import { coerceCellValue } from "./dataGrid.ts";
import { encodeDbValue } from "./binaryValues.ts";

const table: DbTable = { name: "users", schema: "public", type: "table", columns: [], rowCount: -1, ddl: "" };

test("exports result sets as CSV, JSON, Markdown, and executable INSERTs", () => {
  const rows = [{ id: 1, name: "Ada, Inc.", note: null }];
  expect(serializeRows("csv", ["id", "name", "note"], rows)).toBe('id,name,note\n1,"Ada, Inc.",\\N');
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
  const value = { __ternWire: { kind: "binary", base64: "AA==" } };
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

test("preserves identity values with the required override", () => {
  const identityTable: DbTable = {
    ...table,
    columns: [{ name: "id", type: "integer", notNull: true, pk: true, fk: null, identity: true, identityGeneration: "ALWAYS" }],
  };
  expect(serializeRows("sql", ["id"], [{ id: 7 }, { id: 8 }], identityTable)).toBe(
    'INSERT INTO "public"."users" ("id") OVERRIDING SYSTEM VALUE VALUES (7);\nINSERT INTO "public"."users" ("id") OVERRIDING SYSTEM VALUE VALUES (8);\n',
  );
});

test('JSON exports omit hidden columns and preserve requested order', () => {
  expect(JSON.parse(serializeRows('json', ['name'], [{ id: 1, name: 'Ada', secret: 'hidden' }]))).toEqual([{ name: 'Ada' }]);
});

test('CSV rejects truncated quoted values', () => {
  expect(() => parseCsv('value\n"truncated')).toThrow('unterminated');
  expect(() => parseCsv('value\n"truncated\n')).toThrow('unterminated');
});

test('CSV keeps empty parsed records but ignores absent trailing lines', () => {
  expect(parseCsv('a,b\n,\n1,x\n"",""\n').rows).toEqual([{ a: '', b: '' }, { a: '1', b: 'x' }, { a: '', b: '' }]);
  expect(parseCsv('a\n""\n').rows).toEqual([{ a: '' }]);
  expect(parseCsv('a\n\n1\n').rows).toEqual([{ a: '' }, { a: '1' }]);
});

test("CSV rejects text after closing quotes", () => {
  for (const text of ['value\n"ok"junk', 'value\n"ok" ', '"value"junk\n1']) {
    expect(() => parseCsv(text)).toThrow("after a closing quote");
  }
  expect(parseCsv('a,b\r\n"ok",""\r\n"x","y"').rows).toEqual([{ a: "ok", b: "" }, { a: "x", b: "y" }]);
});

test("Markdown preserves structured JSON and arrays before escaping", () => {
  expect(serializeRows("markdown", ["json", "array"], [{ json: { message: "a|b" }, array: [1, { ok: true }] }]))
    .toContain('| {"message":"a\\|b"} | [1,{"ok":true}] |');
});

test("CSV round-trips nulls, empty strings and leading backslashes", () => {
  const values = [null, "", "\\N", "\\\\N", "\\path"];
  for (const value of values) {
    const parsed = parseCsv(serializeRows("csv", ["value"], [{ value }]));
    expect(parsed.rows).toHaveLength(1);
    expect(coerceCellValue(parsed.rows[0].value!, "text")).toBe(value);
  }
});

test("exports nonfinite numbers without replacing them with NULL", () => {
  const rows = [{ n: encodeDbValue(Infinity) }, { n: encodeDbValue(-Infinity) }];
  expect(serializeRows("sql", ["n"], rows, { ...table, schema: undefined })).toContain("VALUES (1e999)");
  expect(serializeRows("sql", ["n"], rows, { ...table, schema: undefined })).toContain("VALUES (-1e999)");
  expect(serializeRows("sql", ["n"], rows, table)).toContain("VALUES ('Infinity')");
  expect(serializeRows("csv", ["n"], rows)).toBe("n\nInfinity\n-Infinity");
  expect(JSON.parse(serializeRows("json", ["n"], rows))).toEqual([{ n: "Infinity" }, { n: "-Infinity" }]);
});

test("CSV preserves exact whitespace in exported column names", () => {
  const columns = ["name", " name ", " ", " quoted, name "];
  const rows = [{ "name": "plain", " name ": "padded", " ": "space", " quoted, name ": "quoted" }];
  expect(parseCsv(serializeRows("csv", columns, rows))).toEqual({ columns, rows });
});

test('parseCsv strips a UTF-8 BOM from the first header name', () => {
  const parsed = parseCsv('﻿id,name\n1,Ada');
  expect(parsed.columns).toEqual(['id', 'name']);
  expect(parsed.rows).toEqual([{ id: '1', name: 'Ada' }]);
});

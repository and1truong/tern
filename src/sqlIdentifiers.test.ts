import { describe, expect, test } from "bun:test";
import { quoteIdent, tableKey, tableLabel, tableSql } from "./sqlIdentifiers.ts";
import type { DbTable } from "../shared.ts";

const table = (name: string, schema?: string): DbTable => ({
  name, schema, type: "table", columns: [], rowCount: -1, ddl: "",
});

describe("SQL identifiers", () => {
  test("quotes schema and relation as separate identifiers", () => {
    expect(tableSql(table("audit.log", "tenant-data"))).toBe(
      `"tenant-data"."audit.log"`,
    );
  });

  test("escapes embedded quotes", () => {
    expect(quoteIdent(`say"hi`)).toBe(`"say""hi"`);
  });

  test("uses qualified keys while keeping public labels compact", () => {
    expect(tableKey(table("users", "public"))).toBe("public.users");
    expect(tableLabel(table("users", "public"))).toBe("users");
    expect(tableLabel(table("events", "audit"))).toBe("audit.events");
  });
});

test('table identities distinguish dots inside quoted identifiers', () => {
  const a = { schema: 'a.b', name: 'c' } as any;
  const b = { schema: 'a', name: 'b.c' } as any;
  expect(tableKey(a)).not.toBe(tableKey(b));
});

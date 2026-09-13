import { describe, test, expect } from "bun:test";
import { compileGroup, previewWhere, groupHasActive, newRule, defaultOp, opsFor, MAX_DEPTH, type FilterModel } from "./dbFilter.ts";
import type { DbColumn } from "../shared.ts";

const cols: DbColumn[] = [
  { name: "id", type: "INTEGER", notNull: true, pk: true, fk: null },
  { name: "name", type: "TEXT", notNull: false, pk: false, fk: null },
  { name: "amount", type: "REAL", notNull: true, pk: false, fk: null },
];

describe("compileGroup", () => {
  test("single text contains -> LIKE with ? param", () => {
    const m: FilterModel = { id: "g", combinator: "AND" as const, rules: [{ ...newRule(cols), col: 1, op: "contains", value: "al" }] };
    const out = compileGroup(m, cols);
    expect(out.where).toBe('("name" LIKE ?)');
    expect(out.params).toEqual(["%al%"]);
  });

  test("numeric greater-than -> bare placeholder", () => {
    const m: FilterModel = { id: "g", combinator: "AND" as const, rules: [{ ...newRule(cols), col: 2, op: "gt", value: "50" }] };
    const out = compileGroup(m, cols);
    expect(out.where).toBe('("amount" > ?)');
    expect(out.params).toEqual([50]);
  });

  test("AND group joins two rules", () => {
    const m: FilterModel = {
      id: "g", combinator: "AND" as const,
      rules: [
        { ...newRule(cols), col: 1, op: "contains", value: "al" },
        { ...newRule(cols), col: 2, op: "gt", value: "50" },
      ],
    };
    const out = compileGroup(m, cols);
    expect(out.where).toBe('("name" LIKE ? AND "amount" > ?)');
    expect(out.params).toEqual(["%al%", 50]);
  });

  test("nested group uses OR joiner", () => {
    const m: FilterModel = {
      id: "g", combinator: "AND" as const,
      rules: [
        { ...newRule(cols), col: 1, op: "contains", value: "al" },
        { id: "sg", combinator: "OR" as const, rules: [
          { ...newRule(cols), col: 2, op: "gt", value: "50" },
          { ...newRule(cols), col: 2, op: "lt", value: "0" },
        ] },
      ],
    };
    const out = compileGroup(m, cols);
    expect(out.where).toBe('("name" LIKE ? AND ("amount" > ? OR "amount" < ?))');
  });

  test("empty-value rules are skipped (inactive)", () => {
    const m: FilterModel = { id: "g", combinator: "AND" as const, rules: [{ ...newRule(cols), col: 1, op: "contains", value: "" }] };
    expect(compileGroup(m, cols).where).toBe("");
    expect(groupHasActive(m)).toBe(false);
  });

  test("uses the PostgreSQL regex operator for PostgreSQL filters", () => {
    const m: FilterModel = { id: "g", combinator: "AND", rules: [{ ...newRule(cols), col: 1, op: "regex", value: "^A" }] };
    expect(compileGroup(m, cols, "postgres")).toEqual({ where: '("name" ~ ?)', params: ["^A"] });
    expect(previewWhere(m, cols, "postgres")).toBe(`("name" ~ '^A')`);
  });

  test("offers SQLite glob patterns instead of unsupported regex", () => {
    expect(opsFor("TEXT", "sqlite").map((op) => op.v)).toContain("glob");
    expect(opsFor("TEXT", "sqlite").map((op) => op.v)).not.toContain("regex");
    const m: FilterModel = { id: "g", combinator: "AND", rules: [{ ...newRule(cols), col: 1, op: "glob", value: "A*" }] };
    expect(compileGroup(m, cols, "sqlite")).toEqual({ where: '("name" GLOB ?)', params: ["A*"] });
  });

  test("safely compiles a stale dialect-specific rule during source switches", () => {
    const regex: FilterModel = { id: "g", combinator: "AND", rules: [{ ...newRule(cols), col: 1, op: "regex", value: "A*" }] };
    const glob: FilterModel = { id: "g", combinator: "AND", rules: [{ ...newRule(cols), col: 1, op: "glob", value: "^A" }] };
    expect(compileGroup(regex, cols, "sqlite").where).toBe('("name" GLOB ?)');
    expect(compileGroup(glob, cols, "postgres").where).toBe('("name" ~ ?)');
  });
});

describe("previewWhere", () => {
  test("inlines values, read-friendly", () => {
    const m: FilterModel = {
      id: "g", combinator: "OR" as const,
      rules: [
        { ...newRule(cols), col: 1, op: "contains", value: "al" },
        { ...newRule(cols), col: 2, op: "gt", value: "50" },
      ],
    };
    expect(previewWhere(m, cols)).toBe('("name" LIKE \'%al%\' OR "amount" > 50)');
  });
});

describe("depth + ops", () => {
  test("MAX_DEPTH is 12", () => { expect(MAX_DEPTH).toBe(12); });
  test("newRule defaults to a numeric op for INTEGER col 0", () => {
    expect(newRule(cols).op).toBe("equals");
  });
  test("defaultOp differs by type", () => {
    expect(defaultOp("INTEGER")).toBe("equals");
    expect(defaultOp("TEXT")).toBe("contains");
  });
});

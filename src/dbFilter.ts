import type { DbColumn } from "../shared.ts";

// Maximum group-nesting depth (root group = depth 0). Bump to allow deeper trees.
export const MAX_DEPTH = 12;

export type FilterCombinator = "AND" | "OR";
export type DbDialect = "sqlite" | "postgres";

export type TextOp = "contains" | "not_contains" | "regex" | "glob" | "equals" | "not_equals" | "is_null" | "not_null";
export type NumOp = "equals" | "not_equals" | "lt" | "gt" | "lte" | "gte" | "is_null" | "not_null";
export type FilterOp = TextOp | NumOp;

export interface FilterRule {
  id: string;
  col: number;       // index into the table's DbColumn[]
  op: FilterOp;
  value: string;
}
export interface FilterGroup {
  id: string;
  combinator: FilterCombinator;
  rules: (FilterRule | FilterGroup)[];
}
export type FilterModel = FilterGroup;

export const TEXT_OPS: { v: TextOp; l: string }[] = [
  { v: "contains", l: "contains" },
  { v: "not_contains", l: "not contains" },
  { v: "regex", l: "regex" },
  { v: "equals", l: "= equals" },
  { v: "not_equals", l: "≠ not equals" },
  { v: "is_null", l: "is null" },
  { v: "not_null", l: "not null" },
];
const SQLITE_TEXT_OPS: { v: TextOp; l: string }[] = TEXT_OPS.map((op) =>
  op.v === "regex" ? { v: "glob", l: "glob pattern" } : op,
);
export const NUM_OPS: { v: NumOp; l: string }[] = [
  { v: "equals", l: "= equals" },
  { v: "not_equals", l: "≠ not equals" },
  { v: "lt", l: "< less than" },
  { v: "gt", l: "> greater than" },
  { v: "lte", l: "≤ ≤" },
  { v: "gte", l: "≥ ≥" },
  { v: "is_null", l: "is null" },
  { v: "not_null", l: "not null" },
];

let _id = 0;
export const newId = () => "f" + ++_id;
export function newRule(cols: DbColumn[]): FilterRule {
  return { id: newId(), col: 0, op: defaultOp(cols[0]?.type ?? "TEXT"), value: "" };
}
export function newGroup(): FilterGroup {
  return { id: newId(), combinator: "AND", rules: [] };
}

export function isNumericType(t: string): boolean {
  const u = t.toUpperCase();
  return u.includes("INT") || u.includes("REAL") || u.includes("FLOA") || u.includes("NUM") || u.includes("DOUBLE");
}
export function opsFor(type: string, dialect: DbDialect = "sqlite") {
  return isNumericType(type) ? NUM_OPS : dialect === "postgres" ? TEXT_OPS : SQLITE_TEXT_OPS;
}
export function defaultOp(type: string): FilterOp { return isNumericType(type) ? "equals" : "contains"; }
export const opNeedsValue = (op: FilterOp) => op !== "is_null" && op !== "not_null";

const isGroup = (r: FilterRule | FilterGroup): r is FilterGroup => "rules" in r;

export function groupHasActive(g: FilterGroup): boolean {
  return g.rules.some((r) => (isGroup(r) ? groupHasActive(r) : opNeedsValue(r.op) ? r.value !== "" : true));
}

function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `"${name}"` : `"${name.replace(/"/g, '""')}"`;
}

// --- execution compiler: parameterized WHERE + params ---
function numOrThrow(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
  return n;
}

function compileRuleExec(r: FilterRule, cols: DbColumn[], params: unknown[], dialect: DbDialect): string {
  const col = cols[r.col];
  const name = ident(col.name);
  const numeric = isNumericType(col.type);
  switch (r.op) {
    case "contains": params.push(`%${r.value}%`); return `${name} LIKE ?`;
    case "not_contains": params.push(`%${r.value}%`); return `${name} NOT LIKE ?`;
    case "regex": {
      params.push(r.value); return `${name} ${dialect === "postgres" ? "~" : "GLOB"} ?`;
    }
    case "glob": {
      params.push(r.value); return `${name} ${dialect === "postgres" ? "~" : "GLOB"} ?`;
    }
    case "equals": { if (numeric) { const n = numOrThrow(r.value); params.push(n); return `${name} = ?`; } params.push(r.value); return `${name} = ?`; }
    case "not_equals": { if (numeric) { params.push(numOrThrow(r.value)); return `${name} <> ?`; } params.push(r.value); return `${name} <> ?`; }
    case "lt": params.push(numOrThrow(r.value)); return `${name} < ?`;
    case "gt": params.push(numOrThrow(r.value)); return `${name} > ?`;
    case "lte": params.push(numOrThrow(r.value)); return `${name} <= ?`;
    case "gte": params.push(numOrThrow(r.value)); return `${name} >= ?`;
    case "is_null": return `${name} IS NULL`;
    case "not_null": return `${name} IS NOT NULL`;
  }
}

function compileGroupExec(g: FilterGroup, cols: DbColumn[], params: unknown[], dialect: DbDialect): string {
  const parts: string[] = [];
  for (const r of g.rules) {
    if (isGroup(r)) { const sub = compileGroupExec(r, cols, params, dialect); if (sub) parts.push(sub); }
    else if (opNeedsValue(r.op) ? r.value !== "" : true) parts.push(compileRuleExec(r, cols, params, dialect));
  }
  if (!parts.length) return "";
  return "(" + parts.join(g.combinator === "AND" ? " AND " : " OR ") + ")";
}

export function compileGroup(model: FilterModel, cols: DbColumn[], dialect: DbDialect = "sqlite"): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  return { where: compileGroupExec(model, cols, params, dialect), params };
}

// --- preview compiler: inline literals, for display only ---
function sqlLit(value: string, numeric: boolean): string {
  if (numeric && Number.isFinite(Number(value))) return value;
  return "'" + value.replace(/'/g, "''") + "'";
}
function compileRulePreview(r: FilterRule, cols: DbColumn[], dialect: DbDialect): string {
  const col = cols[r.col];
  const name = ident(col.name);
  const numeric = isNumericType(col.type);
  switch (r.op) {
    case "contains": return `${name} LIKE '%${r.value.replace(/'/g, "''")}%'`;
    case "not_contains": return `${name} NOT LIKE '%${r.value.replace(/'/g, "''")}%'`;
    case "regex": {
      return `${name} ${dialect === "postgres" ? "~" : "GLOB"} '${r.value.replace(/'/g, "''")}'`;
    }
    case "glob": {
      return `${name} ${dialect === "postgres" ? "~" : "GLOB"} '${r.value.replace(/'/g, "''")}'`;
    }
    case "equals": return `${name} = ${sqlLit(r.value, numeric)}`;
    case "not_equals": return `${name} <> ${sqlLit(r.value, numeric)}`;
    case "lt": return `${name} < ${sqlLit(r.value, numeric)}`;
    case "gt": return `${name} > ${sqlLit(r.value, numeric)}`;
    case "lte": return `${name} <= ${sqlLit(r.value, numeric)}`;
    case "gte": return `${name} >= ${sqlLit(r.value, numeric)}`;
    case "is_null": return `${name} IS NULL`;
    case "not_null": return `${name} IS NOT NULL`;
  }
}
function compileGroupPreview(g: FilterGroup, cols: DbColumn[], dialect: DbDialect): string {
  const parts: string[] = [];
  for (const r of g.rules) {
    if (isGroup(r)) { const sub = compileGroupPreview(r, cols, dialect); if (sub) parts.push(sub); }
    else if (opNeedsValue(r.op) ? r.value !== "" : true) parts.push(compileRulePreview(r, cols, dialect));
  }
  if (!parts.length) return "";
  return "(" + parts.join(g.combinator === "AND" ? " AND " : " OR ") + ")";
}
export function previewWhere(model: FilterModel, cols: DbColumn[], dialect: DbDialect = "sqlite"): string {
  return compileGroupPreview(model, cols, dialect);
}

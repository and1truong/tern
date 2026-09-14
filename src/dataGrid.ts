import { serializeRows } from "./dataTransfer.ts";
import { quoteIdent } from "./sqlIdentifiers.ts";
import { encodeDbValue } from "../binaryValues.ts";
import type { DbTable, RowChange } from "../shared.ts";

export type SortDirection = "asc" | "desc";
export interface SortSpec { column: string; direction: SortDirection }

export function toggleSort(sorts: SortSpec[], column: string, additive: boolean): SortSpec[] {
  const existing = sorts.find((sort) => sort.column === column);
  if (!existing) {
    const next = { column, direction: "asc" as const };
    return additive ? [...sorts, next] : [next];
  }
  if (existing.direction === "asc") {
    const next = { column, direction: "desc" as const };
    return additive
      ? sorts.map((sort) => sort.column === column ? next : sort)
      : [next];
  }
  return additive ? sorts.filter((sort) => sort.column !== column) : [];
}

export function orderBySql(sorts: (SortSpec & { asText?: boolean })[]): string {
  if (!sorts.length) return "";
  return " ORDER BY " + sorts
    .map((sort) => `${sort.asText ? `CAST(${quoteIdent(sort.column)} AS TEXT)` : quoteIdent(sort.column)} ${sort.direction.toUpperCase()}`)
    .join(", ");
}

// SQLite permits NULL in ordinary primary keys; such rows have no unique identity.
export function rowIdentity(table: DbTable, row: Record<string, unknown>): string[] {
  const primary = table.columns.filter(column => column.pk).map(column => column.name);
  return [primary, ...(table.uniqueKeys ?? [])].find(key => key.length && key.every(name => row[name] != null)) ?? [];
}

export function paginationSorts(table: DbTable, sorts: SortSpec[]): (SortSpec & { asText?: boolean })[] {
  const orderable = table.columns.filter(column => column.orderable !== false);
  const names = new Set(orderable.map(column => column.name));
  const primary = table.columns.filter(column => column.pk).map(column => column.name);
  const key = [primary, ...(table.uniqueKeys ?? [])].find(key => key.length && key.every(name => names.has(name) && table.columns.some(column => column.name === name && column.notNull)));
  const result: (SortSpec & { asText?: boolean })[] = sorts.filter(sort => names.has(sort.column));
  for (const column of key ?? orderable.map(column => column.name)) {
    if (!result.some(sort => sort.column === column)) result.push({ column, direction: "asc" });
  }
  if (!key) {
    for (const column of table.columns.filter(column => column.orderable === false)) {
      result.push({ column: column.name, direction: "asc", asText: true });
    }
  }
  return result;
}

export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return serializeRows("csv", columns, rows);
}

export function coerceCellValue(raw: string, type: string): unknown {
  const value = raw.trim();
  if (raw === "\\N") return null;
  if (raw.startsWith("\\\\")) return raw.slice(1);
  if (/\b(DECIMAL|NUMERIC)\b/i.test(type) && value !== "") return value;
  if (/\b(INT|INTEGER|BIGINT|SMALLINT|INT8|SERIAL|BIGSERIAL)\b/i.test(type) && /^[-+]?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (/\b(REAL|FLOAT|DOUBLE)\b/i.test(type) && value !== "") {
    if (/^[+-]?infinity$/i.test(value)) return encodeDbValue(Number(`${value.startsWith("-") ? "-" : "+"}Infinity`));
    const number = Number(value);
    return Number.isFinite(number) ? number : raw;
  }
  if (/\b(BOOL|BOOLEAN)\b/i.test(type)) {
    if (/^(true|1)$/i.test(raw.trim())) return true;
    if (/^(false|0)$/i.test(raw.trim())) return false;
  }
  return raw;
}

export function editKey(row: number, column: string): string {
  return `${row}\u0000${column}`;
}

export function buildRowChanges(
  table: DbTable,
  rows: Record<string, unknown>[],
  edits: Record<string, unknown>,
  deleted: Set<number>,
  inserts: Record<string, unknown>[],
  nonComparableColumns: ReadonlySet<string> = new Set(),
): RowChange[] {
  const tableRef = { name: table.name, ...(table.schema ? { schema: table.schema } : {}) };
  const changes: RowChange[] = [];
  rows.forEach((row, rowIndex) => {
    const identity = rowIdentity(table, row);
    const key = Object.fromEntries(identity.map((column) => [column, row[column]]));
    const expected = nonComparableColumns.size
      ? Object.fromEntries(Object.entries(row).filter(([column]) => !nonComparableColumns.has(column)))
      : row;
    if (deleted.has(rowIndex)) {
      if (identity.length) changes.push({ kind: "delete", table: tableRef, key, expected });
      return;
    }
    const values: Record<string, unknown> = {};
    for (const column of table.columns) {
      const stagedKey = editKey(rowIndex, column.name);
      if (stagedKey in edits && !nonComparableColumns.has(column.name)) values[column.name] = edits[stagedKey];
    }
    if (identity.length && Object.keys(values).length) {
      changes.push({ kind: "update", table: tableRef, key, expected, values });
    }
  });
  for (const values of inserts) changes.push({ kind: "insert", table: tableRef, values });
  return changes;
}

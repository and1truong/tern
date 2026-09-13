import type { DbTable } from "../shared.ts";

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function tableKey(table: DbTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function tableLabel(table: DbTable): string {
  return table.schema && table.schema !== "public" ? tableKey(table) : table.name;
}

export function tableSql(table: DbTable): string {
  return table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
    : quoteIdent(table.name);
}

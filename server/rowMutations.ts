import type { DbTableRef, RowChange, RowChangeStatement } from "../shared.ts";
import { DbError } from "../shared.ts";
import { decodeDbValue } from "../binaryValues.ts";

const MAX_CHANGES = 500;

function quoteIdent(name: string): string {
  if (!name) throw new DbError("invalid_change", "identifier cannot be empty");
  return `"${name.replace(/"/g, '""')}"`;
}

function relationSql(table: DbTableRef): string {
  return table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
    : quoteIdent(table.name);
}

function entries(values: Record<string, unknown>, label: string): [string, unknown][] {
  const out = Object.entries(values);
  if (!out.length) throw new DbError("invalid_change", `${label} cannot be empty`);
  return out;
}

function whereSql(change: Extract<RowChange, { kind: "update" | "delete" }>, params: unknown[]): string {
  const key = entries(change.key, "row key");
  const expected = Object.entries(change.expected).filter(([column]) => !(column in change.key));
  return [...key, ...expected].map(([column, value]) => {
    params.push(decodeDbValue(value));
    // `IS` is SQLite's null-safe equality and Postgres dispatch rewrites this
    // predicate to `IS NOT DISTINCT FROM` before execution.
    return `${quoteIdent(column)} IS ?`;
  }).join(" AND ");
}

export function compileRowChange(change: RowChange): RowChangeStatement {
  const relation = relationSql(change.table);
  const params: unknown[] = [];
  if (change.kind === "insert") {
    const values = Object.entries(change.values);
    if (!values.length) return { kind: change.kind, sql: `INSERT INTO ${relation} DEFAULT VALUES`, params };
    params.push(...values.map(([, value]) => decodeDbValue(value)));
    return {
      kind: change.kind,
      sql: `INSERT INTO ${relation} (${values.map(([column]) => quoteIdent(column)).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
      params,
    };
  }
  if (change.kind === "update") {
    const values = entries(change.values, "updated values");
    params.push(...values.map(([, value]) => decodeDbValue(value)));
    const where = whereSql(change, params);
    return {
      kind: change.kind,
      sql: `UPDATE ${relation} SET ${values.map(([column]) => `${quoteIdent(column)} = ?`).join(", ")} WHERE ${where}`,
      params,
    };
  }
  const where = whereSql(change, params);
  return { kind: change.kind, sql: `DELETE FROM ${relation} WHERE ${where}`, params };
}

export function compileRowChanges(changes: RowChange[]): RowChangeStatement[] {
  if (!changes.length) throw new DbError("invalid_change", "no row changes supplied");
  if (changes.length > MAX_CHANGES) throw new DbError("invalid_change", `at most ${MAX_CHANGES} row changes can be applied at once`);
  return changes.map(compileRowChange);
}

export function toPostgresMutationSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/ IS \?|\?/g, (token) => {
    const placeholder = `$${++parameter}`;
    return token === "?" ? placeholder : ` IS NOT DISTINCT FROM ${placeholder}`;
  });
}

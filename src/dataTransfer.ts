import type { DbTable } from "../shared.ts";
import { tableSql } from "./sqlIdentifiers.ts";
import { decodeDbValue, isDbBinaryValue, unwrapDbValueForDisplay } from "../binaryValues.ts";

export type ExportFormat = "csv" | "json" | "sql" | "markdown";

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sqlValue(value: unknown, postgres: boolean, type = ""): string {
  if (isDbBinaryValue(value)) {
    const bytes = decodeDbValue(value) as Uint8Array;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    return postgres ? `decode('${hex}', 'hex')` : `X'${hex}'`;
  }
  if (postgres && Array.isArray(value) && (type === "ARRAY" || type.endsWith("[]"))) {
    const arrayLiteral = (items: unknown[]): string => '{' + items.map(item => Array.isArray(item) ? arrayLiteral(item) : item == null ? 'NULL' : '"' + (typeof item === 'object' ? JSON.stringify(item) : String(item)).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
    return "'" + arrayLiteral(value).replace(/'/g, "''") + "'";
  }
  value = unwrapDbValueForDisplay(value);
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function serializeRows(format: ExportFormat, columns: string[], rows: Record<string, unknown>[], table?: DbTable): string {
  const displayRows = rows.map((row) => Object.fromEntries(
    columns.map((column) => [column, unwrapDbValueForDisplay(row[column])]),
  ));
  if (format === "json") return JSON.stringify(displayRows, null, 2) + "\n";
  if (format === "markdown") {
    const cell = (value: unknown) => String(value ?? "NULL").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    return `| ${columns.map(cell).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n`
      + displayRows.map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`).join("\n") + "\n";
  }
  if (format === "sql") {
    if (!table) throw new Error("SQL export requires a table");
    const writableColumns = columns.filter((column) => {
      const metadata = table.columns.find((candidate) => candidate.name === column);
      return !metadata?.generated && !metadata?.identity;
    });
    if (!writableColumns.length) {
      return rows.map(() => `INSERT INTO ${tableSql(table)} DEFAULT VALUES;`).join("\n") + "\n";
    }
    const names = writableColumns.map((column) => `"${column.replace(/"/g, '""')}"`).join(", ");
    return rows.map((row) => `INSERT INTO ${tableSql(table)} (${names}) VALUES (${writableColumns.map((column) => sqlValue(row[column], !!table.schema, table.columns.find(c => c.name === column)?.type)).join(", ")});`).join("\n") + "\n";
  }
  return [columns.map(csvCell).join(","), ...displayRows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n");
}

export function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let quoted = false;
  let quoteClosed = false;
  let recordStarted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\n" && ch !== "\r") recordStarted = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; quoteClosed = true; }
      } else value += ch;
      continue;
    }
    if (quoteClosed && ch !== "," && ch !== "\n" && ch !== "\r") throw new Error("CSV contains text after a closing quote");
    if (ch === '"' && value === "") { quoted = true; continue; }
    if (ch === ",") { record.push(value); value = ""; quoteClosed = false; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(value); value = ""; quoteClosed = false;
      records.push(record);
      record = [];
      recordStarted = false;
      continue;
    }
    value += ch;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  record.push(value);
  if (recordStarted) records.push(record);
  const columns = (records.shift() ?? []).map((column) => column.trim());
  if (!columns.length || columns.some((column) => !column)) throw new Error("CSV must have a non-empty header row");
  if (new Set(columns).size !== columns.length) throw new Error("CSV header names must be unique");
  const rows = records.map((cells, rowIndex) => {
    if (cells.length !== columns.length) throw new Error(`CSV row ${rowIndex + 2} has ${cells.length} values; expected ${columns.length}`);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]]));
  });
  return { columns, rows };
}

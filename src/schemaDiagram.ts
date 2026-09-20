import { tableKey } from "../shared/sqlIdentifiers.ts";
import type { DbSchema, DbTable } from "../shared/types.ts";

export interface SchemaRelation {
  fromTable: DbTable;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export function schemaRelations(schema: DbSchema): SchemaRelation[] {
  const relations: SchemaRelation[] = [];
  for (const table of schema.tables) for (const column of table.columns) for (const target of [column.fk ?? []].flat()) {
    const match = target.match(/^(.+)\(([^()]+)\)$/);
    if (match) relations.push({ fromTable: table, fromColumn: column.name, toTable: match[1], toColumn: match[2] });
  }
  return relations;
}

export function relationTarget(tables: DbTable[], target: string): DbTable | undefined {
  return tables.find(table => tableKey(table) === target)
    ?? (!target.includes(".") ? tables.find(table => table.name === target) : undefined);
}

function entityName(table: Pick<DbTable, "schema" | "name">): string {
  const label = `${table.schema ? `${table.schema}_` : ""}${table.name}`.replace(/[^A-Za-z0-9_]/g, "_");
  const identity = JSON.stringify([table.schema ?? null, table.name]);
  return `${label}_${Array.from(identity, char => char.codePointAt(0)!.toString(16)).join("_")}`;
}

function mermaidType(type: string): string {
  return (type.trim().split(/[\s([]/)[0] || "text").replace(/[^A-Za-z0-9_]/g, "_");
}

export function schemaToMermaid(schema: DbSchema): string {
  const lines = ["erDiagram"];
  for (const table of schema.tables.filter((candidate) => candidate.type === "table")) {
    lines.push(`  ${entityName(table)} {`);
    for (const column of table.columns) {
      const keys = [column.pk ? "PK" : "", column.fk ? "FK" : ""].filter(Boolean).join(",");
      lines.push(`    ${mermaidType(column.type)} ${column.name.replace(/[^A-Za-z0-9_]/g, "_")}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const relation of schemaRelations(schema)) {
    const target = relationTarget(schema.tables, relation.toTable);
    lines.push(`  ${entityName(target ?? { name: relation.toTable })} ||--o{ ${entityName(relation.fromTable)} : "${relation.fromColumn}"`);
  }
  return lines.join("\n") + "\n";
}

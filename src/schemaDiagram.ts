import type { DbSchema, DbTable } from "../shared.ts";

export interface SchemaRelation {
  fromTable: DbTable;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export function schemaRelations(schema: DbSchema): SchemaRelation[] {
  const relations: SchemaRelation[] = [];
  for (const table of schema.tables) for (const column of table.columns) {
    const match = column.fk?.match(/^(.+)\(([^()]+)\)$/);
    if (match) relations.push({ fromTable: table, fromColumn: column.name, toTable: match[1], toColumn: match[2] });
  }
  return relations;
}

function entityName(table: DbTable | string): string {
  const raw = typeof table === "string" ? table : `${table.schema ? `${table.schema}_` : ""}${table.name}`;
  return raw.replace(/[^A-Za-z0-9_]/g, "_");
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
      lines.push(`    ${mermaidType(column.type)} ${entityName(column.name)}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const relation of schemaRelations(schema)) {
    const target = schema.tables.find((table) => table.name === relation.toTable || `${table.schema}.${table.name}` === relation.toTable);
    lines.push(`  ${entityName(target ?? relation.toTable)} ||--o{ ${entityName(relation.fromTable)} : "${relation.fromColumn}"`);
  }
  return lines.join("\n") + "\n";
}

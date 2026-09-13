import { expect, test } from "bun:test";
import { schemaRelations, schemaToMermaid } from "./schemaDiagram.ts";
import type { DbSchema } from "../shared.ts";

const schema: DbSchema = {
  tables: [
    { schema: "public", name: "users", type: "table", rowCount: -1, ddl: "", columns: [{ name: "id", type: "uuid", notNull: true, pk: true, fk: null }] },
    { schema: "audit", name: "events", type: "table", rowCount: -1, ddl: "", columns: [{ name: "actor_id", type: "uuid", notNull: true, pk: false, fk: "users(id)" }] },
  ],
  indexes: [], triggers: [], pragmas: {},
};

test("derives foreign-key relations and Mermaid ER source", () => {
  expect(schemaRelations(schema)).toHaveLength(1);
  const mermaid = schemaToMermaid(schema);
  expect(mermaid).toContain("public_users {");
  expect(mermaid).toContain("uuid id PK");
  expect(mermaid).toContain('public_users ||--o{ audit_events : "actor_id"');
});

test('qualified public targets do not match a same-named table in another schema', () => {
  const duplicate: DbSchema = { ...schema, tables: [
    { ...schema.tables[0], schema: 'audit' },
    schema.tables[0],
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: 'public.users(id)' }] },
  ] };
  const mermaid = schemaToMermaid(duplicate);
  expect(mermaid).toContain('public_users ||--o{ audit_events');
  expect(mermaid).not.toContain('audit_users ||--o{ audit_events');
});

test('quoted dotted foreign-key targets resolve to their actual table', () => {
  const dotted: DbSchema = { ...schema, tables: [
    { ...schema.tables[0], schema: 'a.b', name: 'c' },
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: '"a.b"."c"(id)' }] },
  ] };
  expect(schemaToMermaid(dotted)).toContain('a_b_c ||--o{ audit_events');
});

test('renders every foreign-key target sharing a source column', () => {
  const multiple: DbSchema = { ...schema, tables: [schema.tables[0], { ...schema.tables[0], name: 'admins' },
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: ['public.users(id)', 'public.admins(id)'] }] },
  ] };
  expect(schemaRelations(multiple)).toHaveLength(2);
  expect(schemaToMermaid(multiple)).toContain('public_users ||--o{ audit_events');
  expect(schemaToMermaid(multiple)).toContain('public_admins ||--o{ audit_events');
});

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
  expect(mermaid).toMatch(/public_users_[a-f0-9_]+ \{/);
  expect(mermaid).toContain("uuid id PK");
  expect(mermaid).toMatch(/public_users_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+ : "actor_id"/);
});

test('qualified public targets do not match a same-named table in another schema', () => {
  const duplicate: DbSchema = { ...schema, tables: [
    { ...schema.tables[0], schema: 'audit' },
    schema.tables[0],
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: 'public.users(id)' }] },
  ] };
  const mermaid = schemaToMermaid(duplicate);
  expect(mermaid).toMatch(/public_users_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+/);
  expect(mermaid).not.toMatch(/audit_users_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+/);
});

test('quoted dotted foreign-key targets resolve to their actual table', () => {
  const dotted: DbSchema = { ...schema, tables: [
    { ...schema.tables[0], schema: 'a.b', name: 'c' },
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: '"a.b"."c"(id)' }] },
  ] };
  expect(schemaToMermaid(dotted)).toMatch(/a_b_c_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+/);
});

test('renders every foreign-key target sharing a source column', () => {
  const multiple: DbSchema = { ...schema, tables: [schema.tables[0], { ...schema.tables[0], name: 'admins' },
    { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: ['public.users(id)', 'public.admins(id)'] }] },
  ] };
  expect(schemaRelations(multiple)).toHaveLength(2);
  expect(schemaToMermaid(multiple)).toMatch(/public_users_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+/);
  expect(schemaToMermaid(multiple)).toMatch(/public_admins_[a-f0-9_]+ \|\|--o\{ audit_events_[a-f0-9_]+/);
});

test('entity IDs distinguish colliding schema and table names', () => {
  const tables = [
    { ...schema.tables[0], schema: 'a_b', name: 'c' },
    { ...schema.tables[0], schema: 'a', name: 'b_c' },
    { ...schema.tables[0], name: 'foo-bar' },
    { ...schema.tables[0], name: 'foo_bar' },
  ];
  const source = { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: ['a_b.c(id)', 'a.b_c(id)', 'public.foo-bar(id)', 'public.foo_bar(id)'] }] };
  const text = schemaToMermaid({ ...schema, tables: [...tables, source] });
  const declarations = [...text.matchAll(/^  (\w+) \{$/gm)].map(match => match[1]);
  expect(new Set(declarations).size).toBe(5);
  const targets = [...text.matchAll(/^  (\w+) \|\|--o\{/gm)].map(match => match[1]);
  expect(new Set(targets).size).toBe(4);
  expect(targets.every(target => declarations.includes(target))).toBe(true);
});

test('qualified targets take precedence over literal dotted bare names', () => {
  const misleading = { ...schema.tables[0], schema: 'aaa', name: 'public.users' };
  const source = { ...schema.tables[1], columns: [{ ...schema.tables[1].columns[0], fk: 'public.users(id)' }] };
  expect(schemaToMermaid({ ...schema, tables: [misleading, schema.tables[0], source] }))
    .toMatch(/\n  public_users_[a-f0-9_]+ \|\|--o\{ audit_events_/);
});

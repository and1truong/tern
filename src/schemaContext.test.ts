import { expect, test } from 'bun:test';
import type { DbSchema } from '../shared.ts';
import { filterSchemaCatalog, schemaPreferenceKey, readSchemaPreferences, sqlCompletionSchema } from './schemaContext.ts';
import { isDocuments } from './documents.ts';

const catalog: DbSchema = {
  schemas: ['public', 'billing', 'empty', 'pg_catalog'],
  tables: ['public', 'billing', 'pg_catalog'].map(schema => ({ schema, name: 'users', columns: [], type: 'table', ddl: '', rowCount: 0 })),
  indexes: [{ name: 'i', schema: 'public', sql: '' }, { name: 'i', schema: 'billing', sql: '' }],
  triggers: [{ name: 't', schema: 'public', sql: '' }, { name: 't', schema: 'billing', sql: '' }],
  constraints: [{ name: 'c', schema: 'billing', table: 'users', type: 'UNIQUE', columns: [], definition: '' }],
  sequences: [{ name: 's', schema: 'billing' }], routines: [{ name: 'f', schema: 'public' }], extensions: [{ name: 'ext' }], pragmas: {},
};
test('selected schema scopes every schema-owned object without mutating the catalog', () => {
  const selected = filterSchemaCatalog(catalog, 'billing');
  expect(selected.tables.map(t => t.schema)).toEqual(['billing']);
  expect(selected.indexes.map(t => t.schema)).toEqual(['billing']);
  expect(selected.triggers.map(t => t.schema)).toEqual(['billing']);
  expect(selected.constraints).toHaveLength(1);
  expect(selected.sequences).toHaveLength(1);
  expect(selected.routines).toEqual([]);
  expect(selected.extensions).toEqual(catalog.extensions);
  expect(catalog.tables).toHaveLength(3);
  expect(filterSchemaCatalog(catalog, 'empty').schemas).toEqual(['empty']);
  expect(filterSchemaCatalog(catalog, 'empty').tables).toEqual([]);
  expect(filterSchemaCatalog(catalog).tables).toHaveLength(2);
  expect(filterSchemaCatalog(catalog, undefined, true).tables).toHaveLength(3);
});
test('preferences identify the effective database and validate persisted state', () => {
  const source = { kind: 'postgres' as const, connId: 'one', url: 'postgres://localhost/my%20db', label: '', readOnly: true, environment: 'local' as const };
  expect(schemaPreferenceKey(source)).toBe(schemaPreferenceKey({ ...source, database: 'my db' }));
  expect(schemaPreferenceKey(source)).not.toBe(schemaPreferenceKey({ ...source, database: 'another' }));
  expect(readSchemaPreferences({ a: { schema: 'billing', showSystem: false }, b: { schema: 1 }, c: null })).toEqual({ a: { schema: 'billing', showSystem: false } });
  expect(isDocuments({ active: 'q', tabs: [{ id: 'q', kind: 'sql', title: 'Query', source: { ...source, schema: 'billing' } }] })).toBe(true);
  expect(isDocuments({ active: 'q', tabs: [{ id: 'q', kind: 'sql', title: 'Query', source: { ...source, schema: 1 } }] })).toBe(false);
});
test('completion retains namespaces and unusual identifiers without collisions', () => {
  const completion = sqlCompletionSchema({ ...catalog, tables: [...catalog.tables, { ...catalog.tables[0], schema: '__proto__', name: 'constructor' }] }, true);
  expect(Object.keys(completion)).toEqual(['public', 'billing', 'pg_catalog', '__proto__']);
  expect(completion['__proto__']).toEqual({ constructor: [] });
});

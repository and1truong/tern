import type { DbSchema } from '../shared/types.ts';
import type { DbSource } from './dbApi.ts';

export interface SchemaPreference { schema?: string; showSystem: boolean }
export function isSystemSchema(name: string) { return name.startsWith('pg_') || name === 'information_schema'; }
export function schemaPreferenceKey(source: Extract<DbSource, { kind: 'postgres' }>) {
  // source.url can be a redacted "(invalid url)" or a malformed persisted
  // document — fall back to "" rather than crashing render.
  const database = source.database ?? (() => { try { return decodeURIComponent(new URL(source.url).pathname.slice(1)); } catch { return ''; } })();
  return JSON.stringify([source.connId, database]);
}
export function readSchemaPreferences(value: unknown): Record<string, SchemaPreference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item === 'object'
    && typeof item.showSystem === 'boolean' && (item.schema === undefined || typeof item.schema === 'string')));
}
export function filterSchemaCatalog(catalog: DbSchema, selected?: string, showSystem = false): DbSchema {
  const matches = (item: { schema?: string }) => selected !== undefined ? item.schema === selected : showSystem || !item.schema || !isSystemSchema(item.schema);
  return {
    ...catalog,
    schemas: catalog.schemas?.filter(name => selected !== undefined ? name === selected : showSystem || !isSystemSchema(name)),
    tables: catalog.tables.filter(matches), indexes: catalog.indexes.filter(matches), triggers: catalog.triggers.filter(matches),
    constraints: catalog.constraints?.filter(matches), sequences: catalog.sequences?.filter(matches), routines: catalog.routines?.filter(matches),
  };
}
export function querySchemaLabel(source: DbSource) {
  return source.kind === 'postgres' ? source.schema ?? 'Server default search path' : '';
}
// Keep cross-schema completion available; use a namespace tree so CodeMirror can
// resolve quoted identifiers and offer bare tables from the selected schema.
export function sqlCompletionSchema(catalog: DbSchema, postgres: boolean) {
  if (!postgres) return Object.fromEntries(catalog.tables.map(t => [t.name, t.columns.map(c => c.name)]));
  const namespaces: Record<string, Record<string, string[]>> = Object.create(null);
  for (const table of catalog.tables) {
    const namespace = table.schema ?? 'public';
    (namespaces[namespace] ??= Object.create(null))[table.name] = table.columns.map(column => column.name);
  }
  return namespaces;
}

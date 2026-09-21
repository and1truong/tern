import type { DbSource } from "./dbApi.ts";
export interface Document {
  id: string;
  kind: 'table' | 'sql' | 'diagram' | 'insights' | 'migration' | 'settings' | 'key' | 'console';
  title: string;
  source: DbSource;
  table?: string;
}
export function sourceId(source: DbSource) {
  return source.kind === 'sqlite' ? source.path : `${source.connId}/${source.database ?? ""}`;
}
export function sourceLabel(source: DbSource) {
  return source.kind === 'sqlite' ? source.path.split('/').pop()! : source.label;
}
export function isDocument(d: unknown): d is Document {
  if (!d || typeof d !== 'object') return false;
  const doc = d as Document;
  return typeof doc.id === 'string' && typeof doc.title === 'string' &&
    ['table', 'sql', 'diagram', 'insights', 'migration', 'settings', 'key', 'console'].includes(doc.kind) &&
    (doc.table === undefined || typeof doc.table === 'string') &&
    !!doc.source && (doc.source.kind === 'sqlite' ? typeof doc.source.path === 'string'
      : doc.source.kind === 'postgres' ? typeof doc.source.connId === 'string' && typeof doc.source.url === 'string' && typeof doc.source.label === 'string' && (doc.source.database === undefined || typeof doc.source.database === 'string') && validFlags(doc.source)
      : doc.source.kind === 'redis' && typeof doc.source.connId === 'string' && typeof doc.source.database === 'string' && typeof doc.source.url === 'string' && typeof doc.source.label === 'string' && validFlags(doc.source));
}

// Container-level check only — per-doc validation is isDocument so callers
// can filter a partially corrupt tab list instead of discarding it whole.
export function isDocuments(value: unknown): value is { tabs: Document[]; active: string } {
  if (!value || typeof value !== 'object') return false;
  const state = value as { tabs?: Document[]; active: string };
  return typeof state.active === 'string' && Array.isArray(state.tabs);
}

// Optional profile fields on a persisted doc: when present they must be the
// right type — the profile itself stays authoritative for readOnly.
function validFlags(s: { readOnly?: unknown; environment?: unknown }) {
  return (s.readOnly === undefined || typeof s.readOnly === 'boolean')
    && (s.environment === undefined || typeof s.environment === 'string');
}

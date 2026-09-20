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
export function isDocuments(value: unknown): value is { tabs: Document[]; active: string } {
  if (!value || typeof value !== 'object') return false;
  const state = value as { tabs?: Document[]; active: string };
  return typeof state.active === 'string' && Array.isArray(state.tabs) && state.tabs.every(d =>
    d && typeof d.id === 'string' && typeof d.title === 'string' &&
    ['table', 'sql', 'diagram', 'insights', 'migration', 'settings', 'key', 'console'].includes(d.kind) &&
    (d.table === undefined || typeof d.table === 'string') &&
    d.source && (d.source.kind === 'sqlite' ? typeof d.source.path === 'string'
      : d.source.kind === 'postgres' ? typeof d.source.connId === 'string' && typeof d.source.url === 'string' && typeof d.source.label === 'string' && (d.source.database === undefined || typeof d.source.database === 'string') && validFlags(d.source)
      : d.source.kind === 'redis' && typeof d.source.connId === 'string' && typeof d.source.database === 'string' && typeof d.source.url === 'string' && typeof d.source.label === 'string' && validFlags(d.source)));
}

// Optional profile fields on a persisted doc: when present they must be the
// right type — the profile itself stays authoritative for readOnly.
function validFlags(s: { readOnly?: unknown; environment?: unknown }) {
  return (s.readOnly === undefined || typeof s.readOnly === 'boolean')
    && (s.environment === undefined || typeof s.environment === 'string');
}

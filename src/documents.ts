import type { DbSource } from "./dbApi.ts";
export interface Document {
  id: string;
  kind: 'table' | 'sql' | 'diagram' | 'insights' | 'migration' | 'settings';
  title: string;
  source: DbSource;
  table?: string;
}
export function sourceId(source: DbSource) { return source.kind === 'sqlite' ? source.path : `${source.connId}/${source.database ?? ""}`; }
export function sourceLabel(source: DbSource) { return source.kind === 'sqlite' ? source.path.split('/').pop()! : source.label; }
export function isDocuments(value: unknown): value is { tabs: Document[]; active: string } {
  if (!value || typeof value !== 'object') return false;
  const state = value as { tabs?: Document[]; active?: string };
  return typeof state.active === 'string' && Array.isArray(state.tabs) && state.tabs.every(d =>
    d && typeof d.id === 'string' && typeof d.title === 'string' && ['table', 'sql', 'diagram', 'insights', 'migration', 'settings'].includes(d.kind) &&
    d.source && (d.source.kind === 'sqlite' ? typeof d.source.path === 'string' : d.source.kind === 'postgres' && typeof d.source.connId === 'string'));
}

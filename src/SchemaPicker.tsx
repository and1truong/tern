import { useState } from 'react';
import { isSystemSchema } from './schemaContext.ts';

export function SchemaPicker({ schemas, selected, showSystem, loading, onSelect, onShowSystem, onRefresh }: {
  schemas: string[]; selected?: string; showSystem: boolean; loading: boolean;
  onSelect: (schema?: string) => void; onShowSystem: (show: boolean) => void; onRefresh: () => void;
}) {
  const [search, setSearch] = useState('');
  const missing = selected !== undefined && !schemas.includes(selected);
  const visible = schemas.filter(name => (showSystem || !isSystemSchema(name) || name === selected)
    && (name === selected || name.toLowerCase().includes(search.toLowerCase())));
  return <div className="flex items-center flex-wrap gap-2" aria-busy={loading}>
    <input aria-label="Search schemas" placeholder="Find schema…" value={search} onChange={e => setSearch(e.target.value)}
      className="w-28 bg-[var(--bg)] border border-[var(--border)] p-1" />
    <label>Schema <select aria-label="Schema" disabled={loading} value={selected ?? ''} onChange={e => onSelect(e.target.value || undefined)}
      className="max-w-48 bg-[var(--bg)] border border-[var(--border)] p-1">
      <option value="">All schemas</option>
      {missing && <option value={selected}>{selected} (unavailable)</option>}
      {visible.map(name => <option key={name} value={name}>{name}</option>)}
    </select></label>
    <label className="flex items-center gap-1"><input type="checkbox" aria-label="Show system schemas" checked={showSystem}
      onChange={e => onShowSystem(e.target.checked)} />System</label>
    <button aria-label="Refresh schemas" disabled={loading} onClick={onRefresh}>↻</button>
    {loading ? <span role="status">Loading schemas…</span> : missing ? <span role="alert">Schema unavailable. Select another schema.</span>
      : !visible.length && <span role="status">{search ? 'No matching schemas.' : 'No accessible schemas.'}</span>}
  </div>;
}

import { useCallback, useEffect, useState } from "react";
import { dbApi, type RedisSource } from "./dbApi.ts";
import type { DataSourceInfo } from "../shared.ts";

// Redis-native key browser: incremental SCAN with pattern/type filters, plus
// rename/delete/expire/persist. Never issues KEYS.
export function RedisKeyExplorer({ source, info, activeKey, onOpenKey, onChanged }: {
  source: RedisSource;
  info: DataSourceInfo | null;
  activeKey: string | null;
  onOpenKey(key: string): void;
  onChanged?(): void;
}) {
  const [pattern, setPattern] = useState('*');
  const [type, setType] = useState('');
  const [page, setPage] = useState({ cursor: '0', keys: [] as { key: string; type: string }[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expiring, setExpiring] = useState<{ key: string; seconds: string } | null>(null);
  const [applied, setApplied] = useState(0);

  const load = useCallback(async (reset: boolean) => {
    setBusy(true); setError('');
    try {
      const cursor = reset ? '0' : page.cursor;
      const result = await dbApi.datasource.scan(source, { cursor, match: pattern.trim() || undefined, count: 120, type: type || undefined });
      setPage(prev => reset
        ? { cursor: result.cursor, keys: result.keys }
        : { cursor: result.cursor, keys: [...prev.keys, ...result.keys] });
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }, [source, pattern, type, page.cursor]);

  useEffect(() => { void load(true); }, [source, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  const op = async (body: Parameters<typeof dbApi.datasource.keyOp>[1]) => {
    setBusy(true); setError('');
    try {
      const result = await dbApi.datasource.keyOp(source, body);
      if (!result.ok) setError(result.error ?? 'Operation failed');
      else { setRenaming(null); setDeleting(null); setExpiring(null); onChanged?.(); setApplied(a => a + 1); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const typeBadge = (t: string) => ({ string: 'str', hash: 'hash', list: 'list', set: 'set', zset: 'zset', stream: 'stream' }[t] ?? t);

  return <div className="flex flex-col overflow-hidden h-full">
    <div className="px-3 py-2 space-y-2">
      <input aria-label="Key pattern" value={pattern} onChange={e => setPattern(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void load(true); } }}
        placeholder="pattern, e.g. user:*" className="w-full bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" />
      <div className="flex gap-1 items-center">
        <select aria-label="Type filter" value={type} onChange={e => { setType(e.target.value); setApplied(a => a + 1); }}
          className="bg-[var(--bg)] border border-[var(--border)] p-1 text-xs flex-1">
          <option value="">any type</option>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button disabled={busy} onClick={() => { setApplied(a => a + 1); }} title="Refresh">↻</button>
      </div>
      {info && <p className="text-[10px] text-[var(--faint)]">{info.flavor === 'valkey' ? 'Valkey' : info.flavor === 'redis' ? 'Redis' : info.flavor} {info.version}{info.capabilities.cluster ? ' · cluster' : ''}{info.summary.totalKeys !== undefined ? ` · ${info.summary.totalKeys} keys` : ''}</p>}
    </div>
    {error && <div role="alert" className="error mx-2 mb-1 text-xs">{error}</div>}
    <div className="overflow-auto flex-1">
      {page.keys.map(({ key, type: keyType }) => (
        <div key={key} className="group">
          {renaming?.from === key ? <div className="px-3 py-1 text-xs space-y-1">
            <input aria-label="New key name" autoFocus value={renaming.to} onChange={e => setRenaming({ ...renaming, to: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') void op({ op: 'rename', from: key, to: renaming.to }); }} className="w-full bg-[var(--bg)] border border-[var(--border)] p-1" />
            <div className="flex gap-1"><button className="primary text-xs" disabled={busy} onClick={() => void op({ op: 'rename', from: key, to: renaming.to })}>Rename</button><button className="text-xs" onClick={() => setRenaming(null)}>Cancel</button></div>
          </div> : deleting === key ? <div className="px-3 py-1 text-xs space-y-1">
            <p className="text-[var(--danger)]">Delete “{key}”?</p>
            <div className="flex gap-1"><button className="primary text-xs" disabled={busy} onClick={() => void op({ op: 'delete', keys: [key] })}>Delete</button><button className="text-xs" onClick={() => setDeleting(null)}>Cancel</button></div>
          </div> : expiring?.key === key ? <div className="px-3 py-1 text-xs space-y-1">
            <input aria-label="Seconds until expiry" autoFocus type="number" min="1" value={expiring.seconds} onChange={e => setExpiring({ ...expiring, seconds: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && /^\d+$/.test(expiring.seconds) && Number(expiring.seconds) >= 1) void op({ op: 'expire', key, seconds: Number(expiring.seconds) }); }} className="w-full bg-[var(--bg)] border border-[var(--border)] p-1" />
            <div className="flex gap-1"><button className="primary text-xs" disabled={busy || !/^\d+$/.test(expiring.seconds) || Number(expiring.seconds) < 1} title={!/^\d+$/.test(expiring.seconds) || Number(expiring.seconds) < 1 ? 'Seconds must be a positive number' : undefined} onClick={() => void op({ op: 'expire', key, seconds: Number(expiring.seconds) })}>Expire</button><button className="text-xs" onClick={() => setExpiring(null)}>Cancel</button></div>
          </div> : <div className={"w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-[var(--hover)] " + (key === activeKey ? "bg-[var(--accent)]/15" : "")}>
            <button className="flex-1 flex items-center gap-2 text-left min-w-0" title={key} onClick={() => onOpenKey(key)}>
              <span className="mono text-[9px] text-[var(--faint)] uppercase">{typeBadge(keyType)}</span>
              <span className="truncate">{key}</span>
            </button>
            <span className="hidden group-hover:flex gap-1">
              <button aria-label={`Rename ${key}`} onClick={() => setRenaming({ from: key, to: key })}>✎</button>
              <button aria-label={`Expire ${key}`} onClick={() => setExpiring({ key, seconds: '3600' })}>⏱</button>
              <button aria-label={`Persist ${key}`} disabled={busy} onClick={() => void op({ op: 'persist', key })}>⏳</button>
              <button aria-label={`Delete ${key}`} className="text-[var(--danger)]" onClick={() => setDeleting(key)}>×</button>
            </span>
          </div>}
        </div>
      ))}
      {!page.keys.length && !busy && <p className="p-3 text-xs text-[var(--faint)]">No keys matched. Adjust the pattern and press Enter.</p>}
      {page.cursor !== '0' && <button disabled={busy} className="w-full px-3 py-2 text-xs text-[var(--accent)]" onClick={() => void load(false)}>{busy ? 'Scanning…' : 'Load more (SCAN)'}</button>}
    </div>
  </div>;
}

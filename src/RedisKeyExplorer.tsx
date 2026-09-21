import { useCallback, useEffect, useRef, useState } from "react";
import { dbApi, type RedisSource } from "./dbApi.ts";
import type { DataSourceInfo } from "../shared/types.ts";

// Redis-native key browser: incremental SCAN with pattern/type filters, plus
// rename/delete/expire/persist. Never issues KEYS.
export function RedisKeyExplorer({ source, info, writable, activeKey, onOpenKey, onRenamedKey, onChanged }: {
  source: RedisSource;
  info: DataSourceInfo | null;
  writable: boolean;
  activeKey: string | null;
  onOpenKey(key: string): void;
  // The callback gets this explorer's own source — the parent's selected
  // source may have changed while the rename was in flight.
  onRenamedKey?(source: RedisSource, from: string, to: string): void;
  onChanged?(): void;
}) {
  const [pattern, setPattern] = useState('*');
  const [type, setType] = useState('');
  const [page, setPage] = useState({ cursor: '0', keys: [] as { key: string; type: string }[] });
  // busy counts in-flight ops — a finished load must not re-enable controls
  // while a rename check or key op is still running.
  const [busy, setBusy] = useState(0);
  const isBusy = busy > 0;
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expiring, setExpiring] = useState<{ key: string; seconds: string } | null>(null);
  const [applied, setApplied] = useState(0);
  const loadGen = useRef(0);
  // The pattern draft only applies on Enter/refresh; paging continues the
  // result set that's actually displayed, so the applied filters are a
  // snapshot rather than the live input state.
  const filtersRef = useRef({ match: '*' as string | undefined, type: undefined as string | undefined });
  const apply = (nextType = type, nextMatch = pattern.trim() || undefined) => {
    filtersRef.current = { match: nextMatch, type: nextType || undefined };
    // A requery invalidates the rows an armed rename/delete/expire was aimed
    // at — clear them alongside the result set.
    setRenaming(null); setDeleting(null); setExpiring(null);
    setApplied(a => a + 1);
  };

  const load = useCallback(async (reset: boolean) => {
    setBusy(n => n + 1); setError('');
    const gen = reset ? ++loadGen.current : loadGen.current;
    try {
      const cursor = reset ? '0' : page.cursor;
      const result = await dbApi.datasource.scan(source, { cursor, match: filtersRef.current.match, count: 120, type: filtersRef.current.type });
      // A stale page from before a filter reset must not merge into the new
      // result set.
      if (gen !== loadGen.current) return;
      // No error boundary above us — a malformed page must become an error
      // message, not a crash in the setPage updater.
      if (!result || !Array.isArray(result.keys) || typeof result.cursor !== "string") throw new Error("Malformed scan reply");
      const scanned = result.keys.filter((k): k is { key: string; type: string } => !!k && typeof k.key === "string" && typeof k.type === "string");
      // SCAN may revisit keys (and pages may overlap) — dedupe by key name.
      setPage(prev => {
        const keys = reset ? scanned : [...prev.keys, ...scanned];
        return { cursor: result.cursor, keys: [...new Map(keys.map(k => [k.key, k])).values()] };
      });
    } catch (e) { if (gen === loadGen.current) setError(String(e)); }
    finally { setBusy(n => n - 1); }
  }, [source, page.cursor]);

  // `info === null` in the deps retries a mount-time scan that raced the
  // connection still establishing — the error would otherwise sit until a
  // manual ↻. Object identity stays off the list so info refreshes (key-op
  // count bumps) don't reset the page.
  useEffect(() => { void load(true); }, [source, applied, info === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // Armed write controls must not outlive the writable session that armed
  // them — dropping to read-only clears any pending confirm.
  useEffect(() => { if (!writable) { setRenaming(null); setDeleting(null); setExpiring(null); } }, [writable]);
  // A source switch (another logical DB) can hold keys with identical names;
  // an armed confirm must not fire against a key from a different database,
  // and stale rows must not be clickable while the new page loads.
  useEffect(() => { setRenaming(null); setDeleting(null); setExpiring(null); setPage({ cursor: '0', keys: [] }); }, [source]);

  const op = async (body: Parameters<typeof dbApi.datasource.keyOp>[1]) => {
    setBusy(n => n + 1); setError('');
    try {
      const result = await dbApi.datasource.keyOp(source, body);
      if (!result.ok) setError(result.error ?? 'Operation failed');
      else { setRenaming(null); setDeleting(null); setExpiring(null); onChanged?.(); setApplied(a => a + 1); }
      return result;
    } catch (e) { setError(String(e)); return null; }
    finally { setBusy(n => n - 1); }
  };

  // RENAME overwrites an existing destination — confirm first, then retarget
  // any open key document at the new name.
  const submitRename = async (from: string, to: string) => {
    if (!to.trim() || to === from) { setRenaming(null); return; }
    // Busy-gate the existence check too — sibling ops and re-submits must not
    // interleave with the pending rename.
    setBusy(n => n + 1); setError('');
    try {
      let proceed = true;
      try {
        const target = await dbApi.datasource.inspect(source, to);
        if (target?.value?.kind !== 'none') proceed = window.confirm(`"${to}" already exists — overwrite it?`);
      } catch {
        // An unverifiable destination must not fail open — RENAME overwrites.
        proceed = window.confirm(`Couldn't check whether "${to}" exists — rename anyway?`);
      }
      if (!proceed) return;
      const result = await op({ op: 'rename', from, to });
      // Any open key doc for `from` retargets — including inactive tabs, so
      // this fires on every successful rename, not just the active one.
      if (result?.ok) onRenamedKey?.(source, from, to);
    } finally { setBusy(n => n - 1); }
  };

  const typeBadge = (t: string) => ({ string: 'str', hash: 'hash', list: 'list', set: 'set', zset: 'zset', stream: 'stream' }[t] ?? t);
  // The server rejects non-safe integers — mirror the bound so the error
  // surfaces before the round trip.
  const validSeconds = (s: string) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) >= 1;

  return <div className="flex flex-col overflow-hidden h-full">
    <div className="px-3 py-2 space-y-2">
      <input aria-label="Key pattern" value={pattern} onChange={e => setPattern(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
        placeholder="pattern, e.g. user:*" className="w-full bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" />
      <div className="flex gap-1 items-center">
        <select aria-label="Type filter" value={type} onChange={e => { setType(e.target.value); apply(e.target.value, filtersRef.current.match); }}
          className="bg-[var(--bg)] border border-[var(--border)] p-1 text-xs flex-1">
          <option value="">any type</option>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button disabled={isBusy} onClick={() => apply()} title="Refresh">↻</button>
      </div>
      {info && <p className="text-[10px] text-[var(--faint)]">{info.flavor === 'valkey' ? 'Valkey' : info.flavor === 'redis' ? 'Redis' : info.flavor} {info.version}{info.capabilities?.cluster ? ' · cluster' : ''}{info.summary.totalKeys !== undefined ? ` · ${info.summary.totalKeys} keys` : ''}</p>}
    </div>
    {error && <div role="alert" className="error mx-2 mb-1 text-xs">{error}</div>}
    <div className="overflow-auto flex-1">
      {page.keys.map(({ key, type: keyType }) => (
        <div key={key} className="group">
          {renaming?.from === key ? <div className="px-3 py-1 text-xs space-y-1">
            <input aria-label="New key name" autoFocus value={renaming.to} onChange={e => setRenaming({ ...renaming, to: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) void submitRename(key, renaming.to); if (e.key === 'Escape') setRenaming(null); }} className="w-full bg-[var(--bg)] border border-[var(--border)] p-1" />
            <div className="flex gap-1"><button className="primary text-xs" disabled={isBusy} onClick={() => void submitRename(key, renaming.to)}>Rename</button><button className="text-xs" onClick={() => setRenaming(null)}>Cancel</button></div>
          </div> : deleting === key ? <div className="px-3 py-1 text-xs space-y-1">
            <p className="text-[var(--danger)]">Delete “{key}”?</p>
            <div className="flex gap-1"><button className="primary text-xs" disabled={isBusy} onClick={() => void op({ op: 'delete', keys: [key] })}>Delete</button><button className="text-xs" onClick={() => setDeleting(null)}>Cancel</button></div>
          </div> : expiring?.key === key ? <div className="px-3 py-1 text-xs space-y-1">
            <input aria-label="Seconds until expiry" autoFocus type="number" min="1" value={expiring.seconds} onChange={e => setExpiring({ ...expiring, seconds: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && !busy && validSeconds(expiring.seconds)) void op({ op: 'expire', key, seconds: Number(expiring.seconds) }); if (e.key === 'Escape') setExpiring(null); }} className="w-full bg-[var(--bg)] border border-[var(--border)] p-1" />
            <div className="flex gap-1"><button className="primary text-xs" disabled={isBusy || !validSeconds(expiring.seconds)} title={validSeconds(expiring.seconds) ? undefined : 'Seconds must be a positive integer'} onClick={() => void op({ op: 'expire', key, seconds: Number(expiring.seconds) })}>Expire</button><button className="text-xs" onClick={() => setExpiring(null)}>Cancel</button></div>
          </div> : <div className={"w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-[var(--hover)] " + (key === activeKey ? "bg-[var(--accent)]/15" : "")}>
            <button className="flex-1 flex items-center gap-2 text-left min-w-0" title={key} onClick={() => onOpenKey(key)}>
              <span className="mono text-[9px] text-[var(--faint)] uppercase">{typeBadge(keyType)}</span>
              <span className="truncate">{key}</span>
            </button>
            {writable && <span className="hidden group-hover:flex gap-1">
              <button aria-label={`Rename ${key}`} onClick={() => setRenaming({ from: key, to: key })}>✎</button>
              <button aria-label={`Expire ${key}`} onClick={() => setExpiring({ key, seconds: '3600' })}>⏱</button>
              <button aria-label={`Persist ${key}`} disabled={isBusy} onClick={() => void op({ op: 'persist', key })}>⏳</button>
              <button aria-label={`Delete ${key}`} className="text-[var(--danger)]" onClick={() => setDeleting(key)}>×</button>
            </span>}
          </div>}
        </div>
      ))}
      {!page.keys.length && !busy && <p className="p-3 text-xs text-[var(--faint)]">No keys matched. Adjust the pattern and press Enter.</p>}
      {page.cursor !== '0' && <button disabled={isBusy} className="w-full px-3 py-2 text-xs text-[var(--accent)]" onClick={() => void load(false)}>{busy ? 'Scanning…' : 'Load more (SCAN)'}</button>}
    </div>
  </div>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { dbApi, type RedisSource } from "./dbApi.ts";
import type { KeyInspection } from "../shared/types.ts";

// Type-aware viewer/editor for one Redis key. Edits are explicit actions
// (never implicit), and the server still enforces read-only sessions.
export function RedisKeyView({ source, keyName, writable, onChanged, onRenamed }: {
  source: RedisSource;
  keyName: string;
  writable: boolean;
  onChanged?(): void;
  onRenamed?(newKey: string): void;
}) {
  const [inspection, setInspection] = useState<KeyInspection | null>(null);
  const [error, setError] = useState('');
  // busy counts in-flight ops — a finished load must not re-enable controls
  // while a mutation or rename check is still running.
  const [busy, setBusy] = useState(0);
  const isBusy = busy > 0;
  // Bumped on every fresh reload so field-row drafts armed against the old
  // data remount instead of saving stale text over refreshed values.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [stringDraft, setStringDraft] = useState<string | null>(null);
  const [newField, setNewField] = useState({ field: '', value: '' });
  const [newMember, setNewMember] = useState('');
  const [newScore, setNewScore] = useState<{ member: string; score: string } | null>(null);
  const [listDraft, setListDraft] = useState<{ index: number; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamed, setRenamed] = useState<{ to: string } | null>(null);
  const [expiresIn, setExpiresIn] = useState('3600');
  // Every load supersedes the previous one — a stale response (e.g. an
  // in-flight inspect for a renamed-away key) must not merge into newer state.
  const loadGen = useRef(0);
  // load() reads the target through a ref: a mutation in flight during a
  // rename retarget must reload the NEW key, not inspect the deleted old one.
  const targetRef = useRef({ source, keyName });
  targetRef.current = { source, keyName };

  const load = useCallback(async (cursor?: string) => {
    setBusy(n => n + 1); setError('');
    const gen = ++loadGen.current;
    // A fresh reload drops armed/in-progress state so a stale confirmation
    // cannot fire against refreshed data (or a retargeted key); paging keeps
    // the drafts being edited.
    if (!cursor) {
      setReloadNonce(n => n + 1);
      setConfirmDelete(false); setRenamed(null); setNewScore(null); setListDraft(null); setStringDraft(null);
      setNewField({ field: '', value: '' }); setNewMember(''); setExpiresIn('3600');
    }
    try {
      const next = await dbApi.datasource.inspect(targetRef.current.source, targetRef.current.keyName, cursor);
      if (gen !== loadGen.current) return;
      setInspection(prev => cursor && prev && prev.key === next.key
        ? mergePage(prev, next)
        : next);
    } catch (e) { if (gen === loadGen.current) setError(String(e)); }
    finally { setBusy(n => n - 1); }
  }, []);

  useEffect(() => { setInspection(null); setStringDraft(null); void load(); }, [load, source, keyName]);
  // Armed write controls must not outlive the writable session that armed
  // them — dropping to read-only clears any pending confirm or draft.
  useEffect(() => {
    if (!writable) {
      setConfirmDelete(false); setRenamed(null); setNewScore(null); setListDraft(null); setStringDraft(null);
      setNewField({ field: '', value: '' }); setNewMember(''); setExpiresIn('3600');
    }
  }, [writable]);

  const mutate = async (op: Parameters<typeof dbApi.datasource.keyOp>[1]) => {
    setBusy(n => n + 1); setError('');
    try {
      const result = await dbApi.datasource.keyOp(source, op);
      if (!result.ok) setError(result.error ?? 'Operation failed');
      // A rename deletes the key this view inspects — reloading here would
      // briefly flash "key does not exist"; the retarget reloads instead.
      else {
        if (op.op === 'setString') setStringDraft(null);
        onChanged?.();
        if (op.op !== 'rename') await load();
      }
      return result;
    } catch (e) { setError(String(e)); return null; }
    finally { setBusy(n => n - 1); }
  };

  if (!inspection) return <div className="p-4 text-[var(--text-muted)] text-sm">{error || (busy ? 'Loading…' : 'Key not inspected.')}</div>;
  const v = inspection.value;
  const ttl = inspection.ttlSeconds === null ? 'unknown' : inspection.ttlSeconds === -2 ? 'missing' : inspection.ttlSeconds === -1 ? 'no expiry' : `${inspection.ttlSeconds}s`;
  const editCell = writable ? undefined : 'Read-only session';

  return <div className="document-body flex flex-col overflow-hidden">
    <div className="toolbar flex-wrap gap-2">
      <b className="truncate max-w-[40%]" title={keyName}>{keyName}</b>
      <span className="mono text-[10px] uppercase text-[var(--muted)]">{inspection.type}</span>
      <span className="text-xs text-[var(--text-muted)]">TTL {ttl}{inspection.size !== null ? ` · size ${inspection.size}` : ''}{inspection.memoryBytes !== null ? ` · ${inspection.memoryBytes} B` : ''}</span>
      {/* External mutations (console, other docs, another client) can leave */}
      {/* this view stale — an explicit reload is the escape hatch. */}
      <button aria-label="Reload key" disabled={isBusy} title="Reload" onClick={() => void load()}>↻</button>
      <span className="ml-auto flex gap-1 items-center">
        {renamed && <span className="flex gap-1"><input aria-label="New key name" value={renamed.to} onChange={e => setRenamed({ to: e.target.value })} className="bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" /><button className="primary text-xs" disabled={isBusy} onClick={() => {
          const to = renamed.to;
          // Empty or same-name renames are no-ops, not server errors.
          if (!to.trim() || to === keyName) { setRenamed(null); return; }
          // RENAME overwrites an existing destination — confirm first. Busy
          // spans the check so other toolbar ops can't interleave with it.
          setBusy(n => n + 1);
          const check = to === keyName ? Promise.resolve(true)
            : dbApi.datasource.inspect(source, to).then(target => target.value.kind === 'none' || window.confirm(`"${to}" already exists — overwrite it?`)).catch(() => true);
          void check.then(proceed => {
            if (!proceed) return;
            void mutate({ op: 'rename', from: keyName, to }).then(result => {
              // A failed rename keeps the input armed with the typed name.
              if (result?.ok) { setRenamed(null); onRenamed?.(to); }
            });
          }).finally(() => setBusy(n => n - 1));
        }}>Rename</button><button className="text-xs" onClick={() => setRenamed(null)}>×</button></span>}
        {!renamed && writable && <button disabled={isBusy} onClick={() => setRenamed({ to: keyName })}>Rename</button>}
        {writable && <span className="flex gap-1 items-center"><input aria-label="Expire seconds" type="number" min="1" value={expiresIn} onChange={e => setExpiresIn(e.target.value)} className="w-20 bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" /><button disabled={isBusy || !/^\d+$/.test(expiresIn.trim()) || Number(expiresIn) < 1} title={/^\d+$/.test(expiresIn.trim()) && Number(expiresIn) >= 1 ? undefined : 'Seconds must be a positive number'} onClick={() => void mutate({ op: 'expire', key: keyName, seconds: Number(expiresIn) })}>Expire</button><button disabled={isBusy} onClick={() => void mutate({ op: 'persist', key: keyName })}>Persist</button></span>}
        {confirmDelete ? <span className="flex gap-1"><button className="primary text-xs" disabled={isBusy} onClick={() => void mutate({ op: 'delete', keys: [keyName] })}>Confirm delete</button><button className="text-xs" onClick={() => setConfirmDelete(false)}>Cancel</button></span>
          : writable && <button className="text-[var(--danger)]" onClick={() => setConfirmDelete(true)}>Delete</button>}
      </span>
    </div>
    {error && <div role="alert" className="error">{error}</div>}
    {editCell && <div className="toolbar text-xs text-[var(--text-muted)]">{editCell}</div>}
    <div className="overflow-auto flex-1 p-2">
      {v.kind === 'none' && <p className="text-sm text-[var(--text-muted)]">This key does not exist (it may have expired).</p>}
      {v.kind === 'unknown' && <p className="text-sm text-[var(--text-muted)]">{v.note}</p>}
      {v.kind === 'string' && <div className="space-y-2">
        <textarea readOnly={!writable || v.truncated} value={stringDraft ?? v.value} onChange={e => setStringDraft(e.target.value)}
          rows={6} className="w-full bg-[var(--bg)] border border-[var(--border)] p-2 font-mono text-xs" />
        <p className="text-xs text-[var(--faint)]">{v.lengthBytes} bytes{v.truncated ? ' · preview truncated — editing disabled; edit via GET/SET in the console' : ''}{!v.truncated && writable && stringDraft === null ? ' · click into the text to edit' : ''}</p>
        {writable && !v.truncated && stringDraft !== null && <div className="flex gap-1">
          <button className="primary text-xs" disabled={isBusy} onClick={() => void mutate({ op: 'setString', key: keyName, value: stringDraft })}>Save value</button>
          <button className="text-xs" onClick={() => setStringDraft(null)}>Revert</button>
        </div>}
      </div>}
      {v.kind === 'hash' && <div className="space-y-2">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[var(--faint)]"><th className="w-1/3">field</th><th>value</th>{writable && <th className="w-16"></th>}</tr></thead>
          <tbody>{v.entries.map(e => <HashRow key={`${reloadNonce}:${e.field}`} entry={e} busy={busy > 0} writable={writable} onSave={(value) => void mutate({ op: 'hashSet', key: keyName, field: e.field, value })} onDelete={() => void mutate({ op: 'hashDelete', key: keyName, fields: [e.field] })} />)}</tbody>
        </table>
        {writable && <form className="flex gap-1" onSubmit={e => { e.preventDefault(); if (newField.field) { void mutate({ op: 'hashSet', key: keyName, field: newField.field, value: newField.value }); setNewField({ field: '', value: '' }); } }}>
          <input value={newField.field} onChange={e => setNewField({ ...newField, field: e.target.value })} placeholder="field" className="w-1/3 bg-[var(--bg)] border border-[var(--border)] p-1" />
          <input value={newField.value} onChange={e => setNewField({ ...newField, value: e.target.value })} placeholder="value" className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" />
          <button className="primary text-xs" disabled={isBusy || !newField.field}>Add field</button>
        </form>}
      </div>}
      {v.kind === 'list' && <table className="w-full text-xs">
        <thead><tr className="text-left text-[var(--faint)]"><th className="w-16">index</th><th>value</th></tr></thead>
        <tbody>{v.items.map((item, index) => <tr key={index} className="border-t border-[var(--border)]">
          <td className="mono py-1 text-[var(--faint)]">{v.start + index}</td>
          <td className="py-1">{listDraft?.index === v.start + index
            ? <span className="flex gap-1"><input autoFocus value={listDraft.value} onChange={e => setListDraft({ ...listDraft, value: e.target.value })} className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={isBusy} onClick={() => { void mutate({ op: 'listSet', key: keyName, index: listDraft.index, value: listDraft.value }); setListDraft(null); }}>Save</button><button className="text-xs" onClick={() => setListDraft(null)}>×</button></span>
            : <span className="flex gap-2 items-center"><span className="font-mono break-all flex-1">{item}</span>{writable && <button aria-label={`Edit element ${v.start + index}`} onClick={() => setListDraft({ index: v.start + index, value: item })}>✎</button>}</span>}
          </td>
        </tr>)}</tbody>
      </table>}
      {v.kind === 'set' && <div className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-1">{v.members.map(m => <span key={m} className="mono border border-[var(--border)] px-2 py-0.5 flex gap-1 items-center">{m}{writable && <button aria-label={`Remove ${m}`} className="text-[var(--danger)]" disabled={isBusy} onClick={() => void mutate({ op: 'setRemove', key: keyName, members: [m] })}>×</button>}</span>)}</div>
        {writable && <form className="flex gap-1" onSubmit={e => { e.preventDefault(); if (newMember) { void mutate({ op: 'setAdd', key: keyName, members: [newMember] }); setNewMember(''); } }}>
          <input value={newMember} onChange={e => setNewMember(e.target.value)} placeholder="new member" className="bg-[var(--bg)] border border-[var(--border)] p-1" />
          <button className="primary text-xs" disabled={isBusy || !newMember}>Add member</button>
        </form>}
      </div>}
      {v.kind === 'zset' && <table className="w-full text-xs">
        <thead><tr className="text-left text-[var(--faint)]"><th>member</th><th className="w-24">score</th>{writable && <th className="w-16"></th>}</tr></thead>
        <tbody>{v.entries.map(e => <tr key={e.member} className="border-t border-[var(--border)]">
          <td className="py-1 font-mono break-all">{e.member}</td>
          <td className="py-1">{newScore?.member === e.member
            ? <span className="flex gap-1"><input autoFocus type="number" step="any" value={newScore.score} onChange={ev => setNewScore({ ...newScore, score: ev.target.value })} className="w-20 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={isBusy || newScore.score.trim() === '' || !Number.isFinite(Number(newScore.score))} title={newScore.score.trim() === '' || !Number.isFinite(Number(newScore.score)) ? 'Score must be a finite number' : undefined} onClick={() => { void mutate({ op: 'zsetAdd', key: keyName, member: e.member, score: Number(newScore.score) }); setNewScore(null); }}>Save</button><button className="text-xs" onClick={() => setNewScore(null)}>×</button></span>
            : <span className="flex gap-2 items-center"><span className="mono">{e.score}</span>{writable && <button aria-label={`Edit score for ${e.member}`} onClick={() => setNewScore({ member: e.member, score: String(e.score) })}>✎</button>}</span>}
          </td>
          {writable && <td><button aria-label={`Remove ${e.member}`} className="text-[var(--danger)]" disabled={isBusy} onClick={() => void mutate({ op: 'zsetRemove', key: keyName, members: [e.member] })}>×</button></td>}
        </tr>)}</tbody>
      </table>}
      {v.kind === 'stream' && <div className="space-y-2 text-xs">
        {v.entries.map(e => <div key={e.id} className="border border-[var(--border)] p-2">
          <p className="mono text-[var(--muted)] mb-1">{e.id}</p>
          <table className="w-full"><tbody>{Object.entries(e.fields).map(([f, val]) => <tr key={f}><td className="pr-2 font-mono text-[var(--muted)] align-top">{f}</td><td className="font-mono break-all">{val}</td></tr>)}</tbody></table>
        </div>)}
        <p className="text-[var(--faint)]">Streams are read-only in this view — append with XADD in the console.</p>
      </div>}
      {'truncated' in v && v.truncated && nextCursor(v) !== undefined && <button disabled={isBusy} className="mt-2 text-xs text-[var(--accent)]" onClick={() => void load(nextCursor(v))}>
        {busy ? 'Loading…' : v.kind === 'list' ? 'Load more' : 'Load more (SCAN)'}
      </button>}
    </div>
  </div>;
}

function nextCursor(v: KeyInspection['value']): string | undefined {
  switch (v.kind) {
    case 'hash': case 'set': case 'zset': return v.cursor !== '0' ? v.cursor : undefined;
    case 'list': return String(v.start + v.items.length);
    case 'stream': return v.lastId ?? undefined;
    default: return undefined;
  }
}

function mergePage(previous: KeyInspection, next: KeyInspection): KeyInspection {
  const a = previous.value;
  const b = next.value;
  // SCAN-family pages may revisit elements (rehashing or mid-iteration
  // mutation) — dedupe by identity so React never sees duplicate row keys.
  if (a.kind === 'hash' && b.kind === 'hash') return { ...next, value: { ...b, entries: [...new Map([...a.entries, ...b.entries].map(e => [e.field, e])).values()] } };
  if (a.kind === 'list' && b.kind === 'list') return { ...next, value: { ...b, items: [...a.items, ...b.items], start: a.start } };
  if (a.kind === 'set' && b.kind === 'set') return { ...next, value: { ...b, members: [...new Set([...a.members, ...b.members])] } };
  if (a.kind === 'zset' && b.kind === 'zset') return { ...next, value: { ...b, entries: [...new Map([...a.entries, ...b.entries].map(e => [e.member, e])).values()] } };
  if (a.kind === 'stream' && b.kind === 'stream') return { ...next, value: { ...b, entries: [...new Map([...a.entries, ...b.entries].map(e => [e.id, e])).values()] } };
  return next;
}

function HashRow({ entry, busy, writable, onSave, onDelete }: {
  entry: { field: string; value: string }; busy: boolean; writable: boolean;
  onSave(value: string): void; onDelete(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // An armed edit must not outlive the writable session that armed it.
  useEffect(() => { if (!writable) setDraft(null); }, [writable]);
  return <tr className="border-t border-[var(--border)]">
    <td className="py-1 font-mono break-all pr-2">{entry.field}</td>
    <td className="py-1">{draft !== null && writable
      ? <span className="flex gap-1"><input autoFocus value={draft} onChange={e => setDraft(e.target.value)} className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={busy} onClick={() => { onSave(draft); setDraft(null); }}>Save</button><button className="text-xs" onClick={() => setDraft(null)}>×</button></span>
      : <span className="flex gap-2 items-center"><span className="font-mono break-all flex-1">{entry.value}</span>{writable && !busy && <button aria-label={`Edit field ${entry.field}`} onClick={() => setDraft(entry.value)}>✎</button>}</span>}
    </td>
    {writable && <td>{!busy && <button aria-label={`Delete field ${entry.field}`} className="text-[var(--danger)]" onClick={onDelete}>×</button>}</td>}
  </tr>;
}

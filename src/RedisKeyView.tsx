import { useCallback, useEffect, useState } from "react";
import { dbApi, type RedisSource } from "./dbApi.ts";
import type { KeyInspection } from "../shared.ts";

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
  const [busy, setBusy] = useState(false);
  const [stringDraft, setStringDraft] = useState<string | null>(null);
  const [newField, setNewField] = useState({ field: '', value: '' });
  const [newMember, setNewMember] = useState('');
  const [newScore, setNewScore] = useState<{ member: string; score: string } | null>(null);
  const [listDraft, setListDraft] = useState<{ index: number; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamed, setRenamed] = useState<{ to: string } | null>(null);
  const [expiresIn, setExpiresIn] = useState('3600');

  const load = useCallback(async (cursor?: string) => {
    setBusy(true); setError('');
    try {
      const next = await dbApi.datasource.inspect(source, keyName, cursor);
      setInspection(prev => cursor && prev
        ? mergePage(prev, next)
        : next);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }, [source, keyName]);

  useEffect(() => { setInspection(null); setStringDraft(null); void load(); }, [load]);

  const mutate = async (op: Parameters<typeof dbApi.datasource.keyOp>[1]) => {
    setBusy(true); setError('');
    try {
      const result = await dbApi.datasource.keyOp(source, op);
      if (!result.ok) setError(result.error ?? 'Operation failed');
      else { setStringDraft(null); onChanged?.(); await load(); }
      return result;
    } catch (e) { setError(String(e)); return null; }
    finally { setBusy(false); }
  };

  if (!inspection) return <div className="p-4 text-[var(--text-muted)] text-sm">{error || (busy ? 'Loading…' : 'Key not inspected.')}</div>;
  const v = inspection.value;
  const ttl = inspection.ttlSeconds === -2 ? 'missing' : inspection.ttlSeconds === -1 ? 'no expiry' : `${inspection.ttlSeconds}s`;
  const editCell = writable ? undefined : 'Read-only session';

  return <div className="document-body flex flex-col overflow-hidden">
    <div className="toolbar flex-wrap gap-2">
      <b className="truncate max-w-[40%]" title={keyName}>{keyName}</b>
      <span className="mono text-[10px] uppercase text-[var(--muted)]">{inspection.type}</span>
      <span className="text-xs text-[var(--text-muted)]">TTL {ttl}{inspection.size !== null ? ` · size ${inspection.size}` : ''}{inspection.memoryBytes !== null ? ` · ${inspection.memoryBytes} B` : ''}</span>
      <span className="ml-auto flex gap-1 items-center">
        {renamed && <span className="flex gap-1"><input aria-label="New key name" value={renamed.to} onChange={e => setRenamed({ to: e.target.value })} className="bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" /><button className="primary text-xs" disabled={busy} onClick={() => {
          const to = renamed.to;
          void mutate({ op: 'rename', from: keyName, to }).then(result => {
            setRenamed(null);
            if (result?.ok) onRenamed?.(to);   // retarget this document at the new key
          });
        }}>Rename</button><button className="text-xs" onClick={() => setRenamed(null)}>×</button></span>}
        {!renamed && writable && <button disabled={busy} onClick={() => setRenamed({ to: keyName })}>Rename</button>}
        {writable && <span className="flex gap-1 items-center"><input aria-label="Expire seconds" type="number" min="1" value={expiresIn} onChange={e => setExpiresIn(e.target.value)} className="w-20 bg-[var(--bg)] border border-[var(--border)] p-1 text-xs" /><button disabled={busy || !/^\d+$/.test(expiresIn.trim()) || Number(expiresIn) < 1} title={/^\d+$/.test(expiresIn.trim()) && Number(expiresIn) >= 1 ? undefined : 'Seconds must be a positive number'} onClick={() => void mutate({ op: 'expire', key: keyName, seconds: Number(expiresIn) })}>Expire</button><button disabled={busy} onClick={() => void mutate({ op: 'persist', key: keyName })}>Persist</button></span>}
        {confirmDelete ? <span className="flex gap-1"><button className="primary text-xs" disabled={busy} onClick={() => void mutate({ op: 'delete', keys: [keyName] })}>Confirm delete</button><button className="text-xs" onClick={() => setConfirmDelete(false)}>Cancel</button></span>
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
          <button className="primary text-xs" disabled={busy} onClick={() => void mutate({ op: 'setString', key: keyName, value: stringDraft })}>Save value</button>
          <button className="text-xs" onClick={() => setStringDraft(null)}>Revert</button>
        </div>}
      </div>}
      {v.kind === 'hash' && <div className="space-y-2">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[var(--faint)]"><th className="w-1/3">field</th><th>value</th>{writable && <th className="w-16"></th>}</tr></thead>
          <tbody>{v.entries.map(e => <HashRow key={e.field} entry={e} busy={busy} onSave={(value) => void mutate({ op: 'hashSet', key: keyName, field: e.field, value })} onDelete={() => void mutate({ op: 'hashDelete', key: keyName, fields: [e.field] })} />)}</tbody>
        </table>
        {writable && <form className="flex gap-1" onSubmit={e => { e.preventDefault(); if (newField.field) { void mutate({ op: 'hashSet', key: keyName, field: newField.field, value: newField.value }); setNewField({ field: '', value: '' }); } }}>
          <input value={newField.field} onChange={e => setNewField({ ...newField, field: e.target.value })} placeholder="field" className="w-1/3 bg-[var(--bg)] border border-[var(--border)] p-1" />
          <input value={newField.value} onChange={e => setNewField({ ...newField, value: e.target.value })} placeholder="value" className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" />
          <button className="primary text-xs" disabled={busy || !newField.field}>Add field</button>
        </form>}
      </div>}
      {v.kind === 'list' && <table className="w-full text-xs">
        <thead><tr className="text-left text-[var(--faint)]"><th className="w-16">index</th><th>value</th></tr></thead>
        <tbody>{v.items.map((item, index) => <tr key={index} className="border-t border-[var(--border)]">
          <td className="mono py-1 text-[var(--faint)]">{v.start + index}</td>
          <td className="py-1">{listDraft?.index === v.start + index
            ? <span className="flex gap-1"><input autoFocus value={listDraft.value} onChange={e => setListDraft({ ...listDraft, value: e.target.value })} className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={busy} onClick={() => { void mutate({ op: 'listSet', key: keyName, index: listDraft.index, value: listDraft.value }); setListDraft(null); }}>Save</button><button className="text-xs" onClick={() => setListDraft(null)}>×</button></span>
            : <span className="flex gap-2 items-center"><span className="font-mono break-all flex-1">{item}</span>{writable && <button aria-label={`Edit element ${v.start + index}`} onClick={() => setListDraft({ index: v.start + index, value: item })}>✎</button>}</span>}
          </td>
        </tr>)}</tbody>
      </table>}
      {v.kind === 'set' && <div className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-1">{v.members.map(m => <span key={m} className="mono border border-[var(--border)] px-2 py-0.5 flex gap-1 items-center">{m}{writable && <button aria-label={`Remove ${m}`} className="text-[var(--danger)]" disabled={busy} onClick={() => void mutate({ op: 'setRemove', key: keyName, members: [m] })}>×</button>}</span>)}</div>
        {writable && <form className="flex gap-1" onSubmit={e => { e.preventDefault(); if (newMember) { void mutate({ op: 'setAdd', key: keyName, members: [newMember] }); setNewMember(''); } }}>
          <input value={newMember} onChange={e => setNewMember(e.target.value)} placeholder="new member" className="bg-[var(--bg)] border border-[var(--border)] p-1" />
          <button className="primary text-xs" disabled={busy || !newMember}>Add member</button>
        </form>}
      </div>}
      {v.kind === 'zset' && <table className="w-full text-xs">
        <thead><tr className="text-left text-[var(--faint)]"><th>member</th><th className="w-24">score</th>{writable && <th className="w-16"></th>}</tr></thead>
        <tbody>{v.entries.map(e => <tr key={e.member} className="border-t border-[var(--border)]">
          <td className="py-1 font-mono break-all">{e.member}</td>
          <td className="py-1">{newScore?.member === e.member
            ? <span className="flex gap-1"><input autoFocus type="number" step="any" value={newScore.score} onChange={ev => setNewScore({ ...newScore, score: ev.target.value })} className="w-20 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={busy} onClick={() => { void mutate({ op: 'zsetAdd', key: keyName, member: e.member, score: Number(newScore.score) }); setNewScore(null); }}>Save</button><button className="text-xs" onClick={() => setNewScore(null)}>×</button></span>
            : <span className="flex gap-2 items-center"><span className="mono">{e.score}</span>{writable && <button aria-label={`Edit score for ${e.member}`} onClick={() => setNewScore({ member: e.member, score: String(e.score) })}>✎</button>}</span>}
          </td>
          {writable && <td><button aria-label={`Remove ${e.member}`} className="text-[var(--danger)]" disabled={busy} onClick={() => void mutate({ op: 'zsetRemove', key: keyName, members: [e.member] })}>×</button></td>}
        </tr>)}</tbody>
      </table>}
      {v.kind === 'stream' && <div className="space-y-2 text-xs">
        {v.entries.map(e => <div key={e.id} className="border border-[var(--border)] p-2">
          <p className="mono text-[var(--muted)] mb-1">{e.id}</p>
          <table className="w-full"><tbody>{Object.entries(e.fields).map(([f, val]) => <tr key={f}><td className="pr-2 font-mono text-[var(--muted)] align-top">{f}</td><td className="font-mono break-all">{val}</td></tr>)}</tbody></table>
        </div>)}
        <p className="text-[var(--faint)]">Streams are read-only in this view — append with XADD in the console.</p>
      </div>}
      {'truncated' in v && v.truncated && <button disabled={busy} className="mt-2 text-xs text-[var(--accent)]" onClick={() => void load(nextCursor(v))}>
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
  if (a.kind === 'hash' && b.kind === 'hash') return { ...next, value: { ...b, entries: [...a.entries, ...b.entries] } };
  if (a.kind === 'list' && b.kind === 'list') return { ...next, value: { ...b, items: [...a.items, ...b.items], start: a.start } };
  if (a.kind === 'set' && b.kind === 'set') return { ...next, value: { ...b, members: [...a.members, ...b.members] } };
  if (a.kind === 'zset' && b.kind === 'zset') return { ...next, value: { ...b, entries: [...a.entries, ...b.entries] } };
  if (a.kind === 'stream' && b.kind === 'stream') return { ...next, value: { ...b, entries: [...a.entries, ...b.entries] } };
  return next;
}

function HashRow({ entry, busy, onSave, onDelete }: {
  entry: { field: string; value: string }; busy: boolean;
  onSave(value: string): void; onDelete(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <tr className="border-t border-[var(--border)]">
    <td className="py-1 font-mono break-all pr-2">{entry.field}</td>
    <td className="py-1">{draft === null
      ? <span className="flex gap-2 items-center"><span className="font-mono break-all flex-1">{entry.value}</span>{!busy && <button aria-label={`Edit field ${entry.field}`} onClick={() => setDraft(entry.value)}>✎</button>}</span>
      : <span className="flex gap-1"><input autoFocus value={draft} onChange={e => setDraft(e.target.value)} className="flex-1 bg-[var(--bg)] border border-[var(--border)] p-1" /><button className="primary text-xs" disabled={busy} onClick={() => { onSave(draft); setDraft(null); }}>Save</button><button className="text-xs" onClick={() => setDraft(null)}>×</button></span>}
    </td>
    <td>{!busy && <button aria-label={`Delete field ${entry.field}`} className="text-[var(--danger)]" onClick={onDelete}>×</button>}</td>
  </tr>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Plus, RefreshCw, Terminal, Network, Activity, FileCode, KeyRound } from "lucide-react";
import { dbApi, type DbSource } from "./dbApi.ts";
import type { DbSchema, DataSourceInfo } from "../shared.ts";
import { DatabaseCreateViewModal } from "./DatabaseCreateViewModal.tsx";
import { DatabaseOpenModal } from "./DatabaseOpenModal.tsx";
import { ObjectTree, SchemaDiagramPane, InsightsPane, PragmasPane } from "./DatabaseViews.tsx";
import { TableDocument } from "./TableDocument.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { RedisKeyExplorer } from "./RedisKeyExplorer.tsx";
import { RedisKeyView } from "./RedisKeyView.tsx";
import { RedisConsole } from "./RedisConsole.tsx";
import { DatabaseMigrationModal } from "./DatabaseMigrationModal.tsx";
import { tableKey, tableLabel } from "./sqlIdentifiers.ts";
import { sourceId, sourceLabel, isDocuments, type Document } from "./documents.ts";

export function App() {
  const [connections, setConnections] = useState<DbSource[]>([]);
  const [selected, setSelected] = useState<DbSource | null>(null);
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  const [schemas, setSchemas] = useState<Record<string, DbSchema>>({});
  const [infos, setInfos] = useState<Record<string, DataSourceInfo>>({});
  const [states, setStates] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<Document[]>([]);
  const [active, setActive] = useState('');
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const initializedAccess = useRef(new Set<string>());
  const [writable, setWritable] = useState<Record<string, boolean>>({});
  const [accessTarget, setAccessTarget] = useState<DbSource | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const accessDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (accessTarget) accessDialog.current?.showModal(); }, [accessTarget]);
  const [latency, setLatency] = useState(0);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<false | 'sqlite' | 'postgres' | 'redis'>(false);
  const [sidebar, setSidebar] = useState(252);
  const [createView, setCreateView] = useState(false);
  const [help, setHelp] = useState(false);
  const current = tabs.find(t => t.id === active);
  const source = current?.source ?? selected;
  const id = source ? sourceId(source) : '';
  const refreshConnections = async () => {
    const [profiles, sqlite] = await Promise.all([dbApi.connections.list(), dbApi.recent()]);
    const redisDatabase = (url: string) => { try { return decodeURIComponent(new URL(url).pathname.slice(1)) || '0'; } catch { return '0'; } };
    setConnections([
      ...profiles.connections.map(c => c.driver === 'redis'
        ? { kind: 'redis' as const, connId: c.id, database: redisDatabase(c.url), label: c.label, url: c.url, readOnly: c.readOnly, environment: c.environment }
        : { kind: 'postgres' as const, connId: c.id, label: c.label, url: c.url, readOnly: c.readOnly, environment: c.environment }),
      ...sqlite.databases.map(d => ({ kind: 'sqlite' as const, path: d.path })),
    ]);
  };
  const connect = async (source: DbSource) => {
    const key = sourceId(source);
    setStates(s => ({ ...s, [key]: 'Connecting…' }));
    try {
      if (source.kind === 'redis') {
        const { info } = await dbApi.datasource.session(source);
        if (!initializedAccess.current.has(key)) {
          const defaultWritable = source.readOnly === false;
          await dbApi.access(source, defaultWritable);
          initializedAccess.current.add(key);
          setWritable(s => ({ ...s, [key]: defaultWritable }));
        }
        setInfos(s => ({ ...s, [key]: info }));
        setStates(s => ({ ...s, [key]: 'Connected' }));
        return info;
      }
      if (source.kind === 'sqlite') await dbApi.open(source.path);
      const schema = await dbApi.schema(source);
      if (source.kind === "postgres") {
        const result = await dbApi.databases(source);
        setDatabases(s => ({ ...s, [source.connId]: result.databases }));
      }
      if (!initializedAccess.current.has(key)) {
        const defaultWritable = source.kind === 'postgres' && source.readOnly === false;
        await dbApi.access(source, defaultWritable);
        initializedAccess.current.add(key);
        setWritable(s => ({ ...s, [key]: defaultWritable }));
      }
      setSchemas(s => ({ ...s, [key]: schema }));
      setStates(s => ({ ...s, [key]: 'Connected' }));
      return schema;
    } catch (e) { setStates(s => ({ ...s, [key]: 'Disconnected' })); setError(`${sourceLabel(source)}: ${String(e)}`); return null; }
  };
  useEffect(() => {
    void refreshConnections().catch(e => setError(String(e)));
    void dbApi.state.get<unknown>('documents').then(async saved => {
      if (isDocuments(saved)) {
        setTabs(saved.tabs); setActive(saved.active);
        const unique = new Map(saved.tabs.map(d => [sourceId(d.source), d.source]));
        setSelected(saved.tabs.find(d => d.id === saved.active)?.source ?? null);
        await Promise.all([...unique.values()].map(connect));
      }
      setReady(true);
    }).catch(e => setError(String(e)));
    void dbApi.state.get<{ sidebar: number }>('layout').then(value => { if (value?.sidebar) setSidebar(Math.max(180, Math.min(440, value.sidebar))); });
  }, []);
  useEffect(() => { if (ready) void dbApi.state.set('documents', { tabs, active }).catch(e => setError(String(e))); }, [tabs, active, ready]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.values(dirty).some(Boolean)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const open = (kind: Document['kind'], table?: string) => {
    if (!source || (!schemas[id] && !infos[id])) return;
    if (kind !== 'key' && kind !== 'console') {
      const existing = tabs.find(t => t.kind === kind && sourceId(t.source) === id && t.table === table && kind !== 'sql');
      if (existing) { setActive(existing.id); return; }
    }
    const titles = { diagram: 'Relationships', insights: 'Database Insights', migration: 'Migration Studio', settings: 'Database Settings', console: 'Console' } as const;
    const title = kind === 'table' ? tableLabel(schemas[id].tables.find(t => tableKey(t) === table)!)
      : kind === 'sql' ? `Query ${tabs.filter(t => t.kind === 'sql').length + 1}`
      : kind === 'key' ? `Key ${table ?? ''}`
      : titles[kind];
    const doc: Document = { id: crypto.randomUUID(), kind, title, source, table };
    setTabs(prev => [...prev, doc]); setActive(doc.id);
  };
  const close = async (doc: Document) => {
    if (dirty[doc.id]) { setError('Apply or revert pending changes, or wait for SQL to save before closing this document.'); return; }
    if (doc.kind === 'sql' || doc.kind === 'console') {
      try { await dbApi.state.remove(`${doc.kind === 'sql' ? 'sql' : 'redis'}:${doc.id}`); }
      catch (e) { setError(String(e)); return; }
    }
    setTabs(prev => prev.filter(t => t.id !== doc.id));
    if (active === doc.id) setActive(tabs.find(t => t.id !== doc.id)?.id ?? '');
  };
  const retargetKey = (docId: string, newKey: string) => {
    setTabs(prev => prev.map(d => d.id === docId && d.kind === 'key' ? { ...d, table: newKey, title: `Key ${newKey}` } : d));
  };
  const changeAccess = async (target: DbSource, enabled: boolean) => {
    setAccessBusy(true); setError('');
    try {
      await dbApi.access(target, enabled);
      setWritable(s => ({ ...s, [sourceId(target)]: enabled }));
      setAccessTarget(null);
    } catch (e) { setError(String(e)); }
    finally { setAccessBusy(false); }
  };
  const toggleAccess = () => {
    if (!source || accessBusy) return;
    if (writable[id]) void changeAccess(source, false);
    else { setError(''); setAccessTarget(source); }
  };
  const actions = useRef({ open, close, current }); actions.current = { open, close, current };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'n') { e.preventDefault(); actions.current.open(actions.current.current?.source.kind === 'redis' ? 'console' : 'sql'); }
      if (e.key === 'o') { e.preventDefault(); setPicker('sqlite'); }
      if (e.key === 'w' && actions.current.current) { e.preventDefault(); actions.current.close(actions.current.current); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const forget = async (s: DbSource) => {
    const sameSource = (a: DbSource | null | undefined, b: DbSource) => !!a && a.kind === b.kind && (a.kind === 'sqlite' ? a.path === (b as typeof a).path : a.connId === (b as typeof a).connId);
    if (tabs.some(t => sameSource(t.source, s))) { setError('Close this connection’s documents before removing it.'); return; }
    try {
      if (s.kind === 'sqlite') await dbApi.forget(s.path); else await dbApi.connections.delete(s.connId);
      await refreshConnections();
      const removed = (t: DbSource | null) => sameSource(t, s);
      setSelected(prev => removed(prev) ? null : prev);
      const stale = (key: string) => s.kind === 'sqlite' ? key === s.path : key === s.connId || key.startsWith(`${s.connId}/`);
      const prune = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => !stale(key)));
      setDatabases(prune); setSchemas(prune); setInfos(prune); setStates(prune); setWritable(prune);
      [...initializedAccess.current].filter(stale).forEach(key => initializedAccess.current.delete(key));
    } catch (e) { setError(String(e)); }
  };
  return <main className="workbench" onPointerDown={e => { if (!(e.target as Element).closest('.menubar')) e.currentTarget.querySelectorAll<HTMLDetailsElement>('.menubar details[open]').forEach(d => { d.open = false; }); }}>
    <header className="menubar" onClick={e => { const target = (e.target as Element).closest('details'); e.currentTarget.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { if (d !== target || (e.target as Element).closest('button')) d.open = false; }); }}><Database size={15}/><b className="mr-3">Tern</b>
      <details><summary>File</summary><div className="menu"><button onClick={() => setPicker('sqlite')}>Open SQLite… <kbd>⌘O</kbd></button><button onClick={() => setPicker('postgres')}>New PostgreSQL Connection…</button><button onClick={() => setPicker('redis')}>New Redis Connection…</button><button disabled={!source} onClick={() => open(source?.kind === 'redis' ? 'console' : 'sql')}>New {source?.kind === 'redis' ? 'console' : 'SQL'} document <kbd>⌘N</kbd></button></div></details>
      <details><summary>View</summary><div className="menu">{source?.kind === 'redis' ? <button disabled={!source} onClick={() => open('console')}>Command console</button> : <><button disabled={!source} onClick={() => open('diagram')}>Relationships</button><button disabled={!source} onClick={() => open('insights')}>Database Insights</button><button disabled={!source} onClick={() => open('settings')}>Database Settings</button></>}</div></details>
      <details><summary>Database</summary><div className="menu"><button disabled={!source || !writable[id]} onClick={() => setCreateView(true)}>Create view…</button><button disabled={!source} onClick={() => source && void connect(source)}>Refresh catalog</button><button disabled={!source} onClick={() => void toggleAccess()}>Toggle read-only</button></div></details>
      <details><summary>Query</summary><div className="menu"><button disabled={!source} onClick={() => open('sql')}>New query</button><button disabled={!source} onClick={() => open('migration')}>Migration Studio</button></div></details>
      <button onClick={() => setHelp(!help)}>Help</button><span className="ml-auto text-[var(--text-muted)]">Database Workbench</span>
    </header>
    <div className="toolbar main-toolbar"><button aria-label="Refresh catalog" disabled={!source} onClick={() => source && void connect(source)}><RefreshCw size={14}/></button><button disabled={!source} onClick={() => open(source?.kind === 'redis' ? 'console' : 'sql')}>{source?.kind === 'redis' ? <><Terminal size={14}/>Console</> : <><Plus size={14}/>SQL</>}</button><span className="divider"/>
      <button onClick={() => setPicker('postgres')}><Database size={14}/>New connection</button><button onClick={() => setPicker('redis')}><KeyRound size={14}/>New Redis</button><button onClick={() => setPicker('sqlite')}>Open SQLite</button>
      {source?.kind === 'postgres' && <select aria-label="Database" className="bg-[var(--bg)] border border-[var(--border)] p-1" value={source.database ?? decodeURIComponent(new URL(source.url).pathname.slice(1))} onChange={e => { const next = { ...source, database: e.target.value }; setSelected(next); setActive(''); void connect(next); }}>{(databases[source.connId] ?? [decodeURIComponent(new URL(source.url).pathname.slice(1))]).map(name => <option key={name}>{name}</option>)}</select>}
      {source?.kind === 'redis' && <select aria-label="Logical database" className="bg-[var(--bg)] border border-[var(--border)] p-1" value={source.database} onChange={e => { const next = { ...source, database: e.target.value }; setSelected(next); setActive(''); void connect(next); }}>{Array.from({ length: 16 }, (_, i) => String(i)).map(name => <option key={name} value={name}>db {name}</option>)}</select>}
      <span className="ml-auto truncate">{source ? sourceLabel(source) : 'No connection'}</span>{source && source.kind !== 'sqlite' && <span className={source.environment === 'production' ? 'production' : 'environment'}>{source.environment}</span>}
      <button disabled={!source} className={writable[id] ? 'production' : 'text-[var(--text-muted)]'} onClick={() => void toggleAccess()}>{writable[id] ? '● Writable' : 'Read Only'}</button>
    </div>
    {error && <div role="alert" className="error flex">{error}<button aria-label="Dismiss error" className="ml-auto" onClick={() => setError('')}>×</button></div>}
    {help && <div className="toolbar">⌘/Ctrl+O Open SQLite · ⌘/Ctrl+N New SQL · ⌘/Ctrl+W Close document · ⌘/Ctrl+Enter Run statement · Shift+⌘/Ctrl+Enter Run all<button className="ml-auto" onClick={() => setHelp(false)}>Close</button></div>}
    <div className="workbench-center">
      <aside className="explorer" style={{ width: sidebar }}><div className="explorer-title">CONNECTIONS<button aria-label="Add connection" onClick={() => setPicker('postgres')}>+</button></div>
        <div className="connections-list">{connections.map(s => <div key={sourceId(s)} className="connection-row"><button className={id === sourceId(s) ? 'selected' : ''} title={s.kind === 'sqlite' ? s.path : s.url} onClick={() => { setSelected(s); setActive(''); void connect(s); }}><Database size={13}/><span className="truncate">{sourceLabel(s)}</span><span className="connection-state">{states[sourceId(s)] === 'Connected' ? '●' : '○'}</span></button><button aria-label={`Remove ${sourceLabel(s)}`} onClick={() => void forget(s)}>×</button></div>)}</div>
        {source && <><div className="explorer-title database-title">{source.kind === 'sqlite' ? sourceLabel(source) : source.kind === 'redis' ? `db ${source.database}` : (source.database ?? decodeURIComponent(new URL(source.url).pathname.slice(1)))}<span>{states[id]}</span></div>
          {source.kind === 'redis'
            ? <RedisKeyExplorer source={source} info={infos[id] ?? null} activeKey={current?.kind === 'key' ? current.table ?? null : null} onOpenKey={key => open('key', key)} onChanged={() => void connect(source)} />
            : <ObjectTree schema={schemas[id] ?? null} activeTable={current?.table ?? null} onSelect={table => open('table', table)} locked={false}/>}</>}
        {!connections.length && <p className="p-3 text-[var(--text-muted)]">Open a SQLite file, add a PostgreSQL connection, or connect to Redis to begin.</p>}
      </aside>
      <div role="separator" aria-label="Resize explorer" aria-orientation="vertical" tabIndex={0} className="resize-handle" onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const width = Math.max(180, Math.min(440, sidebar + (e.key === 'ArrowLeft' ? -10 : 10))); setSidebar(width); void dbApi.state.set('layout', { sidebar: width }); } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebar(Math.max(180, Math.min(440, e.clientX))); }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); void dbApi.state.set('layout', { sidebar }); }}/>
      <section className="document-area">
        <div className="document-tabs" role="tablist">{tabs.map(doc => <div key={doc.id} className={`document-tab ${doc.id === active ? 'selected' : ''}`}><button role="tab" aria-selected={doc.id === active} title={`${doc.title} — ${sourceLabel(doc.source)}`} onClick={() => { setActive(doc.id); setSelected(doc.source); }}>{doc.kind === 'sql' ? <Terminal size={13}/> : doc.kind === 'diagram' ? <Network size={13}/> : doc.kind === 'insights' ? <Activity size={13}/> : <FileCode size={13}/>} {doc.title}{dirty[doc.id] && ' ●'}</button><button aria-label={`Close ${doc.title}`} onClick={() => close(doc)}>×</button></div>)}<button aria-label="New SQL document" disabled={!source} onClick={() => open('sql')}>+</button></div>
        {!current && <div className="welcome"><Database size={32}/><h1>Tern</h1><p>SQLite · PostgreSQL · Redis / Valkey workbench</p><div className="welcome-actions"><button onClick={() => setPicker('sqlite')}>Open SQLite database <kbd>⌘O</kbd></button><button onClick={() => setPicker('postgres')}>New PostgreSQL connection</button><button onClick={() => setPicker('redis')}>New Redis connection</button>{source && <><button onClick={() => open(source.kind === 'redis' ? 'console' : 'sql')}>New {source.kind === 'redis' ? 'console' : 'SQL'} document <kbd>⌘N</kbd></button><button onClick={() => open('diagram')}>Relationships</button><button onClick={() => open('insights')}>Database Insights</button><button onClick={() => open('migration')}>Migration Studio</button></>}</div><p className="text-[var(--text-muted)]">Select a connection, then open objects from the explorer.</p></div>}
        {tabs.map(doc => <DocumentView key={doc.id} doc={doc} visible={doc.id === active} schema={schemas[sourceId(doc.source)]} info={infos[sourceId(doc.source)]} writable={!!writable[sourceId(doc.source)]} onDirty={setDirty} onLatency={setLatency} onRefresh={() => void connect(doc.source)} onRetargetKey={retargetKey} />)}
      </section>
    </div>
    {accessTarget && <dialog ref={accessDialog} aria-labelledby="access-title" className="connection-dialog" onCancel={event => { if (accessBusy) event.preventDefault(); else setAccessTarget(null); }}>
      <form onSubmit={event => { event.preventDefault(); void changeAccess(accessTarget, true); }}>
        <header className="toolbar"><b id="access-title">Enable writes?</b></header>
        <div className="form-fields">
          <p>Allow changes to {sourceLabel(accessTarget)}?</p>
          {accessTarget.kind === 'postgres' && accessTarget.environment === 'production' && <p className="error">This is a PRODUCTION connection.</p>}
          <p>Row changes still require review and Apply transaction.</p>
          {error && <div role="alert" className="error">{error}</div>}
        </div>
        <footer className="toolbar justify-end">
          <button type="button" autoFocus disabled={accessBusy} onClick={() => setAccessTarget(null)}>Cancel</button>
          <button className="primary" disabled={accessBusy}>{accessBusy ? 'Enabling…' : 'Enable writes'}</button>
        </footer>
      </form>
    </dialog>}
    <footer className="statusbar"><span>{source?.kind === 'redis' ? `${infos[id]?.flavor === 'valkey' ? 'Valkey' : 'Redis'} ${infos[id]?.version ?? ''}` : source?.kind === 'postgres' ? `PostgreSQL ${schemas[id]?.pragmas.server_version ?? ''}` : source ? `SQLite ${schemas[id]?.pragmas.sqlite_version ?? ''}` : 'Tern'}</span><span>{source?.kind === 'sqlite' ? source.path : source ? new URL(source.url).host : 'No database open'}</span><span>{source?.kind === "postgres" ? source.database ?? decodeURIComponent(new URL(source.url).pathname.slice(1)) : source?.kind === "redis" ? `db ${source.database}` : ""}</span><span className="ml-auto">{states[id] ?? 'Ready'}</span><span className={writable[id] ? 'production' : ''}>{writable[id] ? 'Writable' : 'Read Only'}</span><span>{latency.toFixed(1)} ms</span></footer>
    {createView && source && <DatabaseCreateViewModal source={source} onClose={() => setCreateView(false)} onCreated={() => void connect(source)}/>}
    {picker && <DatabaseOpenModal initial={picker} onClose={() => setPicker(false)} onOpen={s => { setPicker(false); setSelected(s); setActive(''); void connect(s); void refreshConnections(); }}/ >}
  </main>;
}

function DocumentView({ doc, visible, schema, info, writable, onDirty, onLatency, onRefresh, onRetargetKey }: {
  doc: Document; visible: boolean; schema?: DbSchema; info?: DataSourceInfo; writable: boolean;
  onDirty: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; onLatency: (ms: number) => void; onRefresh: () => void;
  onRetargetKey(docId: string, newKey: string): void;
}) {
  const dirty = useCallback((value: boolean) => onDirty(s => s[doc.id] === value ? s : { ...s, [doc.id]: value }), [doc.id, onDirty]);
  const table = schema?.tables.find(t => tableKey(t) === doc.table);
  if (doc.source.kind === 'redis') {
    return <div role="tabpanel" className={visible ? 'document-body' : 'hidden'}>
      {doc.kind === 'key' && (doc.table ? <RedisKeyView source={doc.source} keyName={doc.table} writable={writable} onChanged={onRefresh} onRenamed={newKey => onRetargetKey(doc.id, newKey)}/> : <div className="p-4">No key selected.</div>)}
      {doc.kind === 'console' && <RedisConsole docId={doc.id} source={doc.source} info={info ?? null} writable={writable} onDirty={dirty} onLatency={onLatency}/>}
      {doc.kind !== 'key' && doc.kind !== 'console' && <div className="p-4 text-[var(--text-muted)]">This document type is not available for Redis connections.</div>}
    </div>;
  }
  return <div role="tabpanel" className={visible ? 'document-body' : 'hidden'}>
    {!schema ? <div className="p-4 text-[var(--text-muted)]">Connection unavailable. Reconnect using the explorer.</div> : <>
      {doc.kind === 'table' && (table ? <TableDocument table={table} schema={schema} source={doc.source} writable={writable} onDirty={dirty} onLatency={onLatency}/> : <div className="p-4">This object no longer exists.</div>)}
      {doc.kind === 'sql' && <SqlEditor documentId={doc.id} source={doc.source} schema={schema} writable={writable} onExeced={onRefresh} onDirty={dirty} onLatency={onLatency}/>}
      {doc.kind === 'diagram' && <SchemaDiagramPane schema={schema}/>}
      {doc.kind === 'insights' && <InsightsPane source={doc.source}/>}
      {doc.kind === 'settings' && <PragmasPane pragmas={schema.pragmas}/>}
      {doc.kind === 'migration' && <DatabaseMigrationModal source={doc.source} writable={writable} onDirty={dirty} onClose={() => {}} onApplied={onRefresh}/>}
    </>}
  </div>;
}

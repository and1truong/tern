import { SchemaPicker } from "./SchemaPicker.tsx";
import { filterSchemaCatalog, isSystemSchema, querySchemaLabel, readSchemaPreferences, schemaPreferenceKey, type SchemaPreference } from "./schemaContext.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Plus, RefreshCw, Terminal, Network, Activity, FileCode, KeyRound } from "lucide-react";
import { dbApi, type DbSource } from "./dbApi.ts";
import type { DbSchema, DataSourceInfo } from "../shared/types.ts";
import { DatabaseCreateViewModal } from "./DatabaseCreateViewModal.tsx";
import { DatabaseOpenModal } from "./DatabaseOpenModal.tsx";
import { ObjectTree } from "./ObjectTree.tsx";
import { SchemaDiagramPane } from "./SchemaDiagramPane.tsx";
import { InsightsPane } from "./InsightsPane.tsx";
import { PragmasPane } from "./PragmasPane.tsx";
import { TableDocument } from "./TableDocument.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { RedisKeyExplorer } from "./RedisKeyExplorer.tsx";
import { RedisKeyView } from "./RedisKeyView.tsx";
import { RedisConsole } from "./RedisConsole.tsx";
import { DatabaseMigrationModal } from "./DatabaseMigrationModal.tsx";
import { tableKey, tableLabel } from "../shared/sqlIdentifiers.ts";
import { sourceId, sourceLabel, isDocuments, isDocument, type Document } from "./documents.ts";
import { anyDialogOpen } from "./gridDialogs.tsx";

// Stored URLs can be malformed (hand-edited state); never let a URL parse
// throw during render.
const urlPathName = (url: string) => { try { return decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return ''; } };
const urlHost = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function App() {
  const preferences = useRef<Record<string, SchemaPreference>>({});
  const catalogRequests = useRef(new Map<string, number>());
  const systemCatalogs = useRef(new Set<string>());
  const [preferenceVersion, setPreferenceVersion] = useState(0);
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
  // close() reads this ref, not the render-time map: setState is async, so a
  // dirty flag set and a close() inside the same task would otherwise miss
  // the flag and silently discard unsaved console/SQL state.
  const dirtyRef = useRef<Record<string, boolean>>({});
  const syncDirty = (updater: React.SetStateAction<Record<string, boolean>>) => {
    // Resolve against the ref synchronously — assigning inside the setState
    // updater would only land at commit time, re-opening the close() race
    // the ref exists to close.
    const next = typeof updater === 'function' ? updater(dirtyRef.current) : updater;
    dirtyRef.current = next;
    setDirty(next);
  };
  const [writable, setWritable] = useState<Record<string, boolean>>({});
  // The ref is authoritative user intent — changeAccess writes it
  // synchronously so a racing connect() re-assert sees pending toggles.
  // (It must NOT be synced from render-time `writable`: that would clobber
  // the intent before the POST resolves.)
  const writableRef = useRef<Record<string, boolean>>({});
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
  // connect() reads profiles through a ref so startup restores don't race a
  // still-empty `connections` render snapshot.
  const connectionsRef = useRef<DbSource[]>([]);
  // sqlite paths removed while a connect() was still in flight — /open
  // re-adds to recent_files, so connect() re-forgets when it lands.
  const forgotten = useRef(new Set<string>());
  const refreshConnections = async () => {
    const [profiles, sqlite] = await Promise.all([dbApi.connections.list(), dbApi.recent()]);
    const redisDatabase = (url: string) => urlPathName(url) || '0';
    connectionsRef.current = [
      ...profiles.connections.map(c => c.driver === 'redis'
        ? { kind: 'redis' as const, connId: c.id, database: redisDatabase(c.url), label: c.label, url: c.url, readOnly: c.readOnly, environment: c.environment }
        : { kind: 'postgres' as const, connId: c.id, label: c.label, url: c.url, readOnly: c.readOnly, environment: c.environment }),
      ...sqlite.databases.map(d => ({ kind: 'sqlite' as const, path: d.path })),
    ];
    setConnections(connectionsRef.current);
  };
  const connect = async (source: DbSource, includeSystem = false) => {
    const key = sourceId(source);
    const request = (catalogRequests.current.get(key) ?? 0) + 1;
    catalogRequests.current.set(key, request);
    setStates(s => ({ ...s, [key]: 'Connecting…' }));
    try {
      // The live profile's readOnly is authoritative — a persisted document's
      // copy can be stale or hand-edited, so it must not grant writable
      // access on its own.
      const profileWritable = source.kind !== 'sqlite'
        && connectionsRef.current.find((c): c is Extract<DbSource, { connId: string }> => 'connId' in c && c.kind === source.kind && c.connId === source.connId)?.readOnly === false;
      if (source.kind === 'redis') {
        const { info } = await dbApi.datasource.session(source);
        // Re-assert the access flag on every connect — a server restart drops
        // the server-side session flags while the UI still shows them.
        // The thunk re-reads intent at dispatch, and the server's echo is
        // authoritative for the badge — a racing toggle that later fails and
        // rolls back must not leave the UI claiming writable.
        const { writable: actual } = await dbApi.access(source, () => writableRef.current[key] ?? profileWritable);
        setWritable(s => ({ ...s, [key]: actual }));
        setInfos(s => ({ ...s, [key]: info }));
        setStates(s => ({ ...s, [key]: 'Connected' }));
        return info;
      }
      if (source.kind === 'sqlite') {
        await dbApi.open(source.path);
        // A forget() issued while this connect was in flight must stick —
        // /open re-inserts into recent_files, so drop it again.
        if (forgotten.current.has(source.path)) { void dbApi.forget(source.path).catch(() => {}); setStates(s => ({ ...s, [key]: 'Disconnected' })); return null; }
      }
      if (includeSystem || (source.kind === 'postgres' && source.schema && isSystemSchema(source.schema))) systemCatalogs.current.add(key);
      const schema = await dbApi.schema(source, systemCatalogs.current.has(key));
      if (source.kind === "postgres") {
        const result = await dbApi.databases(source);
        setDatabases(s => ({ ...s, [source.connId]: result.databases }));
      }
      // Re-assert the user's flag for sqlite too — the server-side session
      // flag drops on reconnect while the UI still shows Writable. The
      // thunk re-reads intent at dispatch: if this request sat queued behind
      // an explicit toggle that then failed and rolled back, sending the
      // stale flag would leave the server writable under a read-only UI.
      const { writable: actual } = await dbApi.access(source, () => writableRef.current[key] ?? profileWritable);
      setWritable(s => ({ ...s, [key]: actual }));
      if (catalogRequests.current.get(key) !== request) return schema;
      setSchemas(s => ({ ...s, [key]: schema }));
      setStates(s => ({ ...s, [key]: 'Connected' }));
      return schema;
    } catch (e) {
      if (catalogRequests.current.get(key) !== request) return null;
      setStates(s => ({ ...s, [key]: 'Disconnected' }));
      // A failed reconnect must not keep the Writable badge of a previous
      // session — the flag is only meaningful while connected.
      setWritable(s => ({ ...s, [key]: false }));
      setError(`${sourceLabel(source)}: ${String(e)}`);
      return null;
    }
  };
  useEffect(() => {
    const connectionsReady = refreshConnections().catch(e => setError(String(e)));
    void dbApi.state.get<unknown>('schemaPreferences').then(value => {
      preferences.current = readSchemaPreferences(value);
      setPreferenceVersion(v => v + 1);
      return dbApi.state.get<unknown>('documents');
    }).then(async saved => {
      if (isDocuments(saved)) {
        // One malformed persisted doc must not discard the whole saved tab
        // set — drop it, and repair `active` if it pointed at a dropped tab.
        const restored = saved.tabs.filter(isDocument);
        setTabs(restored);
        setActive(restored.some(t => t.id === saved.active) ? saved.active : restored[0]?.id ?? '');
        for (const doc of restored) if (doc.source.kind === 'postgres' && doc.source.schema && isSystemSchema(doc.source.schema)) systemCatalogs.current.add(sourceId(doc.source));
        const unique = new Map(restored.map(d => [sourceId(d.source), d.source]));
        setSelected(restored.find(d => d.id === saved.active)?.source ?? null);
        // Profiles must be loaded before connect() reads their readOnly flag.
        await connectionsReady;
        await Promise.all([...unique.values()].map(s => connect(s, s.kind === "postgres" && preferences.current[schemaPreferenceKey(s)]?.showSystem)));
      }
      // Only mark ready after a successful fetch — a failed restore must not
      // let the persist effect overwrite saved documents with the empty state.
      setReady(true);
    }).catch(e => setError(String(e)));
    void dbApi.state.get<{ sidebar: number }>('layout').then(value => { if (typeof value?.sidebar === 'number') setSidebar(Math.max(180, Math.min(440, value.sidebar))); }).catch(() => {});
  }, []);
  useEffect(() => { if (ready) void dbApi.state.set('schemaPreferences', preferences.current).catch(e => setError(String(e))); }, [preferenceVersion, ready]);
  useEffect(() => { if (ready) void dbApi.state.set('documents', { tabs, active }).catch(e => setError(String(e))); }, [tabs, active, ready]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.values(dirty).some(Boolean)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const selectSource = (next: DbSource) => {
    if (next.kind === 'postgres') {
      const pref = preferences.current[schemaPreferenceKey(next)];
      next = { ...next, schema: pref?.schema };
      setSelected(next); setActive('');
      void connect(next, pref?.showSystem);
    } else { setSelected(next); setActive(''); void connect(next); }
  };
  const schemaPreference = source?.kind === 'postgres' ? preferences.current[schemaPreferenceKey(source)] : undefined;
  const showSystem = schemaPreference?.showSystem ?? false;
  const selectSchema = (schema: string | undefined, system = showSystem) => {
    if (source?.kind !== 'postgres') return;
    preferences.current = { ...preferences.current, [schemaPreferenceKey(source)]: { schema, showSystem: system } };
    setPreferenceVersion(v => v + 1);
    // The selector controls the next document. Existing documents keep their source.
    const next = { ...source, schema };
    setSelected(next); setActive('');
    if (system && !systemCatalogs.current.has(id)) void connect(next, true);
  };
  const open = (kind: Document['kind'], table?: string) => {
    if (!source || (!schemas[id] && !infos[id])) return;
    // Redis connections only support key/console documents — anything else
    // would render an unusable stub.
    if (source.kind === 'redis' ? kind !== 'key' && kind !== 'console' : kind === 'key' || kind === 'console') return;
    // SQL and console docs carry per-doc state (title, history) so each open
    // is its own document; every other kind focuses the existing tab.
    // A migration doc is also pinned to its schema — a preview under one
    // search_path must not be reused as another schema's document.
    if (kind !== 'sql' && kind !== 'console') {
      const existing = tabs.find(t => t.kind === kind && sourceId(t.source) === id && t.table === table
        && (kind !== 'migration' || (t.source.kind === 'postgres' ? t.source.schema : undefined) === (source.kind === 'postgres' ? source.schema : undefined)));
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
    if (dirtyRef.current[doc.id] ?? dirty[doc.id]) { setError('Apply or revert pending changes, or wait for SQL to save before closing this document.'); return; }
    if (doc.kind === 'sql' || doc.kind === 'console') {
      try { await dbApi.state.remove(`${doc.kind === 'sql' ? 'sql' : 'redis'}:${doc.id}`); }
      catch (e) { setError(String(e)); return; }
    }
    // The doc's dirty entries die with it — a stale `true` would keep the
    // beforeunload guard warning forever.
    delete dirtyRef.current[doc.id];
    setDirty(s => { const next = { ...s }; delete next[doc.id]; return next; });
    // The next active tab is picked from the filtered list — reading the
    // render-time `tabs`/`active` can leave `active` pointing at a removed
    // doc when two closes race.
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== doc.id);
      setActive(a => remaining.some(t => t.id === a) ? a : remaining[0]?.id ?? '');
      return remaining;
    });
  };
  const retargetKey = (docId: string, newKey: string) => {
    // The merge target must be found in the CURRENT tab list — the doc may
    // have been closed (or opened) while the rename was in flight.
    setTabs(prev => {
      const renamed = prev.find(d => d.id === docId);
      const existing = renamed && prev.find(d => d.id !== docId && d.kind === 'key' && d.table === newKey && sourceId(d.source) === sourceId(renamed.source));
      if (existing) {
        // Only follow the merge when the renamed doc was active — the op is
        // async, so an unconditional activate would yank focus from a tab the
        // user switched to while the rename was in flight.
        setActive(a => a === docId ? existing.id : a);
        return prev.filter(d => d.id !== docId);
      }
      return prev.map(d => d.id === docId && d.kind === 'key' ? { ...d, table: newKey, title: `Key ${newKey}` } : d);
    });
  };
  // Info-only refresh: key ops mutate the summary (totalKeys etc.) but do not
  // warrant a full reconnect — that would flash the explorer/statusbar.
  const refreshInfo = async (target: DbSource) => {
    if (target.kind !== 'redis') return;
    try {
      const { info } = await dbApi.datasource.session(target);
      setInfos(s => ({ ...s, [sourceId(target)]: info }));
    } catch { /* badge refresh is best-effort */ }
  };
  // Key-view mutations (rename/delete/expire) change the set the explorer
  // lists — bump its reload tick alongside the info refresh, or stale keys
  // linger until a manual refresh.
  const [explorerTick, setExplorerTick] = useState(0);
  const keyChanged = (target: DbSource) => { void refreshInfo(target); setExplorerTick(t => t + 1); };
  const changeAccess = async (target: DbSource, enabled: boolean) => {
    setAccessBusy(true); setError('');
    const key = sourceId(target);
    // Record intent synchronously — a connect() re-assert racing the toggle
    // must see the pending flag, not the last committed one, or its POST
    // lands last and desyncs the server flag from the UI.
    const prev = writableRef.current[key];
    writableRef.current = { ...writableRef.current, [key]: enabled };
    try {
      // The server's flag is authoritative — a timeout can fire after the
      // server applied the change, and echoing the request would desync.
      const { writable: actual } = await dbApi.access(target, enabled);
      writableRef.current = { ...writableRef.current, [key]: actual };
      setWritable(s => ({ ...s, [key]: actual }));
      setAccessTarget(null);
    } catch (e) {
      const next = { ...writableRef.current };
      if (prev === undefined) delete next[key]; else next[key] = prev;
      writableRef.current = next;
      setError(String(e));
    }
    finally { setAccessBusy(false); }
  };
  const toggleAccess = () => {
    if (!source || accessBusy) return;
    if (writable[id]) void changeAccess(source, false);
    else { setError(''); setAccessTarget(source); }
  };
  const actions = useRef({ open, close, current, source, modal: false });
  actions.current = { open, close, current, source, modal: !!accessTarget || !!picker || createView };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // A modal dialog owns the keyboard — global shortcuts must not mutate
      // documents behind it. anyDialogOpen covers the in-document grid
      // dialogs, which mount without re-rendering this component.
      if (actions.current.modal || anyDialogOpen()) return;
      if (e.key === 'n') { e.preventDefault(); actions.current.open(actions.current.source?.kind === 'redis' ? 'console' : 'sql'); }
      if (e.key === 'o') { e.preventDefault(); setPicker('sqlite'); }
      if (e.key === 'w' && actions.current.current) { e.preventDefault(); actions.current.close(actions.current.current); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const forget = async (s: DbSource) => {
    const sameSource = (a: DbSource | null | undefined, b: DbSource) => !!a && a.kind === b.kind && (a.kind === 'sqlite' ? a.path === (b as typeof a).path : a.connId === (b as typeof a).connId);
    if (tabs.some(t => sameSource(t.source, s))) { setError('Close this connection’s documents before removing it.'); return; }
    try {
      if (s.kind === 'sqlite') { forgotten.current.add(s.path); await dbApi.forget(s.path); }
      else await dbApi.connections.delete(s.connId);
      await refreshConnections();
      const removed = (t: DbSource | null) => sameSource(t, s);
      setSelected(prev => removed(prev) ? null : prev);
      const stale = (key: string) => s.kind === 'sqlite' ? key === s.path : key === s.connId || key.startsWith(`${s.connId}/`);
      const prune = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => !stale(key)));
      setDatabases(prune); setSchemas(prune); setInfos(prune); setStates(prune); setWritable(prune);
      writableRef.current = prune(writableRef.current);
      systemCatalogs.current = new Set([...systemCatalogs.current].filter(key => !stale(key)));
      for (const key of catalogRequests.current.keys()) if (stale(key)) catalogRequests.current.delete(key);
      if (s.kind === 'postgres') { preferences.current = Object.fromEntries(Object.entries(preferences.current).filter(([key]) => (JSON.parse(key) as string[])[0] !== s.connId)); setPreferenceVersion(v => v + 1); }
    } catch (e) { setError(String(e)); }
  };
  return <main className="workbench" onPointerDown={e => { if (!(e.target as Element).closest('.menubar')) e.currentTarget.querySelectorAll<HTMLDetailsElement>('.menubar details[open]').forEach(d => { d.open = false; }); }}>
    <header className="menubar" onClick={e => { const target = (e.target as Element).closest('details'); e.currentTarget.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { if (d !== target || (e.target as Element).closest('button')) d.open = false; }); }}><Database size={15}/><b className="mr-3">Tern</b>
      <details><summary>File</summary><div className="menu"><button onClick={() => setPicker('sqlite')}>Open SQLite… <kbd>⌘O</kbd></button><button onClick={() => setPicker('postgres')}>New PostgreSQL Connection…</button><button onClick={() => setPicker('redis')}>New Redis Connection…</button><button disabled={!source} onClick={() => open(source?.kind === 'redis' ? 'console' : 'sql')}>New {source?.kind === 'redis' ? 'console' : 'SQL'} document <kbd>⌘N</kbd></button></div></details>
      <details><summary>View</summary><div className="menu">{source?.kind === 'redis' ? <button disabled={!source} onClick={() => open('console')}>Command console</button> : <><button disabled={!source} onClick={() => open('diagram')}>Relationships</button><button disabled={!source} onClick={() => open('insights')}>Database Insights</button><button disabled={!source} onClick={() => open('settings')}>Database Settings</button></>}</div></details>
      <details><summary>Database</summary><div className="menu"><button disabled={!source || source.kind === 'redis' || !writable[id]} onClick={() => setCreateView(true)}>Create view…</button><button disabled={!source} onClick={() => source && void connect(source)}>Refresh catalog</button><button disabled={!source} onClick={() => void toggleAccess()}>Toggle read-only</button></div></details>
      <details><summary>Query</summary><div className="menu"><button disabled={!source || source.kind === 'redis'} onClick={() => open('sql')}>New query</button><button disabled={!source || source.kind === 'redis'} onClick={() => open('migration')}>Migration Studio</button></div></details>
      <button onClick={() => setHelp(!help)}>Help</button><span className="ml-auto text-[var(--text-muted)]">Database Workbench</span>
    </header>
    <div className="toolbar main-toolbar"><button aria-label="Refresh catalog" disabled={!source} onClick={() => source && void connect(source)}><RefreshCw size={14}/></button><button disabled={!source} onClick={() => open(source?.kind === 'redis' ? 'console' : 'sql')}>{source?.kind === 'redis' ? <><Terminal size={14}/>Console</> : <><Plus size={14}/>SQL</>}</button><span className="divider"/>
      <button onClick={() => setPicker('postgres')}><Database size={14}/>New connection</button><button onClick={() => setPicker('redis')}><KeyRound size={14}/>New Redis</button><button onClick={() => setPicker('sqlite')}>Open SQLite</button>
      {source?.kind === 'postgres' && <select aria-label="Database" className="bg-[var(--bg)] border border-[var(--border)] p-1" value={source.database ?? urlPathName(source.url)} onChange={e => selectSource({ ...source, database: e.target.value, schema: undefined })}>{(databases[source.connId] ?? [urlPathName(source.url)]).map(name => <option key={name}>{name}</option>)}</select>}
      {source?.kind === 'postgres' && <SchemaPicker key={id} schemas={schemas[id]?.schemas ?? []} selected={source.schema}
        showSystem={showSystem} loading={states[id] === 'Connecting…'} onSelect={schema => selectSchema(schema)}
        onShowSystem={show => selectSchema(source.schema, show)} onRefresh={() => void connect(source, showSystem)} />}
      {/* Cluster mode has a single logical db — the selector only applies */}
      {/* to standalone connections (db count isn't in the capability set, */}
      {/* so the list stays at the conventional 16). */}
      {source?.kind === 'redis' && !infos[id]?.capabilities?.cluster && <select aria-label="Logical database" className="bg-[var(--bg)] border border-[var(--border)] p-1" value={source.database} onChange={e => { const next = { ...source, database: e.target.value }; setSelected(next); setActive(''); void connect(next); }}>{Array.from({ length: 16 }, (_, i) => String(i)).map(name => <option key={name} value={name}>db {name}</option>)}</select>}
      <span className="ml-auto truncate">{source ? sourceLabel(source) : 'No connection'}</span>{source && source.kind !== 'sqlite' && <span className={source.environment === 'production' ? 'production' : 'environment'}>{source.environment}</span>}
      <button disabled={!source} className={writable[id] ? 'production' : 'text-[var(--text-muted)]'} onClick={() => void toggleAccess()}>{writable[id] ? '● Writable' : 'Read Only'}</button>
    </div>
    {error && <div role="alert" className="error flex">{error}<button aria-label="Dismiss error" className="ml-auto" onClick={() => setError('')}>×</button></div>}
    {help && <div className="toolbar">⌘/Ctrl+O Open SQLite · ⌘/Ctrl+N New SQL · ⌘/Ctrl+W Close document · ⌘/Ctrl+Enter Run statement · Shift+⌘/Ctrl+Enter Run all<button className="ml-auto" onClick={() => setHelp(false)}>Close</button></div>}
    <div className="workbench-center">
      <aside className="explorer" style={{ width: sidebar }}><div className="explorer-title">CONNECTIONS<button aria-label="Add connection" onClick={() => setPicker('postgres')}>+</button></div>
        <div className="connections-list">{connections.map(s => <div key={sourceId(s)} className="connection-row"><button className={id === sourceId(s) ? 'selected' : ''} title={s.kind === 'sqlite' ? s.path : s.url} disabled={!ready} onClick={() => { if (s.kind === 'sqlite') forgotten.current.delete(s.path); selectSource(s); }}><Database size={13}/><span className="truncate">{sourceLabel(s)}</span><span className="connection-state">{states[sourceId(s)] === 'Connected' ? '●' : '○'}</span></button><button aria-label={`Remove ${sourceLabel(s)}`} onClick={() => void forget(s)}>×</button></div>)}</div>
        {source && <><div className="explorer-title database-title">{source.kind === 'sqlite' ? sourceLabel(source) : source.kind === 'redis' ? `db ${source.database}` : (source.database ?? urlPathName(source.url))}<span>{states[id]}</span></div>
          {source.kind === 'redis'
            ? <RedisKeyExplorer source={source} info={infos[id] ?? null} writable={!!writable[id]} reloadTick={explorerTick} activeKey={current?.kind === 'key' ? current.table ?? null : null} onOpenKey={key => open('key', key)} onRenamedKey={(src, from, to) => {
              // The explorer's own source identifies the docs — the selected
              // source may have switched while the rename was in flight.
              const sid = sourceId(src);
              // The merge target must be found in the CURRENT tab list — it
              // may have been closed (or opened) while the rename was in
              // flight.
              setTabs(prev => {
                const existing = prev.find(d => d.kind === 'key' && d.table === to && sourceId(d.source) === sid);
                // Only follow the merge when a renamed doc was active — a
                // rename from the explorer must not steal an unrelated tab's
                // focus (and a merged-away active doc must not leave `active`
                // pointing at a removed id).
                setActive(a => existing && prev.some(d => d.id === a && d.kind === 'key' && d.table === from && sourceId(d.source) === sid) ? existing.id : a);
                return prev.flatMap(d => d.kind === 'key' && d.table === from && sourceId(d.source) === sid ? (existing ? [] : [{ ...d, table: to, title: `Key ${to}` }]) : [d]);
              });
            }} onChanged={() => void refreshInfo(source)} />
            : <ObjectTree key={id} schema={schemas[id] && source.kind === 'postgres' ? filterSchemaCatalog(schemas[id], source.schema, showSystem) : schemas[id] ?? null} activeTable={current?.table ?? null} onSelect={table => open('table', table)} locked={false}/>}</>}
        {!connections.length && <p className="p-3 text-[var(--text-muted)]">Open a SQLite file, add a PostgreSQL connection, or connect to Redis to begin.</p>}
      </aside>
      <div role="separator" aria-label="Resize explorer" aria-orientation="vertical" tabIndex={0} className="resize-handle" onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const width = Math.max(180, Math.min(440, sidebar + (e.key === 'ArrowLeft' ? -10 : 10))); setSidebar(width); void dbApi.state.set('layout', { sidebar: width }).catch(() => {}); } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebar(Math.max(180, Math.min(440, e.clientX))); }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); void dbApi.state.set('layout', { sidebar }).catch(() => {}); }}/>
      <section className="document-area">
        <div className="document-tabs" role="tablist">{tabs.map(doc => <div key={doc.id} className={`document-tab ${doc.id === active ? 'selected' : ''}`}><button role="tab" aria-selected={doc.id === active} title={`${doc.title} — ${sourceLabel(doc.source)}`} onClick={() => { setActive(doc.id); setSelected(doc.source); }}>{doc.kind === 'sql' ? <Terminal size={13}/> : doc.kind === 'diagram' ? <Network size={13}/> : doc.kind === 'insights' ? <Activity size={13}/> : <FileCode size={13}/>} {doc.title}{dirty[doc.id] && ' ●'}</button><button aria-label={`Close ${doc.title}`} onClick={() => close(doc)}>×</button></div>)}<button aria-label="New document" disabled={!source} onClick={() => open(source?.kind === 'redis' ? 'console' : 'sql')}>+</button></div>
        {!current && <div className="welcome"><Database size={32}/><h1>Tern</h1><p>SQLite · PostgreSQL · Redis / Valkey workbench</p><div className="welcome-actions"><button onClick={() => setPicker('sqlite')}>Open SQLite database <kbd>⌘O</kbd></button><button onClick={() => setPicker('postgres')}>New PostgreSQL connection</button><button onClick={() => setPicker('redis')}>New Redis connection</button>{source && <>{source.kind === 'postgres' && <p>Query schema: {querySchemaLabel(source)}</p>}<button onClick={() => open(source.kind === 'redis' ? 'console' : 'sql')}>New {source.kind === 'redis' ? 'console' : 'SQL'} document <kbd>⌘N</kbd></button>{source.kind !== 'redis' && <><button onClick={() => open('diagram')}>Relationships</button><button onClick={() => open('insights')}>Database Insights</button><button onClick={() => open('migration')}>Migration Studio</button></>}</>}</div><p className="text-[var(--text-muted)]">Select a connection, then open objects from the explorer.</p></div>}
        {tabs.map(doc => <DocumentView key={doc.id} doc={doc} visible={doc.id === active} schema={schemas[sourceId(doc.source)]} info={infos[sourceId(doc.source)]} writable={!!writable[sourceId(doc.source)]} onDirty={syncDirty} onLatency={setLatency} onRefresh={doc.source.kind === 'redis' ? () => keyChanged(doc.source) : () => void connect(doc.source)} onRetargetKey={retargetKey} />)}
      </section>
    </div>
    {accessTarget && <dialog ref={accessDialog} aria-labelledby="access-title" className="connection-dialog" onCancel={event => { if (accessBusy) event.preventDefault(); else setAccessTarget(null); }}>
      <form onSubmit={event => { event.preventDefault(); void changeAccess(accessTarget, true); }}>
        <header className="toolbar"><b id="access-title">Enable writes?</b></header>
        <div className="form-fields">
          <p>Allow changes to {sourceLabel(accessTarget)}?</p>
          {accessTarget.kind !== 'sqlite' && accessTarget.environment === 'production' && <p className="error">This is a PRODUCTION connection.</p>}
          <p>{accessTarget.kind === 'redis' ? 'Key operations and console commands execute immediately.' : 'Row changes still require review and Apply transaction.'}</p>
          {error && <div role="alert" className="error">{error}</div>}
        </div>
        <footer className="toolbar justify-end">
          <button type="button" autoFocus disabled={accessBusy} onClick={() => setAccessTarget(null)}>Cancel</button>
          <button className="primary" disabled={accessBusy}>{accessBusy ? 'Enabling…' : 'Enable writes'}</button>
        </footer>
      </form>
    </dialog>}
    <footer className="statusbar"><span>{source?.kind === 'redis' ? `${infos[id]?.flavor === 'valkey' ? 'Valkey' : 'Redis'} ${infos[id]?.version ?? ''}` : source?.kind === 'postgres' ? `PostgreSQL ${schemas[id]?.pragmas.server_version ?? ''}` : source ? `SQLite ${schemas[id]?.pragmas.sqlite_version ?? ''}` : 'Tern'}</span><span>{source?.kind === 'sqlite' ? source.path : source ? urlHost(source.url) : 'No database open'}</span><span>{source?.kind === "postgres" ? source.database ?? urlPathName(source.url) : source?.kind === "redis" ? `db ${source.database}` : ""}</span><span className="ml-auto">{states[id] ?? 'Ready'}</span><span className={writable[id] ? 'production' : ''}>{writable[id] ? 'Writable' : 'Read Only'}</span><span>{latency.toFixed(1)} ms</span></footer>
    {createView && source && <DatabaseCreateViewModal source={source} onClose={() => setCreateView(false)} onCreated={() => void connect(source)}/>}
    {picker && <DatabaseOpenModal initial={picker} onClose={() => setPicker(false)} onOpen={s => { setPicker(false); // connect() reads the just-saved profile's readOnly — refresh first; an explicit open also clears a pending forget.
      if (s.kind === 'sqlite') forgotten.current.delete(s.path);
      void refreshConnections().then(() => selectSource(s)).catch(e => setError(String(e))); }}/ >}
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
      {doc.kind === 'key' && (doc.table !== undefined ? <RedisKeyView source={doc.source} keyName={doc.table} writable={writable} onChanged={onRefresh} onRenamed={newKey => onRetargetKey(doc.id, newKey)}/> : <div className="p-4">No key selected.</div>)}
      {doc.kind === 'console' && <RedisConsole docId={doc.id} source={doc.source} info={info ?? null} writable={writable} onDirty={dirty} onLatency={onLatency}/>}
      {doc.kind !== 'key' && doc.kind !== 'console' && <div className="p-4 text-[var(--text-muted)]">This document type is not available for Redis connections.</div>}
    </div>;
  }
  return <div role="tabpanel" className={visible ? 'document-body' : 'hidden'}>
    {doc.source.kind === 'postgres' && <div className="toolbar">Query schema: {querySchemaLabel(doc.source)}
      {doc.source.schema && schema && !schema.schemas?.includes(doc.source.schema) && <span role="alert" className="error">Schema unavailable; open a new document with another schema.</span>}
    </div>}
    {!schema ? <div className="p-4 text-[var(--text-muted)]">Connection unavailable. Reconnect using the explorer.</div> : <>
      {doc.kind === 'table' && (table ? <TableDocument table={table} schema={schema} source={doc.source} writable={writable} onDirty={dirty} onLatency={onLatency}/> : <div className="p-4">This object no longer exists.</div>)}
      {doc.kind === 'sql' && <SqlEditor documentId={doc.id} source={doc.source} schema={schema} writable={writable} onExeced={onRefresh} onDirty={dirty} onLatency={onLatency}/>}
      {doc.kind === 'diagram' && <SchemaDiagramPane schema={schema} visible={visible}/>}
      {doc.kind === 'insights' && <InsightsPane source={doc.source}/>}
      {doc.kind === 'settings' && <PragmasPane pragmas={schema.pragmas}/>}
      {doc.kind === 'migration' && <DatabaseMigrationModal source={doc.source} writable={writable} onDirty={dirty} onClose={() => {}} onApplied={onRefresh}/>}
    </>}
  </div>;
}

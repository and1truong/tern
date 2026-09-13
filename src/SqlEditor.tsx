import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import type { DbSchema, ExecResult, QueryResult } from "../shared.ts";
import { dbApi } from "./dbApi.ts";
import type { DbSource } from "./dbApi.ts";
import { isWriteSql, sqlToRun } from "./sqlConsole.ts";
import Notice from "./Notice.tsx";
import { binaryByteLength, isDbBinaryValue, unwrapDbValueForDisplay } from "../binaryValues.ts";

interface ConsoleTab { id: string; name: string; sql: string }
interface HistoryEntry { id: string; sql: string; ranAt: number; ms: number; ok: boolean }
interface SavedConsole { tabs: ConsoleTab[]; activeId: string; history: HistoryEntry[] }
interface StatementOutput { sql: string; kind?: "query" | "explain"; result?: QueryResult; exec?: ExecResult; error?: string }

function freshConsole(): SavedConsole {
  const id = crypto.randomUUID();
  return { tabs: [{ id, name: "Console 1", sql: "" }], activeId: id, history: [] };
}

function isSavedConsole(value: unknown): value is SavedConsole {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<SavedConsole>;
  return Array.isArray(saved.tabs) && saved.tabs.length > 0 && typeof saved.activeId === "string" && Array.isArray(saved.history);
}

export function SqlEditor({ documentId, source, schema, writable, onExeced, onDirty, onLatency }: {
  documentId: string;
  onLatency?: (ms: number) => void;
  onDirty: (dirty: boolean) => void;
  source: DbSource;
  schema: DbSchema;
  writable: boolean;
  onExeced: () => void;
}) {
  const storageKey = `sql:${documentId}`;
  const [consoleState, setConsole] = useState<SavedConsole>(freshConsole);
  const [ready, setReady] = useState(false);
  const [outputs, setOutputs] = useState<StatementOutput[]>([]);
  const [activeOutput, setActiveOutput] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<any>(null);
  const controller = useRef<AbortController | null>(null);
  const saveVersion = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    dbApi.state.get<SavedConsole>(storageKey).then((value) => {
      if (isSavedConsole(value)) setConsole(value);
      setReady(true);
    }).catch((e) => setError(String(e)));
  }, [storageKey]);
  const latest = useRef(consoleState);
  latest.current = consoleState;
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); void dbApi.state.set(storageKey, latest.current); }
    controller.current?.abort();
  }, [storageKey]);
  const persist = (next: SavedConsole) => {
    const version = ++saveVersion.current;
    setConsole(next);
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    onDirty(true);
    void dbApi.state.set(storageKey, next).then(() => { if (version === saveVersion.current) onDirty(false); }).catch((e) => setError(String(e)));
  };
  const active = consoleState.tabs.find((tab) => tab.id === consoleState.activeId) ?? consoleState.tabs[0];
  const updateSql = (value: string) => {
    const version = ++saveVersion.current;
    const next = {
      ...consoleState,
      tabs: consoleState.tabs.map((tab) => tab.id === active.id ? { ...tab, sql: value } : tab),
    };
    setConsole(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    onDirty(true);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void dbApi.state.set(storageKey, next).then(() => { if (version === saveVersion.current) onDirty(false); }).catch((e) => setError(String(e))); }, 250);
  };
  const completionSchema = useMemo(() => Object.fromEntries(schema.tables.map((table) => [
    table.schema ? `${table.schema}.${table.name}` : table.name,
    table.columns.map((column) => column.name),
  ])), [schema]);
  const extensions = useMemo(() => [sql({
    dialect: source.kind === "postgres" ? PostgreSQL : SQLite,
    schema: completionSchema,
  })], [source.kind, completionSchema]);

  const run = async (all: boolean) => {
    if (busy || !ready) return;
    const view = editor.current;
    const selection = view?.state.selection.main ?? { from: 0, to: 0 };
    const statements = sqlToRun(active.sql, selection, all, source.kind);
    if (!statements.length) return;
    setBusy(true); setError(null); setOutputs([]); setActiveOutput(0);
    const abort = new AbortController();
    controller.current = abort;
    const nextOutputs: StatementOutput[] = [];
    let nextConsole = consoleState;
    let wrote = false;
    for (const statement of statements) {
      if (abort.signal.aborted) break;
      const started = performance.now();
      const isWrite = isWriteSql(statement, source.kind);
      if (isWrite && !writable) {
        nextOutputs.push({ sql: statement, error: "Read-only mode: enable Writable before running this statement." });
        break;
      }
      try {
        let output: StatementOutput;
        if (isWrite) {
          output = { sql: statement, exec: await dbApi.exec(source, statement, true, abort.signal, timeoutMs) };
          wrote = true;
        } else {
          output = { sql: statement, result: await dbApi.query(source, statement, [], 1000, 0, abort.signal, timeoutMs) };
        }
        nextOutputs.push(output);
        onLatency?.(output.result?.ms ?? output.exec?.ms ?? 0);
        const entry: HistoryEntry = {
          id: crypto.randomUUID(), sql: statement, ranAt: Date.now(),
          ms: output.result?.ms ?? output.exec?.ms ?? performance.now() - started, ok: true,
        };
        nextConsole = { ...nextConsole, history: [entry, ...nextConsole.history].slice(0, 100) };
        persist(nextConsole);
      } catch (runError) {
        const message = controller.current?.signal.aborted ? "Query cancelled." : String(runError);
        nextOutputs.push({ sql: statement, error: message });
        const entry: HistoryEntry = { id: crypto.randomUUID(), sql: statement, ranAt: Date.now(), ms: performance.now() - started, ok: false };
        nextConsole = { ...nextConsole, history: [entry, ...nextConsole.history].slice(0, 100) };
        persist(nextConsole);
        break;
      }
      setOutputs([...nextOutputs]);
    }
    setOutputs([...nextOutputs]);
    if (wrote) onExeced();
    controller.current = null;
    setBusy(false);
  };

  const explain = async () => {
    const selection = editor.current?.state.selection.main ?? { from: 0, to: 0 };
    const statement = sqlToRun(active.sql, selection, false, source.kind)[0];
    if (!statement) return;
    if (isWriteSql(statement, source.kind)) {
      setOutputs([{ sql: statement, kind: "explain", error: "EXPLAIN is available only for read queries." }]);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setOutputs([]); setActiveOutput(0);
    try {
      const result = await dbApi.explain(source, statement, [], abort.signal, timeoutMs);
      onLatency?.(result.ms);
      setOutputs([{ sql: statement, kind: "explain", result }]);
    } catch (runError) {
      setOutputs([{ sql: statement, kind: "explain", error: abort.signal.aborted ? "Query cancelled." : String(runError) }]);
    } finally { controller.current = null; setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" onKeyDown={(event) => {
      if (!busy && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void run(event.shiftKey);
      }
    }}>
      <div className="toolbar"><span>{source.kind === "postgres" ? "PostgreSQL" : "SQLite"} · {writable ? "Writable" : "Read Only"}</span><button className="ml-auto" onClick={() => setHistoryOpen(!historyOpen)}>Query history</button></div>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="min-h-[180px] flex-1 overflow-auto border-b border-[var(--border)]">
            <CodeMirror value={active.sql} height="100%" minHeight="180px" extensions={extensions}
              theme={oneDark} editable={ready && !busy} basicSetup={{ autocompletion: true, lineNumbers: true, foldGutter: true }}
              placeholder="Write SQL…  ⌘/Ctrl+Enter runs selection or current statement"
              onCreateEditor={(view) => { editor.current = view; }} onChange={updateSql} />
          </div>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg)]">
            <button onClick={() => void run(false)} disabled={!ready || busy || !active.sql.trim()}
              className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)] disabled:opacity-40">Run</button>
            <button onClick={() => void run(true)} disabled={!ready || busy || !active.sql.trim()}
              className="px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--border-2)] text-[var(--muted)] disabled:opacity-40">Run all</button>
            <button onClick={() => void explain()} disabled={!ready || busy || !active.sql.trim()}
              className="px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--border-2)] text-[var(--muted)] disabled:opacity-40">Explain</button>
            {busy && controller.current && <button onClick={() => controller.current?.abort()} className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--red)]">Cancel</button>}
            <label className="text-[11px]">Timeout <select aria-label="Query timeout" disabled={busy} value={timeoutMs} onChange={e => setTimeoutMs(Number(e.target.value))}>{[1000, 5000, 30000, 60000, 300000].map(t => <option key={t} value={t}>{t / 1000}s</option>)}</select></label>
            <span className="text-[10px] text-[var(--faint)]">⌘/Ctrl+Enter · Shift adds Run all</span>
          </div>
          {error && <Notice variant="error" layout="inline" className="px-3 py-1 text-xs">{error}</Notice>}
          <SqlOutputs outputs={outputs} active={activeOutput} onActive={setActiveOutput} />
        </div>

        {historyOpen && (
          <aside className="w-64 max-w-[40%] border-l border-[var(--border)] flex flex-col bg-[var(--bg)]">
            <div className="flex items-center px-3 py-2 border-b border-[var(--border)] text-xs font-bold text-[var(--text)]">
              Query history
              <button onClick={() => persist({ ...consoleState, history: [] })} className="ml-auto text-[10px] text-[var(--muted)]">Clear</button>
            </div>
            <div className="overflow-auto">
              {consoleState.history.map((entry) => (
                <button key={entry.id} onClick={() => updateSql(entry.sql)} className="w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--hover)]">
                  <div className="mono text-[11px] truncate text-[var(--text)]">{entry.sql}</div>
                  <div className={"text-[10px] " + (entry.ok ? "text-[var(--faint)]" : "text-[var(--red)]")}>{new Date(entry.ranAt).toLocaleString()} · {Math.round(entry.ms)}ms</div>
                </button>
              ))}
              {!consoleState.history.length && <div className="p-3 text-xs text-[var(--faint)]">No queries yet.</div>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function SqlOutputs({ outputs, active, onActive }: { outputs: StatementOutput[]; active: number; onActive: (index: number) => void }) {
  if (!outputs.length) return <div className="h-40 grid place-items-center text-xs text-[var(--faint)]">Run a statement to see results.</div>;
  const output = outputs[active] ?? outputs[0];
  return (
    <div className="h-64 min-h-40 flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--bg)] overflow-x-auto">
        {outputs.map((item, index) => (
          <button key={index} onClick={() => onActive(index)} className={"px-2 py-1 rounded text-[11px] " + (index === active ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--muted)]")}>
            {item.kind === "explain" ? "Plan" : `Result ${index + 1}`}{item.error ? " · error" : ""}
          </button>
        ))}
      </div>
      {output.error ? <Notice variant="error" layout="inline" className="p-3 text-xs">{output.error}</Notice>
        : output.exec ? <div className="p-3 mono text-xs text-[var(--muted)]">{output.exec.rowsAffected} row(s) affected · {output.exec.ms}ms</div>
        : output.result ? <ResultTable result={output.result} /> : null}
    </div>
  );
}

function ResultTable({ result }: { result: QueryResult }) {
  const cellText = (value: unknown) => {
    if (isDbBinaryValue(value)) return `<binary ${binaryByteLength(value).toLocaleString()} bytes>`;
    const displayValue = unwrapDbValueForDisplay(value);
    return typeof displayValue === "object" ? JSON.stringify(displayValue) : String(displayValue);
  };
  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-[var(--panel)]"><tr>{result.columns.map((column) => <th key={column} className="text-left mono px-2 py-1 border-b border-[var(--border)]">{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column} className="mono px-2 py-1 border-b border-[var(--border)]">{row[column] == null ? <i className="text-[var(--faint)]">NULL</i> : cellText(row[column])}</td>)}</tr>)}</tbody>
      </table>
      <div className="px-3 py-1 mono text-[10px] text-[var(--faint)]">{result.rows.length}{result.hasMore ? "+" : ""} rows · {result.ms}ms</div>
    </div>
  );
}

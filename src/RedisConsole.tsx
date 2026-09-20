import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { dbApi, type RedisSource } from "./dbApi.ts";
import type { CommandResult, DataSourceInfo, RespValue } from "../shared/types.ts";
import { completeCommand, argumentHint, expectsKeyArg } from "../datasources/redis/autocomplete.ts";
import { explainCommand, type CommandExplanation } from "../datasources/redis/explain.ts";
import { lintCommand } from "../datasources/redis/lint.ts";
import { boundConsoleHistory } from "./consoleHistory.ts";
import { redactSensitive } from "./redisRedact.ts";

interface HistoryEntry { command: string; at: number }
interface SavedConsole { input: string; history: HistoryEntry[]; favorites: string[] }
interface OutputEntry { command: string; result?: CommandResult; error?: string; at: number }

const freshConsole = (): SavedConsole => ({ input: "", history: [], favorites: [] });

function isSavedConsole(value: unknown): value is SavedConsole {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<SavedConsole>;
  return typeof saved.input === 'string' && Array.isArray(saved.history) && Array.isArray(saved.favorites);
}

// Redis-cli style rendering of a tagged RESP value.
export function renderRESP(value: RespValue, indent = ""): string[] {
  switch (value.t) {
    case "nil": return [`${indent}(nil)`];
    case "str": return [`${indent}"${value.s.replace(/\n/g, "\\n")}"`];
    case "int": return [`${indent}(integer) ${value.n}`];
    case "dbl": return [`${indent}(double) ${value.n}`];
    case "bool": return [`${indent}${value.b ? "(true)" : "(false)"}`];
    case "err": return [`${indent}(error) ${value.s}`];
    case "big": return [`${indent}(bigint) ${value.s}`];
    case "verb": return [`${indent}${value.s}`];
    case "arr":
    case "set": {
      if (!value.items.length) return [`${indent}(empty ${value.t === "set" ? "set" : "array"})`];
      return value.items.flatMap((item, i) => [
        `${indent}${i + 1})`,
        ...renderRESP(item, indent === "" ? "  " : indent + " "),
      ]);
    }
    case "map":
      return value.entries.flatMap(([k, v], i) => [
        `${indent}${i + 1}) ${renderRESP(k, "").join("").trim()}`,
        ...renderRESP(v, indent + "  "),
      ]);
  }
}

// Redis command console: execution, history, favorites, deterministic
// autocomplete, and Tern's explain/lint analysis. Works fully offline.
export function RedisConsole({ docId, source, info, writable, onDirty, onLatency }: {
  docId: string;
  source: RedisSource;
  info: DataSourceInfo | null;
  writable: boolean;
  onDirty: (dirty: boolean) => void;
  onLatency: (ms: number) => void;
}) {
  const storageKey = `redis:${docId}`;
  const [consoleState, setConsole] = useState<SavedConsole>(freshConsole);
  const [ready, setReady] = useState(false);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ReturnType<typeof completeCommand>>([]);
  const [knownKeys, setKnownKeys] = useState<string[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersion = useRef(0);
  const keyFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runAbort = useRef<AbortController | null>(null);
  const latest = useRef(consoleState);
  latest.current = consoleState;

  useEffect(() => {
    dbApi.state.get<SavedConsole>(storageKey).then(value => {
      if (isSavedConsole(value)) setConsole(boundConsoleHistory(value));
      setReady(true);
    }).catch(e => setError(String(e)));
  }, [storageKey]);
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); void dbApi.state.set(storageKey, stash(latest.current)).catch(() => {}); }
    if (keyFetchTimer.current) clearTimeout(keyFetchTimer.current);
  }, [storageKey]);

  // In-memory state keeps what the user typed; only the persisted copy is
  // redacted, so credentials never reach plaintext app state.
  const stash = (s: SavedConsole): SavedConsole => ({
    input: redactSensitive(s.input),
    history: s.history.map(h => ({ ...h, command: redactSensitive(h.command) })),
    favorites: s.favorites.map(f => redactSensitive(f)),
  });

  const persist = (next: SavedConsole) => {
    next = boundConsoleHistory(next);
    const version = ++saveVersion.current;
    setConsole(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    onDirty(true);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void dbApi.state.set(storageKey, stash(next)).then(() => { if (version === saveVersion.current) onDirty(false); }).catch(e => setError(String(e)));
    }, 250);
  };

  const update = (input: string) => {
    persist({ ...consoleState, input });
    setSuggestions(completeCommand(input, { keys: knownKeys }));
    // Refresh key-name suggestions only while completing a key argument —
    // scanning for command-name prefixes is wasted work.
    if (keyFetchTimer.current) clearTimeout(keyFetchTimer.current);
    if (expectsKeyArg(input)) {
      keyFetchTimer.current = setTimeout(async () => {
        try {
          const prefix = input.trim().split(/\s+/).pop() ?? "";
          const page = await dbApi.datasource.scan(source, { cursor: "0", match: `${prefix.replace(/[\\*?\[\]]/g, "\\$&")}*`, count: 20 });
          setKnownKeys(page.keys.map(k => k.key));
        } catch { /* suggestions are best-effort */ }
      }, 300);
    }
  };

  const run = async () => {
    if (busy || !ready) return;
    const lines = consoleState.input.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const controller = new AbortController();
    runAbort.current = controller;
    setBusy(true); setError(''); setOutputs([]); setSuggestions([]);
    const entries: OutputEntry[] = [];
    let next = consoleState;
    for (const command of lines) {
      const entry: OutputEntry = { command, at: Date.now() };
      try {
        const result = await dbApi.datasource.exec(source, command, controller.signal);
        entry.result = result;
        onLatency(result.ms);
      } catch (e) { entry.error = controller.signal.aborted ? "Cancelled" : String(e); }
      entries.push(entry);
      setOutputs([...entries]);
      if (entry.error || entry.result?.reply.t === "err") break;
      next = { ...next, history: [{ command, at: Date.now() }, ...next.history.filter(h => h.command !== command)].slice(0, 100) };
    }
    runAbort.current = null;
    persist(next);
    setBusy(false);
  };

  const insertSuggestion = (insert: string) => {
    // Replace the trailing partial token with the accepted completion; when
    // the partial sits inside an open quote, drop the dangling fragment too.
    let base = consoleState.input.replace(/\S*$/, "");
    const unclosed = (q: '"' | "'") => {
      const body = q === '"' ? base.replace(/\\./g, "") : base;
      return (body.split(q).length - 1) % 2 === 1;
    };
    if (unclosed('"')) base = base.replace(/"[^"]*$/, "");
    else if (unclosed("'")) base = base.replace(/'[^']*$/, "");
    persist({ ...consoleState, input: base + insert });
    setSuggestions([]);
  };

  const hint = argumentHint(consoleState.input);
  const warnings = info ? lintCommand(consoleState.input, { writable, cluster: info.capabilities?.cluster === true }) : [];
  const explanation: CommandExplanation | null = explainOpen && info
    ? explainCommand(consoleState.input, { cluster: info.capabilities?.cluster === true })
    : null;
  const flavorLabel = info ? (info.flavor === "valkey" ? "Valkey" : "Redis") : "Redis";

  return <div className="flex-1 min-h-0 flex flex-col" onKeyDown={e => {
    if (!busy && ready && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void run(); }
  }}>
    <div className="toolbar flex-wrap">
      <span>{flavorLabel} · {writable ? "Writable" : "Read Only"} · db {source.database}</span>
      {busy && <button onClick={() => runAbort.current?.abort()}>Cancel</button>}
      <button className="ml-auto" onClick={() => setExplainOpen(!explainOpen)}>{explainOpen ? "Hide explain" : "Explain"}</button>
      <button onClick={() => setHistoryOpen(!historyOpen)}>Command history</button>
    </div>
    {error && <div role="alert" className="error flex">{error}<button aria-label="Dismiss error" className="ml-auto" onClick={() => setError('')}>×</button></div>}
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        {warnings.length > 0 && <div className="px-2 py-1 space-y-0.5 border-b border-[var(--border)]">
          {warnings.map((w, i) => <p key={i} className={`text-xs ${w.severity === "error" ? "text-[var(--danger)]" : w.severity === "warning" ? "text-[var(--warning)]" : "text-[var(--text-muted)]"}`}>
            <b>{w.rule}</b> · {w.message}{w.suggestion ? ` → ${w.suggestion}` : ""}
          </p>)}
        </div>}
        <div className="px-2 pt-1 text-xs text-[var(--text-muted)]">{hint.hint}</div>
        <div className="px-2">
          <CodeMirror value={consoleState.input} onChange={update} theme={oneDark} editable={ready && !busy}
            basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false, highlightActiveLine: false }}
            placeholder="Type a Redis command… ⌘/Ctrl+Enter runs it"
            className="border border-[var(--border)] max-h-40 overflow-auto" />
        </div>
        {suggestions.length > 0 && <div className="mx-2 mt-1 border border-[var(--border)] bg-[var(--bg)] max-h-48 overflow-auto text-xs">
          {suggestions.map(s => <button key={`${s.kind}:${s.label}`} className="w-full text-left px-2 py-1 hover:bg-[var(--hover)] flex gap-2" onClick={() => insertSuggestion(s.insert)}>
            <b>{s.label}</b><span className="text-[var(--faint)] truncate">{s.detail}</span>
          </button>)}
        </div>}
        <div className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs space-y-2">
          {outputs.map((entry, i) => <div key={i} className="border-b border-[var(--border)] pb-1">
            <p className="flex gap-2 items-center">
              <span className="text-[var(--accent)]">{entry.command}</span>
              {entry.result && <span className="text-[var(--faint)]">{entry.result.ms.toFixed(1)} ms</span>}
              <button aria-label={`Star ${entry.command}`} className="ml-auto" title="Favorite"
                onClick={() => !consoleState.favorites.includes(entry.command) && persist({ ...consoleState, favorites: [entry.command, ...consoleState.favorites].slice(0, 50) })}>☆</button>
            </p>
            {entry.result && renderRESP(entry.result.reply).map((line, j) => <pre key={j} className={`whitespace-pre-wrap ${line.startsWith("(error)") ? "text-[var(--danger)]" : ""}`}>{line}</pre>)}
            {entry.error && <pre className="text-[var(--danger)] whitespace-pre-wrap">{entry.error}</pre>}
          </div>)}
          {!outputs.length && <p className="text-[var(--faint)]">Run a command to see its RESP reply here.</p>}
        </div>
      </div>
      {explainOpen && explanation && <aside className="w-80 border-l border-[var(--border)] p-3 overflow-auto text-xs space-y-2">
        <b className="text-sm">{explanation.name}</b>
        <p>{explanation.summary}</p>
        <p><b>{explanation.access === "read" ? "Read-only" : explanation.access === "unknown" ? "Unclassified" : explanation.access}</b>{explanation.complexity ? ` · Complexity: ${explanation.complexity}` : ""}{explanation.blocking ? " · Blocking" : ""} · TTL: {explanation.ttlEffect}</p>
        {explanation.expected && <p><b>Returns:</b> {explanation.expected}</p>}
        {explanation.args.length > 0 && <div><b>Arguments</b><ul className="space-y-1 mt-1">{explanation.args.map((a, i) => <li key={i}><code>{a.token}</code> — {a.meaning}</li>)}</ul></div>}
        {explanation.dangers.length > 0 && <ul className="text-[var(--danger)] space-y-1">{explanation.dangers.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        {explanation.risks.length > 0 && <ul className="space-y-1 text-[var(--warning)]">{explanation.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        {explanation.cluster.length > 0 && <ul className="space-y-1 text-[var(--text-muted)]">{explanation.cluster.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        {consoleState.favorites.length > 0 && <div><b>Favorites</b><ul className="mt-1 space-y-1">{consoleState.favorites.map(f => <li key={f}><button className="text-left w-full truncate hover:underline" onClick={() => persist({ ...consoleState, input: f })}>★ {f}</button></li>)}</ul></div>}
      </aside>}
      {historyOpen && <aside className="w-80 border-l border-[var(--border)] p-3 overflow-auto text-xs">
        <div className="flex"><b>Command history</b><button className="ml-auto text-[10px] text-[var(--muted)]" onClick={() => persist({ ...consoleState, history: [] })}>Clear</button></div>
        {consoleState.history.map((entry, i) => <button key={i} className="block w-full text-left py-1 border-b border-[var(--border)] truncate hover:bg-[var(--hover)]" onClick={() => persist({ ...consoleState, input: entry.command })}>
          {entry.command}
        </button>)}
        {!consoleState.history.length && <p className="text-[var(--faint)]">No commands yet.</p>}
      </aside>}
    </div>
  </div>;
}

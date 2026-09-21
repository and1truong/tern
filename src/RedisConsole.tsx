import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView, ViewUpdate } from "@codemirror/view";
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
  // history/favorites are newer fields — a console saved before they existed
  // must still restore rather than losing its input.
  const saved = value as Partial<SavedConsole>;
  return typeof saved.input === 'string';
}

// Redis-cli style rendering of a tagged RESP value. The wire shape is only
// trusted as far as the tag — a malformed node renders as unprintable
// rather than crashing the app (there is no error boundary above us).
export function renderRESP(value: RespValue, indent = ""): string[] {
  if (!value || typeof value !== "object") return [`${indent}(unprintable reply)`];
  // A pathological or hostile reply could nest deep enough to overflow the
  // stack mid-render — cap the depth instead of crashing the app. The cap is
  // at entry so map keys (which recurse into renderRESP too) count.
  if (indent.length > 64) return [`${indent}…`];
  switch (value.t) {
    case "nil": return [`${indent}(nil)`];
    case "str": return typeof value.s === "string" ? [`${indent}"${value.s.replace(/\n/g, "\\n")}"`] : [`${indent}(unprintable reply)`];
    case "int": return [`${indent}(integer) ${value.n}`];
    case "dbl": return [`${indent}(double) ${value.n}`];
    case "bool": return [`${indent}${value.b ? "(true)" : "(false)"}`];
    case "err": return [`${indent}(error) ${value.s}`];
    case "big": return [`${indent}(bigint) ${value.s}`];
    case "verb": return [`${indent}${value.s}`];
    case "arr":
    case "set": {
      const items = Array.isArray(value.items) ? value.items : [];
      if (!items.length) return [`${indent}(empty ${value.t === "set" ? "set" : "array"})`];
      return items.flatMap((item, i) => [
        `${indent}${i + 1})`,
        ...renderRESP(item, indent === "" ? "  " : indent + " "),
      ]);
    }
    case "map": {
      const entries = Array.isArray(value.entries) ? value.entries : [];
      return entries.flatMap((pair, i) => [
        `${indent}${i + 1}) ${renderRESP(pair?.[0], indent + " ").join("").trim()}`,
        ...renderRESP(pair?.[1], indent + "  "),
      ]);
    }
    default: return [`${indent}(unprintable reply)`];
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
  const keyFetchAbort = useRef<AbortController | null>(null);
  const runAbort = useRef<AbortController | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(0);
  const latest = useRef(consoleState);
  latest.current = consoleState;

  useEffect(() => {
    dbApi.state.get<SavedConsole>(storageKey).then(value => {
      // Only the top-level shape is guaranteed — drop entries whose fields
      // aren't the expected types rather than letting them throw in stash().
      if (isSavedConsole(value)) setConsole(boundConsoleHistory({
        input: value.input,
        history: (Array.isArray(value.history) ? value.history : []).filter(h => h && typeof h.command === 'string' && typeof h.at === 'number'),
        favorites: (Array.isArray(value.favorites) ? value.favorites : []).filter(f => typeof f === 'string'),
      }));
    }).catch(e => setError(String(e))).finally(() => setReady(true));
  }, [storageKey]);
  useEffect(() => () => {
    runAbort.current?.abort();
    keyFetchAbort.current?.abort();
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
      // A failed save must not wedge the doc dirty forever — surface the
      // error and clear dirty so the document can still be closed.
      void dbApi.state.set(storageKey, stash(next))
        .catch(e => setError(String(e)))
        .finally(() => { if (version === saveVersion.current) onDirty(false); });
    }, 250);
  };

  const update = (input: string, view: ViewUpdate) => {
    // Commands are per-line; suggestions and hints describe the text before
    // the cursor, not the whole line.
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const col = view.state.selection.main.head - line.from;
    setCursorLine(line.number);
    setCursorCol(col);
    const activeLine = line.text.slice(0, col);
    // A programmatic setConsole (restore, history/favorite clicks already
    // persisted) echoes through onChange — skip the redundant save so a
    // restored doc doesn't come up dirty.
    if (input !== latest.current.input) persist({ ...latest.current, input });
    setSuggestions(completeCommand(activeLine, { keys: knownKeys }));
    // Refresh key-name suggestions only while completing a key argument —
    // scanning for command-name prefixes is wasted work.
    if (keyFetchTimer.current) clearTimeout(keyFetchTimer.current);
    if (expectsKeyArg(activeLine)) {
      keyFetchTimer.current = setTimeout(async () => {
        keyFetchAbort.current?.abort();
        const controller = new AbortController();
        keyFetchAbort.current = controller;
        try {
          const page = await dbApi.datasource.scan(source, { cursor: "0", match: `${partialToken(activeLine).replace(/[\\*?\[\]]/g, "\\$&")}*`, count: 20 }, controller.signal);
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
    const ran: string[] = [];
    for (const command of lines) {
      const entry: OutputEntry = { command, at: Date.now() };
      try {
        const result = await dbApi.datasource.exec(source, command, controller.signal);
        // A malformed result (no reply node) must not wedge `busy` nor
        // crash renderRESP downstream — treat it like a command error.
        if (!result?.reply || typeof result.reply !== "object" || typeof result.ms !== "number") entry.error = "Malformed server reply";
        else { entry.result = result; onLatency(result.ms); }
      } catch (e) { entry.error = controller.signal.aborted ? "Cancelled" : String(e); }
      entries.push(entry);
      setOutputs([...entries]);
      if (entry.error || entry.result?.reply.t === "err") break;
      ran.push(command);
    }
    runAbort.current = null;
    // History merges into the LATEST state — favorites/history edits (e.g.
    // clearing history) made while the run was in flight must not be
    // resurrected by the snapshot captured when it started.
    const ranUnique = [...new Set(ran)];
    persist({
      ...latest.current,
      history: [...ranUnique.map(command => ({ command, at: Date.now() })), ...latest.current.history.filter(h => !ranUnique.includes(h.command))].slice(0, 100),
    });
    setBusy(false);
  };

  const insertSuggestion = (insert: string) => {
    // Replace the partial token ending at the cursor; when the partial sits
    // inside an open quote, drop the dangling fragment too. Text after the
    // cursor is preserved. latest.current, not the render snapshot — edits
    // landing in the same commit window must not revert each other.
    const lines = latest.current.input.split("\n");
    const i = Math.min(cursorLine - 1, lines.length - 1);
    const suffix = lines[i]!.slice(cursorCol);
    let base = lines[i]!.slice(0, cursorCol).replace(/\S*$/, "");
    if (unclosedQuote(base, '"')) base = base.replace(/"[^"]*$/, "");
    else if (unclosedQuote(base, "'")) base = base.replace(/'[^']*$/, "");
    lines[i] = base + insert + suffix;
    persist({ ...latest.current, input: lines.join("\n") });
    setSuggestions([]);
    // Focus stays on the editor so the user can keep typing after the click.
    editorView.current?.focus();
  };

  const activeLine = (consoleState.input.split("\n")[cursorLine - 1] ?? "").slice(0, cursorCol);
  const hint = argumentHint(activeLine);
  // Each line is its own command — lint them independently so "PING\nPING"
  // doesn't parse as one arity-violating command.
  const warnings = info ? consoleState.input.split("\n").map(l => l.trim()).filter(Boolean)
    .flatMap(l => lintCommand(l, { writable, cluster: info.capabilities?.cluster === true })) : [];
  const explanation: CommandExplanation | null = explainOpen && info
    ? explainCommand(activeLine, { cluster: info.capabilities?.cluster === true })
    : null;
  const flavorLabel = info ? (info.flavor === "valkey" ? "Valkey" : "Redis") : "Redis";

  return <div className="flex-1 min-h-0 flex flex-col" onKeyDown={e => {
    if (!busy && ready && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void run(); }
    if (e.key === "Escape" && suggestions.length) setSuggestions([]);
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
          <CodeMirror value={consoleState.input} onChange={update}
            onCreateEditor={view => { editorView.current = view; }}
            onUpdate={u => {
              const line = u.state.doc.lineAt(u.state.selection.main.head);
              const col = u.state.selection.main.head - line.from;
              if (line.number !== cursorLine || col !== cursorCol) {
                setCursorLine(line.number);
                setCursorCol(col);
                // Suggestions describe the text under the cursor — recompute
                // them on moves so a stale list can't insert at this position.
                setSuggestions(completeCommand(line.text.slice(0, col), { keys: knownKeys }));
              }
            }}
            theme={oneDark} editable={ready && !busy}
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
              <span className="text-[var(--accent)]">{redactSensitive(entry.command)}</span>
              {entry.result && <span className="text-[var(--faint)]">{entry.result.ms.toFixed(1)} ms</span>}
              <button aria-label={`Star ${redactSensitive(entry.command)}`} className="ml-auto" title="Favorite"
                onClick={() => !latest.current.favorites.includes(entry.command) && persist({ ...latest.current, favorites: [entry.command, ...latest.current.favorites].slice(0, 50) })}>☆</button>
            </p>
            {entry.result && renderRESP(entry.result.reply).map((line, j) => <pre key={j} className={`whitespace-pre-wrap ${line.startsWith("(error)") ? "text-[var(--danger)]" : ""}`}>{line}</pre>)}
            {entry.error && <pre className="text-[var(--danger)] whitespace-pre-wrap">{redactSensitive(entry.error)}</pre>}
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
        {consoleState.favorites.length > 0 && <div><b>Favorites</b><ul className="mt-1 space-y-1">{consoleState.favorites.map(f => <li key={f}><button className="text-left w-full truncate hover:underline" onClick={() => { setSuggestions([]); persist({ ...latest.current, input: f }); }}>★ {redactSensitive(f)}</button></li>)}</ul></div>}
      </aside>}
      {historyOpen && <aside className="w-80 border-l border-[var(--border)] p-3 overflow-auto text-xs">
        <div className="flex"><b>Command history</b><button className="ml-auto text-[10px] text-[var(--muted)]" onClick={() => persist({ ...latest.current, history: [] })}>Clear</button></div>
        {consoleState.history.map((entry, i) => <button key={i} className="block w-full text-left py-1 border-b border-[var(--border)] truncate hover:bg-[var(--hover)]" onClick={() => { setSuggestions([]); persist({ ...latest.current, input: entry.command }); }}>
          {redactSensitive(entry.command)}
        </button>)}
        {!consoleState.history.length && <p className="text-[var(--faint)]">No commands yet.</p>}
      </aside>}
    </div>
  </div>;
}

// Does `text` end inside an unterminated quote? Double quotes consume the
// char after any backslash; single quotes escape only via \' (matching
// sdssplitargs — '\\' inside single quotes is a literal backslash).
function unclosedQuote(text: string, q: '"' | "'"): boolean {
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && (q === '"' || text[i + 1] === "'")) { i++; continue; }
    if (ch === q) open = !open;
  }
  return open;
}

// The partial argument being typed at the end of a line: empty on trailing
// whitespace, the unquoted tail otherwise, and the content after an
// unterminated quote when one is open.
function partialToken(line: string): string {
  if (!line || /\s$/.test(line)) return "";
  if (unclosedQuote(line, '"')) return line.slice(line.lastIndexOf('"') + 1);
  if (unclosedQuote(line, "'")) return line.slice(line.lastIndexOf("'") + 1);
  const tail = line.match(/\S*$/)?.[0] ?? "";
  // A balanced quoted token still carries its delimiters — strip them.
  return tail.length > 1 && ((tail.startsWith('"') && tail.endsWith('"')) || (tail.startsWith("'") && tail.endsWith("'")))
    ? tail.slice(1, -1)
    : tail;
}

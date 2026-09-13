import { useState } from "react";
import { X, Database as DbIcon, Play } from "lucide-react";
import Notice from "./Notice.tsx";
import { dbApi } from "./dbApi.ts";
import type { DbSource } from "./dbApi.ts";
import type { QueryResult } from "../shared.ts";
import { unwrapDbValueForDisplay } from "../binaryValues.ts";
import { firstSqlVerb, isWriteSql, splitSqlStatements } from "./sqlConsole.ts";

export function validateViewQuery(body: string, dialect: DbSource["kind"]): string {
  const statements = splitSqlStatements(body, dialect);
  if (statements.length !== 1 || !["SELECT", "WITH", "VALUES"].includes(firstSqlVerb(statements[0].sql, dialect)) || isWriteSql(statements[0].sql, dialect)) {
    throw new Error("View body must contain exactly one read-only SELECT, WITH, or VALUES query.");
  }
  return statements[0].sql;
}

export function DatabaseCreateViewModal({ source, onClose, onCreated }: {
  source: DbSource; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [ifne, setIfne] = useState(false);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createDdl = (query: string) => `CREATE VIEW${ifne && source.kind === "sqlite" ? " IF NOT EXISTS" : ""} "${name.replace(/"/g, '""')}" AS ${query}`;
  let ddl = "";
  let validationError = "";
  try { ddl = createDdl(validateViewQuery(body, source.kind)); }
  catch (error) { if (body.trim()) validationError = String(error); }
  const canCreate = name.trim() && body.trim();

  const runPreview = async () => {
    setBusy(true); setErr(null);
    try {
      setPreview(await dbApi.query(source, validateViewQuery(body, source.kind), [], 100));
    } catch (e) { setPreview(null); setErr(String(e)); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      await dbApi.exec(source, createDdl(validateViewQuery(body, source.kind)), true);
      onCreated();
      onClose();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]">
          <DbIcon size={15} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold text-[var(--text)] flex-1">Create view</span>
          <button onClick={onClose} className="w-7 h-7 grid place-items-center rounded-md hover:bg-[var(--hover)] text-[var(--muted)]"><X size={15} /></button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-auto">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--muted)] w-16">Name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="adults"
              className="flex-1 mono rounded-lg border border-[var(--border-2)] bg-[var(--bg)] px-3 py-1.5 text-sm text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--muted)]">AS (SELECT …)</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} rows={5}
              placeholder="SELECT id, email FROM users WHERE age >= 18"
              className="mono rounded-lg border border-[var(--border-2)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] resize-y" />
          </div>

          {source.kind === "sqlite" && <label className="flex items-center gap-2 text-xs text-[var(--muted)] cursor-pointer select-none">
            <input type="checkbox" checked={ifne} onChange={(e) => setIfne(e.target.checked)} />
            IF NOT EXISTS
          </label>}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--faint)] mb-1">DDL</div>
            <pre className="mono text-[11px] text-[var(--text)] whitespace-pre-wrap break-all">{validationError || ddl}</pre>
          </div>

          {preview && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--faint)] mb-1">
                Preview · {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} · {preview.ms}ms
              </div>
              <div className="overflow-auto max-h-40">
                <table className="text-[11px] border-collapse">
                  <thead><tr>{preview.columns.map((c) => <th key={c} className="text-left mono font-semibold px-1.5 py-0.5 border-b border-[var(--border)]">{c}</th>)}</tr></thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i}>{preview.columns.map((c) => {
                        const value = unwrapDbValueForDisplay((row as Record<string, unknown>)[c]);
                        return <td key={c} className="mono px-1.5 py-0.5 border-b border-[var(--border)]">{value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}</td>;
                      })}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {err && <Notice variant="error" layout="inline" className="text-xs px-2 py-1">{err}</Notice>}
        </div>

        <div className="flex justify-between items-center gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={runPreview} disabled={!body.trim() || busy} title="Run the SELECT to preview rows"
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-semibold text-[var(--muted)] border border-[var(--border-2)] hover:bg-[var(--hover)] disabled:opacity-40">
            <Play size={13} /> Preview
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-[var(--muted)] border border-[var(--border-2)] hover:bg-[var(--hover)]">Cancel</button>
            <button onClick={create} disabled={!canCreate || busy}
              className="px-4 py-1.5 rounded-lg text-sm font-bold bg-[var(--accent)] text-[var(--panel)] disabled:opacity-40">Create</button>
          </div>
        </div>
      </div>
    </div>
  );
}

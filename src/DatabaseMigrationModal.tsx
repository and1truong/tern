import { useState } from "react";
import type { MigrationResult } from "../shared.ts";
import type { DbSource } from "./dbApi.ts";
import { dbApi } from "./dbApi.ts";
import Notice from "./Notice.tsx";

export function DatabaseMigrationModal({ source, onClose, onApplied, writable = false, onDirty }: {
  source: DbSource;
  writable?: boolean;
  onDirty?: (value: boolean) => void;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [log, setLog] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const [preview, setPreview] = useState<MigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validate = async () => {
    setBusy(true); setError(null); setPreview(null);
    try { const result = await dbApi.migration.preview(source, sql); setPreview(result); setLog(l => [...l, `BEGIN → execute DDL → ROLLBACK · ${result.ms} ms`]); }
    catch (validateError) { setError(String(validateError)); setLog(l => [...l, `Validation failed: ${String(validateError)}`]); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const result = await dbApi.migration.apply(source, sql);
      setLog(l => [...l, `BEGIN → execute DDL → COMMIT · ${result.ms} ms`]);
      setPreview(null); setSql(""); onDirty?.(false); onApplied(); onClose();
    } catch (applyError) { setError(String(applyError)); }
    finally { setBusy(false); }
  };
  const production = source.kind === "postgres" && source.environment === "production";
  return (
    <div className="document-body">
      <div role="dialog" aria-label="Migration studio" className="document-body">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <div><div className="text-sm font-bold text-[var(--text)]">Migration Studio</div><div className="text-[10px] text-[var(--faint)]">Dry-run with rollback, then apply in one transaction</div></div>
          <span className="ml-auto">{writable ? "Writable" : "Read Only"}</span>
        </div>
        <div className="overflow-auto p-4 grid gap-3">
          {source.kind === 'postgres' && <Notice variant="warning" layout="inline" className="px-2 py-1 text-xs">PostgreSQL dry runs require Writable. Sequence changes (nextval/setval) and external side effects are not undone by rollback. Use a disposable database when these effects are unacceptable.</Notice>}
          {production && <Notice variant="warning" layout="inline" className="px-2 py-1 text-xs">This migration targets a production profile.</Notice>}
          <textarea aria-label="Migration SQL" disabled={busy} value={sql} onChange={(event) => { setSql(event.target.value); onDirty?.(!!event.target.value); setPreview(null); setError(null); }}
            spellCheck={false} placeholder={'CREATE TABLE example (\n  id INTEGER PRIMARY KEY\n);'}
            className="mono h-72 resize-y rounded-md border border-[var(--border-2)] bg-[var(--bg)] p-3 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]" />
          {preview && <Notice variant="success" layout="inline" className="px-2 py-1 text-xs">Dry-run passed and rolled back in {preview.ms}ms. The script is ready to apply.</Notice>}
          {error && <Notice variant="error" layout="inline" className="px-2 py-1 text-xs">{error}</Notice>}
          {!!log.length && <section><h3 className="text-[10px] text-[var(--text-muted)] uppercase">Execution log</h3><pre className="mono text-xs whitespace-pre-wrap py-2">{log.join("\n")}</pre></section>}
          <div className="text-[10px] text-[var(--faint)]">BEGIN/COMMIT/ROLLBACK are managed by the runner. Changing the SQL invalidates the dry-run.</div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={() => { setSql(""); setPreview(null); onDirty?.(false); onClose(); }} disabled={busy} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Revert</button>
          <button onClick={() => void validate()} disabled={busy || !sql.trim() || (source.kind === "postgres" && !writable)} className="px-3 py-1.5 rounded-md border border-[var(--border-2)] text-xs font-semibold text-[var(--muted)] disabled:opacity-40">{busy && !preview ? "Validating…" : "Dry run"}</button>
          <button onClick={() => void apply()} disabled={busy || !preview || !writable} className="px-3 py-1.5 rounded-md bg-[var(--red)] text-white text-xs font-bold disabled:opacity-40">Apply migration</button>
        </div>
      </div>
    </div>
  );
}

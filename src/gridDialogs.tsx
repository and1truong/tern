import { useState } from "react";
import Notice from "./Notice.tsx";
import type { DbTable, RowChangeStatement } from "../shared/types.ts";
import { tableLabel } from "../shared/sqlIdentifiers.ts";
import { coerceCellValue } from "../shared/dataGrid.ts";
import { parseCsv } from "../shared/dataTransfer.ts";
import { binaryByteLength, isDbBinaryValue, unwrapDbValueForDisplay } from "../shared/binaryValues.ts";

export function InsertRowModal({ table, onClose, onAdd }: {
  table: DbTable;
  onClose: () => void;
  onAdd: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const writableColumns = table.columns.filter((column) => !column.generated && column.identityGeneration !== "ALWAYS");
  const submit = () => {
    const row: Record<string, unknown> = {};
    for (const column of writableColumns) {
      const raw = values[column.name];
      if (raw !== undefined) row[column.name] = coerceCellValue(raw, column.type);
    }
    onAdd(row);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-label="Add row" className="w-[560px] max-w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <b className="text-sm text-[var(--text)]">Add row to {tableLabel(table)}</b>
          <button aria-label="Close add row" onClick={onClose} className="ml-auto text-[var(--muted)]">×</button>
        </div>
        <div className="overflow-auto p-4 grid gap-2">
          {writableColumns.map((column) => (
            <label key={column.name} className="grid grid-cols-[140px_1fr] items-center gap-3 text-xs">
              <span className="truncate text-[var(--muted)]" title={column.name}>{column.name}</span>
              <input aria-label={`New ${column.name}`} value={values[column.name] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, [column.name]: event.target.value }))}
                placeholder={column.type || "value"}
                className="mono min-w-0 rounded-md border border-[var(--border-2)] bg-[var(--bg)] px-2 py-1.5 text-[var(--text)] outline-none focus:border-[var(--accent)]" />
              <span className="col-span-2 flex items-center gap-2">
                <input type="checkbox" aria-label={`Use default for ${column.name}`} checked={values[column.name] === undefined}
                  onChange={event => setValues(current => {
                    const next = { ...current };
                    if (event.target.checked) delete next[column.name]; else next[column.name] = "";
                    return next;
                  })} />Use database default
              </span>
            </label>
          ))}
          <span className="text-[10px] text-[var(--faint)]">Use \N for SQL NULL; double a leading backslash for literal text. Uncheck default to insert an explicit value, including an empty string; generated and ALWAYS identity columns are filled by the database.</span>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Cancel</button>
          <button onClick={submit} className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)]">Stage row</button>
        </div>
      </div>
    </div>
  );
}

export function ImportCsvModal({ table, onClose, onStage }: {
  table: DbTable;
  onClose: () => void;
  onStage: (rows: Record<string, unknown>[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  let preview: ReturnType<typeof parseCsv> | null = null;
  let previewError: string | null = null;
  try { if (text.trim()) preview = parseCsv(text); }
  catch (parseError) { previewError = String(parseError); }
  const stage = () => {
    setError(null);
    try {
      const parsed = parseCsv(text);
      if (!parsed.rows.length) throw new Error("CSV has no data rows");
      if (parsed.rows.length > 500) throw new Error("Import is limited to 500 rows per transaction");
      const known = new Map(table.columns.map((column) => [column.name, column]));
      const writable = new Map(table.columns.filter((column) => !column.generated && column.identityGeneration !== "ALWAYS").map((column) => [column.name, column]));
      const unknown = parsed.columns.filter((column) => !known.has(column));
      if (unknown.length) throw new Error(`Unknown column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
      const readonly = parsed.columns.filter((column) => !writable.has(column));
      if (readonly.length) throw new Error(`Generated or ALWAYS identity column${readonly.length === 1 ? " is" : "s are"} not writable: ${readonly.join(", ")}`);
      onStage(parsed.rows.map((row) => Object.fromEntries(parsed.columns.map((name) => [name, coerceCellValue(row[name], writable.get(name)?.type ?? "")]))));
    } catch (stageError) { setError(String(stageError)); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-label="Import CSV" className="w-[720px] max-w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <b className="text-sm text-[var(--text)]">Import CSV into {tableLabel(table)}</b>
          <button aria-label="Close CSV import" onClick={onClose} className="ml-auto text-[var(--muted)]">×</button>
        </div>
        <div className="overflow-auto p-4 grid gap-3">
          <input aria-label="Choose CSV file" type="file" accept=".csv,text/csv" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.text().then(setText).catch((readError) => setError(String(readError)));
          }} className="text-xs text-[var(--muted)]" />
          <textarea aria-label="CSV content" value={text} onChange={(event) => { setText(event.target.value); setError(null); }}
            placeholder={`id,name\n1,Ada`} className="mono h-48 resize-y rounded-md border border-[var(--border-2)] bg-[var(--bg)] p-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]" />
          {preview && <div className="text-xs text-[var(--muted)]">{preview.rows.length} row(s) · columns: {preview.columns.join(", ")}</div>}
          {(error ?? previewError) && <Notice variant="error" layout="inline" className="text-xs px-2 py-1">{error ?? previewError}</Notice>}
          <span className="text-[10px] text-[var(--faint)]">The header maps by column name. Use \N for SQL NULL; double a leading backslash for literal text. Imported rows are staged for SQL review and one atomic transaction.</span>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Cancel</button>
          <button onClick={stage} disabled={!text.trim()} className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)] disabled:opacity-40">Stage import</button>
        </div>
      </div>
    </div>
  );
}

export function ValueInspector({ column, value, onClose }: { column: string; value: unknown; onClose: () => void }) {
  const text = isDbBinaryValue(value)
    ? `Binary value (${binaryByteLength(value).toLocaleString()} bytes)\n\nBase64:\n${value.__ternWire.base64}`
    : (() => {
      const displayValue = unwrapDbValueForDisplay(value);
      return typeof displayValue === "object" ? JSON.stringify(displayValue, null, 2) : String(displayValue);
    })();
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-label="Large value inspector" className="w-[760px] max-w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <b className="text-sm text-[var(--text)]">{column}</b>
          <span className="mono text-[10px] text-[var(--faint)]">{text.length.toLocaleString()} characters</span>
          <button onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))} className="ml-auto px-2 py-1 text-xs text-[var(--muted)]">{copied ? "Copied" : "Copy"}</button>
          <button aria-label="Close large value" onClick={onClose} className="text-[var(--muted)]">×</button>
        </div>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 mono text-xs text-[var(--text)]">{text}</pre>
      </div>
    </div>
  );
}

export function RowChangesModal({ statements, applying, error, onClose, onApply, writable }: {
  statements: RowChangeStatement[];
  writable: boolean;
  applying: boolean;
  error: string | null;
  onClose: () => void;
  onApply: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(event) => event.target === event.currentTarget && !applying && onClose()}>
      <div role="dialog" aria-label="Review row changes" className="w-[680px] max-w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <b className="text-sm text-[var(--text)]">Review {statements.length} row change{statements.length === 1 ? "" : "s"}</b>
          <button aria-label="Close row changes" disabled={applying} onClick={onClose} className="ml-auto text-[var(--muted)]">×</button>
        </div>
        <div className="overflow-auto p-4 grid gap-3">
          {statements.map((statement, index) => (
            <div key={index} className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
              <div className="text-[10px] uppercase font-bold text-[var(--accent)] mb-1">{statement.kind}</div>
              <pre className="mono text-[11px] whitespace-pre-wrap break-words text-[var(--text)]">{statement.sql}</pre>
              <div className="mono text-[10px] mt-2 text-[var(--faint)]">params: [{statement.params.map((value) => value === null ? "NULL" : String(value)).join(", ")}]</div>
            </div>
          ))}
          {error && <Notice variant="error" layout="inline" className="text-xs px-2 py-1">{error}</Notice>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} disabled={applying} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Back</button>
          <button onClick={onApply} disabled={applying || !writable}
            className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)] disabled:opacity-40">
            {applying ? "Applying…" : "Apply transaction"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useRef } from "react";
import Notice from "./Notice.tsx";
import { dbApi } from "./dbApi.ts";
import type { DbSource } from "./dbApi.ts";
import type { DbTable, QueryResult, RowChangeStatement } from "../shared/types.ts";
import { coerceCellValue, editKey, rowIdentity, rowsToCsv } from "../shared/dataGrid.ts";
import type { SortSpec } from "../shared/dataGrid.ts";
import { serializeRows } from "../shared/dataTransfer.ts";
import type { ExportFormat } from "../shared/dataTransfer.ts";
import { displayDbValue, isDbBinaryValue } from "../shared/binaryValues.ts";
import { useStagedRows } from "./stagedRows.ts";
import { ImportCsvModal, InsertRowModal, RowChangesModal, ValueInspector } from "./gridDialogs.tsx";

export function DataGrid({ table, source, writable, columns, result, sorts, pageSize, onSort, onPrevious, onNext, onPageSize, onDirtyChange, onApplied, onExportAll }: {
  table: DbTable;
  source: DbSource;
  writable: boolean;
  columns: string[];
  result: QueryResult | null;
  sorts: SortSpec[];
  pageSize: number;
  onSort: (column: string, additive: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onPageSize: (size: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  onApplied: () => void;
  onExportAll: () => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
}) {
  const cols = result?.columns.length ? result.columns : columns;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const cancelEdit = useRef(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [preview, setPreview] = useState<RowChangeStatement[] | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [importOpen, setImportOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [inspecting, setInspecting] = useState<{ column: string; value: unknown } | null>(null);
  useEffect(() => { setSelected(new Set()); setCopyState("idle"); }, [result]);

  const rows = result?.rows ?? [];
  const visibleCols = cols.filter((column) => !hiddenColumns.has(column));
  const selectedRows = selected.size
    ? rows.filter((_, index) => selected.has(index))
    : rows;
  const csv = () => rowsToCsv(visibleCols, selectedRows);
  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(csv());
      setCopyState("copied");
    } catch { setCopyState("error"); }
  };
  const download = (content: string, format: ExportFormat) => {
    const mime = format === "json" ? "application/json" : format === "csv" ? "text/csv" : "text/plain";
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${table.name}.${format === "markdown" ? "md" : format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const exportRows = async (all: boolean) => {
    setTransferBusy(true); setMutationError(null);
    try {
      const data = all ? await onExportAll() : { columns: visibleCols, rows: selectedRows };
      download(serializeRows(exportFormat, data.columns.filter(column => visibleCols.includes(column)), data.rows, table), exportFormat);
    } catch (error) { setMutationError(String(error)); }
    finally { setTransferBusy(false); }
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const first = result && rows.length ? result.offset + 1 : 0;
  const last = result ? result.offset + rows.length : 0;
  const primaryColumns = table.columns.filter((column) => column.pk);
  const canInsert = writable && table.type === "table";
  const canEditRows = canInsert && rows.some(row => rowIdentity(table, row).length > 0);
  const nonComparableColumns = source.kind === "postgres"
    ? new Set(table.columns.filter((column) => column.comparable === false).map((column) => column.name))
    : undefined;
  const staged = useStagedRows(table, rows, nonComparableColumns);
  const { edits, deleted, editing, setEditing, changes, dirty } = staged;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const revert = () => {
    staged.revert();
    setPreview(null); setMutationError(null);
  };
  const review = async () => {
    setMutationError(null);
    try { setPreview((await dbApi.rows.preview(changes)).statements); }
    catch (error) { setMutationError(String(error)); }
  };
  const apply = async () => {
    setApplying(true); setMutationError(null);
    try {
      await dbApi.rows.apply(source, changes);
      revert();
      onApplied();
    } catch (error) { setMutationError(String(error)); }
    finally { setApplying(false); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="relative flex flex-wrap items-center gap-1.5 px-2 py-1 border-b border-[var(--border)] bg-[var(--bg)]">
        <button onClick={() => void copyCsv()} disabled={!rows.length}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Copy CSV
        </button>
        <select aria-label="Export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
          className="px-1 py-1 rounded text-[11px] border border-[var(--border-2)] bg-[var(--bg)] text-[var(--muted)]">
          <option value="csv">CSV</option><option value="json">JSON</option><option value="sql">SQL</option><option value="markdown">Markdown</option>
        </select>
        <button onClick={() => void exportRows(false)} disabled={!rows.length || transferBusy}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Export page
        </button>
        <button onClick={() => void exportRows(true)} disabled={!rows.length || transferBusy || dirty}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Export all
        </button>
        <button onClick={() => setColumnsOpen((open) => !open)} className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)]">
          Columns {visibleCols.length}/{cols.length}
        </button>
        {columnsOpen && (
          <div className="absolute top-full left-2 z-30 mt-1 w-56 max-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2 shadow-xl">
            {cols.map((column) => <label key={column} className="flex items-center gap-2 px-1 py-1 text-xs text-[var(--text)]">
              <input type="checkbox" checked={!hiddenColumns.has(column)} onChange={(event) => setHiddenColumns((current) => {
                const next = new Set(current);
                if (event.target.checked) next.delete(column); else if (current.size < cols.length - 1) next.add(column);
                return next;
              })} />
              <span className="truncate">{column}</span>
            </label>)}
          </div>
        )}
        <span className="h-5 w-px bg-[var(--border)]" />
        <button onClick={() => setInsertOpen(true)} disabled={!canInsert}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Add row
        </button>
        <button onClick={() => setImportOpen(true)} disabled={!canInsert || dirty}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Import CSV
        </button>
        <button onClick={() => { staged.stageDelete(selected); setSelected(new Set()); }}
          disabled={!canEditRows || selected.size === 0 || [...selected].some(index => !rowIdentity(table, rows[index]).length)}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--red)] hover:bg-[var(--hover)] disabled:opacity-40">
          Delete selected
        </button>
        {dirty && <span className="text-[var(--warning)] text-[11px]">{changes.length} pending changes</span>}
        <button onClick={() => void review()} disabled={!changes.length}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--hover)] disabled:opacity-40">
          Review {changes.length || ""} change{changes.length === 1 ? "" : "s"}
        </button>
        <button onClick={revert} disabled={!dirty}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Revert
        </button>
        <button onClick={() => void review()} disabled={!changes.length || !writable} className="px-2 py-1 text-[11px] text-[var(--accent)] disabled:opacity-40">Apply…</button>
        {selected.size > 0 && <span className="text-[11px] text-[var(--accent)]">{selected.size} selected</span>}
        {copyState === "copied" && <span className="text-[11px] text-[var(--muted)]">Copied</span>}
        {copyState === "error" && <span className="text-[11px] text-[var(--danger)]">Clipboard unavailable</span>}
        <span className="ml-auto text-[10px] text-[var(--faint)]">
          {canEditRows ? `Double-click a cell to edit${!primaryColumns.length ? " · using unique key" : ""}` : writable && table.type === "table" ? "Updates require a primary or non-null unique key" : "Shift-click headers for multi-sort"}
        </span>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-[var(--panel)] z-10">
            <tr>
              <th className="w-8 px-2 py-1.5 border-b border-[var(--border)]">
                <input type="checkbox" aria-label="Select all rows" checked={allSelected}
                  onChange={(event) => setSelected(event.target.checked ? new Set(rows.map((_, i) => i)) : new Set())} />
              </th>
              {visibleCols.map((c) => (
                <th key={c} className="text-left font-semibold text-[var(--text)] border-b border-[var(--border)] whitespace-nowrap">
                  <button aria-label={`Sort by ${c}`} disabled={dirty || table.columns.find(column => column.name === c)?.orderable === false} onClick={(event) => onSort(c, event.shiftKey)}
                    className="w-full flex items-center gap-1 px-2 py-1.5 text-left hover:bg-[var(--hover)]">
                    {c}
                    {sorts.find((sort) => sort.column === c) && (
                      <span className="text-[var(--accent)]">
                        {sorts.find((sort) => sort.column === c)!.direction === "asc" ? "↑" : "↓"}
                        {sorts.length > 1 ? sorts.findIndex((sort) => sort.column === c) + 1 : ""}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result?.rows.map((row, i) => (
              <tr key={i} className={"hover:bg-[var(--hover)] " + (deleted.has(i) ? "opacity-50 line-through" : "")}>
                <td className="w-8 px-2 py-1 border-b border-[var(--border)]">
                  <input type="checkbox" aria-label={`Select row ${result.offset + i + 1}`}
                    checked={selected.has(i)} onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(i); else next.delete(i);
                      return next;
                    })} />
                </td>
                {visibleCols.map((c) => {
                  const v = (row as Record<string, unknown>)[c];
                  const stagedKey = editKey(i, c);
                  const value = stagedKey in edits ? edits[stagedKey] : v;
                  const isNull = value === null || value === undefined;
                  const isNum = typeof value === "number";
                  const column = table.columns.find((candidate) => candidate.name === c);
                  const canEditCell = canEditRows && rowIdentity(table, row).length > 0 && !column?.generated && !nonComparableColumns?.has(c) && (v == null || typeof v !== "object");
                  return (
                    <td key={c} title={nonComparableColumns?.has(c) ? "Editing unavailable: this type cannot be checked for concurrent changes." : undefined} onDoubleClick={() => { if (canEditCell && !deleted.has(i)) { cancelEdit.current = false; setEditing(stagedKey); } }}
                      className={"px-2 py-1 border-b border-[var(--border)] mono text-[var(--text)] align-top " + (isNum ? "text-right " : "") + (stagedKey in edits ? "bg-[var(--accent)]/10 " : "") + (canEditCell ? "cursor-text" : "")}>
                      {editing === stagedKey ? (
                        <input autoFocus aria-label={`Edit row ${result.offset + i + 1} ${c}`}
                          title={"Use \\N for SQL NULL; double a leading backslash for literal text."}
                          defaultValue={isNull ? "\\N" : String(value).replace(/^\\/, "\\\\")}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") { cancelEdit.current = true; setEditing(null); }
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          onBlur={(event) => {
                            if (cancelEdit.current) { cancelEdit.current = false; return; }
                            staged.stageCell(stagedKey, coerceCellValue(event.target.value, column?.type ?? ""), v);
                            setEditing(null);
                          }}
                          className="w-full min-w-16 bg-[var(--bg)] border border-[var(--accent)] rounded px-1 outline-none" />
                      ) : isNull ? <span className="italic text-[var(--faint)]">NULL</span> : (() => {
                        const display = displayDbValue(value);
                        return isDbBinaryValue(value) || display.length > 160
                          ? <button title="Open large value" onClick={() => setInspecting({ column: c, value })} className="max-w-80 text-left truncate text-[var(--accent)]">{display}</button>
                          : display;
                      })()}
                    </td>
                  );
                })}
              </tr>
            ))}
            {result && result.rows.length === 0 && (
              <tr><td colSpan={visibleCols.length + 1} className="px-2 py-6 text-center text-[var(--faint)]">No rows.</td></tr>
            )}
            {!result && (
              <tr><td colSpan={visibleCols.length + 1} className="px-2 py-6 text-center text-[var(--faint)]">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {result && (
        <div className="flex items-center gap-2 px-3 py-1 border-t border-[var(--border)] text-[11px] text-[var(--faint)] mono">
          <span>{first}–{last}{result.hasMore ? "+" : ""} · {result.ms}ms</span>
          <button onClick={onPrevious} disabled={result.offset === 0 || dirty}
            className="ml-auto px-2 py-0.5 rounded border border-[var(--border-2)] disabled:opacity-40">Previous</button>
          <span>Page {Math.floor(result.offset / pageSize) + 1}</span>
          <button onClick={onNext} disabled={!result.hasMore || dirty}
            className="px-2 py-0.5 rounded border border-[var(--border-2)] disabled:opacity-40">Next</button>
          <select aria-label="Rows per page" value={pageSize} disabled={dirty} onChange={(event) => onPageSize(Number(event.target.value))}
            className="bg-[var(--bg)] border border-[var(--border-2)] rounded px-1 py-0.5">
            {[50, 100, 250, 500].map((size) => <option key={size} value={size}>{size}/page</option>)}
          </select>
        </div>
      )}
      {mutationError && <Notice variant="error" layout="inline" className="px-3 py-1 text-xs">{mutationError}</Notice>}
      {insertOpen && (
        <InsertRowModal table={table} onClose={() => setInsertOpen(false)} onAdd={(values) => {
          staged.stageInsert(values);
          setInsertOpen(false);
        }} />
      )}
      {importOpen && (
        <ImportCsvModal table={table} onClose={() => setImportOpen(false)} onStage={(imported) => {
          staged.stageInserts(imported);
          setImportOpen(false);
        }} />
      )}
      {preview && (
        <RowChangesModal writable={writable} statements={preview} applying={applying} error={mutationError}
          onClose={() => setPreview(null)} onApply={() => void apply()} />
      )}
      {inspecting && <ValueInspector column={inspecting.column} value={inspecting.value} onClose={() => setInspecting(null)} />}
    </div>
  );
}

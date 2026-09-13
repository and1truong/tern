import { useEffect, useState, useCallback, useRef } from "react";
import { Table2, Eye, Search } from "lucide-react";
import Notice from "./Notice.tsx";
import { dbApi } from "./dbApi.ts";
import type { DbSource } from "./dbApi.ts";
import type { DatabaseInsights, DbSchema, DbTable, DbColumn, QueryResult, RowChangeStatement } from "../shared.ts";
import { tableKey, tableLabel } from "./sqlIdentifiers.ts";
import { buildRowChanges, coerceCellValue, editKey, rowsToCsv } from "./dataGrid.ts";
import type { SortSpec } from "./dataGrid.ts";
import { parseCsv, serializeRows } from "./dataTransfer.ts";
import type { ExportFormat } from "./dataTransfer.ts";
import { schemaRelations, schemaToMermaid } from "./schemaDiagram.ts";
import { binaryByteLength, isDbBinaryValue, unwrapDbValueForDisplay } from "../binaryValues.ts";
function displayDbValue(value: unknown): string {
  if (isDbBinaryValue(value)) return `<binary ${binaryByteLength(value).toLocaleString()} bytes>`;
  value = unwrapDbValueForDisplay(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function EmptyHint({ text }: { text: string }) {
  return <div className="flex-1 grid place-items-center text-[var(--faint)] text-xs px-6 text-center">{text}</div>;
}

export function ObjectTree({ schema, activeTable, onSelect, locked }: {
  schema: DbSchema | null; activeTable: string | null; onSelect: (name: string) => void; locked: boolean;
}) {
  const [search, setSearch] = useState("");
  if (!schema) return <div className="overflow-auto p-3 text-[var(--faint)] text-xs">No database open.</div>;
  const needle = search.trim().toLowerCase();
  const matches = (values: Array<string | undefined>) => !needle || values.some((value) => value?.toLowerCase().includes(needle));
  const visibleTables = schema.tables.filter((table) => matches([
    table.name, table.schema, table.type, ...table.columns.map((column) => column.name),
  ]));
  const schemaNames = schema.schemas?.length ? schema.schemas : [...new Set(visibleTables.map((table) => table.schema).filter(Boolean))] as string[];
  const groups = (schemaNames.length ? schemaNames : [""]).map((name) => ({
    name,
    tables: visibleTables.filter((table) => (table.schema ?? "") === (name === "main" ? "" : name)),
  })).filter((group) => group.tables.length > 0);
  if (!groups.length && visibleTables.length) groups.push({ name: "", tables: visibleTables });
  const Section = ({ label, items, icon }: { label: string; items: DbTable[]; icon: React.ReactNode }) => (
    items.length > 0 && (
      <details open className="mb-1"><summary className="px-3 py-1 text-[10px] uppercase text-[var(--text-muted)]">{label} ({items.length})</summary>
        {items.map((t) => {
          const key = tableKey(t);
          return (
          <button key={key} onClick={() => onSelect(key)} disabled={locked} title={t.ddl?.slice(0, 120)}
            className={"w-full flex items-center gap-2 px-3 py-1 text-left text-xs " + (key === activeTable ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text)] hover:bg-[var(--hover)]")}>
            <span className="text-[var(--muted)]">{icon}</span>
            <span className="truncate flex-1">{tableLabel(t)}</span>
            <span className="mono text-[9px] text-[var(--faint)]">{t.columns.length}c</span>
            {t.rowCount >= 0 && <span className="mono text-[10px] text-[var(--faint)]">{t.rowCount}</span>}
          </button>
          );
        })}
      </details>
    )
  );
  const objectRows = <T extends { name: string; schema?: string }>(label: string, items: T[], detail: (item: T) => string) => {
    const visible = items.filter((item) => matches([item.name, item.schema, detail(item)]));
    if (!visible.length) return null;
    return (
      <div className="mb-2">
        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--faint)]">{label} ({visible.length})</div>
        {visible.map((item, index) => (
          <div key={`${item.schema ?? ""}:${item.name}:${index}`} title={detail(item)} className="flex items-center gap-2 px-3 py-1 text-xs text-[var(--muted)]">
            <span className="mono text-[9px] uppercase text-[var(--faint)]">{label.slice(0, 3)}</span>
            <span className="truncate">{item.schema && item.schema !== "public" ? `${item.schema}.` : ""}{item.name}</span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="overflow-auto border-r border-[var(--border)]">
      <label className="sticky top-0 z-10 flex items-center gap-1.5 m-2 px-2 h-7 rounded-md border border-[var(--border-2)] bg-[var(--bg)]">
        <Search size={12} className="text-[var(--faint)]" />
        <input aria-label="Search database objects" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find objects…"
          className="min-w-0 w-full bg-transparent text-xs text-[var(--text)] outline-none" />
      </label>
      {groups.map((group) => (
        <div key={group.name || "main"}>
          {schemaNames.length > 1 && <div className="px-3 py-1.5 border-y border-[var(--border)] bg-[var(--bg)] mono text-[10px] font-bold text-[var(--accent)]">{group.name || "main"}</div>}
          {Section({ label: "Tables", items: group.tables.filter((table) => table.type === "table"), icon: <Table2 size={12} /> })}
          {Section({ label: "Views", items: group.tables.filter((table) => table.type === "view"), icon: <Eye size={12} /> })}
          {Section({ label: "Materialized", items: group.tables.filter((table) => table.type === "materialized_view"), icon: <Eye size={12} /> })}
        </div>
      ))}
      {objectRows("Indexes", schema.indexes, (item) => `${item.unique ? "unique " : ""}${item.table ?? ""} ${(item.columns ?? []).join(", ")}`)}
      {objectRows("Triggers", schema.triggers, (item) => `${item.timing ?? ""} ${item.event ?? ""} ${item.table ?? ""}`)}
      {objectRows("Constraints", schema.constraints ?? [], (item) => `${item.type} ${item.table} ${item.definition}`)}
      {objectRows("Sequences", schema.sequences ?? [], (item) => item.definition ?? "")}
      {objectRows("Routines", schema.routines ?? [], (item) => `${item.type ?? ""} ${item.definition ?? ""}`)}
      {objectRows("Extensions", schema.extensions ?? [], (item) => item.definition ?? "")}
      {needle && !visibleTables.length && !schema.indexes.some((item) => matches([item.name])) && (
        <div className="p-3 text-xs text-[var(--faint)]">No matching objects.</div>
      )}
    </div>
  );
}

function TypeChip({ type }: { type: string }) {
  if (!type) return null;
  return <span className="mono text-[9px] px-1 rounded bg-[var(--hover)] text-[var(--muted)]">{type}</span>;
}

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
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [deleted, setDeleted] = useState<Set<number>>(() => new Set());
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([]);
  const cancelEdit = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
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
      download(serializeRows(exportFormat, data.columns, data.rows, table), exportFormat);
    } catch (error) { setMutationError(String(error)); }
    finally { setTransferBusy(false); }
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const first = result && rows.length ? result.offset + 1 : 0;
  const last = result ? result.offset + rows.length : 0;
  const primaryColumns = table.columns.filter((column) => column.pk);
  const fallbackKey = table.uniqueKeys?.find((key) => key.length && key.every((name) => table.columns.some((column) => column.name === name && column.notNull))) ?? [];
  const identityColumns = primaryColumns.length ? primaryColumns : fallbackKey.map((name) => table.columns.find((column) => column.name === name)!);
  const canInsert = writable && table.type === "table";
  const canEditRows = canInsert && identityColumns.length > 0;
  const nonComparableColumns = source.kind === "postgres"
    ? new Set(table.columns.filter((column) => column.comparable === false).map((column) => column.name))
    : undefined;
  const changes = buildRowChanges(table, rows, edits, deleted, inserts, nonComparableColumns);
  const dirty = changes.length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const revert = () => {
    setEdits({}); setDeleted(new Set()); setInserts([]); setEditing(null);
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
        <button onClick={() => { setDeleted(new Set([...deleted, ...selected])); setSelected(new Set()); }}
          disabled={!canEditRows || selected.size === 0}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--red)] hover:bg-[var(--hover)] disabled:opacity-40">
          Delete selected
        </button>
        {dirty && <span className="text-[var(--warning)] text-[11px]">{changes.length} pending changes</span>}
        <button onClick={() => void review()} disabled={!dirty}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--hover)] disabled:opacity-40">
          Review {changes.length || ""} change{changes.length === 1 ? "" : "s"}
        </button>
        <button onClick={revert} disabled={!dirty}
          className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
          Revert
        </button>
        <button onClick={() => void review()} disabled={!dirty || !writable} className="px-2 py-1 text-[11px] text-[var(--accent)] disabled:opacity-40">Apply…</button>
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
                  <button aria-label={`Sort by ${c}`} disabled={dirty} onClick={(event) => onSort(c, event.shiftKey)}
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
                  const canEditCell = canEditRows && !column?.generated && !nonComparableColumns?.has(c) && (v == null || typeof v !== "object");
                  return (
                    <td key={c} title={nonComparableColumns?.has(c) ? "Editing unavailable: this type cannot be checked for concurrent changes." : undefined} onDoubleClick={() => { if (canEditCell && !deleted.has(i)) { cancelEdit.current = false; setEditing(stagedKey); } }}
                      className={"px-2 py-1 border-b border-[var(--border)] mono text-[var(--text)] align-top " + (isNum ? "text-right " : "") + (stagedKey in edits ? "bg-[var(--accent)]/10 " : "") + (canEditCell ? "cursor-text" : "")}>
                      {editing === stagedKey ? (
                        <input autoFocus aria-label={`Edit row ${result.offset + i + 1} ${c}`}
                          defaultValue={isNull ? "NULL" : String(value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") { cancelEdit.current = true; setEditing(null); }
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          onBlur={(event) => {
                            if (cancelEdit.current) { cancelEdit.current = false; return; }
                            const nextValue = coerceCellValue(event.target.value, column?.type ?? "");
                            setEdits((current) => {
                              const next = { ...current };
                              if (Object.is(nextValue, v)) delete next[stagedKey]; else next[stagedKey] = nextValue;
                              return next;
                            });
                            setEditing(null);
                          }}
                          className="w-full min-w-16 bg-[var(--bg)] border border-[var(--accent)] rounded px-1 outline-none" />
                      ) : isNull ? <span className="italic text-[var(--faint)]">NULL</span> : (() => {
                        const display = displayDbValue(value);
                        return display.length > 160
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
          setInserts((current) => [...current, values]);
          setInsertOpen(false);
        }} />
      )}
      {importOpen && (
        <ImportCsvModal table={table} onClose={() => setImportOpen(false)} onStage={(imported) => {
          setInserts((current) => [...current, ...imported]);
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

function InsertRowModal({ table, onClose, onAdd }: {
  table: DbTable;
  onClose: () => void;
  onAdd: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const writableColumns = table.columns.filter((column) => !column.generated && !column.identity);
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
          <span className="text-[10px] text-[var(--faint)]">Uncheck default to insert an explicit value, including an empty string; generated and identity columns are filled by the database.</span>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Cancel</button>
          <button onClick={submit} className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)]">Stage row</button>
        </div>
      </div>
    </div>
  );
}

function ImportCsvModal({ table, onClose, onStage }: {
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
      const writable = new Map(table.columns.filter((column) => !column.generated && !column.identity).map((column) => [column.name, column]));
      const unknown = parsed.columns.filter((column) => !known.has(column));
      if (unknown.length) throw new Error(`Unknown column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
      const readonly = parsed.columns.filter((column) => !writable.has(column));
      if (readonly.length) throw new Error(`Generated or identity column${readonly.length === 1 ? " is" : "s are"} not writable: ${readonly.join(", ")}`);
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
          <span className="text-[10px] text-[var(--faint)]">The header maps by column name. Imported rows are staged for SQL review and one atomic transaction.</span>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-[var(--muted)]">Cancel</button>
          <button onClick={stage} disabled={!text.trim()} className="px-3 py-1.5 rounded-md text-xs font-bold bg-[var(--accent)] text-[var(--panel)] disabled:opacity-40">Stage import</button>
        </div>
      </div>
    </div>
  );
}

function ValueInspector({ column, value, onClose }: { column: string; value: unknown; onClose: () => void }) {
  const text = isDbBinaryValue(value)
    ? `Binary value (${binaryByteLength(value).toLocaleString()} bytes)\n\nBase64:\n${value.__dbmWire.base64}`
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

function RowChangesModal({ statements, applying, error, onClose, onApply, writable }: {
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

export function StructurePane({ table, schema }: { table: DbTable; schema: DbSchema }) {
  return (
    <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-[var(--faint)]">
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">#</th>
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">Name</th>
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">Type</th>
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">Notnull</th>
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">Default</th>
            <th className="text-left font-semibold px-2 py-1 border-b border-[var(--border)]">Key</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c: DbColumn, i) => (
            <tr key={c.name} className="hover:bg-[var(--hover)]">
              <td className="px-2 py-1 border-b border-[var(--border)] text-[var(--faint)] mono">{i}</td>
              <td className="px-2 py-1 border-b border-[var(--border)] mono text-[var(--text)]">{c.name}</td>
              <td className="px-2 py-1 border-b border-[var(--border)]"><TypeChip type={c.type} /></td>
              <td className="px-2 py-1 border-b border-[var(--border)] text-[var(--muted)]">{c.notNull ? "NOT NULL" : ""}</td>
              <td className="px-2 py-1 border-b border-[var(--border)] mono text-[var(--muted)]">{c.identity ? "IDENTITY" : c.generated ? "GENERATED" : c.defaultValue ?? ""}</td>
              <td className="px-2 py-1 border-b border-[var(--border)] text-[var(--muted)]">
                {c.pk ? <span className="text-[var(--accent)]">PK</span> : ""}
                {c.fk ? <span className="ml-1 text-[var(--faint)]">→ {c.fk}</span> : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {([['Indexes', schema.indexes.filter((x) => x.table === table.name && x.schema === table.schema).map((x) => `${x.name}: ${x.sql || x.columns?.join(', ')}`)],
        ['Foreign keys', table.columns.filter((x) => x.fk).map((x) => `${x.name} → ${x.fk}`)],
        ['Constraints', (schema.constraints ?? []).filter((x) => x.table === table.name && x.schema === table.schema).map((x) => `${x.name}: ${x.definition}`)],
        ['Triggers', schema.triggers.filter((x) => x.table === table.name && x.schema === table.schema).map((x) => `${x.name}: ${x.sql}`)]] as [string, string[]][]).map(([label, rows]) => <section key={label}><h3 className="text-[var(--text-muted)] uppercase text-[10px] py-2">{label}</h3>{rows.length ? rows.map((row, i) => <pre key={i} className="border-b border-[var(--border)] py-1 whitespace-pre-wrap text-xs">{row}</pre>) : <span className="text-[var(--text-muted)] text-xs">None</span>}</section>)}
      {table.ddl && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--faint)] mb-1">DDL</div>
          <pre className="mono text-[11px] text-[var(--text)] bg-[var(--bg)] border border-[var(--border)] rounded-md p-2 overflow-auto whitespace-pre-wrap">{table.ddl}</pre>
        </div>
      )}
    </div>
  );
}

export function PragmasPane({ pragmas }: { pragmas: Record<string, string> }) {
  const entries = Object.entries(pragmas);
  if (!entries.length) return <EmptyHint text="No pragmas." />;
  return (
    <div className="flex-1 overflow-auto p-3">
      <table className="text-xs border-collapse">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="hover:bg-[var(--hover)]">
              <td className="px-2 py-1 border-b border-[var(--border)] mono text-[var(--muted)] whitespace-nowrap">{k}</td>
              <td className="px-2 py-1 border-b border-[var(--border)] mono text-[var(--text)]">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SchemaDiagramPane({ schema }: { schema: DbSchema }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [focus, setFocus] = useState('');
  const [error, setError] = useState('');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const tables = schema.tables.filter(t => t.type === 'table');
  const columns = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const rowHeight = Math.max(140, ...tables.map(t => 46 + t.columns.length * 20));
  const positions = new Map(tables.map((t, i) => [tableKey(t), { x: (i % columns) * 300, y: Math.floor(i / columns) * (rowHeight + 50) }]));
  const fit = () => {
    const bounds = svg.current?.getBoundingClientRect();
    if (!bounds) return;
    setZoom(Math.max(.1, Math.min(1.5, (bounds.width - 48) / (columns * 300), (bounds.height - 48) / (Math.ceil(tables.length / columns) * (rowHeight + 50)))));
    setPan({ x: 24, y: 24 });
  };
  useEffect(fit, [schema]);
  const exportMermaid = () => {
    const url = URL.createObjectURL(new Blob([schemaToMermaid(schema)], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = 'relationships.mmd'; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="document-body">
    <div className="toolbar"><span>{tables.length} tables · {schemaRelations(schema).length} relationships</span><button onClick={() => setZoom(z => Math.max(.1, z / 1.2))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(3, z * 1.2))}>+</button><button onClick={fit}>Fit</button>
      <select aria-label="Focus table" value={focus} onChange={e => { const key = e.target.value; setFocus(key); const p = positions.get(key); if (p) { setZoom(1); setPan({ x: 30 - p.x, y: 30 - p.y }); } }} className="bg-[var(--bg)]"><option value="">Focus table…</option>{tables.map(t => <option key={tableKey(t)} value={tableKey(t)}>{tableLabel(t)}</option>)}</select>
      <button className="ml-auto" onClick={() => void navigator.clipboard.writeText(schemaToMermaid(schema)).catch(e => setError(String(e)))}>Copy Mermaid</button><button onClick={exportMermaid}>Export Mermaid</button>
    </div>
    {error && <div className="error">{error}</div>}
    <svg ref={svg} role="img" aria-label="Database relationships diagram" className="flex-1 min-h-0 w-full" style={{ touchAction: 'none', cursor: 'grab' }} onWheel={e => setZoom(z => Math.max(.1, Math.min(3, z * (e.deltaY < 0 ? 1.1 : .9))))}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY }; }}
      onPointerMove={e => { if (!drag.current) return; const dx = e.clientX - drag.current.x; const dy = e.clientY - drag.current.y; setPan(p => ({ x: p.x + dx, y: p.y + dy })); drag.current = { x: e.clientX, y: e.clientY }; }}
      onPointerUp={e => { drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); }}>
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"/></marker></defs>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {schemaRelations(schema).map((r, i) => {
          const target = tables.find(t => tableKey(t) === r.toTable || tableLabel(t) === r.toTable || t.name === r.toTable);
          const from = positions.get(tableKey(r.fromTable)); const to = target && positions.get(tableKey(target));
          if (!from || !to) return null;
          const fy = from.y + 42 + Math.max(0, r.fromTable.columns.findIndex(c => c.name === r.fromColumn)) * 20;
          const ty = to.y + 42 + Math.max(0, target!.columns.findIndex(c => c.name === r.toColumn)) * 20;
          return <path key={i} d={`M${from.x + 250},${fy} C${from.x + 285},${fy} ${to.x - 35},${ty} ${to.x},${ty}`} stroke="var(--accent)" strokeWidth="1.3" fill="none" markerEnd="url(#arrow)"><title>{r.fromColumn} → {r.toTable}.{r.toColumn}</title></path>;
        })}
        {tables.map(t => { const p = positions.get(tableKey(t))!; return <g key={tableKey(t)} transform={`translate(${p.x} ${p.y})`}>
          <rect width="250" height={34 + t.columns.length * 20} fill="var(--surface)" stroke={focus === tableKey(t) ? 'var(--accent)' : 'var(--border-strong)'}/>
          <rect width="250" height="28" fill="var(--surface-raised)"/><text x="10" y="19" fill="var(--text)" fontSize="12" fontWeight="600">{tableLabel(t)}</text>
          {t.columns.map((c, i) => <g key={c.name}><text x="10" y={43 + i * 20} fill={c.pk ? 'var(--accent)' : 'var(--text)'} fontSize="11">{c.pk ? '◆ ' : c.fk ? '↗ ' : ''}{c.name.length > 22 ? c.name.slice(0, 21) + '…' : c.name}</text><text x="240" y={43 + i * 20} textAnchor="end" fill="var(--text-muted)" fontSize="10">{c.type.slice(0, 13)}</text></g>)}
        </g>; })}
      </g>
    </svg>
    {!tables.length && <p className="p-3 text-[var(--text-muted)]">No tables in this database.</p>}
  </div>;
}

export function InsightsPane({ source }: { source: DbSource }) {
  const [insights, setInsights] = useState<DatabaseInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const sourceKey = source.kind === "sqlite" ? `sqlite:${source.path}` : `postgres:${source.connId}/${source.database ?? ""}`;
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setBusy(true); setError(null);
    try {
      const next = await dbApi.insights(source);
      if (request === requestRef.current) setInsights(next);
    } catch (loadError) {
      if (request === requestRef.current) setError(String(loadError));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [sourceKey]);
  useEffect(() => {
    setInsights(null); setError(null);
    void load();
    return () => { requestRef.current++; };
  }, [load]);
  const formatMetric = (key: string, value: string | number) => {
    if (key.endsWith("_bytes") && typeof value === "number") {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let amount = value; let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
      return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
    }
    return typeof value === "number" ? value.toLocaleString() : value;
  };
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <div className="flex items-center mb-3">
        <div className="text-xs font-bold text-[var(--text)]">Operational insights</div>
        <button onClick={() => void load()} disabled={busy} className="ml-auto px-2.5 py-1 rounded-md border border-[var(--border-2)] text-[11px] font-semibold text-[var(--muted)] disabled:opacity-40">{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
      {error && <Notice variant="error" layout="inline" className="mb-3 px-2 py-1 text-xs">{error}</Notice>}
      {insights && (
        <>
          <table className="text-xs border-collapse w-full"><tbody>{Object.entries(insights.metrics).map(([key, value]) => <tr key={key} className="border-b border-[var(--border)]"><th className="text-left font-normal py-1.5 text-[var(--text-muted)] w-64">{key.replace(/_/g, ' ')}</th><td className="mono">{formatMetric(key, value)}</td></tr>)}</tbody></table>
          <div className="mt-4 text-[10px] font-bold uppercase tracking-wide text-[var(--faint)]">Database activity ({insights.activity.length})</div>
          <div className="mt-1 overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs border-collapse">
              <thead><tr>{["PID", "User", "Application", "State", "Duration", "Transaction", "Locks", "Wait", "Query"].map((label) => <th key={label} className="text-left px-2 py-1 border-b border-[var(--border)] text-[var(--faint)]">{label}</th>)}</tr></thead>
              <tbody>{insights.activity.map((item) => <tr key={item.id}>
                <td className="px-2 py-1 border-b border-[var(--border)] mono">{item.id}</td><td className="px-2 py-1 border-b border-[var(--border)]">{item.user}</td>
                <td className="px-2 py-1 border-b border-[var(--border)]">{item.application}</td><td className="px-2 py-1 border-b border-[var(--border)]">{item.state}</td><td className="px-2 py-1 border-b border-[var(--border)] mono">{Math.round(item.durationMs)}ms</td>
                <td className="px-2 py-1 border-b border-[var(--border)] whitespace-nowrap">{item.transaction}</td><td className="px-2 py-1 border-b border-[var(--border)]">{item.locks}</td><td className="px-2 py-1 border-b border-[var(--border)]">{item.wait}</td><td title={item.query} className="max-w-md truncate px-2 py-1 border-b border-[var(--border)] mono">{item.query}</td>
              </tr>)}</tbody>
            </table>
            {!insights.activity.length && <div className="px-3 py-3 text-xs text-[var(--faint)]">No other active database sessions.</div>}
          </div>
          {!!insights.tables?.length && <><h3 className="text-[10px] uppercase text-[var(--text-muted)] mt-5 mb-2">Table statistics</h3><table className="w-full text-xs"><thead><tr>{['Table', 'Size', 'Live tuples', 'Dead tuples', 'Scans'].map(h => <th key={h} className="text-left py-1 border-b border-[var(--border)]">{h}</th>)}</tr></thead><tbody>{insights.tables.map(t => <tr key={t.name}>{[t.name, formatMetric('size_bytes', t.bytes), t.live, t.dead, t.scans].map((v, i) => <td key={i} className="py-1 border-b border-[var(--border)] mono">{v}</td>)}</tr>)}</tbody></table></>}
        </>
      )}
      {!insights && !error && <div className="text-xs text-[var(--faint)]">Loading insights…</div>}
    </div>
  );
}

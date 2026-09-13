import { useCallback, useEffect, useState } from "react";
import type { DbSchema, DbTable, QueryResult } from "../shared.ts";
import { dbApi, type DbSource } from "./dbApi.ts";
import { DataGrid, StructurePane } from "./DatabaseViews.tsx";
import { DatabaseFilterBuilder } from "./DatabaseFilterBuilder.tsx";
import { compileGroup, newGroup, type FilterModel } from "./dbFilter.ts";
import { orderBySql, toggleSort, type SortSpec } from "./dataGrid.ts";
import { tableSql } from "./sqlIdentifiers.ts";

export function TableDocument({ table, schema, source, writable, onDirty, onLatency }: {
  table: DbTable; schema: DbSchema; source: DbSource; writable: boolean;
  onDirty: (dirty: boolean) => void; onLatency: (ms: number) => void;
}) {
  const [pane, setPane] = useState("data");
  let [filter, setFilter] = useState<FilterModel>(newGroup);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sorts, setSorts] = useState<SortSpec[]>([]);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(100);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState<{ table: DbTable; result: QueryResult } | null>(null);
  const result = loaded?.result ?? null;
  const resultTable = loaded?.table ?? table;
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const columnKey = JSON.stringify(table.columns.map(({ name, type }) => [name, type]));
  const [filterColumns, setFilterColumns] = useState(columnKey);
  if (filterColumns !== columnKey) {
    filter = newGroup();
    setFilter(filter);
    setFilterColumns(columnKey);
    setSorts([]);
    setPage(0);
  }
  const { where, params } = compileGroup(filter, table.columns, source.kind);
  const query = `SELECT * FROM ${tableSql(table)}` + (where ? ` WHERE ${where}` : "") + orderBySql(sorts);
  const parameters = JSON.stringify(params);
  useEffect(() => {
    if (dirty) return;
    const abort = new AbortController();
    setError("");
    dbApi.query(source, query, params, size, page * size, abort.signal).then((r) => {
      if (!abort.signal.aborted) { setLoaded({ table, result: r }); onLatency(r.ms); }
    }).catch((e) => { if (!abort.signal.aborted) setError(String(e)); });
    return () => abort.abort();
  }, [query, parameters, size, page, revision, table, dirty]);
  const changed = useCallback((value: boolean) => { setDirty(value); onDirty(value); }, [onDirty]);
  const exportAll = async () => {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 100_000; offset += 5000) {
      const r = await dbApi.query(source, query, params, 5000, offset);
      rows.push(...r.rows);
      if (!r.hasMore) return { columns: r.columns, rows };
    }
    throw new Error("Export exceeds 100,000 rows; narrow the filter");
  };
  return <div className="document-body">
    <div className="toolbar">
      {['data', 'structure', 'ddl'].map((name) => <button key={name} className={pane === name ? 'active' : ''} disabled={dirty && name !== 'data'} onClick={() => setPane(name)}>{name === 'ddl' ? 'DDL' : name[0].toUpperCase() + name.slice(1)}</button>)}
      <span className="divider"/><button disabled={dirty} onClick={() => setFilterOpen(!filterOpen)}>Filter</button>
      <button disabled={dirty} onClick={() => setRevision(revision + 1)}>Refresh</button>
      <span className="ml-auto text-[var(--text-muted)]">{writable ? 'Writable · changes are staged' : 'Read Only'}</span>
    </div>
    {error && <div role="alert" className="error">{error}</div>}
    <div className={pane === 'data' ? 'document-body' : 'hidden'}>
      {filterOpen && <DatabaseFilterBuilder model={filter} cols={table.columns} dialect={source.kind} onChange={(value) => { if (!dirty) { setFilter(value); setPage(0); } }} />}
      <DataGrid table={resultTable} source={source} writable={writable} columns={resultTable.columns.map(c => c.name)} result={result} sorts={sorts} pageSize={size}
        onSort={(name, additive) => { setSorts(toggleSort(sorts, name, additive)); setPage(0); }} onPrevious={() => setPage(Math.max(0, page - 1))} onNext={() => setPage(page + 1)}
        onPageSize={(value) => { setSize(value); setPage(0); }} onDirtyChange={changed} onApplied={() => setRevision(revision + 1)} onExportAll={exportAll} />
    </div>
    {pane === 'structure' && <StructurePane table={table} schema={schema} />}
    {pane === 'ddl' && <pre className="p-4 overflow-auto text-xs mono">{table.ddl || 'DDL is unavailable for this object.'}</pre>}
  </div>;
}

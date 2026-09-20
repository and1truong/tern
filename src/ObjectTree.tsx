import { useState } from "react";
import { Table2, Eye, Search } from "lucide-react";
import type { DbSchema, DbTable } from "../shared/types.ts";
import { tableKey, tableLabel } from "../shared/sqlIdentifiers.ts";

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
    tables: visibleTables.filter((table) => (table.schema ?? (name === "main" ? "main" : "")) === name),
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

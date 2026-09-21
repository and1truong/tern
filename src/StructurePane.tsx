import type { DbColumn, DbSchema, DbTable } from "../shared/types.ts";

function TypeChip({ type }: { type: string }) {
  if (!type) return null;
  return <span className="mono text-[9px] px-1 rounded bg-[var(--hover)] text-[var(--muted)]">{type}</span>;
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
                {c.fk ? <span className="ml-1 text-[var(--faint)]">→ {[c.fk].flat().join(", ")}</span> : ""}
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

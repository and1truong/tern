// Staged row changes: the pending-edit lifecycle behind the data grid's
// Review/Apply transaction flow. Edits, deletes and inserts accumulate here,
// compile to RowChanges, and revert atomically — the grid never writes until
// the user confirms the generated statements.
import { useState } from "react";
import type { DbTable, RowChange } from "../shared/types.ts";
import { buildRowChanges } from "../shared/dataGrid.ts";

export function useStagedRows(table: DbTable, rows: Record<string, unknown>[], nonComparableColumns?: Set<string>) {
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [deleted, setDeleted] = useState<Set<number>>(() => new Set());
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const changes: RowChange[] = buildRowChanges(table, rows, edits, deleted, inserts, nonComparableColumns);
  const dirty = editing !== null || Object.keys(edits).length > 0 || deleted.size > 0 || inserts.length > 0;
  return {
    edits, deleted, inserts, editing, setEditing, changes, dirty,
    stageCell: (key: string, next: unknown, original: unknown) =>
      setEdits((current) => {
        const nextEdits = { ...current };
        if (Object.is(next, original)) delete nextEdits[key]; else nextEdits[key] = next;
        return nextEdits;
      }),
    stageDelete: (indices: Iterable<number>) => setDeleted((current) => new Set([...current, ...indices])),
    stageInsert: (values: Record<string, unknown>) => setInserts((current) => [...current, values]),
    stageInserts: (rows: Record<string, unknown>[]) => setInserts((current) => [...current, ...rows]),
    revert: () => { setEdits({}); setDeleted(new Set()); setInserts([]); setEditing(null); },
  };
}

export type StagedRows = ReturnType<typeof useStagedRows>;

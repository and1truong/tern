import { Plus, X } from "lucide-react";
import type { DbColumn } from "../shared.ts";
import {
  type FilterModel, type FilterGroup, type FilterRule, type FilterOp,
  type DbDialect, opsFor, defaultOp, opNeedsValue, newRule, newGroup, MAX_DEPTH,
} from "./dbFilter.ts";

export function DatabaseFilterBuilder({ model, cols, dialect, onChange }: {
  model: FilterModel; cols: DbColumn[]; dialect: DbDialect; onChange: (m: FilterModel) => void;
}) {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <GroupView group={model} cols={cols} dialect={dialect} depth={0} onChange={onChange} />
    </div>
  );
}

function GroupView({ group, cols, dialect, depth, onChange, onRemove }: {
  group: FilterGroup; cols: DbColumn[]; dialect: DbDialect; depth: number;
  onChange: (g: FilterGroup) => void; onRemove?: () => void;
}) {
  const replaceChild = (id: string, next: FilterRule | FilterGroup) =>
    onChange({ ...group, rules: group.rules.map((r) => (r.id === id ? next : r)) });
  const removeChild = (id: string) =>
    onChange({ ...group, rules: group.rules.filter((r) => r.id !== id) });
  const addRule = () => onChange({ ...group, rules: [...group.rules, newRule(cols)] });
  const addGroup = () => onChange({ ...group, rules: [...group.rules, newGroup()] });

  return (
    <div className={"flex flex-col gap-1.5 " + (depth > 0 ? "pl-3 border-l border-[var(--border)]" : "")}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-[var(--faint)] font-semibold">{depth === 0 ? "Match" : "Group"}</span>
        <select value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as "AND" | "OR" })}
          className="mono rounded border border-[var(--border-2)] bg-[var(--panel)] px-1.5 py-0.5 text-[var(--text)]">
          <option value="AND">all</option>
          <option value="OR">any</option>
        </select>
        <span className="text-[var(--faint)]">of</span>
        <button onClick={addRule} title="Add rule"
          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[var(--accent)] hover:bg-[var(--hover)] font-semibold">
          <Plus size={11} /> rule
        </button>
        {depth < MAX_DEPTH && (
          <button onClick={addGroup} title="Add nested group"
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[var(--muted)] hover:bg-[var(--hover)] font-semibold">
            <Plus size={11} /> group
          </button>
        )}
        {onRemove && (
          <button onClick={onRemove} title="Remove group"
            className="ml-auto w-5 h-5 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--red)]">
            <X size={11} />
          </button>
        )}
      </div>

      {group.rules.length === 0 && (
        <div className="text-[11px] text-[var(--faint)] italic pl-1">(match everything)</div>
      )}

      <div className="flex flex-col gap-1">
        {group.rules.map((r) =>
          "rules" in r ? (
            <GroupView key={r.id} group={r} cols={cols} dialect={dialect} depth={depth + 1}
              onChange={(g) => replaceChild(r.id, g)}
              onRemove={() => removeChild(r.id)} />
          ) : (
            <RuleView key={r.id} rule={r} cols={cols} dialect={dialect}
              onChange={(nr) => replaceChild(r.id, nr)}
              onRemove={() => removeChild(r.id)} />
          ),
        )}
      </div>
    </div>
  );
}

function RuleView({ rule, cols, dialect, onChange, onRemove }: {
  rule: FilterRule; cols: DbColumn[]; dialect: DbDialect; onChange: (r: FilterRule) => void; onRemove: () => void;
}) {
  const col = cols[rule.col];
  const ops = opsFor(col?.type ?? "TEXT", dialect);
  const needsValue = opNeedsValue(rule.op);
  // Changing the column resets the op to that type's default and clears the value,
  // so a stale numeric op never runs against a text column (or vice versa).
  const setCol = (idx: number) =>
    onChange({ ...rule, col: idx, op: defaultOp(cols[idx]?.type ?? "TEXT"), value: "" });

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <select value={rule.col} onChange={(e) => setCol(Number(e.target.value))}
        className="mono rounded border border-[var(--border-2)] bg-[var(--panel)] px-1.5 py-0.5 text-[var(--text)] max-w-[40%]">
        {cols.map((c, i) => (
          <option key={c.name} value={i}>{c.name}{c.type ? ` (${c.type})` : ""}</option>
        ))}
      </select>
      <select value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as FilterOp })}
        className="mono rounded border border-[var(--border-2)] bg-[var(--panel)] px-1.5 py-0.5 text-[var(--muted)]">
        {ops.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
      {needsValue && (
        <input value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}
          placeholder="value" spellCheck={false}
          className="mono rounded border border-[var(--border-2)] bg-[var(--panel)] px-1.5 py-0.5 text-[var(--text)] w-28" />
      )}
      <button onClick={onRemove} title="Remove rule"
        className="w-5 h-5 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--red)]">
        <X size={11} />
      </button>
    </div>
  );
}

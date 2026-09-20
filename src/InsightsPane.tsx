import { useCallback, useEffect, useRef, useState } from "react";
import Notice from "./Notice.tsx";
import { dbApi } from "./dbApi.ts";
import type { DbSource } from "./dbApi.ts";
import type { DatabaseInsights } from "../shared/types.ts";

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

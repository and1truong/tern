import { useEffect, useRef, useState } from "react";
import type { DbSchema } from "../shared/types.ts";
import { tableKey, tableLabel } from "../shared/sqlIdentifiers.ts";
import { relationTarget, schemaRelations, schemaToMermaid } from "./schemaDiagram.ts";

export function SchemaDiagramPane({ schema, visible = true }: { schema: DbSchema; visible?: boolean }) {
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
  // Hidden (display:none) panes measure 0 — refit once the tab becomes
  // visible or the 10% floor stays squashed until a manual Fit.
  useEffect(() => { if (visible) fit(); }, [schema, visible]);
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
          const target = relationTarget(tables, r.toTable);
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

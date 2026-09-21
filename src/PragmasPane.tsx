function EmptyHint({ text }: { text: string }) {
  return <div className="flex-1 grid place-items-center text-[var(--faint)] text-xs px-6 text-center">{text}</div>;
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

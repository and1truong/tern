// Match /api/state's serialized character limit; never truncate editor contents.
export function boundConsoleHistory<T extends { history: unknown[] }>(state: T): T {
  const history: unknown[] = [];
  let size = JSON.stringify({ ...state, history }).length;
  for (const entry of state.history.slice(0, 100)) {
    const added = JSON.stringify(entry).length + (history.length ? 1 : 0);
    if (size + added > 2_000_000) break;
    history.push(entry);
    size += added;
  }
  return { ...state, history };
}

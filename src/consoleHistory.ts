const LIMIT = 2_000_000;

// Match /api/state's serialized character limit. History is the first thing
// dropped; only a pathological multi-MB paste ever truncates the editor
// buffer, and favorites are bounded last.
export function boundConsoleHistory<T extends { history: unknown[]; input?: string; favorites?: unknown[]; tabs?: { sql?: string }[] }>(state: T): T {
  const history: unknown[] = [];
  let size = JSON.stringify({ ...state, history }).length;
  for (const entry of state.history.slice(0, 100)) {
    const added = JSON.stringify(entry).length + (history.length ? 1 : 0);
    if (size + added > LIMIT) break;
    history.push(entry);
    size += added;
  }
  // An oversized input/favorites/tab buffer would make every state.set
  // reject — halve them until the serialized object fits. Escapes only grow
  // a string, so each halving strictly shrinks the serialized form.
  let input = state.input ?? "";
  let favorites = (state.favorites ?? []).slice(0, 50);
  let tabs = state.tabs;
  const sizeOf = (t: typeof tabs) => JSON.stringify({ ...state, history, input, favorites, tabs: t }).length;
  const fits = () => sizeOf(tabs) <= LIMIT;
  while (input.length && !fits()) input = input.slice(0, input.length >> 1);
  while (favorites.length && !fits()) favorites = favorites.slice(0, favorites.length >> 1);
  if (tabs && !fits()) {
    // The SQL editor keeps its buffer in tabs[].sql — a pathological paste
    // lives there, not in input. Halve the longest tab until it fits.
    const shrink = tabs.map(t => ({ ...t }));
    while (sizeOf(shrink) > LIMIT) {
      const longest = shrink.reduce((a, b) => (b.sql?.length ?? 0) > (a.sql?.length ?? 0) ? b : a);
      if (!longest.sql?.length) break;
      longest.sql = longest.sql.slice(0, longest.sql.length >> 1);
    }
    tabs = shrink;
  }
  return { ...state, history, input, favorites, ...(tabs ? { tabs } : {}) };
}

// SQL statements can carry credentials (ALTER ROLE x PASSWORD 's3cret',
// CREATE USER ... IDENTIFIED BY 's3cret') — like the redis console's AUTH/URL
// redaction, scrub literal secrets before persisting to plaintext app state.
export function redactSqlSecrets(sql: string): string {
  // Literals come in three forms: 'x' (with '' or backslash escapes), "x",
  // and dollar quoting ($tag$...$tag$) — an unmatched form leaks the secret
  // fragment. Unterminated literals (the buffer persists while typing) are
  // covered by the $-anchored alternatives, and password='x' conninfo too.
  // Value-shaped expressions (crypt('pw', ...), ('x')) also carry secrets;
  // a bare token only counts after '=' — 'SELECT password FROM t' and
  // 'PASSWORD NULL' are identifiers/keywords, not secrets. Dollar tags take
  // [^\s$]* (Postgres allows digits/non-ASCII past the first char) and a
  // comment between keyword and value still bridges. A pasted DSN keeps its
  // password too — like the redis console, any scheme:// URI's userinfo is
  // stripped rather than enumerating schemes.
  const redacted = sql.replace(/([a-z][a-z0-9+.-]*:\/\/)\S*@/gi, "$1(redacted)@");
  // '…', "…" and `…` regions are data or identifiers — a keyword inside one
  // (SELECT 'password' FROM t) is not a secret, and the value alternation
  // would consume the closing quote and mangle the persisted buffer. The
  // keyword's own literal value is still consumed — only matches that START
  // inside a quoted region are skipped.
  const literals: [number, number][] = [];
  for (let i = 0; i < redacted.length; i++) {
    const ch = redacted[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const start = i++;
      while (i < redacted.length) {
        if (redacted[i] === ch) {
          if (redacted[i + 1] === ch) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      literals.push([start, i]);
    }
  }
  return redacted.replace(
    /\b(password|identified\s+(?:with\s+\S+\s+)?by(?:\s+values)?)\b(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*(?:=(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*((?:e|b|x|n|u&)?'(?:[^'\\]|\\.|'')*'|"[^"]*"|\$([^\s$]*)\$[\s\S]*?\$\3\$|(?:e|b|x|n|u&)?'(?:[^'\\]|\\.|'')*$|"[^"]*$|\$[^\s$]*\$[\s\S]*$|\([^;]*\)|\w+\s*\([^;]*\)|[^\s;'"()]+)|((?:e|b|x|n|u&)?'(?:[^'\\]|\\.|'')*'|"[^"]*"|\$([^\s$]*)\$[\s\S]*?\$\5\$|(?:e|b|x|n|u&)?'(?:[^'\\]|\\.|'')*$|"[^"]*$|\$[^\s$]*\$[\s\S]*$|\([^;]*\)|\w+\s*\([^;]*\)))/gi,
    (...args) => {
      const offset = args[args.length - 2] as number;
      return literals.some(([a, b]) => offset >= a && offset < b) ? args[0] as string : `${args[1]} '(redacted)'`;
    },
  );
}

// Console input is persisted to app state (plaintext SQLite) — anything that
// carries Redis credentials (AUTH, HELLO AUTH) must be redacted before it is
// written, and history/favorites must never store the raw text either.
// Deliberately whitespace-token based: never throws on partial input.
export function redactSensitive(input: string): string {
  return input.split("\n").map(redactLine).join("\n");
}

function redactLine(line: string): string {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const name = (parts[0] ?? "").toUpperCase();
  if (name === "AUTH") {
    if (parts.length >= 3) return `${parts[0]} ${parts[1]} (redacted)`;      // AUTH username password
    if (parts.length === 2) return `${parts[0]} (redacted)`;                 // AUTH password
    return line;
  }
  if (name === "HELLO") {
    const idx = parts.findIndex(p => p.toUpperCase() === "AUTH");
    if (idx === -1) return line;
    // HELLO protover AUTH username password — redact username and password.
    const kept = parts.slice(0, idx + 1);
    const sensitive = parts.slice(idx + 1);
    return [...kept, ...sensitive.map(() => "(redacted)")].join(" ");
  }
  return line;
}

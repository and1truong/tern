// Console input is persisted to app state (plaintext SQLite) — anything that
// carries Redis credentials (AUTH, HELLO AUTH) must be redacted before it is
// written, and history/favorites must never store the raw text either.
// Deliberately whitespace-token based (never throws on partial input) and
// redacts every argument after the credential keyword: quoted passwords with
// spaces must not survive even partially.
export function redactSensitive(input: string): string {
  return input.split("\n").map(redactLine).join("\n");
}

function redactLine(line: string): string {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const name = (parts[0] ?? "").toUpperCase();
  if (name === "AUTH") {
    // Everything after the command may be or contain the password.
    return parts.length >= 2 ? `AUTH (redacted)` : line;
  }
  if (name === "HELLO") {
    const idx = parts.findIndex(p => p.toUpperCase() === "AUTH");
    if (idx === -1) return line;
    const kept = parts.slice(0, idx + 1);
    return [...kept, "(redacted)"].join(" ");
  }
  return line;
}

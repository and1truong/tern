// Console input is persisted to app state (plaintext SQLite) — anything that
// carries Redis credentials must be redacted before it is written, and
// history/favorites must never store the raw text either.
// Token-based (redis-cli quoting rules, so a quoted command name cannot slip
// past the check) and never throws on partial input: unparseable lines fall
// back to whitespace splitting. Everything after the credential keyword is
// redacted — quoted passwords with spaces must not survive even partially.
import { tokenizeCommand } from "../datasources/redis/resp.ts";

export function redactSensitive(input: string): string {
  return input.split("\n").map(redactLine).join("\n");
}

function redactLine(line: string): string {
  let parts: string[];
  try { parts = tokenizeCommand(line); }
  catch { parts = line.trim().split(/\s+/).filter(Boolean); }
  const name = (parts[0] ?? "").toUpperCase();
  // Rebuild the line with everything after `index` collapsed to (redacted).
  const redactAfter = (index: number) => [...parts.slice(0, index + 1), "(redacted)"].join(" ");

  if (name === "AUTH") {
    // Everything after the command may be or contain the password.
    return parts.length >= 2 ? redactAfter(0) : line;
  }
  if (name === "HELLO" || name === "MIGRATE") {
    // HELLO 3 AUTH user pass · MIGRATE … AUTH pass | AUTH2 user pass
    const idx = parts.findIndex(p => p.toUpperCase() === "AUTH" || p.toUpperCase() === "AUTH2");
    return idx === -1 ? line : redactAfter(idx);
  }
  if (name === "CONFIG") {
    // CONFIG SET masterauth|requirepass <password>
    if (parts[1]?.toUpperCase() === "SET" && ["MASTERAUTH", "REQUIREPASS"].includes(parts[2]?.toUpperCase() ?? "")) {
      return redactAfter(2);
    }
    return line;
  }
  if (name === "ACL") {
    // ACL SETUSER user >password #hashed … — each credential token redacts.
    if (parts[1]?.toUpperCase() !== "SETUSER") return line;
    return parts.map(p => /^[>#]/.test(p) ? "(redacted)" : p).join(" ");
  }
  return line;
}

// Console input is persisted to app state (plaintext SQLite) — anything that
// carries Redis credentials must be redacted before it is written, and
// history/favorites must never store the raw text either.
// Token-based (redis-cli quoting rules, so a quoted command name cannot slip
// past the check) and never throws on partial input: unparseable lines fall
// back to whitespace splitting. Everything after the credential keyword is
// redacted — quoted passwords with spaces must not survive even partially.
import { tokenizeCommand } from "../datasources/redis/resp.ts";

// CONFIG SET parameters whose values are credentials.
const CONFIG_SECRET_PARAMS = new Set(["MASTERAUTH", "REQUIREPASS", "TLS-KEY-FILE-PASS", "TLS-CLIENT-KEY-FILE-PASS"]);

export function redactSensitive(input: string): string {
  return input.split("\n").map(redactLine).join("\n");
}

function redactLine(line: string): string {
  // A pasted connection URL keeps its password anywhere on the line. Match
  // greedily to the LAST '@' before whitespace — an '@' inside the password
  // must not leave a fragment behind; over-redaction is safe here, so any
  // scheme: URI's userinfo is stripped rather than enumerating schemes.
  line = line.replace(/([a-z][a-z0-9+.-]*:\/\/)\S*@/gi, "$1(redacted)@");
  let parts: string[];
  try { parts = tokenizeCommand(line); }
  catch { parts = line.trim().split(/\s+/).filter(Boolean); }
  // The unparseable-line fallback keeps quote characters on its tokens, so
  // command/keyword comparisons run against quote-stripped tokens.
  const norm = parts.map(p => p.replace(/^["']+|["']+$/g, "").toUpperCase());
  const name = norm[0] ?? "";
  // Rebuild the line with everything after `index` collapsed to (redacted).
  const redactAfter = (index: number) => [...parts.slice(0, index + 1), "(redacted)"].join(" ");

  if (name === "AUTH") {
    // Everything after the command may be or contain the password.
    return parts.length >= 2 ? redactAfter(0) : line;
  }
  if (name === "HELLO" || name === "MIGRATE") {
    // HELLO 3 AUTH user pass · MIGRATE … AUTH pass | AUTH2 user pass
    const idx = norm.findIndex(p => p === "AUTH" || p === "AUTH2");
    return idx === -1 ? line : redactAfter(idx);
  }
  if (name === "CONFIG") {
    // CONFIG SET <credential param> <password>
    if (norm[1] === "SET" && CONFIG_SECRET_PARAMS.has(norm[2] ?? "")) {
      return redactAfter(2);
    }
    return line;
  }
  if (name === "SENTINEL") {
    // SENTINEL SET <master> auth-pass|auth-user <credential>
    if (norm[1] === "SET") {
      const idx = norm.findIndex(p => p === "AUTH-PASS" || p === "AUTH-USER");
      return idx === -1 ? line : redactAfter(idx);
    }
    return line;
  }
  if (name === "ACL") {
    // ACL SETUSER user >password #hashed <password !hashed — `>`/`#` add and
    // `<`/`!` remove credentials; all four carry secret material. A leading
    // quote survives the unparseable-line fallback, so skip it when testing.
    if (norm[1] !== "SETUSER") return line;
    return parts.map(p => /^["']?[>#<!]/.test(p) ? "(redacted)" : p).join(" ");
  }
  return line;
}

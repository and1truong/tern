// Built-in Redis/Valkey command catalog. Pure data + lookup, shared by the
// server (write classification, catalog enrichment) and the client bundle
// (autocomplete, explain, lint). Runtime COMMAND DOCS metadata may refine
// summaries/complexity, but the safety model here is authoritative.
export type CommandGroup =
  | "key" | "string" | "hash" | "list" | "set" | "sorted-set" | "stream"
  | "connection" | "server" | "scripting" | "pubsub" | "transactions" | "cluster";

export interface CommandArgSpec {
  name: string;
  type?: "key" | "string" | "int" | "double" | "pattern" | "enum" | "unix-time";
  description?: string;
  enum?: string[];        // for type "enum": literal tokens
  optional?: boolean;
  multiple?: boolean;     // repeats (with its enum values if present)
}

export interface CommandDoc {
  name: string;               // canonical uppercase
  group: CommandGroup;
  arity: number;              // Redis arity: positive exact, negative means minimum (-x ⇒ at least x incl. command name)
  summary: string;
  since: string;
  access: "read" | "write" | "read-write" | "admin";
  complexity?: string;
  args?: CommandArgSpec[];
  returns?: string;           // expected result, human phrasing
  blocking?: boolean;
  ttl?: "clear" | "set" | "none";
  danger?: "destructive" | "full-scan" | "admin" | "config";
  keyPositions?: number[];    // 0-based arg positions (after the command name) holding key names
  notes?: string;             // cluster/large-key guidance shown by explain
}

export const commandCatalog: CommandDoc[] = [];

const byName = new Map<string, CommandDoc>();

export function lookupCommand(name: string): CommandDoc | null {
  if (!byName.size) for (const doc of commandCatalog) byName.set(doc.name, doc);
  return byName.get(name.toUpperCase()) ?? null;
}

export function isWriteCommand(doc: CommandDoc | null): boolean {
  return doc !== null && doc.access !== "read";
}

// Resolve the blocking timeout (in seconds) for a blocking command's args.
// Returns null when the command is not blocking or the timeout is undetermined;
// 0 means "blocks indefinitely".
const BLOCKING_TIMEOUT: Record<string, "first" | "last"> = {
  BLPOP: "last", BRPOP: "last", BZPOPMIN: "last", BZPOPMAX: "last",
  BLMOVE: "last", BRPOPLPUSH: "last", BLMPOP: "first",
};

export function blockingTimeoutSeconds(doc: CommandDoc, args: string[]): number | null {
  if (!doc.blocking) return null;
  if (doc.name === "XREAD" || doc.name === "XREADGROUP") {
    const idx = args.findIndex(a => a.toUpperCase() === "BLOCK");
    if (idx === -1 || idx + 1 >= args.length) return null;
    const ms = Number(args[idx + 1]);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  const position = BLOCKING_TIMEOUT[doc.name];
  if (!position) return null;
  const raw = position === "last" ? args.at(-1) : args[0];
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

// Redis has no EXPLAIN — Tern explains commands from the built-in catalog:
// semantics, access classification, complexity, blocking behavior, TTL side
// effects, cluster implications and safety risks. Pure and offline.
import { blockingTimeoutSeconds, lookupCommand, commandKeys, argRoles, isReadAllowed, UNSHARED_CLIENT_SUBCOMMANDS, UNSHARED_CONNECTION_COMMANDS, type CommandDoc } from "./catalog.ts";
import { tokenizeCommand } from "./resp.ts";
import type { Capabilities } from "../../shared/types.ts";

export interface CommandExplanation {
  name: string;
  known: boolean;
  summary: string;
  access: "read" | "write" | "read-write" | "admin" | "unknown";
  complexity?: string;
  blocking: boolean;
  ttlEffect: string;
  expected?: string;
  args: { token: string; meaning: string }[];
  dangers: string[];
  cluster: string[];
  risks: string[];
}

export function explainCommand(input: string, capabilities: Pick<Capabilities, "cluster">): CommandExplanation {
  let tokens: string[];
  try { tokens = tokenizeCommand(input); }
  catch (error) { return unknownExplanation(input, error instanceof Error ? error.message : "unparseable command"); }
  if (!tokens.length) return unknownExplanation("", "empty command");
  const name = tokens[0]!.toUpperCase();
  const args = tokens.slice(1);
  const doc = lookupCommand(name);
  // The console refuses commands that would corrupt the shared transport —
  // explain the refusal alongside the command, not just its semantics.
  const refused = UNSHARED_CONNECTION_COMMANDS[name];
  if (!doc) {
    const explanation = unknownExplanation(name, "not in the built-in catalog");
    if (refused) explanation.dangers.push(`Refused by the console: ${refused}.`);
    return explanation;
  }

  const argsExplanation = mapArgs(doc, args);
  const dangers: string[] = [];
  if (refused) dangers.push(`Refused by the console: ${refused}.`);
  if (name === "CLIENT" && UNSHARED_CLIENT_SUBCOMMANDS.test(args[0] ?? "")) {
    dangers.push(`Refused by the console: CLIENT ${args[0]!.toUpperCase()} mutates the shared connection.`);
  }
  if (name === "SCRIPT" && /^DEBUG$/i.test(args[0] ?? "")) {
    dangers.push("Refused by the console: SCRIPT DEBUG puts the shared connection into the Lua debugger.");
  }
  if (doc.danger === "destructive") dangers.push("Destructive: removes data.");
  if (doc.danger === "full-scan") dangers.push("Scans the entire keyspace and blocks the server while it runs.");
  if (doc.danger === "admin") dangers.push("Administrative command — affects server behavior.");
  if (doc.danger === "config") dangers.push("Changes server configuration.");

  const cluster: string[] = [];
  if (capabilities.cluster) {
    const keys = commandKeys(doc, args);
    if (keys.length >= 2) {
      const tags = new Set(keys.map(hashTagOf));
      if (tags.size > 1) cluster.push("Multi-key command across different hash slots — may fail with CROSSSLOT; wrap keys in matching {hash tags}.");
    } else if (keys.length === 1) {
      cluster.push("Single key — slot-safe.");
    }
  }

  const risks: string[] = [];
  // XREAD/XREADGROUP only block when BLOCK is given; for them a null timeout
  // means "not blocking at all", not "unknown duration".
  // WAIT/WAITAOF with all-zero replica counts are trivially satisfied and
  // XREAD only blocks with BLOCK — catalog "blocking" alone isn't enough.
  const conditionalBlock = doc.name === "XREAD" || doc.name === "XREADGROUP" || doc.name === "WAIT" || doc.name === "WAITAOF";
  const blockSeconds = doc.blocking ? blockingTimeoutSeconds(doc, args) : null;
  const actuallyBlocking = doc.blocking === true && !(conditionalBlock && blockSeconds === null);
  if (actuallyBlocking) {
    if (blockSeconds === 0) risks.push("Blocks indefinitely with timeout 0 — the console refuses this; pass a positive timeout.");
    else risks.push(`Blocks the connection up to ${blockSeconds ?? "?"} second(s) waiting for data.`);
  }
  if (doc.danger === "full-scan") risks.push("Full keyspace scan — prefer SCAN with a cursor.");
  const minimum = doc.arity < 0 ? -doc.arity : doc.arity;
  if (tokens.length < minimum) risks.push(`Arity mismatch: expected at least ${minimum} tokens including the command, got ${tokens.length}.`);
  if (doc.arity > 0 && tokens.length !== doc.arity) risks.push(`Arity mismatch: command takes exactly ${doc.arity - 1} argument(s), got ${args.length}.`);
  if (doc.notes) risks.push(doc.notes);

  // A "read" doc with a write option flag (SORT … STORE, GEORADIUS … STORE)
  // is effectively a write — report what exec and lint will enforce.
  const writeFlag = doc.access === "read" && !isReadAllowed(doc, args);
  if (writeFlag) risks.push(`${name} writes a new key with these options — requires a writable session.`);
  const effectiveAccess = writeFlag ? "write" as const : doc.access;

  const ttlEffect = doc.ttl === "clear" ? "clears the key TTL"
    : doc.ttl === "set" ? "sets or modifies the key TTL"
    : "none";

  return {
    name, known: true, summary: doc.summary, access: effectiveAccess,
    complexity: doc.complexity, blocking: actuallyBlocking, ttlEffect,
    expected: doc.returns, args: argsExplanation, dangers, cluster, risks,
  };
}

function unknownExplanation(name: string, note: string): CommandExplanation {
  return {
    name: name.toUpperCase(), known: false, summary: note, access: "unknown",
    blocking: false, ttlEffect: "none", args: [], dangers: [], cluster: [], risks: [],
  };
}

function mapArgs(doc: CommandDoc, args: string[]): { token: string; meaning: string }[] {
  return argRoles(doc, args).map(({ token, spec }) => {
    if (!spec) return { token, meaning: "additional argument" };
    const base = spec.description ?? spec.enum?.join(" | ") ?? spec.type ?? "";
    return { token, meaning: `${spec.name}${base ? ` — ${base}` : ""}` };
  });
}

// Cluster slot affinity: "{user1}.profile" hashes "user1". Redis hashes the
// substring between the FIRST "{" and the FIRST "}" after it — only when
// non-empty. "a{}b{c}" therefore hashes the whole key, not "c".
export function hashTagOf(key: string): string {
  const open = key.indexOf("{");
  if (open === -1) return key;
  const close = key.indexOf("}", open + 1);
  return close > open + 1 ? key.slice(open + 1, close) : key;
}

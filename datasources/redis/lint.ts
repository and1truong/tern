// Static safety checks for Redis commands: risky patterns surface warnings,
// never silent rewrites — the console always executes the exact input, and the
// server still enforces read-only sessions.
import { blockingTimeoutSeconds, isWriteCommand, lookupCommand, commandKeys } from "./catalog.ts";
import { tokenizeCommand } from "./resp.ts";
import { hashTagOf } from "./explain.ts";

export interface LintWarning {
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion?: string;
}

export function lintCommand(input: string, opts: { writable: boolean; cluster: boolean }): LintWarning[] {
  let tokens: string[];
  try { tokens = tokenizeCommand(input); }
  catch (error) {
    return [{ rule: "parse", severity: "info", message: error instanceof Error ? error.message : "Command does not parse" }];
  }
  if (!tokens.length) return [];
  const name = tokens[0]!.toUpperCase();
  const args = tokens.slice(1);
  const doc = lookupCommand(name);
  const warnings: LintWarning[] = [];

  if (!doc) {
    if (!opts.writable) {
      warnings.push({
        rule: "unclassified-readonly", severity: "error",
        message: `${name} is not in the command catalog; read-only sessions only run known read commands.`,
        suggestion: "Enable writes for this session to run unclassified commands.",
      });
    }
    return warnings;
  }

  if (doc.name === "KEYS") {
    warnings.push({
      rule: "keys-full-scan", severity: "warning",
      message: "KEYS scans the whole keyspace and blocks the server while it runs.",
      suggestion: "Use SCAN with a cursor instead.",
    });
  }
  if (doc.name === "FLUSHALL" || doc.name === "FLUSHDB") {
    warnings.push({
      rule: "flush-destructive", severity: "error",
      message: `${doc.name} removes every key ${doc.name === "FLUSHALL" ? "from all databases" : "in this database"}.`,
      suggestion: "Double-check the target connection before running this.",
    });
  }
  if (isUnboundedRead(doc.name, args)) {
    warnings.push({
      rule: "unbounded-read", severity: "warning",
      message: "Reads the entire collection; large keys can stall the server.",
      suggestion: "Page with SCAN-family commands or bounded indexes.",
    });
  }
  if (doc.blocking && blockingTimeoutSeconds(doc, args) === 0) {
    warnings.push({
      rule: "blocking-indefinite", severity: "error",
      message: `${doc.name} with timeout 0 blocks indefinitely; the console refuses this.`,
      suggestion: "Pass a positive timeout in seconds.",
    });
  }
  if (doc.access === "admin") {
    warnings.push({
      rule: "admin-command", severity: "warning",
      message: "Administrative command — verify the target server before running it.",
    });
  }
  if (isWriteCommand(doc) && !opts.writable) {
    warnings.push({
      rule: "write-readonly", severity: "error",
      message: `${doc.name} is a ${doc.access} command on a read-only session.`,
      suggestion: "Enable writes for this session to run it.",
    });
  }
  if (opts.cluster) {
    const keys = commandKeys(doc, args);
    if (keys.length >= 2 && new Set(keys.map(hashTagOf)).size > 1) {
      warnings.push({
        rule: "cross-slot", severity: "warning",
        message: "Keys hash to different cluster slots; the server may reject this with CROSSSLOT.",
        suggestion: "Wrap related keys in matching {hash tags}.",
      });
    }
  }
  const minimum = doc.arity < 0 ? -doc.arity : doc.arity;
  if (tokens.length < minimum) {
    warnings.push({
      rule: "arity", severity: "info",
      message: `Arity mismatch: ${doc.name} expects at least ${minimum - 1} argument(s), got ${args.length}.`,
    });
  } else if (doc.arity > 0 && tokens.length !== doc.arity) {
    warnings.push({
      rule: "arity", severity: "info",
      message: `Arity mismatch: ${doc.name} takes exactly ${doc.arity - 1} argument(s), got ${args.length}.`,
    });
  }
  return warnings;
}

function isUnboundedRead(name: string, args: string[]): boolean {
  if (["SMEMBERS", "HGETALL", "HKEYS", "HVALS"].includes(name)) return true;
  if (name === "LRANGE") return args[1] === "0" && args[2] === "-1";
  if (name === "ZRANGE") {
    const index = args.findIndex(a => a.toUpperCase() === "BYSCORE" || a.toUpperCase() === "BYLEX");
    const start = index === -1 ? args[1] : undefined;
    const stop = index === -1 ? args[2] : undefined;
    return start === "0" && stop === "-1";
  }
  return false;
}

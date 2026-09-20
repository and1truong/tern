// Static safety checks for Redis commands: risky patterns surface warnings,
// never silent rewrites — the console always executes the exact input, and the
// server still enforces read-only sessions.
import { blockingTimeoutSeconds, isReadAllowed, isWriteCommand, lookupCommand, commandKeys, MAX_BLOCK_SECONDS, UNSHARED_CLIENT_SUBCOMMANDS, UNSHARED_CONNECTION_COMMANDS, WRITE_OPTION_FLAGS } from "./catalog.ts";
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

  // The console refuses connection-state commands outright — warn up front,
  // not after the error reply arrives. This check is keyed on the command
  // name so uncataloged refusals (SYNC, ASKING, …) still warn.
  const refused = UNSHARED_CONNECTION_COMMANDS[name];
  if (refused) {
    warnings.push({
      rule: "refused-command", severity: "error",
      message: `${name} is refused by the console: ${refused}.`,
    });
  }
  if (name === "CLIENT" && UNSHARED_CLIENT_SUBCOMMANDS.test(args[0] ?? "")) {
    warnings.push({
      rule: "refused-command", severity: "error",
      message: `CLIENT ${args[0]!.toUpperCase()} is refused by the console: it mutates the shared connection.`,
    });
  }
  // SCRIPT DEBUG parks the shared transport inside the Lua debugger.
  if (name === "SCRIPT" && /^DEBUG$/i.test(args[0] ?? "")) {
    warnings.push({
      rule: "refused-command", severity: "error",
      message: "SCRIPT DEBUG is refused by the console: it puts the shared connection into the Lua debugger.",
    });
  }

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
  if (doc.blocking) {
    const blockSeconds = blockingTimeoutSeconds(doc, args);
    if (blockSeconds === 0) {
      warnings.push({
        rule: "blocking-indefinite", severity: "error",
        message: `${doc.name} with timeout 0 blocks indefinitely; the console refuses this.`,
        suggestion: "Pass a positive timeout in seconds.",
      });
    } else if (blockSeconds !== null && blockSeconds > MAX_BLOCK_SECONDS) {
      warnings.push({
        rule: "blocking-timeout-max", severity: "error",
        message: `${doc.name} timeout exceeds the console maximum of ${MAX_BLOCK_SECONDS} seconds; the console refuses this.`,
      });
    }
  }
  if (doc.access === "admin") {
    warnings.push({
      rule: "admin-command", severity: "warning",
      message: "Administrative command — verify the target server before running it.",
    });
  }
  if (!isReadAllowed(doc, args) && !opts.writable) {
    // A "read"-classified command carrying a write flag (SORT … STORE,
    // GEORADIUS … STORE, GETEX … EX) writes despite its classification.
    const writeFlag = WRITE_OPTION_FLAGS[doc.name]?.(args);
    warnings.push({
      rule: "write-readonly", severity: "error",
      message: isWriteCommand(doc)
        ? `${doc.name} is a ${doc.access} command on a read-only session.`
        : `${doc.name} ${writeFlag} is a write option; read-only sessions cannot run it.`,
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
  const intValue = (s?: string) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : NaN);
  // A trailing LIMIT/COUNT bounds the reply only when it's a real bound:
  // LIMIT 0 means "unlimited" (*INTERCARD), a negative LIMIT count returns
  // everything from the offset (ZRANGE family), and a non-positive COUNT is
  // a server error — none of those suppress the whole-collection warning.
  const boundedTail = (a: string[]) => {
    if (/^(?:COUNT|LIMIT)$/i.test(a.at(-2) ?? "")) return intValue(a.at(-1)) > 0;
    if (/^LIMIT$/i.test(a.at(-3) ?? "")) return intValue(a.at(-1)) >= 0;
    return false;
  };
  const fullIndex = (a?: string, b?: string) => (a === "0" || a === "-0") && b === "-1";
  // Bounds are case-insensitive server-side and may carry an exclusive "(".
  const bound = (a?: string) => a?.toLowerCase().replace(/^\(/, "");
  const fullScore = (min?: string, max?: string) => bound(min) === "-inf" && bound(max) === "+inf";
  const fullLex = (min?: string, max?: string) => bound(min) === "-" && bound(max) === "+";
  // Whole-collection O(N) reads — the set/zset algebra commands read every
  // member of every key, the same stall risk as SMEMBERS; the *STORE
  // variants do the same read plus a write.
  if (["SMEMBERS", "HGETALL", "HKEYS", "HVALS", "SINTER", "SUNION", "SDIFF", "ZINTER", "ZUNION", "ZDIFF", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE", "ZINTERSTORE", "ZUNIONSTORE"].includes(name)) return true;
  // *INTERCARD's LIMIT option caps the cardinality read.
  if (name === "SINTERCARD" || name === "ZINTERCARD") return !boundedTail(args);
  // SORT reads the whole collection (BY/GET multiply that per element);
  // a LIMIT tail caps it.
  if (name === "SORT" || name === "SORT_RO") return !boundedTail(args);
  // XINFO STREAM k FULL returns every entry — an XRANGE - + in disguise —
  // unless a COUNT tail caps it.
  if (name === "XINFO") return /^STREAM$/i.test(args[0] ?? "") && /^FULL$/i.test(args[2] ?? "") && !boundedTail(args);
  // LCS compares both strings end-to-end; LEN bounds the reply to a count.
  if (name === "LCS") return !args.slice(2).some(a => /^LEN$/i.test(a));
  // XREAD STREAMS k 0 replays the entire stream — an XRANGE k - + in
  // disguise — unless COUNT bounds the reply.
  if (name === "XREAD" || name === "XREADGROUP") {
    // Same positional option zone as blockingTimeoutSeconds — a group or
    // consumer literally named STREAMS/COUNT is an argument, not a keyword.
    let count = false;
    let streamsAt = -1;
    for (let i = name === "XREADGROUP" ? 3 : 0; i < args.length; i++) {
      const t = args[i]!.toUpperCase();
      if (t === "STREAMS") { streamsAt = i; break; }
      if (t === "COUNT") { count = true; i++; }
    }
    if (streamsAt < 0 || count) return false;
    const tail = args.slice(streamsAt + 1);
    return tail.slice(Math.ceil(tail.length / 2)).some(id => /^0+(?:-\d+)?$/.test(id));
  }
  if (name === "LRANGE" || name === "GETRANGE" || name === "SUBSTR") return fullIndex(args[1], args[2]);
  if (name === "ZREVRANGE") return fullIndex(args[1], args[2]);
  // Full stream ranges ("-" to "+" — XREVRANGE takes the bounds reversed);
  // a trailing COUNT/LIMIT caps the reply.
  if (name === "XRANGE") return fullLex(args[1], args[2]) && !boundedTail(args);
  if (name === "XREVRANGE") return fullLex(args[2], args[1]) && !boundedTail(args);
  if (name === "ZRANGEBYSCORE") return fullScore(args[1], args[2]) && !boundedTail(args);
  // REV variants take the range bounds in reverse order (max then min).
  if (name === "ZREVRANGEBYSCORE") return fullScore(args[2], args[1]) && !boundedTail(args);
  if (name === "ZRANGEBYLEX") return fullLex(args[1], args[2]) && !boundedTail(args);
  if (name === "ZREVRANGEBYLEX") return fullLex(args[2], args[1]) && !boundedTail(args);
  if (name === "ZRANGE") {
    const modifier = args.slice(3).find(a => a.toUpperCase() === "BYSCORE" || a.toUpperCase() === "BYLEX")?.toUpperCase();
    // With REV the bound order flips: the full score range is "+inf -inf".
    const rev = args.slice(3).some(a => a.toUpperCase() === "REV");
    if (modifier === "BYSCORE") return (rev ? fullScore(args[2], args[1]) : fullScore(args[1], args[2])) && !boundedTail(args);
    if (modifier === "BYLEX") return (rev ? fullLex(args[2], args[1]) : fullLex(args[1], args[2])) && !boundedTail(args);
    return fullIndex(args[1], args[2]);
  }
  return false;
}

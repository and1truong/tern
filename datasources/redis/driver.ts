// The Redis-compatible driver: one driver family for Redis and Valkey. Bun's
// runtime RedisClient is the production transport and stays a private detail —
// everything runs against the injectable SessionTransport so the driver is
// testable and replaceable without Bun.
import {
  DbError,
  type CommandResult, type DataSourceInfo, type KeyInspection, type KeyOp, type KeyOpResult, type ScanPage,
} from "../../shared/types.ts";
import type {
  ConnectionConfig, ConsoleProvider, DataSourceDriver, ExecContext,
  KeyValueExplorerProvider, ScanQuery,
} from "../contracts.ts";
import { detectDataSourceInfo, versionAtLeast } from "./capabilities.ts";
import { sessionUrl, validateRedisUrl } from "./connection.ts";
import { blockingTimeoutSeconds, commandCatalog, isReadAllowed, lookupCommand, MAX_BLOCK_SECONDS, UNSHARED_CLIENT_SUBCOMMANDS, UNSHARED_CONNECTION_COMMANDS, type CommandDoc } from "./catalog.ts";
import { encodeRESP, tokenizeCommand } from "./resp.ts";

export interface SessionTransport {
  // Rejections must distinguish server error replies from transport
  // failures: tag server replies with a `.code` (Bun stamps
  // ERR_REDIS_SERVER_ERROR). An untagged rejection is treated as a broken
  // reply stream and the whole session is evicted.
  send(command: string, args: string[]): Promise<unknown>;
  connect(): Promise<void>;
  close(): Promise<void>;
}
export type TransportFactory = (url: string) => SessionTransport;

const defaultFactory: TransportFactory = (url) => {
  const client = new Bun.RedisClient(url, { tls: url.startsWith("rediss:"), connectionTimeout: 10_000 });
  return {
    send: (command, args) => client.send(command, args),
    connect: () => client.connect(),
    close: async () => client.close(),
  };
};

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;


export function makeRedisDriver(transportFactory: TransportFactory = defaultFactory, options: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {}): DataSourceDriver {
  return {
    id: "redis",
    displayName: "Redis / Valkey",
    kind: "key-value",
    validateUrl: validateRedisUrl,
    // Db indexes are integers — "00" and "0" address the same db and must not
    // fork session keys or writable grants. Non-numeric values pass verbatim;
    // sessionUrl rejects them.
    canonicalizeDatabase: (database) => /^\d+$/.test(database) ? String(BigInt(database)) : database,
    async test(config: ConnectionConfig) {
      const transport = transportFactory(sessionUrl(config.url, config.database));
      try {
        await withTimeout(transport.connect(), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        return await detectInfo(transport, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
      } finally {
        await transport.close().catch(() => {});
      }
    },
    async connect(config: ConnectionConfig) {
      const transport = transportFactory(sessionUrl(config.url, config.database));
      try {
        await withTimeout(transport.connect(), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        const info = await detectInfo(transport, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
        return {
          info,
          console: makeConsoleProvider(transport, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS),
          explorer: makeExplorerProvider(transport, info, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS),
          close: async () => { await transport.close().catch(() => {}); },
        };
      } catch (error) {
        // Connection and metadata detection share the cleanup path so a
        // half-open transport (e.g. INFO refused by ACL) never leaks.
        await transport.close().catch(() => {});
        throw error;
      }
    },
  };
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbError("timeout", "Connection timed out")), ms);
    promise.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(toDbError(error)); });
  });
}

// Every send is bounded: a stalled reply would block the strictly-ordered
// reply stream and wedge the shared session forever. The timeout fires a
// DbError("timeout") so the router evicts and closes the suspect transport.
// setTimeout clamps > 2^31-1 ms, so cap first.
function sendTimed(transport: SessionTransport, command: string, args: string[], ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbError("timeout", `${command} timed out; the session was closed to keep replies in sync`)), Math.min(ms, 0x7FFFFFFF));
    // Resolve through the microtask queue so a synchronous send() throw also
    // clears the timer instead of leaving it armed until ms.
    Promise.resolve().then(() => transport.send(command, args)).then(reply => { clearTimeout(timer); resolve(reply); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function detectInfo(transport: SessionTransport, commandTimeoutMs: number): Promise<DataSourceInfo> {
  let raw: unknown;
  try { raw = await sendTimed(transport, "INFO", [], commandTimeoutMs); }
  catch (error) { throw toDbError(error); }
  // INFO may arrive as bytes — Object.entries over a Uint8Array yields byte
  // indices, which would silently degrade every capability to false.
  const decoded = raw instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: false }).decode(raw) : raw;
  return detectDataSourceInfo(decoded as string | Record<string, unknown>);
}

// NOAUTH/WRONGPASS are absent on purpose: an unauthenticated session can
// never recover on its own, so it is treated as a transport failure and
// evicted rather than retained as a dead session returning err replies.
const COMMAND_ERROR_PREFIX = /^(ERR|WRONGTYPE|NOPERM|BUSYGROUP|NOGROUP|MOVED|ASK|CROSSSLOT|TRYAGAIN|EXECABORT|LOADING|BUSY|READONLY|MAXRETRIES|NOSCRIPT|MINVAL|SETROLLBACK|OOM|MISCONF|MASTERDOWN|CLUSTERDOWN|BUSYKEY|NOREPLICAS|UNBLOCKED|NOTBUSY)/i;

// Auth failures and protected-mode rejections can never recover on this
// connection — the session is dead and must be evicted, not kept serving
// err replies.
const SESSION_FATAL_PREFIX = /^(NOAUTH|WRONGPASS|DENIED)\b/i;

// A server-side command rejection — as opposed to a transport failure that
// must evict the session. DbErrors carry their own code (a sendTimed
// "timeout" must never match the message prefixes below). Bun ≥1.4 tags
// server error replies with ERR_REDIS_SERVER_ERROR; earlier Bun (the floor
// is 1.3.5) reports them as ERR_REDIS_INVALID_RESPONSE, so the message
// prefixes must run before the generic-code fallback — a real protocol
// corruption carries a Bun-generated message that won't match them.
function isCommandError(error: unknown): boolean {
  if (error instanceof DbError) return error.code === "command_error";
  const message = error instanceof Error ? error.message : String(error);
  // Bun stamps every server reply error ERR_REDIS_SERVER_ERROR — auth
  // failures included — so the session-fatal check must precede the code
  // shortcut.
  if (SESSION_FATAL_PREFIX.test(message)) return false;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_REDIS_SERVER_ERROR") return true;
  if (COMMAND_ERROR_PREFIX.test(message)) return true;
  if (typeof code === "string" && code) return false;
  return false;
}

// The console shares one cached transport with the explorer: commands that
// retarget, re-authenticate, queue, or monopolize that connection are refused
// (the lists live in catalog.ts so the linter can warn on the same set).

function toDbError(error: unknown): DbError {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s?out|timeout/i.test(message)) return new DbError("timeout", sanitize(message));
  return new DbError("sql", sanitize(message));
}

// Never leak connection strings (they may carry credentials) through errors.
function sanitize(message: string): string {
  return message.replace(/rediss?:\/\/\S+/gi, "[Redis connection]");
}

// --- console provider ---

function makeConsoleProvider(transport: SessionTransport, commandTimeoutMs: number): ConsoleProvider {
  let merged: CommandDoc[] | null = null;
  return {
    async exec(command: string, ctx: ExecContext): Promise<CommandResult> {
      let tokens: string[];
      try { tokens = tokenizeCommand(command); }
      catch (error) {
        return { reply: { t: "err", s: error instanceof Error ? error.message : "unparseable command" }, ms: 0 };
      }
      if (!tokens.length) return { reply: { t: "err", s: "ERR empty command" }, ms: 0 };
      const name = tokens[0]!.toUpperCase();
      const args = tokens.slice(1);
      const doc = lookupCommand(name);
      // Refusals beat the writable gate — "enable writes" is the wrong hint
      // for a command that can never run on the shared transport.
      const unshared = UNSHARED_CONNECTION_COMMANDS[name];
      if (unshared) {
        return { reply: { t: "err", s: `ERR ${name} is refused by Tern: ${unshared}` }, ms: 0 };
      }
      if (name === "CLIENT" && UNSHARED_CLIENT_SUBCOMMANDS.test(args[0] ?? "")) {
        return { reply: { t: "err", s: `ERR CLIENT ${args[0]!.toUpperCase()} is refused by Tern: it mutates the shared connection` }, ms: 0 };
      }
      // SCRIPT DEBUG sets a per-connection LDB flag — the next EVAL on this
      // shared transport enters the Lua debugger (and SYNC stalls the whole
      // server), which nobody can drive through send().
      if (name === "SCRIPT" && /^DEBUG$/i.test(args[0] ?? "")) {
        return { reply: { t: "err", s: `ERR SCRIPT DEBUG is refused by Tern: it puts the shared connection into the Lua debugger` }, ms: 0 };
      }
      if ((!doc || !isReadAllowed(doc, args)) && !ctx.writable) {
        throw new DbError("not_read_only",
          doc ? `${name} is a ${doc.access} command; enable writes for this session`
            : `${name} is not in the command catalog; enable writes to allow unclassified commands`);
      }
      // Null means the timeout can't be resolved (e.g. a non-numeric arg) —
      // the command goes out and the server replies with its own error.
      const blockSeconds = doc?.blocking ? blockingTimeoutSeconds(doc, args) : null;
      if (blockSeconds === 0) {
        return { reply: { t: "err", s: `ERR ${name} with timeout 0 blocks indefinitely; pass a positive timeout in seconds` }, ms: 0 };
      }
      // Beyond this the wait would outlive anything the console is good for;
      // refuse up front rather than parking a reply on the shared transport.
      if (blockSeconds !== null && blockSeconds > MAX_BLOCK_SECONDS) {
        return { reply: { t: "err", s: `ERR ${name} timeout exceeds the console maximum of ${MAX_BLOCK_SECONDS} seconds` }, ms: 0 };
      }
      // An uncataloged command can't resolve a blocking timeout — refuse the
      // one indefinite shape still recognizable positionally, a literal
      // BLOCK 0 pair, rather than parking the transport until sendTimed
      // evicts the whole session.
      if (!doc && args.some((a, i) => /^BLOCK$/i.test(a) && Number(args[i + 1]) === 0)) {
        return { reply: { t: "err", s: `ERR ${name} is uncataloged and carries BLOCK 0; indefinite blocks are refused on the shared transport` }, ms: 0 };
      }
      // Commands that outlive the timeout abandon a pending reply, which would
      // desync every later response on this shared transport — the thrown
      // DbError("timeout") makes the router evict and close the session.
      const timeoutMs = blockSeconds ? Math.max(blockSeconds * 1000 + 5_000, commandTimeoutMs) : commandTimeoutMs;
      const started = performance.now();
      let reply: unknown;
      try { reply = await sendTimed(transport, name, args, timeoutMs); }
      catch (error) {
        if (isCommandError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          return { reply: { t: "err", s: message }, ms: performance.now() - started };
        }
        throw toDbError(error);
      }
      return { reply: encodeRESP(reply), ms: performance.now() - started };
    },
    async catalog() {
      if (merged) return merged;
      // Runtime enrichment is optional — only a server-side rejection may
      // degrade to the built-in catalog, and it is not cached so the next
      // call retries.
      try {
        merged = mergeCommandDocs(commandCatalog, await sendTimed(transport, "COMMAND", ["DOCS"], commandTimeoutMs));
      } catch (error) {
        if (!isCommandError(error)) throw toDbError(error);
        return commandCatalog;
      }
      return merged;
    },
  };
}

function mergeCommandDocs(docs: CommandDoc[], raw: unknown): CommandDoc[] {
  const runtime = normalizeCommandDocs(raw);
  if (!runtime.size) return docs;
  return docs.map(doc => {
    const r = runtime.get(doc.name);
    if (!r) return doc;
    return { ...doc, summary: r.summary ?? doc.summary, complexity: r.complexity ?? doc.complexity, since: r.since ?? doc.since };
  });
}

function normalizeCommandDocs(raw: unknown): Map<string, Partial<CommandDoc>> {
  const out = new Map<string, Partial<CommandDoc>>();
  if (!raw || typeof raw !== "object") return out;
  const entries: Iterable<[string, unknown]> = raw instanceof Map ? raw.entries() : Object.entries(raw as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const doc: Partial<CommandDoc> = {};
    if (typeof v.summary === "string") doc.summary = v.summary;
    if (typeof v.complexity === "string") doc.complexity = v.complexity;
    if (typeof v.since === "string") doc.since = v.since;
    if (doc.summary || doc.complexity || doc.since) out.set(key.toUpperCase(), doc);
  }
  return out;
}

// --- explorer provider ---

const PAGE_SIZE = 50;
const STRING_PREVIEW_BYTES = 64_000;
const STRING_MAX_BYTES = 1_000_000;

// Transports may return binary replies as Uint8Array — String() on one
// produces "104,105" instead of decoded text.
const text = (value: unknown): string =>
  value instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: false }).decode(value) : String(value);

function makeExplorerProvider(transport: SessionTransport, info: DataSourceInfo, commandTimeoutMs: number): KeyValueExplorerProvider {
  const version = info.version;

  // Redis command rejections carry the "command_error" code so keyOp can turn
  // them into KeyOpResult errors and the router can tell them apart from
  // transport failures (which evict and close the broken session).
  const send = async (command: string, args: string[]): Promise<unknown> => {
    try { return await sendTimed(transport, command, args, commandTimeoutMs); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCommandError(error)) throw new DbError("command_error", sanitize(message));
      throw toDbError(error);
    }
  };

  // Auxiliary probes (TTL, MEMORY USAGE, cardinalities) tolerate command
  // rejections — e.g. MEMORY USAGE denied by ACL — but transport failures must
  // still propagate so the router can evict the broken session.
  const number = async (command: string, args: string[]): Promise<number | null> => {
    try {
      const raw = await send(command, args);
      // A nil reply means "unknown" — Number(null) would silently become 0.
      if (raw === null || raw === undefined) return null;
      // Binary transports answer as Uint8Array — decode before parsing or
      // every probe degrades to null ("unknown").
      const n = typeof raw === "number" ? raw : Number(text(raw));
      return Number.isFinite(n) ? n : null;
    } catch (error) {
      if (error instanceof DbError && error.code === "command_error") return null;
      throw error;
    }
  };

  return {
    async scan(q: ScanQuery): Promise<ScanPage> {
      if (q.type && !versionAtLeast(version, 6)) throw new DbError("invalid_change", "Type filtering requires Redis 6 or newer");
      if (!/^\d+$/.test(q.cursor)) throw new DbError("invalid_change", "Invalid scan cursor");
      const args = [q.cursor];
      if (q.match) args.push("MATCH", q.match);
      if (q.count !== undefined) args.push("COUNT", String(Math.min(1000, Math.max(1, Math.floor(q.count)))));
      if (q.type) args.push("TYPE", q.type);
      const raw = await send("SCAN", args);
      if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) throw new DbError("sql", "Unexpected SCAN reply");
      const keys = (raw[1] as unknown[]).map(text);
      const typed = await Promise.all(keys.map(async key => {
        try { return { key, type: text(await sendTimed(transport, "TYPE", [key], commandTimeoutMs)) }; }
        catch (error) {
          // A per-key TYPE rejection (e.g. ACL) degrades to "unknown" for
          // that key; a transport failure must fail the whole page.
          if (isCommandError(error)) return { key, type: "unknown" };
          throw toDbError(error);
        }
      }));
      return { cursor: text(raw[0]), keys: typed };
    },

    async inspect(key: string, cursor?: string): Promise<KeyInspection> {
      const type = text(await send("TYPE", [key]));
      const [ttlSeconds, memoryBytes, size] = await Promise.all([
        number("TTL", [key]),
        number("MEMORY", ["USAGE", key]),
        sizeCommand(type, key).then(n => n ?? null),
      ]);
      if (type === "none") return { key, type, ttlSeconds: -2, memoryBytes, size: null, value: { kind: "none" } };
      const value = await fetchValue(type, key, cursor);
      return { key, type, ttlSeconds, memoryBytes, size, value };
    },

    async keyOp(op: KeyOp): Promise<KeyOpResult> {
      const { command, args } = keyOpCommand(op, version);
      try {
        const raw = await send(command, args);
        if (raw === null || raw === undefined) return { ok: true };
        const n = typeof raw === "number" ? raw : Number(text(raw));
        return { ok: true, ...(Number.isFinite(n) ? { n } : {}) };
      } catch (error) {
        // Only server-side command rejections become result errors; transport
        // failures propagate so the router can evict the broken session.
        if (error instanceof DbError && error.code === "command_error") return { ok: false, error: error.message };
        throw error;
      }
    },
  };

  function sizeCommand(type: string, key: string): Promise<number | null> {
    const command = { string: "STRLEN", list: "LLEN", set: "SCARD", zset: "ZCARD", hash: "HLEN", stream: "XLEN" }[type];
    return command ? number(command, [key]) : Promise.resolve(null);
  }

  async function fetchValue(type: string, key: string, cursor?: string): Promise<KeyInspection["value"]> {
    switch (type) {
      case "string": {
        const length = await number("STRLEN", [key]);
        if (length !== null && length > STRING_MAX_BYTES) return { kind: "string", value: "", truncated: true, lengthBytes: length };
        // STRLEN and the value read are separate round trips — a concurrent
        // SET could grow the value between them — so always bound the read;
        // a plain GET could pull a value up to the 512MB Redis max.
        const raw = await send("GETRANGE", [key, "0", String(STRING_MAX_BYTES - 1)]);
        const value = raw === null || raw === undefined ? "" : text(raw);
        // GETRANGE caps bytes, not decoded chars — multibyte values need the
        // encoded length for both the truncation signal and the byte count.
        const encoded = new TextEncoder().encode(value);
        const valueBytes = encoded.length;
        // The preview budget is bytes too — a 4-byte-char value would
        // otherwise ship ~4x the preview. Decoding the slice can end
        // mid-codepoint; drop a trailing replacement char.
        const preview = new TextDecoder("utf-8").decode(encoded.subarray(0, STRING_PREVIEW_BYTES)).replace(/\uFFFD$/, "");
        return {
          kind: "string",
          value: preview,
          truncated: valueBytes > STRING_PREVIEW_BYTES || valueBytes >= STRING_MAX_BYTES,
          // STRLEN denied + the capped read full → the true length is
          // unknown; reporting the cap as the length would lie.
          lengthBytes: length ?? (valueBytes >= STRING_MAX_BYTES ? null : valueBytes),
        };
      }
      case "hash": {
        const [next, flat] = await scanPairs("HSCAN", key, cursor);
        return { kind: "hash", entries: pairEntries(flat), cursor: next, truncated: next !== "0" };
      }
      case "set": {
        const [next, flat] = await scanPairs("SSCAN", key, cursor);
        return { kind: "set", members: flat.map(text), cursor: next, truncated: next !== "0" };
      }
      case "zset": {
        const [next, flat] = await scanPairs("ZSCAN", key, cursor);
        const entries: { member: string; score: number | string }[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const score = Number(flat[i + 1]);
          // ±inf scores are legal; JSON cannot carry them, so send text.
          entries.push({ member: text(flat[i]), score: Number.isFinite(score) ? score : text(flat[i + 1]) });
        }
        return { kind: "zset", entries, cursor: next, truncated: next !== "0" };
      }
      case "list": {
        if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new DbError("invalid_change", "Invalid list cursor");
        const start = cursor !== undefined ? Number(cursor) : 0;
        // A cursor past MAX_SAFE_INTEGER serializes as "1e+21" — refuse it
        // here rather than letting the server answer ERR not-an-integer.
        if (!Number.isSafeInteger(start)) throw new DbError("invalid_change", "Invalid list cursor");
        const rawItems = await send("LRANGE", [key, String(start), String(start + PAGE_SIZE - 1)]);
        const items = (Array.isArray(rawItems) ? rawItems : []).map(text);
        // A denied LLEN must not hide "Load more" — a full page may have
        // more behind it even when the total can't be read.
        const total = await number("LLEN", [key]);
        return { kind: "list", items, start, truncated: total == null ? items.length === PAGE_SIZE : start + items.length < total };
      }
      case "stream": {
        if (cursor !== undefined && !/^\d+-\d+$/.test(cursor)) throw new DbError("invalid_change", "Invalid stream cursor");
        // Pre-6.2 ranges include the cursor entry itself (dropped below), so
        // paging there fetches one extra; +1 always probes for a further page.
        const count = PAGE_SIZE + 1 + (cursor !== undefined && !versionAtLeast(version, 6, 2) ? 1 : 0);
        const startId = cursor !== undefined && versionAtLeast(version, 6, 2) ? `(${cursor}` : cursor !== undefined ? cursor : "-";
        const raw = await send("XRANGE", [key, startId, "+", "COUNT", String(count)]);
        let fetched = (Array.isArray(raw) ? raw : []).map(parseStreamEntry);
        if (cursor !== undefined && !versionAtLeast(version, 6, 2)) fetched = fetched.filter(e => streamIdAfter(e.id, cursor));
        // The cursor resumes after the last DISPLAYED entry; the extra fetched
        // entry (when requested) only proves that more pages follow.
        const hasMore = fetched.length > PAGE_SIZE;
        const entries = fetched.slice(0, PAGE_SIZE);
        const lastId = entries.length ? entries.at(-1)!.id : null;
        // null when XLEN is ACL-denied — reporting the page size as the
        // stream's total would fabricate a count.
        return { kind: "stream", length: await number("XLEN", [key]), entries, lastId, truncated: hasMore && lastId !== null };
      }
      default:
        return { kind: "unknown", note: `Server type '${type}' has no viewer` };
    }
  }

  async function scanPairs(command: "HSCAN" | "SSCAN" | "ZSCAN", key: string, cursor?: string): Promise<[string, unknown[]]> {
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new DbError("invalid_change", `Invalid ${command} cursor`);
    const raw = await send(command, [key, cursor ?? "0", "COUNT", String(PAGE_SIZE)]);
    if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) throw new DbError("sql", `Unexpected ${command} reply`);
    return [text(raw[0]), raw[1] as unknown[]];
  }
}

function pairEntries(flat: unknown[]): { field: string; value: string }[] {
  const entries: { field: string; value: string }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) entries.push({ field: text(flat[i]), value: text(flat[i + 1]) });
  return entries;
}

// Field names may repeat within one stream entry — keep ordered pairs; a
// Record would silently drop every occurrence but the last.
function parseStreamEntry(raw: unknown): { id: string; fields: { field: string; value: string }[] } {
  if (!Array.isArray(raw) || raw.length < 2) return { id: text(raw), fields: [] };
  // RESP3-aware transports may decode the field pairs as a map/object rather
  // than the RESP2 flat array — accept either shape.
  const pairs = raw[1];
  const flat = pairs instanceof Map ? [...pairs.entries()].flat()
    : pairs !== null && typeof pairs === "object" && !Array.isArray(pairs) ? Object.entries(pairs).flat()
    : pairs;
  if (!Array.isArray(flat)) return { id: text(raw[0]), fields: [] };
  return { id: text(raw[0]), fields: pairEntries(flat) };
}

// Stream ids compare numerically per segment ("9-1" sorts before "10-1").
function streamIdAfter(id: string, cursor: string): boolean {
  const [aMaj, aSeq] = id.split("-").map(Number);
  const [bMaj, bSeq] = cursor.split("-").map(Number);
  return aMaj! > bMaj! || (aMaj === bMaj && (aSeq ?? 0) > (bSeq ?? 0));
}

function keyOpCommand(op: KeyOp, version: string): { command: string; args: string[] } {
  switch (op.op) {
    case "rename": return { command: "RENAME", args: [op.from, op.to] };
    case "delete": return { command: "DEL", args: op.keys };
    case "expire": return { command: "EXPIRE", args: [op.key, String(Math.floor(op.seconds))] };
    case "persist": return { command: "PERSIST", args: [op.key] };
    // Editing preserves the key's TTL where the server supports KEEPTTL.
    // An unknown version (proxied INFO) must fail loud — omitting KEEPTTL
    // on a ≥6 server silently drops the TTL, while sending it to a <6
    // server only yields a recoverable command_error.
    case "setString": return /^\d+/.test(version) && !versionAtLeast(version, 6)
      ? { command: "SET", args: [op.key, op.value] }
      : { command: "SET", args: [op.key, op.value, "KEEPTTL"] };
    case "hashSet": return { command: "HSET", args: [op.key, op.field, op.value] };
    case "hashDelete": return { command: "HDEL", args: [op.key, ...op.fields] };
    case "setAdd": return { command: "SADD", args: [op.key, ...op.members] };
    case "setRemove": return { command: "SREM", args: [op.key, ...op.members] };
    case "zsetAdd": return { command: "ZADD", args: [op.key, String(op.score), op.member] };
    case "zsetRemove": return { command: "ZREM", args: [op.key, ...op.members] };
    case "listSet": return { command: "LSET", args: [op.key, String(op.index), op.value] };
    default: throw new DbError("invalid_change", "Unknown key operation");
  }
}

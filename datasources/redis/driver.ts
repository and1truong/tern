// The Redis-compatible driver: one driver family for Redis and Valkey. Bun's
// runtime RedisClient is the production transport and stays a private detail —
// everything runs against the injectable SessionTransport so the driver is
// testable and replaceable without Bun.
import {
  DbError,
  type CommandResult, type DataSourceInfo, type KeyInspection, type KeyOp, type KeyOpResult, type ScanPage,
} from "../../shared.ts";
import type {
  ConnectionConfig, ConsoleProvider, DataSourceDriver, ExecContext,
  KeyValueExplorerProvider, ScanQuery,
} from "../contracts.ts";
import { detectDataSourceInfo, versionAtLeast } from "./capabilities.ts";
import { sessionUrl, validateRedisUrl } from "./connection.ts";
import { blockingTimeoutSeconds, commandCatalog, lookupCommand, type CommandDoc } from "./catalog.ts";
import { encodeRESP, tokenizeCommand } from "./resp.ts";

export interface SessionTransport {
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

export function makeRedisDriver(transportFactory: TransportFactory = defaultFactory, options: { connectTimeoutMs?: number } = {}): DataSourceDriver {
  return {
    id: "redis",
    displayName: "Redis / Valkey",
    kind: "key-value",
    validateUrl: validateRedisUrl,
    async test(config: ConnectionConfig) {
      const transport = transportFactory(sessionUrl(config.url, config.database));
      try {
        await withTimeout(transport.connect(), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        return await detectInfo(transport);
      } finally {
        await transport.close().catch(() => {});
      }
    },
    async connect(config: ConnectionConfig) {
      const transport = transportFactory(sessionUrl(config.url, config.database));
      try {
        await withTimeout(transport.connect(), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      } catch (error) {
        await transport.close().catch(() => {});
        throw error;
      }
      const info = await detectInfo(transport);
      return {
        info,
        console: makeConsoleProvider(transport),
        explorer: makeExplorerProvider(transport, info),
        close: async () => { await transport.close().catch(() => {}); },
      };
    },
  };
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbError("timeout", "Connection timed out")), ms);
    promise.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(toDbError(error)); });
  });
}

async function detectInfo(transport: SessionTransport): Promise<DataSourceInfo> {
  let raw: unknown;
  try { raw = await transport.send("INFO", []); }
  catch (error) { throw toDbError(error); }
  return detectDataSourceInfo(raw as string | Record<string, unknown>);
}

const COMMAND_ERROR_PREFIX = /^(ERR|WRONGTYPE|NOPERM|NOAUTH|BUSYGROUP|NOGROUP|MOVED|ASK|CROSSSLOT|EXECABORT|LOADING|BUSY|READONLY|MAXRETRIES|NOSCRIPT|MINVAL|INVALID|SETROLLBACK)/i;

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

function makeConsoleProvider(transport: SessionTransport): ConsoleProvider {
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
      if ((!doc || doc.access !== "read") && !ctx.writable) {
        throw new DbError("not_read_only",
          doc ? `${name} is a ${doc.access} command; enable writes for this session`
            : `${name} is not in the command catalog; enable writes to allow unclassified commands`);
      }
      if (doc?.blocking && blockingTimeoutSeconds(doc, args) === 0) {
        return { reply: { t: "err", s: `ERR ${name} with timeout 0 blocks indefinitely; pass a positive timeout in seconds` }, ms: 0 };
      }
      const started = performance.now();
      let reply: unknown;
      try { reply = await transport.send(name, args); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (COMMAND_ERROR_PREFIX.test(message)) return { reply: { t: "err", s: message }, ms: performance.now() - started };
        throw toDbError(error);
      }
      return { reply: encodeRESP(reply), ms: performance.now() - started };
    },
    async catalog() {
      if (merged) return merged;
      let docs = commandCatalog;
      try {
        docs = mergeCommandDocs(commandCatalog, await transport.send("COMMAND", ["DOCS"]));
      } catch { /* runtime enrichment is optional; the built-in catalog stands alone */ }
      merged = docs;
      return docs;
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

function makeExplorerProvider(transport: SessionTransport, info: DataSourceInfo): KeyValueExplorerProvider {
  const version = info.version;

  const send = async (command: string, args: string[]): Promise<unknown> => {
    try { return await transport.send(command, args); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (COMMAND_ERROR_PREFIX.test(message)) throw new DbError("sql", sanitize(message));
      throw toDbError(error);
    }
  };

  const number = async (command: string, args: string[]): Promise<number | null> => {
    try {
      const raw = await transport.send(command, args);
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };

  return {
    async scan(q: ScanQuery): Promise<ScanPage> {
      if (q.type && !versionAtLeast(version, 6)) throw new DbError("sql", "Type filtering requires Redis 6 or newer");
      const cursor = /^\d+$/.test(q.cursor) ? q.cursor : "0";
      const args = [cursor];
      if (q.match) args.push("MATCH", q.match);
      if (q.count !== undefined) args.push("COUNT", String(Math.min(1000, Math.max(1, Math.floor(q.count)))));
      if (q.type) args.push("TYPE", q.type);
      const raw = await send("SCAN", args);
      if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) throw new DbError("sql", "Unexpected SCAN reply");
      const keys = (raw[1] as unknown[]).map(String);
      const typed = await Promise.all(keys.map(async key => {
        try { return { key, type: String(await transport.send("TYPE", [key])) }; }
        catch { return { key, type: "unknown" }; }
      }));
      return { cursor: String(raw[0]), keys: typed };
    },

    async inspect(key: string, cursor?: string): Promise<KeyInspection> {
      const type = String(await send("TYPE", [key]));
      const [ttlSeconds, memoryBytes, size] = await Promise.all([
        number("TTL", [key]).then(n => n ?? -2),
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
        const n = typeof raw === "number" ? raw : Number(raw);
        return { ok: true, ...(Number.isFinite(n) ? { n } : {}) };
      } catch (error) {
        if (error instanceof DbError) return { ok: false, error: error.message };
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
        const length = await number("STRLEN", [key]) ?? 0;
        if (length > STRING_MAX_BYTES) return { kind: "string", value: "", truncated: true, lengthBytes: length };
        const raw = await transport.send("GET", [key]);
        const value = raw === null || raw === undefined ? "" : raw instanceof Uint8Array
          ? new TextDecoder("utf-8", { fatal: false }).decode(raw)
          : String(raw);
        return { kind: "string", value: value.slice(0, STRING_PREVIEW_BYTES), truncated: value.length > STRING_PREVIEW_BYTES, lengthBytes: length };
      }
      case "hash": {
        const [next, flat] = await scanPairs("HSCAN", key, cursor);
        return { kind: "hash", entries: pairEntries(flat), cursor: next, truncated: next !== "0" };
      }
      case "set": {
        const [next, flat] = await scanPairs("SSCAN", key, cursor);
        return { kind: "set", members: flat.map(String), cursor: next, truncated: next !== "0" };
      }
      case "zset": {
        const [next, flat] = await scanPairs("ZSCAN", key, cursor);
        const entries: { member: string; score: number }[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) entries.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
        return { kind: "zset", entries, cursor: next, truncated: next !== "0" };
      }
      case "list": {
        const start = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 0;
        const items = ((await send("LRANGE", [key, String(start), String(start + PAGE_SIZE - 1)])) as unknown[] ?? []).map(String);
        return { kind: "list", items, start, truncated: start + items.length < (await number("LLEN", [key]) ?? start + items.length) };
      }
      case "stream": {
        const count = cursor !== undefined ? PAGE_SIZE + 1 : PAGE_SIZE;
        const startId = cursor !== undefined && versionAtLeast(version, 6, 2) ? `(${cursor}` : cursor !== undefined ? cursor : "-";
        const raw = (await send("XRANGE", [key, startId, "+", "COUNT", String(count)])) as unknown[] ?? [];
        let entries = raw.map(parseStreamEntry);
        if (cursor !== undefined && !versionAtLeast(version, 6, 2)) entries = entries.filter(e => streamIdAfter(e.id, cursor));
        const lastId = entries.length ? entries.at(-1)!.id : null;
        return { kind: "stream", length: await number("XLEN", [key]) ?? entries.length, entries: entries.slice(0, PAGE_SIZE), lastId, truncated: entries.length >= PAGE_SIZE && lastId !== null };
      }
      default:
        return { kind: "unknown", note: `Server type '${type}' has no viewer` };
    }
  }

  async function scanPairs(command: "HSCAN" | "SSCAN" | "ZSCAN", key: string, cursor?: string): Promise<[string, unknown[]]> {
    const raw = await send(command, [key, /^\d+$/.test(cursor ?? "") ? cursor! : "0", "COUNT", String(PAGE_SIZE)]);
    if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) throw new DbError("sql", `Unexpected ${command} reply`);
    return [String(raw[0]), raw[1] as unknown[]];
  }
}

function pairEntries(flat: unknown[]): { field: string; value: string }[] {
  const entries: { field: string; value: string }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) entries.push({ field: String(flat[i]), value: String(flat[i + 1]) });
  return entries;
}

function parseStreamEntry(raw: unknown): { id: string; fields: Record<string, string> } {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) return { id: String(raw), fields: {} };
  const fields: Record<string, string> = {};
  const flat = raw[1] as unknown[];
  for (let i = 0; i + 1 < flat.length; i += 2) fields[String(flat[i])] = String(flat[i + 1]);
  return { id: String(raw[0]), fields };
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
    case "setString": return versionAtLeast(version, 6)
      ? { command: "SET", args: [op.key, op.value, "KEEPTTL"] }
      : { command: "SET", args: [op.key, op.value] };
    case "hashSet": return { command: "HSET", args: [op.key, op.field, op.value] };
    case "hashDelete": return { command: "HDEL", args: [op.key, ...op.fields] };
    case "setAdd": return { command: "SADD", args: [op.key, ...op.members] };
    case "setRemove": return { command: "SREM", args: [op.key, ...op.members] };
    case "zsetAdd": return { command: "ZADD", args: [op.key, String(op.score), op.member] };
    case "zsetRemove": return { command: "ZREM", args: [op.key, ...op.members] };
    case "listSet": return { command: "LSET", args: [op.key, String(op.index), op.value] };
  }
}

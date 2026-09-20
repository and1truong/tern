import { describe, test, expect } from "bun:test";
import { makeRedisDriver, type SessionTransport, type TransportFactory } from "./driver.ts";
import { DbError } from "../../shared/types.ts";

const INFO_REDIS = [
  "# Server", "redis_version:7.2.4", "tcp_port:6379",
  "# Cluster", "cluster_enabled:0",
  "# Keyspace", "db0:keys=2,expires=0,avg_ttl=0",
].join("\r\n");
const INFO_REDIS5 = INFO_REDIS.replace("redis_version:7.2.4", "redis_version:5.0.14");

type Responder = (command: string, args: string[], calls: { command: string; args: string[] }[]) => unknown;

function makeFake(info: string, responder: Responder = () => "OK") {
  const calls: { command: string; args: string[] }[] = [];
  const transport: SessionTransport = {
    async send(command, args) {
      calls.push({ command, args });
      if (command === "INFO") return info;
      return responder(command, args, calls);
    },
    async connect() {},
    async close() {},
  };
  const factory: TransportFactory = () => transport;
  return { transport, factory, calls };
}

const URL = "redis://localhost:6379";

describe("driver session + detection", () => {
  test("test() detects flavor, version and capabilities", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const info = await makeRedisDriver(factory).test({ url: URL });
    expect(info.flavor).toBe("redis");
    expect(info.version).toBe("7.2.4");
    expect(info.capabilities!.streams).toBe(true);
    expect(info.summary.totalKeys).toBe(2);
  });

  test("connect() returns info, providers and a working close", async () => {
    let closed = false;
    const { factory, transport } = makeFake(INFO_REDIS);
    transport.close = async () => { closed = true; };
    const session = await makeRedisDriver(factory).connect({ url: URL });
    expect(session.info.version).toBe("7.2.4");
    expect(session.console).toBeDefined();
    expect(session.explorer).toBeDefined();
    await session.close();
    expect(closed).toBe(true);
  });

  test("connect timeouts surface as DbError timeout and close the transport", async () => {
    let closed = false;
    const factory: TransportFactory = () => ({
      send: async () => "OK",
      connect: () => new Promise(() => {}),
      close: async () => { closed = true; },
    });
    const driver = makeRedisDriver(factory, { connectTimeoutMs: 30 });
    await expect(driver.test({ url: URL })).rejects.toMatchObject({ code: "timeout" });
    expect(closed).toBe(true);
  });
});

describe("console exec", () => {
  test("read commands run on read-only sessions", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (_c, args) => args[0] === "mykey" ? "v1" : null);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("GET mykey", { writable: false });
    expect(result.reply).toEqual({ t: "str", s: "v1" });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(calls.at(-1)).toEqual({ command: "GET", args: ["mykey"] });
  });

  test("write commands require an explicit writable session", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.console!.exec("SET k v", { writable: false })).rejects.toMatchObject({ code: "not_read_only" });
    const result = await session.console!.exec("SET k v", { writable: true });
    expect(result.reply).toEqual({ t: "str", s: "OK" });
  });

  test("unclassified commands are blocked read-only and allowed writable", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.console!.exec("FT.SEARCH idx *", { writable: false })).rejects.toMatchObject({ code: "not_read_only" });
    const result = await session.console!.exec("FT.SEARCH idx *", { writable: true });
    expect(result.reply).toEqual({ t: "str", s: "OK" });
  });

  test("command errors arrive as err replies; transport failures throw DbError", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "NOSUCH") throw new Error("ERR unknown command 'NOSUCH'");
      if (command === "GET") throw new Error("ECONNREFUSED: connection refused");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("NOSUCH x", { writable: true });
    expect(result.reply).toEqual({ t: "err", s: "ERR unknown command 'NOSUCH'" });
    await expect(session.console!.exec("GET k", { writable: true })).rejects.toBeInstanceOf(DbError);
  });

  test("Bun <1.4 server errors (ERR_REDIS_INVALID_RESPONSE code) still land as err replies", async () => {
    // Bun <1.4 lacks ERR_REDIS_SERVER_ERROR — server rejections carry the
    // transport-level INVALID_RESPONSE code, so classification must consult
    // the message prefix before treating any code as fatal.
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "GET") {
        const error = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        (error as { code?: string }).code = "ERR_REDIS_INVALID_RESPONSE";
        throw error;
      }
      return "PONG";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("GET k", { writable: true });
    expect(result.reply).toEqual({ t: "err", s: "WRONGTYPE Operation against a key holding the wrong kind of value" });
  });

  test("real protocol corruption still throws so the router evicts", async () => {
    // A Bun-generated INVALID_RESPONSE message matches no server-error
    // prefix — it stays a transport failure, which is what triggers the
    // router's session eviction.
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "GET") {
        const error = new Error("Invalid response from server");
        (error as { code?: string }).code = "ERR_REDIS_INVALID_RESPONSE";
        throw error;
      }
      return "PONG";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.console!.exec("GET k", { writable: true })).rejects.toBeInstanceOf(DbError);
  });

  test("an ACL-denied XLEN reports unknown length, not the page size", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "stream";
      if (command === "XLEN") throw new Error("NOPERM this user has no permissions to run the 'xlen' command");
      if (command === "XRANGE") return [["1-1", ["f", "v"]]];
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const page = await session.explorer!.inspect("st", undefined);
    if (page.value.kind !== "stream") throw new Error("expected stream value");
    expect(page.value.length).toBeNull();
  });

  test("NOTBUSY is a routine command error, not a session-fatal transport failure", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "SCRIPT") throw new Error("NOTBUSY No scripts in execution right now.");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("SCRIPT KILL", { writable: true });
    // A bare NOTBUSY on an injectable transport must still land as an err
    // reply — treating it as a transport failure would evict the session.
    expect(result.reply).toEqual({ t: "err", s: "NOTBUSY No scripts in execution right now." });
  });

  test("indefinite blocking commands are refused; timed ones run", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const refused = await session.console!.exec("BLPOP queue 0", { writable: true });
    expect(refused.reply.t).toBe("err");
    expect(String((refused.reply as { s: string }).s)).toMatch(/indefinitely/);
    await session.console!.exec("BLPOP queue 5", { writable: true });
    expect(calls.at(-1)).toEqual({ command: "BLPOP", args: ["queue", "5"] });
    // A consumer group literally named STREAMS must not hide BLOCK 0.
    const xrg = await session.console!.exec("XREADGROUP GROUP STREAMS c BLOCK 0 STREAMS s >", { writable: true });
    expect(xrg.reply.t).toBe("err");
    expect(String((xrg.reply as { s: string }).s)).toMatch(/indefinitely/);
    expect(calls.some(c => c.command === "XREADGROUP")).toBe(false);
  });

  test("catalog merges COMMAND DOCS when available, falls back cleanly", async () => {
    const { factory } = makeFake(INFO_REDIS, (command, args) => {
      if (command === "COMMAND") {
        expect(args).toEqual(["DOCS"]);
        return { zrange: { summary: "Runtime summary", since: "6.2.0", complexity: "O(log(N)+M)" } };
      }
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const docs = await session.console!.catalog();
    const zrange = docs.find(d => d.name === "ZRANGE")!;
    expect(zrange.summary).toBe("Runtime summary");
    // The safety model stays authoritative even when runtime docs arrive.
    expect(zrange.access).toBe("read");

    const failing = makeFake(INFO_REDIS, (command) => { if (command === "COMMAND") throw new Error("ERR unknown command"); return "OK"; });
    const fallback = await makeRedisDriver(failing.factory).connect({ url: URL });
    const docs2 = await fallback.console!.catalog();
    expect(docs2.find(d => d.name === "ZRANGE")!.summary).not.toBe("Runtime summary");
  });
});

describe("explorer scan", () => {
  test("passes MATCH/COUNT and attaches per-key types", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command) => {
      if (command === "SCAN") return ["17", ["a", "b"]];
      if (command === "TYPE") return "string";
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const page = await session.explorer!.scan({ cursor: "0", match: "a:*", count: 100 });
    expect(calls.find(c => c.command === "SCAN")).toEqual({ command: "SCAN", args: ["0", "MATCH", "a:*", "COUNT", "100"] });
    expect(page.cursor).toBe("17");
    expect(page.keys).toEqual([{ key: "a", type: "string" }, { key: "b", type: "string" }]);
  });

  test("TYPE filtering requires Redis 6", async () => {
    const { factory } = makeFake(INFO_REDIS5, (command) => command === "SCAN" ? ["0", []] : "OK");
    const session = await makeRedisDriver(factory).connect({ url: URL });
    // A capability rejection is a request error, not a transport failure —
    // the session stays cached.
    await expect(session.explorer!.scan({ cursor: "0", type: "string" })).rejects.toMatchObject({ code: "invalid_change" });
  });
});

describe("explorer inspect", () => {
  const baseResponder: Responder = (command, args) => {
    switch (command) {
      case "TYPE": return args[0] === "s" ? "string" : args[0] === "h" ? "hash" : args[0] === "z" ? "zset" : args[0] === "st" ? "stream" : "none";
      case "TTL": return -1;
      case "MEMORY": return 42;
      case "STRLEN": return 5;
      case "GET": return args[0] === "s" ? "hello" : null;
      case "GETRANGE": return args[0] === "s" ? "hello" : null;
      case "HSCAN": return ["7", ["f1", "v1", "f2", "v2"]];
      case "ZSCAN": return ["0", ["m1", "1.5"]];
      case "XLEN": return 3;
      case "XRANGE": return [["5-1", ["f", "v"]], ["6-1", ["f", "w"]]];
      default: return null;
    }
  };

  test("small strings are read in full", async () => {
    const { factory } = makeFake(INFO_REDIS, baseResponder);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    expect(inspection.type).toBe("string");
    expect(inspection.size).toBe(5);
    expect(inspection.memoryBytes).toBe(42);
    expect(inspection.ttlSeconds).toBe(-1);
    expect(inspection.value).toEqual({ kind: "string", value: "hello", truncated: false, lengthBytes: 5 });
  });

  test("oversized strings are not read into memory", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command, args) => {
      if (command === "STRLEN") return 2_000_000;
      return baseResponder(command, args, calls);
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    expect(inspection.value).toEqual({ kind: "string", value: "", truncated: true, lengthBytes: 2_000_000 });
    expect(calls.some(c => c.command === "GET" || c.command === "GETRANGE")).toBe(false);
  });

  test("binary (Uint8Array) numeric replies still parse", async () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return bytes("string");
      if (command === "TTL") return bytes("3600");
      if (command === "STRLEN") return 3;
      if (command === "GETRANGE") return "abc";
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("k");
    expect(inspection.ttlSeconds).toBe(3600);
  });

  test("a capped string read with STRLEN denied reports unknown length", async () => {
    const big = "x".repeat(1_000_000);
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "string";
      if (command === "STRLEN") return null; // ACL denied
      if (command === "GETRANGE") return big;
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("k");
    expect(inspection.value).toMatchObject({ kind: "string", truncated: true, lengthBytes: null });
  });

  test("the string preview budget is bytes, not chars", async () => {
    const value = "💾".repeat(20_000); // 80KB of 4-byte chars
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "string";
      if (command === "STRLEN") return 80_000;
      if (command === "GETRANGE") return value;
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("k");
    const v = inspection.value as { kind: "string"; value: string; truncated: boolean };
    expect(v.truncated).toBe(true);
    expect(new TextEncoder().encode(v.value).length).toBeLessThanOrEqual(64_000);
  });

  test("string reads stay bounded even when STRLEN answered", async () => {
    // STRLEN and the value read are separate round trips — a concurrent SET
    // could grow the value between them, so the read is always GETRANGE.
    const { factory, calls } = makeFake(INFO_REDIS, baseResponder);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    expect(inspection.value).toMatchObject({ kind: "string", value: "hello" });
    expect(calls.some(c => c.command === "GET")).toBe(false);
    expect(calls.find(c => c.command === "GETRANGE")?.args).toEqual(["s", "0", String(1_000_000 - 1)]);
  });

  test("hash pages pair fields with values and return the cursor", async () => {
    const { factory } = makeFake(INFO_REDIS, (command, args) => {
      if (command === "HSCAN") {
        expect(args).toEqual(["h", "0", "COUNT", "50"]);
        return ["7", ["f1", "v1", "f2", "v2"]];
      }
      return baseResponder(command, args, []);
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("h");
    expect(inspection.value).toEqual({ kind: "hash", entries: [{ field: "f1", value: "v1" }, { field: "f2", value: "v2" }], cursor: "7", truncated: true });
  });

  test("zset scores arrive as numbers", async () => {
    const { factory } = makeFake(INFO_REDIS, (c, a) => c === "ZSCAN" ? ["0", ["m1", "1.5"]] : baseResponder(c, a, []));
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("z");
    expect(inspection.value).toEqual({ kind: "zset", entries: [{ member: "m1", score: 1.5 }], cursor: "0", truncated: false });
  });

  test("stream paging uses exclusive ranges on 6.2+ and the skip-first fallback before", async () => {
    const modern = makeFake(INFO_REDIS, (command, args) => {
      if (command === "XRANGE") {
        expect(args).toEqual(["st", "(5-1", "+", "COUNT", "51"]);
        return [["6-1", ["f", "w"]]];
      }
      return baseResponder(command, args, []);
    });
    const modernSession = await makeRedisDriver(modern.factory).connect({ url: URL });
    const modernPage = await modernSession.explorer!.inspect("st", "5-1");
    if (modernPage.value.kind !== "stream") throw new Error("expected stream value");
    expect(modernPage.value.entries[0]).toEqual({ id: "6-1", fields: { f: "w" } });

    const legacy = makeFake(INFO_REDIS5, (command, args) => {
      if (command === "XRANGE") {
        expect(args).toEqual(["st", "5-1", "+", "COUNT", "52"]);
        return [["5-1", ["f", "v"]], ["6-1", ["f", "w"]]];
      }
      return baseResponder(command, args, []);
    });
    const legacySession = await makeRedisDriver(legacy.factory).connect({ url: URL });
    const legacyPage = await legacySession.explorer!.inspect("st", "5-1");
    if (legacyPage.value.kind !== "stream") throw new Error("expected stream value");
    expect(legacyPage.value.entries.map(e => e.id)).toEqual(["6-1"]);
  });

  test("a stream field literally named __proto__ survives inspection", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "stream";
      if (command === "TTL") return -1;
      if (command === "XRANGE") return [["1-1", ["__proto__", "pwn", "f", "v"]]];
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    if (inspection.value.kind !== "stream") throw new Error("expected stream value");
    expect(inspection.value.entries[0]?.fields["__proto__"]).toBe("pwn");
    expect(JSON.stringify(inspection.value.entries[0]?.fields)).toContain("pwn");
  });

  test("missing keys and unknown server types degrade gracefully", async () => {
    const { factory } = makeFake(INFO_REDIS, (command, args) => {
      if (command === "TYPE") return args[0] === "gone" ? "none" : "ReJSON-RL";
      if (command === "TTL") return -2;
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    expect((await session.explorer!.inspect("gone")).value).toEqual({ kind: "none" });
    const unknown = await session.explorer!.inspect("doc");
    expect(unknown.value.kind).toBe("unknown");
  });
});

describe("explorer keyOp", () => {
  test("setString preserves TTL on Redis 6+ and plain SETs before", async () => {
    const modern = makeFake(INFO_REDIS);
    const modernSession = await makeRedisDriver(modern.factory).connect({ url: URL });
    await modernSession.explorer!.keyOp({ op: "setString", key: "s", value: "v2" });
    expect(modern.calls.at(-1)).toEqual({ command: "SET", args: ["s", "v2", "KEEPTTL"] });

    const legacy = makeFake(INFO_REDIS5);
    const legacySession = await makeRedisDriver(legacy.factory).connect({ url: URL });
    await legacySession.explorer!.keyOp({ op: "setString", key: "s", value: "v2" });
    expect(legacy.calls.at(-1)).toEqual({ command: "SET", args: ["s", "v2"] });

    // An INFO that reports no version (proxy/managed service) must fail
    // loud with KEEPTTL — a plain SET would silently drop the TTL on ≥6.
    const unknown = makeFake(INFO_REDIS.split("\r\n").filter(line => !line.includes("_version:")).join("\r\n"));
    const unknownSession = await makeRedisDriver(unknown.factory).connect({ url: URL });
    await unknownSession.explorer!.keyOp({ op: "setString", key: "s", value: "v2" });
    expect(unknown.calls.at(-1)).toEqual({ command: "SET", args: ["s", "v2", "KEEPTTL"] });

    // Versions that do not parse as numbers (n/a, v7) are unknown too —
    // only a positively-known pre-6 server gets the plain SET.
    for (const version of ["n/a", "v7"]) {
      const odd = makeFake(INFO_REDIS.replace(/redis_version:[^\r\n]*/, `redis_version:${version}`));
      const oddSession = await makeRedisDriver(odd.factory).connect({ url: URL });
      await oddSession.explorer!.keyOp({ op: "setString", key: "s", value: "v2" });
      expect(odd.calls.at(-1), version).toEqual({ command: "SET", args: ["s", "v2", "KEEPTTL"] });
    }
  });

  test("delete returns the affected count", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command) => command === "DEL" ? 2 : "OK");
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.explorer!.keyOp({ op: "delete", keys: ["a", "b"] });
    expect(calls.at(-1)).toEqual({ command: "DEL", args: ["a", "b"] });
    expect(result).toEqual({ ok: true, n: 2 });
  });

  test("rename on a missing key reports the server error", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => { if (command === "RENAME") throw new Error("ERR no such key"); return "OK"; });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.explorer!.keyOp({ op: "rename", from: "a", to: "b" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no such key/);
  });
});

describe("stream paging regression", () => {
  test("cursor resumes after the last displayed entry, never skipping one", async () => {
    // 51 entries fetched with the probe count: the 51st only proves more exist.
    const ids = Array.from({ length: 51 }, (_, i) => `${i + 1}-1`);
    const { factory } = makeFake(INFO_REDIS, (command, args) => {
      if (command === "XRANGE") {
        const start = args[1]!;
        const after = start.startsWith("(") ? start.slice(1) : null;
        let list: [string, string[]][] = ids.map(id => [id, ["f", "v"]]);
        if (after) {
          const [maj, seq] = after.split("-").map(Number) as [number, number];
          list = list.filter(([id]) => {
            const [iMaj, iSeq] = id!.split("-").map(Number);
            return iMaj! > maj! || (iMaj === maj && (iSeq ?? 0) > (seq ?? 0));
          });
        }
        return list.slice(0, Number(args[4] ?? 50));
      }
      if (command === "TTL") return -1;
      if (command === "MEMORY") return 0;
      if (command === "XLEN") return ids.length;
      if (command === "TYPE") return "stream";
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const page = await session.explorer!.inspect("st", "0-0");
    if (page.value.kind !== "stream") throw new Error("expected stream value");
    expect(page.value.entries).toHaveLength(50);
    expect(page.value.entries[0]!.id).toBe("1-1");
    expect(page.value.entries.at(-1)!.id).toBe("50-1");
    expect(page.value.lastId).toBe("50-1");
    expect(page.value.truncated).toBe(true);

    // Next page starts after 50-1 and shows the 51st.
    const next = await session.explorer!.inspect("st", page.value.lastId!);
    if (next.value.kind !== "stream") throw new Error("expected stream value");
    expect(next.value.entries[0]!.id).toBe("51-1");
  });
});

describe("codex round 2 regressions", () => {
  test("legacy stream paging fetches cursor + page + probe, so 100+ entry streams keep going", async () => {
    // Cursor entry 5-1 plus 51 NEW entries: legacy needs COUNT 52 to see the probe.
    const ids = Array.from({ length: 51 }, (_, i) => `${i + 6}-1`);
    const { factory } = makeFake(INFO_REDIS5, (command, args) => {
      if (command === "XRANGE") {
        expect(args).toEqual(["st", "5-1", "+", "COUNT", "52"]);
        return [["5-1", ["f", "x"]], ...ids.map(id => [id, ["f", "v"]])];
      }
      if (command === "TTL") return -1;
      if (command === "MEMORY") return 0;
      if (command === "XLEN") return 56;
      if (command === "TYPE") return "stream";
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const page = await session.explorer!.inspect("st", "5-1");
    if (page.value.kind !== "stream") throw new Error("expected stream value");
    expect(page.value.entries).toHaveLength(50);
    expect(page.value.entries[0]!.id).toBe("6-1");
    expect(page.value.lastId).toBe("55-1");
    expect(page.value.truncated).toBe(true);
  });

  test("keyOp propagates transport failures instead of returning ok:false", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "DEL") throw new Error("ECONNREFUSED: connection refused");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.explorer!.keyOp({ op: "delete", keys: ["a"] })).rejects.toBeInstanceOf(DbError);
    // Command rejections still surface as result errors.
    const missing = makeFake(INFO_REDIS, (command) => { if (command === "RENAME") throw new Error("ERR no such key"); return "OK"; });
    const okSession = await makeRedisDriver(missing.factory).connect({ url: URL });
    const result = await okSession.explorer!.keyOp({ op: "rename", from: "a", to: "b" });
    expect(result.ok).toBe(false);
  });

  test("connect() closes the transport when INFO detection fails", async () => {
    let closed = false;
    const factory: TransportFactory = () => ({
      send: async (command) => { if (command === "INFO") throw new Error("NOPERM this user has no permissions to run the 'info' command"); return "OK"; },
      connect: async () => {},
      close: async () => { closed = true; },
    });
    await expect(makeRedisDriver(factory).connect({ url: URL })).rejects.toMatchObject({ code: "sql" });
    expect(closed).toBe(true);
  });
});

describe("codex round 3 regressions", () => {
  test("WAIT 1 0 is refused by the console guard", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const refused = await session.console!.exec("WAIT 1 0", { writable: true });
    expect(refused.reply.t).toBe("err");
    expect(String((refused.reply as { s: string }).s)).toMatch(/indefinitely/);
  });
});

describe("codex round 4 regressions", () => {
  test("connection-state commands are refused with guidance", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of ["SELECT 1", "SWAPDB 0 1", "SUBSCRIBE channel", "PSUBSCRIBE pat*"]) {
      const result = await session.console!.exec(command, { writable: true });
      expect(result.reply.t, command).toBe("err");
      expect(String((result.reply as { s: string }).s), command).toMatch(/refused by Tern/);
      expect(calls.some(c => c.command === command.split(" ")[0]), command).toBe(false);
    }
  });
});

describe("codex round 5 regressions", () => {
  test("commands that would poison the shared transport never reach it", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of [
      "RESET", "QUIT", "AUTH secret", "HELLO 3", "MONITOR",
      "MULTI", "EXEC", "DISCARD", "WATCH k", "UNWATCH",
      "ASKING", "READONLY", "READWRITE", "SSUBSCRIBE chan",
      "CLIENT REPLY OFF", "CLIENT TRACKING ON", "CLIENT PAUSE 100",
      // Shared-connection mutators — every session user shares the state.
      "CLIENT SETNAME x", "CLIENT SETINFO lib-name x", "CLIENT NO-EVICT on",
      "CLIENT NO-TOUCH on", "CLIENT CACHING yes", "CLIENT UNBLOCK 5",
      "CLIENT UNPAUSE", "CLIENT CAPA RESP3",
      // LDB parks the shared transport inside the Lua debugger.
      "SCRIPT DEBUG YES", "SCRIPT DEBUG SYNC",
    ]) {
      const result = await session.console!.exec(command, { writable: true });
      expect(result.reply.t, command).toBe("err");
      expect(String((result.reply as { s: string }).s), command).toMatch(/refused by Tern/);
    }
    // Only INFO (from connect) reached the transport — nothing else.
    expect(calls.filter(c => c.command !== "INFO")).toEqual([]);
    // Read-side CLIENT subcommands still run fine.
    const list = await session.console!.exec("CLIENT LIST", { writable: true });
    expect(list.reply).toEqual({ t: "str", s: "OK" });
  });

  test("blocking commands beyond the console maximum are refused up front", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("BLPOP queue 999999", { writable: true });
    expect(result.reply.t).toBe("err");
    expect(String((result.reply as { s: string }).s)).toMatch(/maximum/);
    expect(calls.filter(c => c.command === "BLPOP")).toEqual([]);
    // Unparseable timeouts still reach the server for its own error reply.
    const sent = await session.console!.exec("BLPOP queue notanumber", { writable: true });
    expect(sent.reply).toEqual({ t: "str", s: "OK" });
    expect(calls.filter(c => c.command === "BLPOP")).toHaveLength(1);
  });

  test("a hung command rejects with a timeout error so the session can be evicted", async () => {
    const factory: TransportFactory = () => ({
      send: async (command) => { if (command === "INFO") return INFO_REDIS; return new Promise(() => {}); },
      connect: async () => {},
      close: async () => {},
    });
    const session = await makeRedisDriver(factory, { commandTimeoutMs: 30 }).connect({ url: URL });
    await expect(session.console!.exec("GET k", { writable: true })).rejects.toMatchObject({ code: "timeout" });
  });

  test("ACL-denied auxiliary probes degrade instead of failing the inspection", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "string";
      if (command === "MEMORY") throw new Error("NOPERM this user has no permissions to run the 'memory' command");
      if (command === "TTL") return -1;
      if (command === "STRLEN") return 5;
      if (command === "GETRANGE") return "hello";
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    expect(inspection.memoryBytes).toBeNull();
    expect(inspection.value).toMatchObject({ kind: "string", value: "hello" });
  });

  test("a transport failure during scan's TYPE pass propagates as a DbError", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "SCAN") return ["0", ["a"]];
      if (command === "TYPE") throw new Error("ECONNREFUSED: connection refused");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.explorer!.scan({ cursor: "0" })).rejects.toBeInstanceOf(DbError);
  });

  test("malformed stream cursors are rejected before reaching the server", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "stream";
      if (command === "TTL") return -1;
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.explorer!.inspect("st", "bogus")).rejects.toMatchObject({ code: "invalid_change" });
    expect(calls.some(c => c.command === "XRANGE")).toBe(false);
  });

  test("extended server error prefixes arrive as err replies, not session failures", async () => {
    for (const message of ["WRONGTYPE Operation against a key", "NOPERM no permissions", "CLUSTERDOWN the cluster is down", "BUSYKEY target key exists"]) {
      const { factory } = makeFake(INFO_REDIS, (command) => { if (command === "GET") throw new Error(message); return "OK"; });
      const session = await makeRedisDriver(factory).connect({ url: URL });
      const result = await session.console!.exec("GET k", { writable: true });
      expect(result.reply.t, message).toBe("err");
      expect((result.reply as { s: string }).s).toBe(message);
    }
  });
});

describe("codex round 6 regressions", () => {
  test("replication-stream commands are refused before reaching the transport", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of ["SYNC", "PSYNC ? -1", "REPLCONF listening-port 6379"]) {
      const result = await session.console!.exec(command, { writable: true });
      expect(result.reply.t, command).toBe("err");
      expect(String((result.reply as { s: string }).s), command).toMatch(/refused by Tern/);
    }
    expect(calls.filter(c => c.command !== "INFO")).toEqual([]);
  });

  test("refusals beat the writable gate on read-only sessions", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("SELECT 1", { writable: false });
    expect(result.reply.t).toBe("err");
    expect(String((result.reply as { s: string }).s)).toMatch(/refused by Tern/);
  });

  test("read subcommands of admin containers run on read-only sessions", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of ["MEMORY USAGE k", "ACL WHOAMI", "SLOWLOG LEN", "CLUSTER INFO"]) {
      const result = await session.console!.exec(command, { writable: false });
      expect(result.reply, command).toEqual({ t: "str", s: "OK" });
    }
    expect(calls.filter(c => c.command !== "INFO")).toHaveLength(4);
    await expect(session.console!.exec("ACL SETUSER alice on", { writable: false })).rejects.toMatchObject({ code: "not_read_only" });
    await expect(session.console!.exec("MEMORY PURGE", { writable: false })).rejects.toMatchObject({ code: "not_read_only" });
  });

  test("a typed timeout DbError is never reclassified by its message prefix", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "GET") throw new DbError("timeout", "OOM command timed out");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.console!.exec("GET k", { writable: true })).rejects.toMatchObject({ code: "timeout" });
  });

  test("nil numeric replies stay null instead of collapsing to 0", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "string";
      if (command === "TTL" || command === "MEMORY" || command === "STRLEN") return null;
      if (command === "GETRANGE") return "v";
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("s");
    expect(inspection.memoryBytes).toBeNull();
    expect(inspection.size).toBeNull();
    expect(inspection.value).toMatchObject({ kind: "string", value: "v" });
    // An unknown STRLEN must fall back to a bounded GETRANGE — an
    // unbounded GET could pull a multi-GB value into memory.
    const fetch = calls.findLast(c => c.command === "GETRANGE");
    expect(fetch).toBeDefined();
    expect(fetch!.args.at(-1)).not.toBe("-1");
    expect(calls.some(c => c.command === "GET")).toBe(false);
  });

  test("malformed list/hash/set/zset and scan cursors are rejected", async () => {
    const { factory, calls } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "list";
      if (command === "TTL") return -1;
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.explorer!.inspect("l", "bogus")).rejects.toMatchObject({ code: "invalid_change" });
    // A cursor past MAX_SAFE_INTEGER would serialize as "1e+21" on the wire.
    await expect(session.explorer!.inspect("l", "9".repeat(20))).rejects.toMatchObject({ code: "invalid_change" });
    await expect(session.explorer!.scan({ cursor: "bogus" })).rejects.toMatchObject({ code: "invalid_change" });
    expect(calls.some(c => c.command === "LRANGE" || c.command === "SCAN")).toBe(false);
    for (const type of ["hash", "set", "zset"]) {
      const { factory: f } = makeFake(INFO_REDIS, (command) => {
        if (command === "TYPE") return type;
        if (command === "TTL") return -1;
        return null;
      });
      const s = await makeRedisDriver(f).connect({ url: URL });
      await expect(s.explorer!.inspect("k", "bogus"), type).rejects.toMatchObject({ code: "invalid_change" });
    }
  });

  test("infinite zset scores cross the wire as strings", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "TYPE") return "zset";
      if (command === "TTL") return -1;
      if (command === "ZSCAN") return ["0", ["a", "inf", "b", "-inf", "c", "1.5"]];
      return null;
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const inspection = await session.explorer!.inspect("z");
    expect(inspection.value).toMatchObject({
      kind: "zset",
      entries: [
        { member: "a", score: "inf" },
        { member: "b", score: "-inf" },
        { member: "c", score: 1.5 },
      ],
    });
  });
});

describe("codex round 7 regressions", () => {
  test("a STORE/STOREDIST flag makes a read command require writes", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of ["GEORADIUS geo 0 0 1 km STORE dst", "GEORADIUSBYMEMBER geo m 1 km STOREDIST dst", "SORT k STORE dst"]) {
      await expect(session.console!.exec(command, { writable: false }), command).rejects.toMatchObject({ code: "not_read_only" });
    }
    // Bare reads still run on read-only sessions.
    for (const command of ["GEORADIUS geo 0 0 1 km", "SORT k ALPHA"]) {
      const result = await session.console!.exec(command, { writable: false });
      expect(result.reply, command).toEqual({ t: "str", s: "OK" });
    }
    expect(calls.filter(c => c.command !== "INFO")).toHaveLength(2);
  });

  test("BZMPOP resolves its leading timeout for the blocking guards", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const refused = await session.console!.exec("BZMPOP 0 1 k MIN", { writable: true });
    expect(String((refused.reply as { s: string }).s)).toMatch(/indefinitely/);
    const capped = await session.console!.exec("BZMPOP 999999 1 k MIN", { writable: true });
    expect(String((capped.reply as { s: string }).s)).toMatch(/maximum/);
    expect(calls.filter(c => c.command === "BZMPOP")).toEqual([]);
  });

  test("unsubscribe commands are refused — confirmations would desync replies", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    for (const command of ["UNSUBSCRIBE a b", "PUNSUBSCRIBE p*", "SUNSUBSCRIBE chan", "CLIENT KILL ID 3"]) {
      const result = await session.console!.exec(command, { writable: true });
      expect(result.reply.t, command).toBe("err");
      expect(String((result.reply as { s: string }).s), command).toMatch(/refused by Tern/);
    }
    expect(calls.filter(c => c.command !== "INFO")).toEqual([]);
  });

  test("CLIENT read subcommands run on read-only sessions", async () => {
    const { factory } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const result = await session.console!.exec("CLIENT LIST", { writable: false });
    expect(result.reply).toEqual({ t: "str", s: "OK" });
  });

  test("NOAUTH is session-fatal: it throws instead of becoming an err reply", async () => {
    const { factory } = makeFake(INFO_REDIS, (command) => {
      if (command === "GET") throw new Error("NOAUTH Authentication required");
      return "OK";
    });
    const session = await makeRedisDriver(factory).connect({ url: URL });
    await expect(session.console!.exec("GET k", { writable: true })).rejects.toMatchObject({ code: "sql" });
  });

  test("auth failures stay session-fatal even with Bun's ERR_REDIS_SERVER_ERROR code", async () => {
    for (const message of ["NOAUTH Authentication required", "WRONGPASS invalid username-password pair", "DENIED Redis is running in protected mode"]) {
      const { factory } = makeFake(INFO_REDIS, (command) => {
        if (command === "GET") throw Object.assign(new Error(message), { code: "ERR_REDIS_SERVER_ERROR" });
        return "OK";
      });
      const session = await makeRedisDriver(factory).connect({ url: URL });
      await expect(session.console!.exec("GET k", { writable: true }), message).rejects.toMatchObject({ code: "sql" });
    }
  });

  test("a nil keyOp reply omits n rather than reporting 0", async () => {
    const { factory } = makeFake(INFO_REDIS, () => null);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    expect(await session.explorer!.keyOp({ op: "persist", key: "k" })).toEqual({ ok: true });
  });
});

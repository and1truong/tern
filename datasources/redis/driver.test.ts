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
    expect(info.capabilities.streams).toBe(true);
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

  test("indefinite blocking commands are refused; timed ones run", async () => {
    const { factory, calls } = makeFake(INFO_REDIS);
    const session = await makeRedisDriver(factory).connect({ url: URL });
    const refused = await session.console!.exec("BLPOP queue 0", { writable: true });
    expect(refused.reply.t).toBe("err");
    expect(String((refused.reply as { s: string }).s)).toMatch(/indefinitely/);
    await session.console!.exec("BLPOP queue 5", { writable: true });
    expect(calls.at(-1)).toEqual({ command: "BLPOP", args: ["queue", "5"] });
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
    await expect(session.explorer!.scan({ cursor: "0", type: "string" })).rejects.toMatchObject({ code: "sql" });
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
    expect(calls.some(c => c.command === "GET")).toBe(false);
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

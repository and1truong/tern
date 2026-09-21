import { describe, test, expect } from "bun:test";
import { commandCatalog, lookupCommand, isWriteCommand, isReadAllowed, blockingTimeoutSeconds, commandKeys } from "./catalog.ts";

describe("command catalog integrity", () => {
  const names = commandCatalog.map(d => d.name);
  test("names are unique and uppercase", () => {
    expect(new Set(names).size).toBe(names.length);
    names.forEach(n => expect(n).toMatch(/^[A-Z][A-Z0-9._-]*$/));
  });
  test("every doc has required fields with sane values", () => {
    for (const d of commandCatalog) {
      expect(d.summary.length).toBeGreaterThan(3);
      expect(d.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["read", "write", "read-write", "admin"]).toContain(d.access);
      expect(Number.isInteger(d.arity)).toBe(true);
      if (d.args) {
        for (const a of d.args) {
          expect(a.name.length).toBeGreaterThan(0);
          if (a.type === "enum") expect(a.enum?.length).toBeGreaterThan(0);
        }
      }
      expect(d.ttl === undefined || ["clear", "set", "none"].includes(d.ttl)).toBe(true);
    }
  });
  test("core commands the UI relies on are present", () => {
    for (const name of ["GET", "SET", "DEL", "SCAN", "TYPE", "TTL", "EXPIRE", "PERSIST", "RENAME", "HGETALL", "LRANGE", "SMEMBERS", "ZRANGE", "XRANGE", "XADD", "INFO", "PING", "FLUSHALL", "BLPOP", "BZPOPMIN"]) {
      expect(lookupCommand(name), name).not.toBeNull();
    }
  });
  test("lookupCommand is case-insensitive", () => {
    expect(lookupCommand("zrange")?.name).toBe("ZRANGE");
    expect(lookupCommand("NOPE")).toBeNull();
  });
  test("write classification", () => {
    expect(isWriteCommand(lookupCommand("GET"))).toBe(false);
    expect(isWriteCommand(lookupCommand("SET"))).toBe(true);
    expect(isWriteCommand(lookupCommand("FLUSHALL"))).toBe(true);
    expect(isWriteCommand(null)).toBe(false);
  });
  test("blocking timeout resolution", () => {
    const blpop = lookupCommand("BLPOP")!;
    expect(blockingTimeoutSeconds(blpop, ["k", "5"])).toBe(5);
    expect(blockingTimeoutSeconds(blpop, ["a", "b", "0"])).toBe(0);
    expect(blockingTimeoutSeconds(lookupCommand("GET")!, ["k"])).toBeNull();
    // WAIT with zero replicas is trivially satisfied — never blocks.
    expect(blockingTimeoutSeconds(lookupCommand("WAIT")!, ["0", "0"])).toBeNull();
    expect(blockingTimeoutSeconds(lookupCommand("WAIT")!, ["1", "300000"])).toBe(300);
    const xread = lookupCommand("XREAD")!;
    expect(blockingTimeoutSeconds(xread, ["COUNT", "2", "STREAMS", "s", "$"])).toBeNull();
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "0", "STREAMS", "s", "$"])).toBe(0);
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "1500", "STREAMS", "s", "$"])).toBe(1.5);
  });
  test("read-allowed subcommand coverage matches the catalog", () => {
    // The read-only gate must allow the read subs advertised in the enums.
    for (const [name, args] of [
      ["SCRIPT", ["EXISTS", "abc"]], ["SCRIPT", ["HELP"]],
      ["FUNCTION", ["LIST"]], ["FUNCTION", ["STATS"]],
      ["ACL", ["DRYRUN", "u", "SETUSER", "u", "on"]], ["ACL", ["LOG"]], ["ACL", ["LOG", "5"]], ["ACL", ["HELP"]],
      ["XGROUP", ["HELP", "k"]],
    ] as const) {
      const doc = lookupCommand(name)!;
      expect(isReadAllowed(doc, [...args]), `${name} ${args[0]}`).toBe(true);
    }
    // Write subs stay denied — ACL LOG RESET clears the audit log.
    expect(isReadAllowed(lookupCommand("ACL")!, ["LOG", "RESET"])).toBe(false);
    expect(isReadAllowed(lookupCommand("SCRIPT")!, ["FLUSH"])).toBe(false);
    expect(isReadAllowed(lookupCommand("FUNCTION")!, ["DELETE", "f"])).toBe(false);
    // Data-read-only Lua is still arbitrary code — a runaway script stalls
    // the server, so the _RO entry points sit behind the writable gate.
    for (const name of ["EVAL_RO", "EVALSHA_RO", "FCALL_RO"]) {
      expect(lookupCommand(name)?.access, name).toBe("write");
      expect(isReadAllowed(lookupCommand(name)!, ["x", "0"])).toBe(false);
    }
    // RESTORE and the GEO *_RO variants exist for explain/autocomplete.
    expect(lookupCommand("RESTORE")?.access).toBe("write");
    expect(lookupCommand("GEORADIUS_RO")?.access).toBe("read");
    expect(lookupCommand("GEORADIUSBYMEMBER_RO")?.access).toBe("read");
    // Write flags count only where Redis parses them — a literal named
    // "store" filling a value position is an argument, not the option.
    expect(isReadAllowed(lookupCommand("SORT")!, ["k", "GET", "store"])).toBe(true);
    expect(isReadAllowed(lookupCommand("SORT")!, ["k", "BY", "store"])).toBe(true);
    expect(isReadAllowed(lookupCommand("SORT")!, ["k", "STORE", "dst"])).toBe(false);
    expect(isReadAllowed(lookupCommand("SORT")!, ["k", "GET", "a", "STORE", "dst"])).toBe(false);
    expect(isReadAllowed(lookupCommand("GEORADIUSBYMEMBER")!, ["geo", "store", "1", "km"])).toBe(true);
    expect(isReadAllowed(lookupCommand("GEORADIUSBYMEMBER")!, ["geo", "m", "1", "km", "STOREDIST", "dst"])).toBe(false);
    // GETEX reads unless a TTL-changing option is present.
    const getex = lookupCommand("GETEX")!;
    expect(getex.access).toBe("read");
    expect(isReadAllowed(getex, ["k"])).toBe(true);
    expect(isReadAllowed(getex, ["k", "EX", "5"])).toBe(false);
    expect(isReadAllowed(getex, ["k", "PERSIST"])).toBe(false);
    expect(isReadAllowed(getex, ["k", "pxat", "1"])).toBe(false);
    // LATENCY/MODULE read subs run read-only; their mutating subs do not.
    for (const [name, args] of [
      ["LATENCY", ["LATEST"]], ["LATENCY", ["DOCTOR"]], ["LATENCY", ["HISTORY", "ev"]],
      ["MODULE", ["LIST"]], ["MODULE", ["HELP"]], ["CLIENT", ["DOCTOR"]],
      ["CLUSTER", ["MYSHARDID"]], ["CLUSTER", ["COUNT-FAILURE-REPORTS", "nodeid"]],
    ] as const) {
      expect(isReadAllowed(lookupCommand(name)!, [...args]), `${name} ${args[0]}`).toBe(true);
    }
    expect(isReadAllowed(lookupCommand("LATENCY")!, ["RESET"])).toBe(false);
    expect(isReadAllowed(lookupCommand("MODULE")!, ["LOAD", "/m.so"])).toBe(false);
    // ZINTERCARD is the sorted-set twin of SINTERCARD — a plain read.
    expect(lookupCommand("ZINTERCARD")?.access).toBe("read");
    expect(isReadAllowed(lookupCommand("ZINTERCARD")!, ["2", "z1", "z2"])).toBe(true);
    // SCHEDULE belongs to BGSAVE — SAVE takes no arguments.
    expect(lookupCommand("SAVE")?.arity).toBe(1);
    expect(lookupCommand("BGSAVE")?.args?.[0]?.enum).toEqual(["SCHEDULE"]);
    // Newly cataloged entries classify correctly for explain/autocomplete.
    expect(lookupCommand("BITOP")?.access).toBe("write");
    expect(lookupCommand("XSETID")?.access).toBe("write");
    expect(lookupCommand("MIGRATE")?.access).toBe("write");
    expect(lookupCommand("FAILOVER")?.access).toBe("admin");
    expect(lookupCommand("MODULE")?.danger).toBe("admin");
  });
  test("commandKeys derives key arguments from specs", () => {
    expect(commandKeys(lookupCommand("GET")!, ["mykey"])).toEqual(["mykey"]);
    expect(commandKeys(lookupCommand("DEL")!, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(commandKeys(lookupCommand("BLPOP")!, ["q1", "q2", "5"])).toEqual(["q1", "q2"]);
    expect(commandKeys(lookupCommand("ZRANGE")!, ["board", "0", "9"])).toEqual(["board"]);
    expect(commandKeys(lookupCommand("SET")!, ["k", "v", "EX", "10"])).toEqual(["k"]);
  });
});

describe("WAIT blocking classification", () => {
  test("WAIT is blocking with a millisecond timeout", () => {
    const wait = lookupCommand("WAIT")!;
    expect(wait.blocking).toBe(true);
    expect(blockingTimeoutSeconds(wait, ["1", "0"])).toBe(0);
    expect(blockingTimeoutSeconds(wait, ["1", "2000"])).toBe(2);
  });
});

describe("blocking timeout edge cases", () => {
  test("XREAD only honors BLOCK before STREAMS", () => {
    const doc = lookupCommand("XREAD")!;
    expect(blockingTimeoutSeconds(doc, ["BLOCK", "0", "STREAMS", "s", "$"])).toBe(0);
    // A stream literally named BLOCK is not the flag.
    expect(blockingTimeoutSeconds(doc, ["STREAMS", "BLOCK", "0"])).toBeNull();
    expect(blockingTimeoutSeconds(doc, ["COUNT", "5", "BLOCK", "250", "STREAMS", "s", "$"])).toBe(0.25);
  });
  test("XREADGROUP parses the option zone after GROUP/consumer names", () => {
    const doc = lookupCommand("XREADGROUP")!;
    // A group literally named STREAMS must not end the option zone early —
    // the real BLOCK 0 still parks the reply indefinitely.
    expect(blockingTimeoutSeconds(doc, ["GROUP", "STREAMS", "c", "BLOCK", "0", "STREAMS", "s", ">"])).toBe(0);
    // A consumer literally named BLOCK is an argument; the flag follows it.
    expect(blockingTimeoutSeconds(doc, ["GROUP", "g", "BLOCK", "BLOCK", "0", "STREAMS", "s", ">"])).toBe(0);
    // Group BLOCK, consumer 0, no BLOCK flag — must not refuse a non-blocker.
    expect(blockingTimeoutSeconds(doc, ["GROUP", "BLOCK", "0", "STREAMS", "s", ">"])).toBeNull();
    expect(blockingTimeoutSeconds(doc, ["GROUP", "g", "c", "COUNT", "5", "BLOCK", "0", "STREAMS", "s", ">"])).toBe(0);
    expect(blockingTimeoutSeconds(doc, ["GROUP", "g", "c", "COUNT", "5", "STREAMS", "s", ">"])).toBeNull();
  });
});

describe("argRoles and commandKeys", () => {
  test("numkeys bounds the variadic key list (EVAL, ZUNIONSTORE, LMPOP)", () => {
    const evalDoc = lookupCommand("EVAL")!;
    expect(commandKeys(evalDoc, ["return 1", "2", "k1", "k2", "arg1", "arg2"])).toEqual(["k1", "k2"]);
    expect(commandKeys(evalDoc, ["return 1", "0", "arg1"])).toEqual([]);
    const zunion = lookupCommand("ZUNIONSTORE")!;
    expect(commandKeys(zunion, ["dst", "2", "a", "b", "WEIGHTS", "1", "2"])).toEqual(["dst", "a", "b"]);
    const lmpop = lookupCommand("LMPOP")!;
    expect(commandKeys(lmpop, ["2", "a", "b", "LEFT", "COUNT", "3"])).toEqual(["a", "b"]);
  });
  test("XREAD splits the variadic tail into key half then id half", () => {
    const doc = lookupCommand("XREAD")!;
    expect(commandKeys(doc, ["STREAMS", "s1", "s2", "0", "$"])).toEqual(["s1", "s2"]);
    expect(commandKeys(doc, ["COUNT", "10", "STREAMS", "s1", "0"])).toEqual(["s1"]);
  });
  test("absent optional flags do not consume the next argument", () => {
    const copy = lookupCommand("COPY")!;
    expect(commandKeys(copy, ["src", "dst", "REPLACE"])).toEqual(["src", "dst"]);
    const getex = lookupCommand("GETEX")!;
    expect(commandKeys(getex, ["k", "PERSIST"])).toEqual(["k"]);
  });
  test("a variadic value list stops at the next flag (WEIGHTS → AGGREGATE)", () => {
    const zunion = lookupCommand("ZUNIONSTORE")!;
    expect(commandKeys(zunion, ["dst", "2", "a", "b", "WEIGHTS", "1", "2", "AGGREGATE", "MAX"])).toEqual(["dst", "a", "b"]);
    const zinter = lookupCommand("ZINTER")!;
    expect(commandKeys(zinter, ["2", "x", "y", "AGGREGATE", "MIN", "WITHSCORES"])).toEqual(["x", "y"]);
  });
  test("XADD treats only the stream name as a key", () => {
    const xadd = lookupCommand("XADD")!;
    expect(commandKeys(xadd, ["s", "*", "f", "v"])).toEqual(["s"]);
    expect(commandKeys(xadd, ["s", "MAXLEN", "~", "100", "*", "f", "v"])).toEqual(["s"]);
  });
  test("common read commands the reviewer flagged are cataloged", () => {
    for (const name of ["EXPIRETIME", "PEXPIRETIME", "DUMP", "GETBIT", "BITCOUNT", "BITPOS", "BITFIELD_RO", "LCS", "ROLE", "SLOWLOG", "ACL", "CLUSTER", "GEOADD", "GEOSEARCH", "ZREVRANGEBYLEX"]) {
      expect(lookupCommand(name), name).not.toBeNull();
    }
  });
  test("DEL/UNLINK accept a single key and TOUCH is a read", () => {
    // Real arities are -2 (one key minimum) — a lone DEL is legal.
    expect(lookupCommand("DEL")!.arity).toBe(-2);
    expect(lookupCommand("UNLINK")!.arity).toBe(-2);
    // TOUCH carries @read in Redis's own ACL categories.
    expect(lookupCommand("TOUCH")!.access).toBe("read");
  });
});

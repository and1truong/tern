import { describe, test, expect } from "bun:test";
import { commandCatalog, lookupCommand, isWriteCommand, blockingTimeoutSeconds, commandKeys } from "./catalog.ts";

describe("command catalog integrity", () => {
  const names = commandCatalog.map(d => d.name);
  test("names are unique and uppercase", () => {
    expect(new Set(names).size).toBe(names.length);
    names.forEach(n => expect(n).toMatch(/^[A-Z][A-Z0-9.-]*$/));
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
    const xread = lookupCommand("XREAD")!;
    expect(blockingTimeoutSeconds(xread, ["COUNT", "2", "STREAMS", "s", "$"])).toBeNull();
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "0", "STREAMS", "s", "$"])).toBe(0);
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "1500", "STREAMS", "s", "$"])).toBe(1.5);
  });
  test("commandKeys derives key arguments from specs", () => {
    expect(commandKeys(lookupCommand("GET")!, ["mykey"])).toEqual(["mykey"]);
    expect(commandKeys(lookupCommand("DEL")!, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(commandKeys(lookupCommand("BLPOP")!, ["q1", "q2", "5"])).toEqual(["q1", "q2"]);
    expect(commandKeys(lookupCommand("ZRANGE")!, ["board", "0", "9"])).toEqual(["board"]);
    expect(commandKeys(lookupCommand("SET")!, ["k", "v", "EX", "10"])).toEqual(["k"]);
  });
});

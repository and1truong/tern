import { describe, test, expect } from "bun:test";
import { completeCommand, argumentHint, expectsKeyArg, specForPosition } from "./autocomplete.ts";
import { lookupCommand } from "./catalog.ts";

const keys = ["user:1", "user:2", "session:a"];

describe("completeCommand — command names", () => {
  test("empty input lists commands with summaries", () => {
    const items = completeCommand("");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.kind).toBe("command");
    expect(items[0]!.insert.endsWith(" ")).toBe(true);
    const del = completeCommand("DE").find(i => i.label === "DEL")!;
    expect(del.detail).toContain("Remove");
    expect(del.insert).toBe("DEL ");
  });
  test("prefix at token 0", () => {
    const labels = completeCommand("ZR").map(i => i.label);
    expect(labels).toContain("ZRANGE");
    expect(labels).toContain("ZRANK");
    expect(labels).not.toContain("ZADD");
  });
  test("case-insensitive prefixes", () => {
    const labels = completeCommand("zra").map(i => i.label);
    expect(labels).toContain("ZRANGE");
    expect(labels).toContain("ZRANK");
  });
  test("caps the result count", () => {
    expect(completeCommand("").length).toBeLessThanOrEqual(12);
    expect(completeCommand("S").length).toBeLessThanOrEqual(12);
  });
});

describe("completeCommand — arguments", () => {
  test("key-typed args suggest known keys", () => {
    const labels = completeCommand("GET ", { keys }).map(i => i.label);
    expect(labels).toEqual(keys);
    const filtered = completeCommand("GET user:", { keys }).map(i => i.label);
    expect(filtered).toEqual(["user:1", "user:2"]);
  });
  test("enum args suggest literals at the active position", () => {
    const labels = completeCommand("ZRANGE board 0 9 ").map(i => i.label);
    expect(labels).toEqual(expect.arrayContaining(["REV", "WITHSCORES", "BYSCORE", "BYLEX", "LIMIT"]));
    const set = completeCommand("SET k v EX 10 ").map(i => i.label);
    expect(set).toEqual(expect.arrayContaining(["NX", "XX", "GET", "KEEPTTL"]));
    // An optional non-enum spec (SET's seconds) must not hide later flags.
    const beforeExpiry = completeCommand("SET k v ").map(i => i.label);
    expect(beforeExpiry).toEqual(expect.arrayContaining(["EX", "NX", "KEEPTTL"]));
  });
  test("unknown commands produce no argument completions", () => {
    expect(completeCommand("FAKE ")).toEqual([]);
  });
  test("partial input that is not valid quoting never throws", () => {
    const labels = completeCommand('GET "unterminated', { keys }).map(i => i.label);
    expect(Array.isArray(labels)).toBe(true);
    expect(completeCommand("GET se", { keys }).map(i => i.label)).toEqual(["session:a"]);
  });
  test("keys with spaces or quotes insert quoted so they stay one argument", () => {
    const spaced = completeCommand("GET ", { keys: ["weird key", 'quo"ted', "plain"] });
    const byLabel = Object.fromEntries(spaced.map(i => [i.label, i.insert]));
    expect(byLabel["weird key"]).toBe('"weird key"');
    expect(byLabel['quo"ted']).toBe('"quo\\"ted"');
    expect(byLabel["plain"]).toBe("plain");
  });
});

describe("expectsKeyArg / specForPosition", () => {
  test("expectsKeyArg only fires while typing a key argument", () => {
    expect(expectsKeyArg("GET ")).toBe(true);
    expect(expectsKeyArg("GET k")).toBe(true);
    expect(expectsKeyArg("SET k ")).toBe(false);   // value position
    expect(expectsKeyArg("GET")).toBe(false);      // command-name position
    expect(expectsKeyArg("FAKE ")).toBe(false);
  });
  test("key positions resolve through argRoles, not just spec index", () => {
    // MSET interleaves key/value pairs — even positions are keys.
    expect(expectsKeyArg("MSET ")).toBe(true);
    expect(expectsKeyArg("MSET a ")).toBe(false);
    expect(expectsKeyArg("MSET a 1 ")).toBe(true);
    // EVAL's numkeys bounds the key list; argv positions are not keys.
    expect(expectsKeyArg("EVAL s 1 ")).toBe(true);
    expect(expectsKeyArg("EVAL s 1 k ")).toBe(false);
    // XREAD keys sit in the first half after STREAMS.
    expect(expectsKeyArg("XREAD STREAMS ")).toBe(true);
  });
  test("specForPosition returns null past a fixed arity", () => {
    const get = lookupCommand("GET")!;
    expect(specForPosition(get, 0)?.name).toBe("key");
    expect(specForPosition(get, 1)).toBeNull();
    // Variadic tails keep their spec forever.
    const del = lookupCommand("DEL")!;
    expect(specForPosition(del, 5)?.name).toBe("key");
  });
});

describe("argumentHint", () => {
  test("describes the active argument position", () => {
    const hint = argumentHint("ZRANGE board 0 9 RE");
    expect(hint.doc?.name).toBe("ZRANGE");
    expect(hint.position).toBe(3);
    expect(hint.hint).toContain("REV");
  });
  test("empty input has no hint", () => {
    expect(argumentHint("").doc).toBeNull();
    expect(argumentHint("").hint).toBe("");
  });
  test("unknown command has no hint", () => {
    expect(argumentHint("FAKE x").doc).toBeNull();
  });
});

describe("argumentHint trailing whitespace", () => {
  test("position advances once per completed argument", () => {
    expect(argumentHint("SET ").position).toBe(0);
    expect(argumentHint("SET ").hint).toContain("key");
    expect(argumentHint("SET k ").position).toBe(1);
    expect(argumentHint("SET k ").hint).toContain("value");
    expect(argumentHint("SET k v ").position).toBe(2);
    expect(argumentHint("SET k v EX 10 ").position).toBe(4);
  });
});

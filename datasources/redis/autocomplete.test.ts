import { describe, test, expect } from "bun:test";
import { completeCommand, argumentHint } from "./autocomplete.ts";

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
  });
  test("unknown commands produce no argument completions", () => {
    expect(completeCommand("FAKE ")).toEqual([]);
  });
  test("partial input that is not valid quoting never throws", () => {
    const labels = completeCommand('GET "unterminated', { keys }).map(i => i.label);
    expect(Array.isArray(labels)).toBe(true);
    expect(completeCommand("GET se", { keys }).map(i => i.label)).toEqual(["session:a"]);
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

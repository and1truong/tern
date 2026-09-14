import { describe, test, expect } from "bun:test";
import { tokenizeCommand, encodeRESP } from "./resp.ts";

describe("tokenizeCommand", () => {
  test("splits on whitespace", () => {
    expect(tokenizeCommand("ZRANGE leaderboard 0 9 REV WITHSCORES")).toEqual(
      ["ZRANGE", "leaderboard", "0", "9", "REV", "WITHSCORES"]);
  });
  test("collapses runs of spaces and trims", () => {
    expect(tokenizeCommand("  GET   key  ")).toEqual(["GET", "key"]);
  });
  test("double quotes with escapes", () => {
    expect(tokenizeCommand('SET k "hello \\"world\\"\n"')).toEqual(["SET", "k", 'hello "world"\n']);
  });
  test("single quotes: literal backslash, doubled quote escapes", () => {
    expect(tokenizeCommand("SET k 'a\\nb''c'")).toEqual(["SET", "k", "a\\nb'c"]);
  });
  test("mismatched quote throws with position", () => {
    expect(() => tokenizeCommand('SET k "unterminated')).toThrow(/quote/);
  });
  test("empty input yields empty array", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("encodeRESP", () => {
  test("scalars", () => {
    expect(encodeRESP(null)).toEqual({ t: "nil" });
    expect(encodeRESP("OK")).toEqual({ t: "str", s: "OK" });
    expect(encodeRESP(5)).toEqual({ t: "int", n: 5 });
    expect(encodeRESP(1.5)).toEqual({ t: "dbl", n: 1.5 });
    expect(encodeRESP(true)).toEqual({ t: "bool", b: true });
    expect(encodeRESP(10n)).toEqual({ t: "big", s: "10" });
  });
  test("error instances become err replies", () => {
    expect(encodeRESP(new Error("ERR wrong number"))).toEqual({ t: "err", s: "ERR wrong number" });
  });
  test("arrays, maps, sets and nested values", () => {
    expect(encodeRESP(["a", 1, null])).toEqual({ t: "arr", items: [{ t: "str", s: "a" }, { t: "int", n: 1 }, { t: "nil" }] });
    expect(encodeRESP(new Map([["k", 1]]))).toEqual({ t: "map", entries: [[{ t: "str", s: "k" }, { t: "int", n: 1 }]] });
    expect(encodeRESP(new Set(["a"]))).toEqual({ t: "set", items: [{ t: "str", s: "a" }] });
  });
  test("Uint8Array decodes lossily to str", () => {
    expect(encodeRESP(new Uint8Array([104, 105]))).toEqual({ t: "str", s: "hi" });
  });
  test("objects fall back to string form", () => {
    expect(encodeRESP({ a: 1 })).toEqual({ t: "str", s: "[object Object]" });
  });
});

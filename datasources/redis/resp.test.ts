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
  test("single quotes: literal backslash, backslash-quote escapes", () => {
    expect(tokenizeCommand("SET k 'a\\nb'")).toEqual(["SET", "k", "a\\nb"]);
    expect(tokenizeCommand("SET k 'it\\'s'")).toEqual(["SET", "k", "it's"]);
  });
  test("mismatched quote throws with position", () => {
    expect(() => tokenizeCommand('SET k "unterminated')).toThrow(/quote/);
  });
  test("empty input yields empty array", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
  test("a quote may open mid-token, but a closing quote must end it (sdssplitargs)", () => {
    expect(tokenizeCommand("SET k a'b'")).toEqual(["SET", "k", "ab"]);
    expect(tokenizeCommand("SET k a'b' c")).toEqual(["SET", "k", "ab", "c"]);
    // Text after a closing quote is an "unbalanced quotes" error in redis-cli.
    expect(() => tokenizeCommand("SET k a'b'c")).toThrow(/[Uu]nbalanced/);
    expect(() => tokenizeCommand('SET k "x"y')).toThrow(/[Uu]nbalanced/);
    expect(() => tokenizeCommand('SET k "a""b"')).toThrow(/[Uu]nbalanced/);
  });
  test("unknown escapes are literal; \\x decodes only with two hex digits", () => {
    // \d is not a known escape — it contributes the literal char 'd'.
    expect(tokenizeCommand('SET k "C:\\Users"')).toEqual(["SET", "k", "C:Users"]);
    // \x takes the next two chars only when both are hex digits.
    expect(tokenizeCommand('SET k "a\\x41b"')).toEqual(["SET", "k", "aAb"]);
    // Otherwise \x stays literal — "\x4" is the token x4, not an error, and
    // "\xzz" is xzz, not a NUL byte.
    expect(tokenizeCommand('SET k "\\x4"')).toEqual(["SET", "k", "x4"]);
    expect(tokenizeCommand('SET k "\\xzz"')).toEqual(["SET", "k", "xzz"]);
    expect(tokenizeCommand('SET k "\\x4g"')).toEqual(["SET", "k", "x4g"]);
    // Bytes >= 0x80 cannot round-trip through a UTF-8 string transport —
    // refuse them rather than silently emit a different key than redis-cli.
    expect(() => tokenizeCommand('GET "\\xff"')).toThrow();
    expect(() => tokenizeCommand('GET "\\x80"')).toThrow();
    expect(tokenizeCommand('GET "\\x7f"')).toEqual(["GET", "\x7f"]);
  });
  test("\\v and \\f are literal mid-token; NUL ends the input (sdssplitargs)", () => {
    // sdssplitargs only breaks tokens on ' ', \t, \n, \r and NUL — a \v
    // inside a word is content, so GET\x0bk is one unknown command.
    expect(tokenizeCommand("GET\x0bk")).toEqual(["GET\vk"]);
    expect(tokenizeCommand("GET\x0ck")).toEqual(["GET\fk"]);
    // But as inter-token whitespace (C isspace) they still separate.
    expect(tokenizeCommand("GET \x0b k")).toEqual(["GET", "k"]);
    // NUL terminates the line like a C string.
    expect(tokenizeCommand("GET k\0junk")).toEqual(["GET", "k"]);
  });
  test("NUL inside quotes is an unterminated quote; post-quote \\v ends the token", () => {
    // sdssplitargs: NUL ends the input, so the open quote never closes.
    expect(() => tokenizeCommand('SET "a\0b" v')).toThrow(/unmatched/i);
    // Any isspace after a closing quote ends the token — \v/\f included —
    // and a NUL right after the quote ends the whole input, not the quote.
    expect(tokenizeCommand('SET "a"\vb v')).toEqual(["SET", "a", "b", "v"]);
    expect(tokenizeCommand('SET "a"\0b')).toEqual(["SET", "a"]);
  });
  test("only ASCII whitespace separates tokens", () => {
    // redis-cli uses C isspace(): a NBSP stays inside the argument.
    expect(tokenizeCommand("SET k")).toEqual(["SET k"]);
    expect(tokenizeCommand("GET\ta\tb")).toEqual(["GET", "a", "b"]);
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
  test("plain objects encode as maps", () => {
    expect(encodeRESP({ a: 1 })).toEqual({ t: "map", entries: [[{ t: "str", s: "a" }, { t: "int", n: 1 }]] });
    expect(encodeRESP({})).toEqual({ t: "map", entries: [] });
  });
  test("non-finite doubles encode as strings because JSON cannot carry them", () => {
    expect(encodeRESP(Number.NaN)).toEqual({ t: "str", s: "NaN" });
    expect(encodeRESP(Number.POSITIVE_INFINITY)).toEqual({ t: "str", s: "Infinity" });
    expect(encodeRESP(Number.NEGATIVE_INFINITY)).toEqual({ t: "str", s: "-Infinity" });
    expect(encodeRESP(0.5)).toEqual({ t: "dbl", n: 0.5 });
  });
});

import { expect, test } from "bun:test";
import { renderRESP } from "./RedisConsole.tsx";
import type { RespValue } from "../shared/types.ts";

test("renderRESP renders malformed replies instead of throwing", () => {
  // The wire shape is trusted only as far as the tag — a malformed or
  // hostile server reply must degrade to text, not crash the document.
  expect(renderRESP(undefined as unknown as RespValue)).toEqual(["(unprintable reply)"]);
  expect(renderRESP({ t: "bogus" } as unknown as RespValue)).toEqual(["(unprintable reply)"]);
  expect(renderRESP({ t: "arr", items: "no" } as unknown as RespValue)).toEqual(["(empty array)"]);
  expect(() => renderRESP({ t: "map", entries: null } as unknown as RespValue)).not.toThrow();
  expect(() => renderRESP({ t: "arr", items: [{ t: "arr", items: [undefined] }] } as unknown as RespValue)).not.toThrow();
  // A non-string payload under the "str" tag must degrade, not throw on .replace.
  expect(renderRESP({ t: "str", s: 42 } as unknown as RespValue)).toEqual(["(unprintable reply)"]);
});

test("renderRESP caps recursion through nested maps", () => {
  // Map keys and values both recurse — the depth cap must sit at renderRESP's
  // entry or a deeply nested map reply overflows the stack.
  let deep: RespValue = { t: "nil" };
  for (let i = 0; i < 200; i++) deep = { t: "map", entries: [[{ t: "str", s: "k" }, deep]] };
  expect(() => renderRESP(deep)).not.toThrow();
  expect(renderRESP(deep).join("\n")).toContain("…");
});

test("renderRESP renders well-formed values", () => {
  expect(renderRESP({ t: "int", n: 3 })).toEqual(["(integer) 3"]);
  expect(renderRESP({ t: "arr", items: [{ t: "str", s: "a" }] })).toEqual(["1)", '  "a"']);
});

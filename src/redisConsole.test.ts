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
});

test("renderRESP renders well-formed values", () => {
  expect(renderRESP({ t: "int", n: 3 })).toEqual(["(integer) 3"]);
  expect(renderRESP({ t: "arr", items: [{ t: "str", s: "a" }] })).toEqual(["1)", '  "a"']);
});

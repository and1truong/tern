import { expect, test } from "bun:test";
import { binaryByteLength, decodeDbValue, encodeDbValue, isDbBinaryValue, unwrapDbValueForDisplay } from "./binaryValues.ts";

test("round-trips binary database values through a tagged JSON-safe representation", () => {
  const encoded = encodeDbValue(new Uint8Array([0, 1, 127, 128, 255]));
  expect(isDbBinaryValue(encoded)).toBe(true);
  expect(binaryByteLength(encoded as { __dbmWire: { kind: "binary"; base64: string } })).toBe(5);
  expect([...decodeDbValue(encoded) as Uint8Array]).toEqual([0, 1, 127, 128, 255]);
});

test("does not reinterpret ordinary JSON objects as binary", () => {
  const values = [
    { __dbmBinary: "AA==" },
    { __dbmWire: { kind: "binary", base64: "AA==" } },
    { __dbmWire: { kind: "json", value: "original" } },
  ];
  for (const value of values) {
    const encoded = encodeDbValue(value);
    expect(isDbBinaryValue(encoded)).toBe(false);
    expect(decodeDbValue(encoded)).toBe(value);
    expect(unwrapDbValueForDisplay(encoded)).toBe(value);
  }
});

test("retains binary envelopes when unwrapping display values", () => {
  const encoded = encodeDbValue(new Uint8Array([0]));
  expect(unwrapDbValueForDisplay(encoded)).toBe(encoded);
});

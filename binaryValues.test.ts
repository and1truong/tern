import { expect, test } from "bun:test";
import { binaryByteLength, decodeDbValue, encodeDbValue, isDbBinaryValue, unwrapDbValueForDisplay } from "./binaryValues.ts";

test("round-trips binary database values through a tagged JSON-safe representation", () => {
  const encoded = encodeDbValue(new Uint8Array([0, 1, 127, 128, 255]));
  expect(isDbBinaryValue(encoded)).toBe(true);
  expect(binaryByteLength(encoded as { __ternWire: { kind: "binary"; base64: string } })).toBe(5);
  expect([...decodeDbValue(encoded) as Uint8Array]).toEqual([0, 1, 127, 128, 255]);
});

test("does not reinterpret ordinary JSON objects as binary", () => {
  const values = [
    { __ternBinary: "AA==" },
    { __ternWire: { kind: "binary", base64: "AA==" } },
    { __ternWire: { kind: "json", value: "original" } },
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

test("nonfinite numbers survive JSON transport and optimistic predicate decoding", () => {
  for (const value of [Infinity, -Infinity, NaN]) {
    const wire = JSON.parse(JSON.stringify(encodeDbValue(value)));
    expect(Object.is(decodeDbValue(wire), value)).toBe(true);
    expect(unwrapDbValueForDisplay(wire)).toBe(String(value));
  }
  const collision = { __ternWire: { kind: "number", value: "Infinity" } };
  expect(decodeDbValue(JSON.parse(JSON.stringify(encodeDbValue(collision))))).toEqual(collision);
});

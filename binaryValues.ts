const WIRE_TAG = "__ternWire";

export interface DbBinaryValue {
  __ternWire: { kind: "binary"; base64: string };
}

interface DbEscapedJsonValue {
  __ternWire: { kind: "json"; value: unknown };
}

function hasWireTag(value: unknown): value is Record<typeof WIRE_TAG, unknown> {
  return !!value && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, WIRE_TAG);
}

export function isDbBinaryValue(value: unknown): value is DbBinaryValue {
  if (!hasWireTag(value)) return false;
  const envelope = value[WIRE_TAG];
  return !!envelope && typeof envelope === "object"
    && Object.keys(value).length === 1
    && Object.keys(envelope).length === 2
    && (envelope as Record<string, unknown>).kind === "binary"
    && typeof (envelope as Record<string, unknown>).base64 === "string";
}

function isEscapedJsonValue(value: unknown): value is DbEscapedJsonValue {
  if (!hasWireTag(value)) return false;
  const envelope = value[WIRE_TAG];
  return !!envelope && typeof envelope === "object"
    && Object.keys(value).length === 1
    && Object.keys(envelope).length === 2
    && (envelope as Record<string, unknown>).kind === "json"
    && Object.prototype.hasOwnProperty.call(envelope, "value");
}

export function unwrapDbValueForDisplay(value: unknown): unknown {
  return isEscapedJsonValue(value) ? value[WIRE_TAG].value : value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function encodeDbValue(value: unknown): unknown {
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) {
    return { [WIRE_TAG]: { kind: "binary", base64: bytesToBase64(value) } };
  }
  if (hasWireTag(value)) {
    return { [WIRE_TAG]: { kind: "json", value } };
  }
  return value;
}

export function decodeDbValue(value: unknown): unknown {
  if (isDbBinaryValue(value)) {
    const binary = atob(value[WIRE_TAG].base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (isEscapedJsonValue(value)) return value[WIRE_TAG].value;
  return value;
}

export function binaryByteLength(value: DbBinaryValue): number {
  const base64 = value[WIRE_TAG].base64;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
}

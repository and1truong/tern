// Redis command-line tokenizing and RESP → JSON encoding. Pure, shared by
// server (console execution) and client (autocomplete/explain/lint parsing).
import type { RespValue } from "../../shared/types.ts";

// Tokenize a command line following redis-cli rules: whitespace separates
// tokens; "double quotes" support \x hex, \n \r \t \b \a and \\ escapes plus
// \" for a literal quote; 'single quotes' support only '' for a literal quote
// and keep backslashes literal.
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    let token = "";
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++]!;
      for (;;) {
        if (i >= n) throw new Error(`Unmatched ${quote === '"' ? "double" : "single"} quote in command`);
        const ch = input[i++]!;
        if (ch === quote) {
          if (quote === "'" && input[i] === "'") { token += "'"; i++; continue; }
          break;
        }
        if (quote === '"' && ch === "\\") {
          if (i >= n) throw new Error("Unmatched escape at end of command");
          const esc = input[i++]!;
          const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", a: "\a", '"': '"', "\\": "\\" };
          if (esc === "x") {
            const hex = input.slice(i, i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("Invalid \\x escape in command");
            token += String.fromCharCode(parseInt(hex, 16)); i += 2;
          } else if (esc in simple) token += simple[esc]!;
          else throw new Error(`Unsupported escape \\${esc} in command`);
        } else token += ch;
      }
    } else {
      while (i < n && !/\s/.test(input[i]!)) { token += input[i++]!; }
    }
    tokens.push(token);
  }
  return tokens;
}

// Encode an arbitrary parsed RESP value (as returned by the transport) into the
// tagged wire form. The transport may hand us strings, numbers, booleans,
// bigint, null, arrays, Maps, Sets, Errors and Uint8Arrays.
export function encodeRESP(value: unknown): RespValue {
  if (value === null || value === undefined) return { t: "nil" };
  if (value instanceof Error) return { t: "err", s: value.message };
  switch (typeof value) {
    case "string": return { t: "str", s: value };
    case "boolean": return { t: "bool", b: value };
    case "bigint": return { t: "big", s: value.toString() };
    case "number": return Number.isInteger(value) ? { t: "int", n: value } : { t: "dbl", n: value };
  }
  if (value instanceof Uint8Array) return { t: "str", s: new TextDecoder("utf-8", { fatal: false }).decode(value) };
  if (Array.isArray(value)) return { t: "arr", items: value.map(encodeRESP) };
  if (value instanceof Map) return { t: "map", entries: [...value].map(([k, v]) => [encodeRESP(k), encodeRESP(v)] as [RespValue, RespValue]) };
  if (value instanceof Set) return { t: "set", items: [...value].map(encodeRESP) };
  return { t: "str", s: String(value) };
}

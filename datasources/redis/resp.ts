// Redis command-line tokenizing and RESP → JSON encoding. Pure, shared by
// server (console execution) and client (autocomplete/explain/lint parsing).
import type { RespValue } from "../../shared/types.ts";

// redis-cli's sdssplitargs uses C isspace() — ASCII whitespace only, so a
// NBSP inside an argument stays part of the argument.
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f";
// …but the token switch only ends a token on ' ', \t, \n, \r or NUL — \v
// and \f mid-token are literal characters, and NUL ends the input entirely.
const isTokenBreak = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\0";

// Tokenize a command line following redis-cli rules: whitespace separates
// tokens; "double quotes" support \x hex, \n \r \t \b \a and \\ escapes plus
// \" for a literal quote — any other escaped char is literal — while
// 'single quotes' support only \' and keep other backslashes literal. A
// quoted section may open mid-token (a"b" is ab), but a closing quote must
// be followed by whitespace or end-of-line, matching sdssplitargs.
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && isSpace(input[i]!)) i++;
    if (i >= n || input[i] === "\0") break;
    let token = "";
    // A successful closing quote ends the token on ANY isspace — \v and \f
    // included — even though they can't break a bare token.
    let done = false;
    while (i < n && !done && !isTokenBreak(input[i]!)) {
      if (input[i] === '"' || input[i] === "'") {
        const quote = input[i++]!;
        for (;;) {
          // A literal NUL ends the input mid-quote too (a C string) — the
          // quote is then unterminated, matching sdssplitargs.
          if (i >= n || input[i] === "\0") throw new Error(`Unmatched ${quote === '"' ? "double" : "single"} quote in command`);
          const ch = input[i++]!;
          if (ch === quote) {
            // sdssplitargs: a closing quote must end the token — trailing
            // text is an "unbalanced quotes" error, not concatenation. NUL
            // counts as "nothing at all": the token ends and input stops.
            if (i < n && input[i] !== "\0" && !isSpace(input[i]!)) throw new Error("Unbalanced quotes in command");
            done = true;
            break;
          }
          if (quote === "'" && ch === "\\" && input[i] === "'") { token += "'"; i++; continue; }
          if (quote === '"' && ch === "\\") {
            if (i >= n) throw new Error("Unmatched escape at end of command");
            const esc = input[i++]!;
            const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", a: "\a", '"': '"', "\\": "\\" };
            // sdssplitargs only takes the hex branch when TWO hex digits
            // follow \x — anything else leaves the \x literal and parses the
            // chars as ordinary content ("\x4" → the token "x4", not an
            // error or a NUL byte).
            if (esc === "x" && /^[0-9a-fA-F]$/.test(input[i] ?? "") && /^[0-9a-fA-F]$/.test(input[i + 1] ?? "")) {
              const byte = parseInt(input[i]!, 16) * 16 + parseInt(input[i + 1]!, 16);
              // Args reach the server as UTF-8 strings — a byte ≥ 0x80 would
              // silently encode as a two-byte sequence (sdssplitargs emits
              // the raw byte, which this transport cannot express).
              if (byte >= 0x80) throw new Error("Binary \\x escapes (>= \\x80) are not supported");
              token += String.fromCharCode(byte);
              i += 2;
            } else token += simple[esc] ?? esc;
          } else token += ch;
        }
      } else token += input[i++]!;
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
    case "number": return Number.isInteger(value) ? { t: "int", n: value }
      // JSON cannot carry NaN/Infinity; render them as plain text instead.
      : Number.isFinite(value) ? { t: "dbl", n: value } : { t: "str", s: String(value) };
  }
  if (value instanceof Uint8Array) return { t: "str", s: new TextDecoder("utf-8", { fatal: false }).decode(value) };
  if (Array.isArray(value)) return { t: "arr", items: value.map(encodeRESP) };
  if (value instanceof Map) return { t: "map", entries: [...value].map(([k, v]) => [encodeRESP(k), encodeRESP(v)] as [RespValue, RespValue]) };
  if (value instanceof Set) return { t: "set", items: [...value].map(encodeRESP) };
  // RESP3 maps arrive as plain objects (null prototype) on Bun's transport —
  // encode them as maps rather than rendering "[object Object]".
  if (typeof value === "object") return { t: "map", entries: Object.entries(value as Record<string, unknown>).map(([k, v]) => [encodeRESP(k), encodeRESP(v)] as [RespValue, RespValue]) };
  return { t: "str", s: String(value) };
}

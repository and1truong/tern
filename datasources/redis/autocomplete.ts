// Deterministic command-line completion for the Redis console: command names
// at token 0, then literal enum tokens, known key names, and per-position
// argument hints. Pure metadata — works offline, no AI.
import { commandCatalog, lookupCommand, type CommandArgSpec, type CommandDoc } from "./catalog.ts";
import { tokenizeCommand } from "./resp.ts";

export interface Completion {
  label: string;
  kind: "command" | "enum" | "key";
  detail?: string;
  insert: string;
}

// Split partial input into completed tokens plus the trailing (partial) token.
// Malformed quoting must never break typing, so fall back to naive splitting.
function splitPartial(input: string): { tokens: string[]; prefix: string; atSpace: boolean } {
  const atSpace = /\s$/.test(input);
  let tokens: string[];
  try { tokens = tokenizeCommand(input); }
  catch { tokens = input.trim().split(/\s+/).filter(Boolean); }
  if (atSpace) return { tokens, prefix: "", atSpace };
  const prefix = tokens.at(-1) ?? "";
  return { tokens: tokens.slice(0, -1), prefix, atSpace };
}

const MAX_COMPLETIONS = 12;

export function completeCommand(input: string, opts: { keys?: string[]; max?: number } = {}): Completion[] {
  const max = opts.max ?? MAX_COMPLETIONS;
  const { tokens, prefix } = splitPartial(input);
  const upper = prefix.toUpperCase();

  if (tokens.length === 0) {
    const source = prefix
      ? commandNames().filter(name => name.startsWith(upper))
      : commandNames();
    return source.slice(0, max).map(name => {
      const doc = lookupCommand(name)!;
      return {
        label: name, kind: "command" as const,
        detail: `${doc.summary} · ${doc.access} · arity ${doc.arity}`,
        insert: `${name} `,
      };
    });
  }

  const doc = lookupCommand(tokens[0]!);
  if (!doc) return [];
  const argIndex = tokens.length - 1;
  const lower = prefix.toLowerCase();
  const completions: Completion[] = [];
  for (const spec of enumSpecsAt(doc, argIndex)) {
    for (const value of spec.enum!) {
      if (value.toUpperCase().startsWith(upper)) {
        completions.push({ label: value, kind: "enum", detail: spec.description, insert: `${value} ` });
      }
    }
  }
  if (hasKeyArgAt(doc, argIndex) && opts.keys) {
    for (const key of opts.keys) {
      if (key.toLowerCase().startsWith(lower)) completions.push({ label: key, kind: "key", insert: key });
    }
  }
  return completions.slice(0, max);
}

export interface ArgumentHint {
  doc: CommandDoc | null;
  position: number;   // 0-based index of the argument being typed
  hint: string;
}

export function argumentHint(input: string): ArgumentHint {
  const { tokens, atSpace } = splitPartial(input);
  if (tokens.length === 0) return { doc: null, position: 0, hint: "" };
  const doc = lookupCommand(tokens[0]!);
  if (!doc) return { doc: null, position: 0, hint: "" };
  const position = tokens.length - 1 + (atSpace ? 1 : 0);
  const spec = specForPosition(doc, position);
  if (!spec) return { doc, position, hint: "" };
  const detail = spec.description ?? spec.enum?.join(" | ") ?? spec.type ?? "";
  return { doc, position, hint: `arg ${position + 1}: ${spec.name}${spec.optional ? " (optional)" : ""}${detail ? ` — ${detail}` : ""}` };
}

// The active arg spec, plus later optional enum specs (Redis flags may appear
// in loose order, so ZRANGE's position 3 also offers WITHSCORES and LIMIT).
function enumSpecsAt(doc: CommandDoc, argIndex: number): CommandArgSpec[] {
  const specs = doc.args ?? [];
  const active = specForPosition(doc, argIndex);
  if (!active) return [];
  const result = active.enum ? [active] : [];
  if (!active.enum) return result;
  const start = specs.indexOf(active);
  for (let i = start + 1; i < specs.length; i++) {
    const spec = specs[i]!;
    if (!spec.optional || !spec.enum) break;
    result.push(spec);
  }
  return result;
}

function hasKeyArgAt(doc: CommandDoc, argIndex: number): boolean {
  const spec = specForPosition(doc, argIndex);
  return spec?.type === "key";
}

export function specForPosition(doc: CommandDoc, argIndex: number): CommandArgSpec | null {
  const specs = doc.args;
  if (!specs?.length) return null;
  let i = 0;
  for (const spec of specs) {
    if (spec.multiple) {
      if (argIndex >= i) return spec;
      return null;
    }
    if (argIndex === i) return spec;
    i++;
  }
  return specs.at(-1) ?? null;
}

let cachedNames: string[] | null = null;
function commandNames(): string[] {
  if (!cachedNames) cachedNames = commandCatalog.map(d => d.name);
  return cachedNames;
}

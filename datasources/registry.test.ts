import { describe, test, expect } from "bun:test";
import { createDriverRegistry } from "./registry.ts";
import type { DataSourceDriver } from "./contracts.ts";

const fake = (id: string): DataSourceDriver => ({
  id, displayName: id, kind: "key-value",
  validateUrl: () => {},
  test: undefined as never, connect: undefined as never,
});

describe("driver registry", () => {
  test("registers, resolves and lists drivers", () => {
    const registry = createDriverRegistry();
    const a = fake("a");
    registry.register(a);
    expect(registry.get("a")).toBe(a);
    expect(registry.get("missing")).toBeNull();
    expect(registry.list().map(d => d.id)).toEqual(["a"]);
  });
  test("last registration wins for the same id", () => {
    const registry = createDriverRegistry();
    registry.register(fake("a"));
    const b = fake("a");
    registry.register(b);
    expect(registry.get("a")).toBe(b);
  });
});

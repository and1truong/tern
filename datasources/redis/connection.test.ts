import { describe, test, expect } from "bun:test";
import { buildRedisUrl, validateRedisUrl, sessionUrl } from "./connection.ts";

describe("buildRedisUrl", () => {
  test("host only", () => expect(buildRedisUrl({ host: "localhost" })).toBe("redis://localhost:6379"));
  test("port, db index, tls scheme", () => {
    expect(buildRedisUrl({ host: "db.example.com", port: 6380, database: 2 })).toBe("redis://db.example.com:6380/2");
    expect(buildRedisUrl({ host: "db.example.com", tls: true })).toBe("rediss://db.example.com:6379");
  });
  test("password only targets the default user; username included when present", () => {
    expect(buildRedisUrl({ host: "h", password: "secret" })).toBe("redis://:secret@h:6379");
    expect(buildRedisUrl({ host: "h", username: "default", password: "secret" })).toBe("redis://default:secret@h:6379");
  });
});

describe("validateRedisUrl", () => {
  test("accepts redis and rediss urls with host", () => {
    expect(() => validateRedisUrl("redis://localhost:6379")).not.toThrow();
    expect(() => validateRedisUrl("rediss://:pw@h/0")).not.toThrow();
  });
  test("rejects wrong scheme, missing host, non-numeric db, query params", () => {
    expect(() => validateRedisUrl("postgres://h")).toThrow(/redis/i);
    expect(() => validateRedisUrl("redis://")).toThrow(/host/i);
    expect(() => validateRedisUrl("redis://h/abc")).toThrow(/database/i);
    expect(() => validateRedisUrl("redis://h/?foo=bar")).toThrow(/option/i);
  });
});

describe("sessionUrl", () => {
  test("applies the db index while preserving userinfo", () => {
    expect(sessionUrl("redis://:pw@h:6379", "3")).toBe("redis://:pw@h:6379/3");
    expect(sessionUrl("redis://:pw@h:6379/9", "0")).toBe("redis://:pw@h:6379");
    expect(sessionUrl("redis://h:6379", undefined)).toBe("redis://h:6379");
  });
});

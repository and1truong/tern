import { describe, test, expect } from "bun:test";
import { lintCommand } from "./lint.ts";

const noCluster = { writable: true, cluster: false };

describe("lintCommand", () => {
  test("clean read yields no warnings", () => {
    expect(lintCommand("GET mykey", noCluster)).toEqual([]);
    expect(lintCommand("", noCluster)).toEqual([]);
  });
  test("KEYS is flagged as a full scan with a SCAN suggestion", () => {
    const [warning] = lintCommand("KEYS *", noCluster);
    expect(warning!.rule).toBe("keys-full-scan");
    expect(warning!.severity).toBe("warning");
    expect(warning!.suggestion).toContain("SCAN");
  });
  test("FLUSHALL is destructive", () => {
    const [warning] = lintCommand("FLUSHALL", noCluster);
    expect(warning!.severity).toBe("error");
    expect(warning!.rule).toBe("flush-destructive");
  });
  test("unbounded collection reads are flagged", () => {
    for (const command of ["SMEMBERS bigset", "HGETALL bighash", "HKEYS bighash", "HVALS bighash", "LRANGE list 0 -1", "ZRANGE z 0 -1 WITHSCORES"]) {
      const warning = lintCommand(command, noCluster).find(w => w.rule === "unbounded-read");
      expect(warning, command).toBeDefined();
    }
    expect(lintCommand("LRANGE list 0 99", noCluster).find(w => w.rule === "unbounded-read")).toBeUndefined();
  });
  test("indefinite blocking is an error pointing at a timeout", () => {
    const [warning] = lintCommand("BLPOP queue 0", noCluster);
    expect(warning!.rule).toBe("blocking-indefinite");
    expect(warning!.severity).toBe("error");
    expect(lintCommand("BLPOP queue 5", noCluster).find(w => w.rule === "blocking-indefinite")).toBeUndefined();
  });
  test("admin commands warn", () => {
    expect(lintCommand("CONFIG SET maxmemory 1gb", noCluster).some(w => w.rule === "admin-command")).toBe(true);
    expect(lintCommand("MONITOR", noCluster).some(w => w.rule === "admin-command")).toBe(true);
  });
  test("writes against a read-only session are errors", () => {
    const warnings = lintCommand("SET k v", { writable: false, cluster: false });
    expect(warnings.some(w => w.rule === "write-readonly" && w.severity === "error")).toBe(true);
  });
  test("unknown commands on read-only sessions are refused in advance", () => {
    const warnings = lintCommand("FT.SEARCH idx *", { writable: false, cluster: false });
    expect(warnings.some(w => w.rule === "unclassified-readonly")).toBe(true);
    expect(lintCommand("FT.SEARCH idx *", { writable: true, cluster: false }).some(w => w.rule === "unclassified-readonly")).toBe(false);
  });
  test("cross-slot multi-key warns under cluster", () => {
    const bad = lintCommand("MSET a 1 b 2", { writable: true, cluster: true }).find(w => w.rule === "cross-slot");
    expect(bad).toBeDefined();
    expect(lintCommand("MSET {t}a 1 {t}b 2", { writable: true, cluster: true }).find(w => w.rule === "cross-slot")).toBeUndefined();
    expect(lintCommand("MSET a 1 b 2", { writable: true, cluster: false }).find(w => w.rule === "cross-slot")).toBeUndefined();
  });
  test("arity mismatches inform without blocking", () => {
    const warning = lintCommand("GET", noCluster).find(w => w.rule === "arity");
    expect(warning!.severity).toBe("info");
  });
});

test("WAIT with timeout 0 is flagged as indefinite blocking", () => {
  const [warning] = lintCommand("WAIT 1 0", noCluster);
  expect(warning!.rule).toBe("blocking-indefinite");
  expect(lintCommand("WAIT 1 2000", noCluster).find(w => w.rule === "blocking-indefinite")).toBeUndefined();
});

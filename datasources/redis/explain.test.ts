import { describe, test, expect } from "bun:test";
import { explainCommand, hashTagOf } from "./explain.ts";

describe("explainCommand", () => {
  test("the issue's ZRANGE example", () => {
    const x = explainCommand("ZRANGE leaderboard 0 9 REV WITHSCORES", { cluster: false });
    expect(x.name).toBe("ZRANGE");
    expect(x.known).toBe(true);
    expect(x.access).toBe("read");
    expect(x.complexity).toContain("O(log(N)+M)");
    expect(x.blocking).toBe(false);
    expect(x.ttlEffect).toBe("none");
    expect(x.args[0]).toEqual({ token: "leaderboard", meaning: expect.stringContaining("key") });
    expect(x.expected).toContain("Members");
  });
  test("KEYS surfaces full-scan danger and SCAN suggestion", () => {
    const x = explainCommand("KEYS *", { cluster: false });
    expect(x.dangers.join(" ")).toMatch(/keyspace/i);
    expect(x.risks.join(" ")).toMatch(/SCAN/i);
  });
  test("indefinite blocking is flagged", () => {
    const x = explainCommand("BLPOP queue 0", { cluster: false });
    expect(x.blocking).toBe(true);
    expect(x.risks.join(" ")).toMatch(/indefinit|forever/i);
  });
  test("cluster guidance for multi-key commands", () => {
    const ok = explainCommand("DEL {a}k1 {a}k2", { cluster: true });
    expect(ok.cluster).toEqual([]);
    const bad = explainCommand("DEL alpha beta", { cluster: true });
    expect(bad.cluster.join(" ")).toMatch(/hash slot|hash tag/i);
  });
  test("unknown commands degrade gracefully", () => {
    const x = explainCommand("FAKE x", { cluster: false });
    expect(x.known).toBe(false);
    expect(x.access).toBe("unknown");
  });
  test("arity mismatch is a risk", () => {
    const x = explainCommand("GET", { cluster: false });
    expect(x.risks.join(" ")).toMatch(/argument/i);
  });
});

describe("hashTagOf", () => {
  test("extracts the hashtag or falls back to the whole key", () => {
    expect(hashTagOf("{user1}.profile")).toBe("user1");
    expect(hashTagOf("plain")).toBe("plain");
  });
});

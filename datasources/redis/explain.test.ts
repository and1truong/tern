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
  test("XREAD is only blocking when BLOCK is present", () => {
    expect(explainCommand("XREAD STREAMS s $", { cluster: false }).blocking).toBe(false);
    expect(explainCommand("XREAD BLOCK 500 STREAMS s $", { cluster: false }).blocking).toBe(true);
  });
  test("WAIT with zero replicas is trivially satisfied, not blocking", () => {
    expect(explainCommand("WAIT 0 0", { cluster: false }).blocking).toBe(false);
    expect(explainCommand("WAIT 1 1000", { cluster: false }).blocking).toBe(true);
  });
  test("unknown commands degrade gracefully", () => {
    const x = explainCommand("FAKE x", { cluster: false });
    expect(x.known).toBe(false);
    expect(x.access).toBe("unknown");
  });
  test("refused commands surface the refusal as a danger", () => {
    expect(explainCommand("MULTI", { cluster: false }).dangers.join(" ")).toMatch(/refused/i);
    expect(explainCommand("CLIENT PAUSE 100", { cluster: false }).dangers.join(" ")).toMatch(/refused/i);
    // Even uncataloged refusals are explained.
    expect(explainCommand("SYNC", { cluster: false }).dangers.join(" ")).toMatch(/refused/i);
  });
  test("arity mismatch is a risk", () => {
    const x = explainCommand("GET", { cluster: false });
    expect(x.risks.join(" ")).toMatch(/argument/i);
  });
  test("a read doc with a write option flag reports the effective access", () => {
    // SORT … STORE writes a new key — exec and lint already enforce that;
    // explain must not still say "read".
    const x = explainCommand("SORT k STORE dst", { cluster: false });
    expect(x.access).toBe("write");
    expect(x.risks.join(" ")).toMatch(/writes a new key/i);
    expect(explainCommand("SORT k", { cluster: false }).access).toBe("read");
  });
});

describe("hashTagOf", () => {
  test("extracts the hashtag or falls back to the whole key", () => {
    expect(hashTagOf("{user1}.profile")).toBe("user1");
    expect(hashTagOf("plain")).toBe("plain");
  });
  test("follows Redis cluster semantics for edge cases", () => {
    // An empty {} or an unmatched { contributes no hashtag.
    expect(hashTagOf("{}key")).toBe("{}key");
    expect(hashTagOf("{unclosed")).toBe("{unclosed");
    // Only the FIRST tag counts; a second {} is literal.
    expect(hashTagOf("{a}{b}")).toBe("a");
    expect(hashTagOf("x{a}y{b}z")).toBe("a");
  });
});

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
  test("unbounded range variants are flagged", () => {
    const ro = { writable: true, cluster: false };
    const rules = (input: string) => lintCommand(input, ro).map(w => w.rule);
    expect(rules("ZREVRANGE k 0 -1")).toContain("unbounded-read");
    expect(rules("ZRANGEBYSCORE k -inf +inf")).toContain("unbounded-read");
    expect(rules("ZREVRANGEBYSCORE k +inf -inf")).toContain("unbounded-read");
    expect(rules("ZRANGEBYLEX k - +")).toContain("unbounded-read");
    expect(rules("ZREVRANGEBYLEX k + -")).toContain("unbounded-read");
    expect(rules("ZRANGE k -inf +inf BYSCORE")).toContain("unbounded-read");
    expect(rules("ZRANGE k +inf -inf REV BYSCORE")).toContain("unbounded-read");
    expect(rules("ZRANGE k + - REV BYLEX")).toContain("unbounded-read");
    expect(rules("ZRANGE k - + BYLEX")).toContain("unbounded-read");
    expect(rules("ZRANGE k 0 -1")).toContain("unbounded-read");
    expect(rules("ZRANGE k 0 -1 REV")).toContain("unbounded-read");
    // Bounded ranges stay quiet.
    expect(rules("ZRANGEBYSCORE k 0 100")).not.toContain("unbounded-read");
    expect(rules("ZRANGE k 0 10 BYSCORE")).not.toContain("unbounded-read");
    expect(rules("ZRANGE k 0 10")).not.toContain("unbounded-read");
    // Bounds are case-insensitive and may carry an exclusive "(" server-side.
    expect(rules("ZRANGEBYSCORE k -INF +INF")).toContain("unbounded-read");
    expect(rules("ZRANGEBYSCORE k (-inf (+inf")).toContain("unbounded-read");
    expect(rules("ZRANGE k -INF +INF BYSCORE")).toContain("unbounded-read");
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

test("whole-collection algebra reads warn like SMEMBERS", () => {
  for (const command of ["SINTER a b", "SDIFF a b", "ZUNION a b", "ZINTER a b", "ZINTERCARD 2 z1 z2", "XREAD STREAMS s 0", "SUBSTR k 0 -1"]) {
    expect(lintCommand(command, noCluster).find(w => w.rule === "unbounded-read"), command).toBeDefined();
  }
  expect(lintCommand("XREAD STREAMS s $", noCluster).find(w => w.rule === "unbounded-read")).toBeUndefined();
  expect(lintCommand("XREAD COUNT 5 STREAMS s 0", noCluster).find(w => w.rule === "unbounded-read")).toBeUndefined();
});

test("connection-state commands warn as refused before they hit the wire", () => {
  for (const command of ["SELECT 3", "SUBSCRIBE ch", "MONITOR", "RESET", "MULTI", "WATCH k"]) {
    const warning = lintCommand(command, noCluster).find(w => w.rule === "refused-command");
    expect(warning, command).toBeDefined();
    expect(warning!.severity).toBe("error");
  }
  expect(lintCommand("CLIENT TRACKING ON", noCluster).find(w => w.rule === "refused-command")).toBeDefined();
  for (const sub of ["SETNAME x", "NO-EVICT on", "UNBLOCK 5", "CACHING yes", "UNPAUSE", "CAPA RESP3"]) {
    expect(lintCommand(`CLIENT ${sub}`, noCluster).find(w => w.rule === "refused-command"), sub).toBeDefined();
  }
  // SCRIPT DEBUG parks the shared transport inside the Lua debugger.
  expect(lintCommand("SCRIPT DEBUG YES", noCluster).find(w => w.rule === "refused-command")).toBeDefined();
  expect(lintCommand("SCRIPT EXISTS abc", noCluster).find(w => w.rule === "refused-command")).toBeUndefined();
  expect(lintCommand("CLIENT LIST", noCluster).find(w => w.rule === "refused-command")).toBeUndefined();
  expect(lintCommand("GET k", noCluster).find(w => w.rule === "refused-command")).toBeUndefined();
  // Refusals keyed on the name still warn when the command is uncataloged.
  for (const command of ["SYNC", "PSYNC", "REPLCONF listening-port 6379"]) {
    expect(lintCommand(command, noCluster).find(w => w.rule === "refused-command"), command).toBeDefined();
  }
});

test("read-only subcommands of admin containers stay lint-clean on read-only sessions", () => {
  const ro = { writable: false, cluster: false };
  expect(lintCommand("MEMORY USAGE k", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("ACL WHOAMI", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("ACL SETUSER alice on", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  expect(lintCommand("MEMORY PURGE", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  // A "read"-classified command carrying a write flag is a write.
  expect(lintCommand("GEORADIUS geo 0 0 1 km STORE dst", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  expect(lintCommand("SORT k STORE dst", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  // A literal named "store" in a value position is not the STORE flag.
  expect(lintCommand("SORT k GET store", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("SORT k BY store", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("GEORADIUSBYMEMBER geo store 1 km", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("GEORADIUSBYMEMBER geo m 1 km STOREDIST dst", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  // GETEX is a read unless a TTL-changing option is present.
  expect(lintCommand("GETEX k", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("GETEX k EX 5", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  expect(lintCommand("GETEX k PERSIST", ro).find(w => w.rule === "write-readonly")).toBeDefined();
  expect(lintCommand("GEORADIUS geo 0 0 1 km", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("SORT_RO k", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
  expect(lintCommand("PFCOUNT a b", ro).find(w => w.rule === "write-readonly")).toBeUndefined();
});

test("blocking timeouts beyond the console cap warn like the exec refusal", () => {
  const rules = (input: string) => lintCommand(input, noCluster).map(w => w.rule);
  expect(rules("BLPOP q 999")).toContain("blocking-timeout-max");
  expect(rules("BZMPOP 999 1 k MIN")).toContain("blocking-timeout-max");
  expect(rules("BLPOP q 60")).not.toContain("blocking-timeout-max");
  expect(rules("BLPOP q 0")).toContain("blocking-indefinite");
});

test("full-range stream and string reads are flagged unbounded", () => {
  const rules = (input: string) => lintCommand(input, noCluster).map(w => w.rule);
  expect(rules("XRANGE s - +")).toContain("unbounded-read");
  expect(rules("XREVRANGE s + -")).toContain("unbounded-read");
  expect(rules("GETRANGE k 0 -1")).toContain("unbounded-read");
  // A trailing COUNT bounds the reply — not a whole-collection read.
  expect(rules("XRANGE s - + COUNT 5")).not.toContain("unbounded-read");
  expect(rules("XRANGE s 0-1 9999999999999-0")).not.toContain("unbounded-read");
  expect(rules("GETRANGE k 0 9")).not.toContain("unbounded-read");
  // Whole-collection set/zset algebra and store variants scan everything.
  for (const command of [
    "SINTERCARD 2 a b", "SINTERSTORE dst a b", "SUNIONSTORE dst a b",
    "SDIFFSTORE dst a b", "ZINTERSTORE dst 2 a b", "ZUNIONSTORE dst 2 a b",
    "SINTER a b", "SUNION a b", "SDIFF a b", "ZUNION 2 a b",
  ]) {
    expect(rules(command), command).toContain("unbounded-read");
  }
  // Stream reads from the zero id without COUNT scan the entire history —
  // "00" parses as id 0-0 server-side too.
  expect(rules("XREAD STREAMS s 0")).toContain("unbounded-read");
  expect(rules("XREAD STREAMS s 0-0")).toContain("unbounded-read");
  expect(rules("XREAD STREAMS s 00")).toContain("unbounded-read");
  // "-0" is a legal zero index server-side; LIMIT/COUNT tails bound the read.
  expect(rules("LRANGE k -0 -1")).toContain("unbounded-read");
  expect(rules("ZRANGEBYSCORE k -inf +inf LIMIT 0 10")).not.toContain("unbounded-read");
  expect(rules("ZRANGEBYLEX k - + LIMIT 0 10")).not.toContain("unbounded-read");
  expect(rules("XRANGE s - + COUNT 5")).not.toContain("unbounded-read");
  expect(rules("XREVRANGE s + - COUNT 5")).not.toContain("unbounded-read");
  expect(rules("ZRANGE k -inf +inf BYSCORE LIMIT 0 10")).not.toContain("unbounded-read");
  expect(rules("SINTERCARD 2 a b LIMIT 5")).not.toContain("unbounded-read");
  expect(rules("ZINTERCARD 2 a b LIMIT 5")).not.toContain("unbounded-read");
  // LIMIT 0 is documented "unlimited" for *INTERCARD; a negative LIMIT count
  // returns everything from the offset on the ZRANGE family.
  expect(rules("SINTERCARD 2 a b LIMIT 0")).toContain("unbounded-read");
  expect(rules("ZINTERCARD 2 a b LIMIT 0")).toContain("unbounded-read");
  expect(rules("ZRANGEBYSCORE k -inf +inf LIMIT 0 -1")).toContain("unbounded-read");
  expect(rules("ZRANGEBYLEX k - + LIMIT 0 -1")).toContain("unbounded-read");
  expect(rules("ZRANGE k -inf +inf BYSCORE LIMIT 0 -1")).toContain("unbounded-read");
  expect(rules("XRANGE s - + COUNT -1")).toContain("unbounded-read");
  expect(rules("SINTERCARD 2 a b")).toContain("unbounded-read");
  expect(rules("XREAD COUNT 5 STREAMS s 0")).not.toContain("unbounded-read");
  expect(rules("XREAD STREAMS s $")).not.toContain("unbounded-read");
  // Whole-collection reads in disguise: XINFO FULL, SORT, LCS.
  expect(rules("XINFO STREAM k FULL")).toContain("unbounded-read");
  expect(rules("XINFO STREAM k FULL COUNT 10")).not.toContain("unbounded-read");
  expect(rules("XINFO STREAM k")).not.toContain("unbounded-read");
  expect(rules("XINFO GROUPS k")).not.toContain("unbounded-read");
  expect(rules("SORT k")).toContain("unbounded-read");
  expect(rules("SORT k BY w_* GET o_*")).toContain("unbounded-read");
  expect(rules("SORT k LIMIT 0 10")).not.toContain("unbounded-read");
  expect(rules("SORT k LIMIT 0 -1")).toContain("unbounded-read");
  expect(rules("LCS a b")).toContain("unbounded-read");
  expect(rules("LCS a b LEN")).not.toContain("unbounded-read");
  // A group/consumer literally named COUNT/STREAMS is an argument, not the
  // keyword — the replayed-history warning must still fire.
  expect(rules("XREADGROUP GROUP COUNT c STREAMS k 0")).toContain("unbounded-read");
  expect(rules("XREADGROUP GROUP STREAMS c STREAMS k 0")).toContain("unbounded-read");
  expect(rules("XREADGROUP GROUP g c COUNT 5 STREAMS k 0")).not.toContain("unbounded-read");
});

import { describe, test, expect } from "bun:test";
import { parseInfoSections, detectDataSourceInfo } from "./capabilities.ts";

const redis72 = [
  "# Server",
  "redis_version:7.2.4",
  "redis_mode:standalone",
  "os:Linux",
  "tcp_port:6379",
  "uptime_in_seconds:100",
  "# Clients",
  "connected_clients:2",
  "# Memory",
  "used_memory_human:1.00M",
  "# Persistence",
  "# Stats",
  "# Replication",
  "role:master",
  "# CPU",
  "# Cluster",
  "cluster_enabled:0",
  "# Keyspace",
  "db0:keys=3,expires=1,avg_ttl=0",
].join("\r\n");

const valkey81 = redis72
  .replace("redis_version:7.2.4", "redis_version:7.2.4\nvalkey_version:8.1.1");

const redis5 = redis72.replace("redis_version:7.2.4", "redis_version:5.0.14");

const withModules = redis72 + "\r\n# Modules\r\nmodule:name=search,ver=20800,api=1";

describe("parseInfoSections", () => {
  test("flattens key:value lines and ignores comments", () => {
    const { sections, modules } = parseInfoSections(redis72);
    expect(sections.redis_version).toBe("7.2.4");
    expect(sections.cluster_enabled).toBe("0");
    expect(sections.db0).toBe("keys=3,expires=1,avg_ttl=0");
    expect(modules).toEqual([]);
  });
  test("collects module names", () => {
    const { modules } = parseInfoSections(withModules);
    expect(modules).toEqual(["search"]);
  });
  test("tolerates an already-parsed object (some transports pre-parse INFO)", () => {
    const { sections } = parseInfoSections({ redis_version: "7.0.0" });
    expect(sections.redis_version).toBe("7.0.0");
  });
});

describe("detectDataSourceInfo", () => {
  test("redis 7.2: flavor, version, capabilities, summary", () => {
    const info = detectDataSourceInfo(redis72);
    expect(info.flavor).toBe("redis");
    expect(info.version).toBe("7.2.4");
    expect(info.capabilities).toEqual({ streams: true, acl: true, functions: true, cluster: false, modules: false, search: false });
    expect(info.summary.totalKeys).toBe(3);
    expect(info.summary.tcpPort).toBe(6379);
  });
  test("valkey reports valkey flavor while keeping redis_version compat line", () => {
    const info = detectDataSourceInfo(valkey81);
    expect(info.flavor).toBe("valkey");
    expect(info.version).toBe("8.1.1");
  });
  test("redis 5 predates acl/functions", () => {
    const info = detectDataSourceInfo(redis5);
    expect(info.capabilities).toEqual({ streams: true, acl: false, functions: false, cluster: false, modules: false, search: false });
  });
  test("cluster + search module flags", () => {
    const info = detectDataSourceInfo(withModules.replace("cluster_enabled:0", "cluster_enabled:1"));
    expect(info.capabilities!.cluster).toBe(true);
    expect(info.capabilities!.search).toBe(true);
    expect(info.capabilities!.modules).toBe(true);
  });
  test("unknown server yields unknown flavor and no capabilities", () => {
    const info = detectDataSourceInfo("# Server\r\nfoo:bar");
    expect(info.flavor).toBe("unknown");
    expect(info.version).toBe("");
    expect(info.capabilities).toEqual({ streams: false, acl: false, functions: false, cluster: false, modules: false, search: false });
  });
});

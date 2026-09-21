// Server metadata → flavor/version/capabilities. Pure: unit-testable, and the
// UI's feature decisions consume Capabilities rather than product names.
import type { Capabilities, DataSourceInfo, RedisFlavor } from "../../shared/types.ts";

const versionParts = (version: string): [number, number] => {
  const parts = version.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0];
};

export function versionAtLeast(version: string, maj: number, min = 0): boolean {
  const [vMaj, vMin] = versionParts(version);
  return vMaj > maj || (vMaj === maj && vMin >= min);
};
const since = (version: string, maj: number, min = 0) => versionAtLeast(version, maj, min);

export function parseInfoSections(raw: unknown): {
  sections: Record<string, string>; modules: string[];
} {
  const sections: Record<string, string> = {};
  const modules: string[] = [];
  // Transports may decode INFO's bulk reply into a Map or carry it as
  // bytes; anything else (a bare number, a stray array) is no INFO payload.
  if (raw instanceof Map) raw = Object.fromEntries(raw);
  if (raw instanceof Uint8Array) raw = new TextDecoder("utf-8").decode(raw);
  if (raw === null || raw === undefined) return { sections, modules };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) sections[k] = String(v);
    return { sections, modules };
  }
  if (typeof raw !== "string") return { sections, modules };
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("module:")) {
      const name = /[,:]name=([^,]+)/.exec(line)?.[1];
      if (name) modules.push(name);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx > 0) sections[line.slice(0, idx)!] = line.slice(idx + 1);
  }
  return { sections, modules };
}

export function detectDataSourceInfo(raw: unknown): DataSourceInfo {
  const { sections, modules } = parseInfoSections(raw);
  const flavor: RedisFlavor = sections.valkey_version ? "valkey" : sections.redis_version ? "redis" : "unknown";
  const version = sections.valkey_version ?? sections.redis_version ?? "";
  const capabilities: Capabilities = {
    streams: since(version, 5),
    acl: since(version, 6),
    functions: since(version, 7),
    cluster: sections.cluster_enabled === "1",
    modules: modules.length > 0,
    // Older RediSearch reports as name=ft, not search*.
    search: modules.some(m => /^(ft|search|searchlight)/i.test(m)),
  };
  let totalKeys = 0;
  for (const [key, value] of Object.entries(sections)) {
    if (/^db\d+$/.test(key)) totalKeys += Number(/keys=(\d+)/.exec(value)?.[1] ?? 0);
  }
  const summary: Record<string, string | number | boolean> = { totalKeys };
  const summaryFields = {
    tcp_port: "tcpPort", uptime_in_seconds: "uptimeSeconds", connected_clients: "connectedClients",
    used_memory_human: "usedMemory", role: "role", os: "os",
  } as const;
  for (const [field, label] of Object.entries(summaryFields)) {
    const value = sections[field];
    if (value !== undefined) summary[label] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return { flavor, version, capabilities, summary };
}

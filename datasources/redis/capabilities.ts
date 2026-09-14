// Server metadata → flavor/version/capabilities. Pure: unit-testable, and the
// UI's feature decisions consume Capabilities rather than product names.
import type { Capabilities, DataSourceInfo, RedisFlavor } from "../../shared.ts";

const versionParts = (version: string): [number, number] => {
  const parts = version.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0];
};

export function versionAtLeast(version: string, maj: number, min = 0): boolean {
  const [vMaj, vMin] = versionParts(version);
  return vMaj > maj || (vMaj === maj && vMin >= min);
};
const since = (version: string, maj: number, min = 0) => versionAtLeast(version, maj, min);

export function parseInfoSections(raw: string | Record<string, unknown>): {
  sections: Record<string, string>; modules: string[];
} {
  const sections: Record<string, string> = {};
  const modules: string[] = [];
  if (raw === null || raw === undefined) return { sections, modules };
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) sections[k] = String(v);
    return { sections, modules };
  }
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

export function detectDataSourceInfo(raw: string | Record<string, unknown>): DataSourceInfo {
  const { sections, modules } = parseInfoSections(raw);
  const flavor: RedisFlavor = sections.valkey_version ? "valkey" : sections.redis_version ? "redis" : "unknown";
  const version = sections.valkey_version ?? sections.redis_version ?? "";
  const capabilities: Capabilities = {
    streams: since(version, 5),
    acl: since(version, 6),
    functions: since(version, 7),
    cluster: sections.cluster_enabled === "1",
    modules: modules.length > 0,
    search: modules.some(m => m.includes("search")),
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

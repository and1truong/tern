// Connection-string handling for the Redis-compatible driver. The URL carries
// host/port, username/password, TLS (rediss scheme) and logical db (path) —
// mirroring how the Postgres driver treats its connection URL.
export const REDIS_DEFAULT_PORT = 6379;

export function buildRedisUrl(opts: {
  host: string; port?: number; username?: string; password?: string; tls?: boolean; database?: number;
}): string {
  // IPv6 literals must be bracketed in URLs (mirrors the Postgres builder).
  const host = opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
  const auth = opts.password !== undefined
    ? `//${encodeURIComponent(opts.username ?? "")}:${encodeURIComponent(opts.password)}@`
    : "//";
  const port = opts.port ?? REDIS_DEFAULT_PORT;
  const db = opts.database !== undefined && opts.database > 0 ? `/${opts.database}` : "";
  return `${opts.tls ? "rediss" : "redis"}:${auth}${host}:${port}${db}`;
}

export function validateRedisUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid Redis URL"); }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("A Redis URL (redis:// or rediss://) is required");
  if (!parsed.hostname) throw new Error("A Redis URL with a host is required");
  const db = parsed.pathname.replace(/^\//, "");
  if (db && !/^\d+$/.test(db)) throw new Error("The Redis URL database must be a numeric db index");
  for (const key of parsed.searchParams.keys()) throw new Error(`Unsupported Redis URL option: ${key}`);
}

// Apply (or replace) the logical db index for a session; keeps credentials.
export function sessionUrl(url: string, database?: string): string {
  const parsed = new URL(url);
  const dbPath = database !== undefined && database !== "" && database !== "0" ? `/${database}` : "";
  const auth = parsed.username || parsed.password
    ? `${parsed.username}:${parsed.password}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${dbPath}`;
}

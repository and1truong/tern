// Connection-string handling for the Redis-compatible driver. The URL carries
// host/port, username/password, TLS (rediss scheme) and logical db (path) —
// mirroring how the Postgres driver treats its connection URL.
export const REDIS_DEFAULT_PORT = 6379;

export function buildRedisUrl(opts: {
  host: string; port?: number; username?: string; password?: string; tls?: boolean; database?: number;
}): string {
  // A host with URL-significant characters would repartition the URL
  // ("a@b" → username "a", host "b") — reject rather than mistarget.
  if (/[@/?#\s]/.test(opts.host)) throw new Error("The Redis host must not contain URL-significant characters");
  // IPv6 literals must be bracketed in URLs (mirrors the Postgres builder).
  const host = opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
  const auth = opts.password !== undefined
    ? `//${encodeURIComponent(opts.username ?? "")}:${encodeURIComponent(opts.password)}@`
    : "//";
  const port = opts.port ?? REDIS_DEFAULT_PORT;
  // A negative or non-integer index must not silently collapse to db 0.
  if (opts.database !== undefined && (!Number.isInteger(opts.database) || opts.database < 0)) throw new Error("The Redis database must be a non-negative db index");
  const db = opts.database ? `/${opts.database}` : "";
  return `${opts.tls ? "rediss" : "redis"}:${auth}${host}:${port}${db}`;
}

export function validateRedisUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid Redis URL"); }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("A Redis URL (redis:// or rediss://) is required");
  if (!parsed.hostname) throw new Error("A Redis URL with a host is required");
  if (parsed.hash) throw new Error("A Redis URL must not contain a fragment");
  const db = parsed.pathname.replace(/^\//, "");
  if (db && !/^\d+$/.test(db)) throw new Error("The Redis URL database must be a numeric db index");
  for (const key of parsed.searchParams.keys()) throw new Error(`Unsupported Redis URL option: ${key}`);
}

// Apply (or replace) the logical db index for a session; keeps credentials.
// database === undefined preserves the db index embedded in the URL.
export function sessionUrl(url: string, database?: string): string {
  validateRedisUrl(url);
  const parsed = new URL(url);
  if (database !== undefined && database !== "" && !/^\d+$/.test(database)) throw new Error("The Redis database must be a numeric db index");
  const effective = database === undefined ? parsed.pathname.replace(/^\//, "") : database;
  const dbPath = effective !== "" && effective !== "0" ? `/${effective}` : "";
  // A username-only URL must not gain an empty password — AUTH user "" is a
  // WRONGPASS where no AUTH was wanted. (parsed.* stays percent-encoded —
  // re-interpolating it raw is correct.)
  const auth = parsed.username || parsed.password
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${dbPath}`;
}

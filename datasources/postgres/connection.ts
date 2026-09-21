// Saved-profile URL validation for the postgres driver.
export function validatePgUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid PostgreSQL URL"); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('A PostgreSQL URL with a host is required');
  const ssl = parsed.searchParams.get("sslmode");
  if (ssl && !["disable", "prefer", "require", "verify-ca", "verify-full"].includes(ssl)) throw new Error("Invalid SSL mode");
  for (const key of parsed.searchParams.keys()) {
    if (!['sslmode', 'application_name', 'connect_timeout'].includes(key)) throw new Error(`Unsupported PostgreSQL URL option: ${key}`);
  }
}

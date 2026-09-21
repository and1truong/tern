// DbError → HTTP response mapping shared by the server handlers and the
// datasource router so driver errors map to the same statuses.
import { DbError } from "./types.ts";

const safeMessage = (message: string) => message
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[PostgreSQL connection]")
  .replace(/rediss?:\/\/[^\s"']+/gi, "[Redis connection]");

export const dbErrorResponse = (e: unknown): Response => {
  if (e instanceof DbError) {
    const status = e.code === "not_found" ? 404
      : e.code === "not_read_only" ? 403
      : e.code === "timeout" || e.code === "cancelled" ? 408
      : e.code === "conflict" ? 409
      : 400;
    return Response.json({ error: safeMessage(e.message), code: e.code }, { status });
  }
  return Response.json({ error: e instanceof Error ? safeMessage(e.message) : "db error" }, { status: 400 });
};

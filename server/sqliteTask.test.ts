import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTask } from "./sqliteTask.ts";

test('native SQLite query timeout and cancellation leave the server responsive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tern-cancel-'));
  const path = join(dir, 'test.sqlite'); new Database(path).close();
  const sql = 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x';
  try {
    await expect(sqliteTask({ operation: 'query', args: [path, sql, []] }, undefined, 30)).rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController();
    const result = sqliteTask({ operation: 'query', args: [path, sql, []] }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(await sqliteTask({ operation: 'query', args: [path, 'SELECT 42 AS answer', []] })).toMatchObject({ rows: [{ answer: 42 }] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

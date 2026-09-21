import { describe, expect, test } from "bun:test";
import { assertReadOnlyScript, assertReadOnlySql, boundReadSql, sqlTokens } from "./sqlSafety.ts";
import { DbError } from "./types.ts";

describe("SQL read-only safety", () => {
  test("ignores keywords and semicolons in strings, identifiers, and comments", () => {
    expect(sqlTokens(`/* DELETE; */ SELECT 'UPDATE;' AS "DROP"`)).toEqual(["SELECT", "AS"]);
    expect(assertReadOnlySql(`/* inspect */ SELECT 'value;';`)).toBe(`/* inspect */ SELECT 'value;'`);
  });

  test("ignores PostgreSQL dollar-quoted bodies", () => {
    expect(assertReadOnlySql("SELECT $$ DELETE; UPDATE $$ AS body")).toBe("SELECT $$ DELETE; UPDATE $$ AS body");
    expect(assertReadOnlySql("SELECT $tag$ DROP TABLE x; $tag$ AS body")).toContain("SELECT");
  });

  test("ignores nested PostgreSQL block-comment content", () => {
    const sql = "SELECT /* outer /* DELETE; */ UPDATE; still outer */ 1";
    expect(sqlTokens(sql)).toEqual(["SELECT"]);
    expect(assertReadOnlySql(sql)).toBe(sql);
  });

  test("rejects write operations nested under WITH and EXPLAIN", () => {
    expect(() => assertReadOnlySql("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"))
      .toThrow(DbError);
    expect(() => assertReadOnlySql("EXPLAIN ANALYZE UPDATE t SET n = 1"))
      .toThrow(DbError);
  });

  test("rejects multiple statements but accepts one trailing terminator", () => {
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2"))
      .toThrow(DbError);
    expect(assertReadOnlySql("SELECT 1;")).toBe("SELECT 1");
    expect(assertReadOnlySql("SELECT 1; -- done")).toBe("SELECT 1 -- done");
  });

  test("wraps row-producing reads with one look-ahead row", () => {
    expect(boundReadSql("SELECT * FROM t", 50, 100)).toBe(
      `SELECT * FROM (SELECT * FROM t\n) AS "__tern_query" LIMIT 51 OFFSET 100`,
    );
  });

  test("allows catalog PRAGMAs but rejects state-changing PRAGMAs", () => {
    expect(boundReadSql("PRAGMA table_info(users)", 10)).toBe("PRAGMA table_info(users)");
    expect(() => assertReadOnlySql("PRAGMA foreign_keys = OFF")).toThrow(DbError);
    expect(() => assertReadOnlySql("PRAGMA writable_schema")).toThrow(DbError);
    // PRAGMA x(y) is the SET form — the `=` check alone misses it.
    for (const sql of ["PRAGMA user_version(123)", "PRAGMA application_id(9)", "PRAGMA schema_version(2)", "PRAGMA journal_mode(DELETE)"]) {
      expect(() => assertReadOnlySql(sql, "sqlite"), sql).toThrow(DbError);
      expect(() => assertReadOnlyScript(sql, "sqlite"), sql).toThrow(DbError);
    }
    // Function-arg reads stay allowed.
    expect(boundReadSql("PRAGMA foreign_key_list(t)", 10)).toBe("PRAGMA foreign_key_list(t)");
    expect(boundReadSql("PRAGMA journal_mode", 10)).toBe("PRAGMA journal_mode");
    // Schema-qualified reads are legal for attached DBs, and '=' inside a
    // literal or comment is data — only a structural '=' is the SET form.
    expect(boundReadSql("PRAGMA main.table_info(users)", 10)).toBe("PRAGMA main.table_info(users)");
    expect(boundReadSql("PRAGMA table_info('a=b')", 10)).toBe("PRAGMA table_info('a=b')");
    expect(boundReadSql("PRAGMA index_list(\"a=b\")", 10)).toBe("PRAGMA index_list(\"a=b\")");
    expect(() => assertReadOnlySql("PRAGMA main.user_version = 7")).toThrow(DbError);
    expect(() => assertReadOnlySql("PRAGMA main.journal_mode(DELETE)")).toThrow(DbError);
  });

  test("a read-only postgres query cannot call functions with server-side effects", () => {
    for (const sql of [
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
      "SELECT pg_advisory_lock(1)",
      "SELECT set_config('work_mem', '1GB', false)",
      "SELECT pg_sleep(60)",
      "SELECT pg_catalog.pg_reload_conf()",
      "SELECT lo_import('/etc/passwd')",
      "SELECT dblink_exec('c', 'DELETE FROM t')",
      "SELECT * FROM dblink('host=x dbname=y', 'DELETE FROM t RETURNING *') AS s(n int)",
      "SELECT pg_notify('chan', 'payload')",
      "SELECT pg_logical_slot_get_changes('slot', NULL, NULL)",
      "WITH x AS (SELECT pg_cancel_backend(1)) SELECT * FROM x",
      // A double-quoted identifier followed by ( is still a call — comments
      // count as whitespace between the name and the paren.
      'SELECT "pg_sleep"(60)',
      'SELECT "pg_sleep" /*x*/ (60)',
      "SELECT \"pg_sleep\"--c\n(60)",
      'SELECT "set_config"(\'work_mem\',\'1GB\',false)',
      'SELECT "pg_terminate_backend"(\'12345\')',
      'SELECT * FROM "dblink"(\'host=x dbname=y\',\'DELETE FROM t RETURNING 1\') s(n int)',
      // Server-side filesystem/exec/stat functions added to the denylist.
      "SELECT pg_rotate_logfile()",
      "SELECT pg_file_write('a.conf', 'x', false)",
      "SELECT pg_execute_server_program('id')",
      "SELECT pg_promote(false, 0)",
      "SELECT pg_logical_emit_message(false, 'm', 'x')",
      "SELECT pg_stat_reset()",
      // Server-filesystem readers exfiltrate files back to the client.
      "SELECT pg_read_file('/etc/postgresql/postgresql.key')",
      "SELECT pg_read_binary_file('/x', 0, 10)",
      "SELECT pg_stat_file('/var/lib/postgresql/data')",
      "SELECT pg_ls_dir('/var/lib/postgresql')",
      "SELECT pg_ls_waldir()",
      'SELECT "pg_ls_tmpdir"()',
      // U&"…" identifiers decode \XXXX/\+XXXXXX escapes — the denylist
      // must see the decoded name, not the escaped spelling.
      'SELECT U&"pg\\005fread\\005ffile"(\'/etc/hostname\')',
      'SELECT U&"pg\\005fterminate\\005fbackend"(12345)',
      'SELECT U&"pg\\005fsleep"(600)',
      'SELECT u&"DBLINK"(\'x\',\'y\')',
      // Non-transactional effects that survive a read-only transaction.
      "SELECT pg_backup_start('x', false)",
      "SELECT pg_log_backend_memory_contexts(1)",
      "SELECT pg_get_wal_records_info('0/0', 'FFFFFFFF/FFFFFFFF')",
      // UESCAPE redefines the escape char — the name still decodes and the
      // trailing ( still counts as a call.
      'SELECT U&"pg_sleep" UESCAPE \'!\' (600)',
      'SELECT U&"pg!005fsleep" UESCAPE \'!\' (600)',
      // Comments are whitespace between the UESCAPE clause's three tokens —
      // an unconsumed clause must not make the call invisible.
      'SELECT U&"pg_sleep" UESCAPE /*x*/ \'!\' (600)',
      "SELECT U&\"pg_read_file\" UESCAPE --x\n'!' ('/etc/passwd', 0, 200)",
      'SELECT U&"pg_terminate_backend" UESCAPE --x\n\'!\' (12345)',
      // The clause accepts any SCONST — dollar-quoted and E/N-prefixed
      // literals define the escape char just as '…' does; an unconsumed
      // one must not make the call invisible.
      'SELECT U&"pg!005fsleep" UESCAPE $$!$$ (5)',
      'SELECT U&"pg!005fread!005ffile" UESCAPE $e$!$e$ (\'/etc/passwd\')',
      'SELECT U&"pg!005fterminate!005fbackend" UESCAPE E\'!\' (12345)',
      // Replication slots/origins, snapshots, wal replay, index maintenance.
      "SELECT pg_create_logical_replication_slot('s','test_decoding')",
      "SELECT pg_drop_replication_slot('s')",
      "SELECT pg_replication_origin_create('o')",
      "SELECT pg_export_snapshot()",
      "SELECT pg_wal_replay_pause()",
      "SELECT brin_summarize_new_values('i')",
      "SELECT pg_stat_reset_subscription('s')",
      // Same-class additions: PG18 file readers, session/catalog state, fdw
      // connections, forced stats flush, sequence mutators.
      "SELECT pg_ls_logicalmapdir()",
      "SELECT pg_log_checkpoints()",
      "SELECT pg_signal_autovacuum_worker()",
      "SELECT pg_replication_origin_session_reset()",
      "SELECT postgres_fdw_disconnect_all()",
      "SELECT pg_stat_force_next_flush()",
      "SELECT nextval('s')",
      "SELECT setval('s', 1)",
    ]) {
      expect(() => assertReadOnlySql(sql, "postgres"), sql).toThrow(DbError);
    }
    // A plain U& identifier without escapes still resolves to its name.
    expect(() => assertReadOnlySql('SELECT U&"pg_sleep"(1)', "postgres")).toThrow(DbError);
    // The same names inside literals, quoted identifiers or comments are not calls.
    expect(assertReadOnlySql("SELECT 'pg_terminate_backend'", "postgres")).toContain("pg_terminate_backend");
    expect(assertReadOnlySql('SELECT "pg_terminate_backend" FROM t', "postgres")).toContain("pg_terminate_backend");
    expect(assertReadOnlySql("SELECT 1 /* pg_advisory_lock(1) */", "postgres")).toContain("SELECT");
    // And the denylist only applies to postgres.
    expect(assertReadOnlySql("SELECT pg_sleep FROM t", "sqlite")).toContain("pg_sleep");
  });

  test("a backslash cannot protect a closing quote inside U& strings", () => {
    // In U&'…' the escape char only forms cXXXX/c+XXXXXX/cc — \' is either
    // an invalid escape (default c=\) or a literal backslash (UESCAPE), so
    // the quote closes the literal and the second statement is scanned.
    expect(() => assertReadOnlyScript("SELECT U&'x\\' UESCAPE '!'; SELECT pg_sleep(600)", "postgres")).toThrow(DbError);
    expect(() => assertReadOnlySql("SELECT U&'x\\' UESCAPE '!'; SELECT pg_sleep(600)", "postgres")).toThrow(DbError);
  });

  test("postgres array subscripts do not desync the tokenizer", () => {
    // '[' is not a quoted-identifier open in postgres — a ']' inside a string
    // literal must not swallow the rest of the script.
    expect(() => assertReadOnlySql("SELECT arr[length('a]')]; DELETE FROM t", "postgres")).toThrow(DbError);
    expect(() => assertReadOnlyScript("SELECT arr[1]; DELETE FROM t", "postgres")).toThrow(DbError);
    // A plain subscripted read still passes.
    expect(assertReadOnlySql("SELECT arr[1] FROM t", "postgres")).toContain("arr[1]");
  });
});

test('read expressions do not become write operations', () => {
  for (const sql of ["SELECT replace('abc', 'a', 'z')", 'WITH x AS (SELECT replace(name, name, name) FROM t) SELECT * FROM x', "EXPLAIN SELECT replace('a','b','c')"]) {
    expect(assertReadOnlySql(sql)).toBe(sql);
  }
  expect(() => assertReadOnlySql('WITH x AS (SELECT 1) DELETE FROM t')).toThrow(DbError);
});

test('SHOW bypasses the subquery wrapper without allowing multiple statements', () => {
  expect(boundReadSql('SHOW search_path', 10)).toBe('SHOW search_path');
  expect(() => boundReadSql('SHOW search_path; DELETE FROM t', 10)).toThrow(DbError);
});

test('ordinary backslashes cannot conceal a transaction command', () => {
  const script = "INSERT INTO t VALUES (1); SELECT '\\'; COMMIT; SELECT '';";
  expect(sqlTokens(script)).toContain('COMMIT');
  expect(() => assertReadOnlySql("SELECT '\\'; COMMIT; SELECT '';" )).toThrow(DbError);
  expect(assertReadOnlySql("SELECT E'escaped \\\' COMMIT; text' AS value")).toContain('SELECT');
});

test('PostgreSQL TABLE shorthand uses bounded read queries', () => {
  expect(boundReadSql('TABLE public.users', 5, 2, 'postgres')).toBe('SELECT * FROM (TABLE public.users\n) AS "__tern_query" LIMIT 6 OFFSET 2');
  expect(() => assertReadOnlySql('TABLE public.users', 'sqlite')).toThrow();
});

describe("assertReadOnlyScript", () => {
  test("allows transaction batches of reads", () => {
    expect(() => assertReadOnlyScript("BEGIN READ ONLY; SELECT 1; COMMIT", "postgres")).not.toThrow();
    expect(() => assertReadOnlyScript("BEGIN; SELECT 1; SELECT 2; COMMIT;", "sqlite")).not.toThrow();
    expect(() => assertReadOnlyScript("START TRANSACTION ISOLATION LEVEL SERIALIZABLE; SHOW search_path; COMMIT", "postgres")).not.toThrow();
  });

  test("rejects write statements anywhere in the script", () => {
    expect(() => assertReadOnlyScript("BEGIN; INSERT INTO t VALUES (1); COMMIT")).toThrow(DbError);
    expect(() => assertReadOnlyScript("SELECT 1; DELETE FROM t")).toThrow(DbError);
    expect(() => assertReadOnlyScript("BEGIN; PRAGMA user_version = 7; COMMIT", "sqlite")).toThrow(DbError);
  });

  test("rejects lock-grabbing sqlite transaction starts", () => {
    // BEGIN IMMEDIATE/EXCLUSIVE hold RESERVED/EXCLUSIVE file locks for the
    // script's duration — a read-only exec must not take them.
    expect(() => assertReadOnlyScript("BEGIN IMMEDIATE; SELECT 1; COMMIT", "sqlite")).toThrow(DbError);
    expect(() => assertReadOnlyScript("BEGIN EXCLUSIVE; SELECT 1; COMMIT", "sqlite")).toThrow(DbError);
    expect(() => assertReadOnlyScript("BEGIN DEFERRED; SELECT 1; COMMIT", "sqlite")).not.toThrow();
    // Postgres has no IMMEDIATE/EXCLUSIVE transaction modes — unaffected.
    expect(() => assertReadOnlyScript("BEGIN; SELECT 1; COMMIT", "postgres")).not.toThrow();
  });

  test("rejects read-write transaction starts", () => {
    expect(() => assertReadOnlyScript("BEGIN READ WRITE; SELECT 1; COMMIT")).toThrow(DbError);
    expect(() => assertReadOnlyScript("START TRANSACTION READ WRITE; COMMIT", "postgres")).toThrow(DbError);
  });

  test("semicolons in strings, comments, and E-strings do not split statements", () => {
    expect(() => assertReadOnlyScript("SELECT E'a;b' AS v; SELECT 1", "postgres")).not.toThrow();
    expect(() => assertReadOnlyScript("/* one; two */ SELECT 'three; four'")).not.toThrow();
    expect(() => assertReadOnlyScript("SELECT E'a;b'; DELETE FROM t")).toThrow(DbError);
  });

  test("rejects empty scripts", () => {
    expect(() => assertReadOnlyScript(";;")).toThrow(DbError);
    expect(() => assertReadOnlyScript("")).toThrow(DbError);
  });
});

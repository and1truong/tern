import { expect, test } from "bun:test";
import { validateMigrationSql } from "./migrationSafety.ts";
test('migration validation rejects commit aliases and external SQLite files but accepts trigger bodies', () => {
  for (const sql of ['CREATE TABLE t(id); END;', 'ABORT;', 'START TRANSACTION;', 'ATTACH DATABASE \'/tmp/x\' AS x;', 'PRAGMA writable_schema=ON;']) expect(() => validateMigrationSql(sql)).toThrow();
  expect(validateMigrationSql('CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (CASE WHEN 1 THEN 2 END); END;', 'sqlite')).toContain('TRIGGER');
  expect(() => validateMigrationSql('CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES(1); END; END;', 'sqlite')).toThrow();
  // `end` is a keyword-fallback identifier — WHEN old.end/new.end must not
  // underflow the trigger body depth, or no ';' ever ends the trigger and
  // a later bare END (SQLite's COMMIT alias) slips the first-token check.
  expect(() => validateMigrationSql(
    'CREATE TABLE e2(end INT); CREATE TRIGGER tr AFTER UPDATE ON e2 WHEN old.end <> new.end BEGIN SELECT 1; END; END; DELETE FROM victim;',
    'sqlite',
  )).toThrow();
  // The same script without the commit-slip is valid.
  expect(validateMigrationSql(
    'CREATE TABLE e2(end INT); CREATE TRIGGER tr AFTER UPDATE ON e2 WHEN old.end <> new.end BEGIN SELECT 1; END;',
    'sqlite',
  )).toContain('TRIGGER');
  // Inside the body too: `old.end`/`new.end` qualified names are
  // identifiers, not the closing END — they must not mis-split the trigger.
  expect(validateMigrationSql(
    "CREATE TABLE e2(end INT); CREATE TRIGGER tr AFTER UPDATE ON e2 BEGIN SELECT old.end; UPDATE e2 SET end = new.end; END;",
    'sqlite',
  )).toContain('TRIGGER');
});

test('migration scripts cannot override runner-managed settings', () => {
  // SET/RESET at statement start could disable the runner's own
  // statement_timeout; inside a trigger body the same words are fine.
  for (const sql of ["SET statement_timeout = 0;", "SET LOCAL statement_timeout = 0;", "RESET statement_timeout;"]) {
    expect(() => validateMigrationSql(sql, 'postgres'), sql).toThrow();
  }
  expect(validateMigrationSql("CREATE TABLE t(id); UPDATE t SET id = 1;", 'postgres')).toContain('UPDATE');
});

test('postgres triggers do not hide statements behind BEGIN/END identifiers', () => {
  // BEGIN/END are unreserved keywords in Postgres — `ON begin` must not
  // open a "trigger body" that swallows the following COMMIT, or the dry
  // run would persist a write.
  const sneaky = "CREATE OR REPLACE TRIGGER t BEFORE INSERT ON begin FOR EACH ROW EXECUTE FUNCTION f(); COMMIT;";
  expect(() => validateMigrationSql(sneaky, 'postgres')).toThrow();
  const wedged = "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION end(); SET statement_timeout = 0;";
  expect(() => validateMigrationSql(wedged, 'postgres')).toThrow();
  // A plain postgres trigger script is fine.
  expect(validateMigrationSql("CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();", 'postgres')).toContain('TRIGGER');
});

test('migration preview cannot execute nontransactional COPY or LOAD', () => {
  // COPY writes server files / runs programs and LOAD links a shared
  // library — effects the dry-run ROLLBACK cannot undo.
  for (const sql of [
    "COPY (SELECT 1) TO '/tmp/exfil';",
    "COPY t FROM PROGRAM 'id';",
    "LOAD '/tmp/evil.so';",
  ]) {
    expect(() => validateMigrationSql(sql, 'postgres'), sql).toThrow();
  }
  expect(() => validateMigrationSql("CREATE TABLE t(id); COPY t FROM '/tmp/seed.csv';", 'postgres')).toThrow();
});

test('migration preview denies functions whose effects outlive the transaction', () => {
  for (const sql of [
    "SELECT pg_file_write('a.conf','x',false);",
    "SELECT pg_create_logical_replication_slot('s','test_decoding');",
    "SELECT pg_drop_replication_slot('s');",
    "SELECT pg_backup_start('x', false);",
    "SELECT dblink_exec('c','DELETE FROM t');",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity;",
    "CREATE TABLE t(id); SELECT pg_replication_origin_create('o');",
    // Postgres permits CHECKPOINT inside a transaction — it is a
    // nontransactional effect the preview ROLLBACK cannot undo.
    "CHECKPOINT",
    // A DO / CREATE FUNCTION body is a dollar-quoted literal — denylisted
    // functions inside it must still be caught.
    "DO $$ BEGIN PERFORM pg_terminate_backend(pid) FROM pg_stat_activity; END $$;",
    "CREATE FUNCTION f() RETURNS bigint LANGUAGE sql AS $$ SELECT pg_advisory_lock(1) $$; SELECT f();",
    // Single-quoted routine bodies carry the same risk — literals after
    // DO/AS are scanned too, not just $$…$$ ones.
    "DO 'BEGIN PERFORM pg_terminate_backend(pid) FROM pg_stat_activity; END' LANGUAGE plpgsql;",
    "CREATE FUNCTION f() RETURNS bigint AS 'SELECT pg_advisory_lock(1)' LANGUAGE sql;",
    'SELECT U&"pg_terminate_backend" UESCAPE /*c*/ \'!\' (pid) FROM pg_stat_activity;',
    // U&'…' bodies are legal DO/AS SCONSTs — the U lexes as a word token —
    // and E'…' bodies decode \xHH/\ooo escapes server-side.
    "DO U&'PERFORM pg_terminate_backend(pg_backend_pid())';",
    "DO E'PERFORM p\\x67_sleep(1)';",
    "DO E'PERFORM pg\\137sleep(1)';",
    "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS U&'SELECT pg_read_file($$pg_hba.conf$$)';",
    // LANGUAGE <word|Sconst> may sit between DO and the code literal.
    "DO LANGUAGE plpgsql 'BEGIN PERFORM pg_terminate_backend(pid) FROM pg_stat_activity; END';",
    "DO LANGUAGE plpgsql $$BEGIN PERFORM pg_file_write('/tmp/x','y',false); END$$;",
    "DO LANGUAGE 'plpgsql' 'BEGIN PERFORM pg_advisory_lock(1); END';",
    // A U& body honors its own trailing UESCAPE clause — !005f decodes to _.
    "DO U&'PERFORM pg!005fsleep(1)' UESCAPE '!';",
    // Under standard_conforming_strings=off a plain literal's escapes decode
    // too — scanning it as if they do is the safe direction.
    "DO 'PERFORM pg\\x5fsleep(1)';",
    // Peek reads the same decoded WAL the denied get_* variants consume.
    "SELECT pg_logical_slot_peek_changes('s', NULL, NULL);",
    // Credential-bearing catalogs — same exfiltration class as the file readers.
    "SELECT * FROM pg_authid;",
  ]) {
    expect(() => validateMigrationSql(sql, 'postgres'), sql).toThrow();
  }
  // A denylisted name inside an ordinary data literal is not a call — and a
  // dollar-quoted literal is data, not a routine body, away from DO/AS.
  expect(validateMigrationSql("CREATE TABLE t(x); INSERT INTO t VALUES ('pg_sleep');", 'postgres')).toContain('pg_sleep');
  expect(validateMigrationSql("CREATE TABLE t(x); INSERT INTO t VALUES ($$called pg_sleep at 3am$$);", 'postgres')).toContain('pg_sleep');
  // Bodies that don't call denylisted functions stay allowed.
  expect(validateMigrationSql("DO $$ BEGIN RAISE NOTICE 'migrating'; END $$;", 'postgres')).toContain('RAISE');
  // Transaction-scoped advisory locks release at the preview ROLLBACK and
  // are a legitimate migration idiom — they stay allowed.
  expect(validateMigrationSql("SELECT pg_advisory_xact_lock(1); CREATE TABLE t(id);", 'postgres')).toContain('pg_advisory_xact_lock');
});

test('migration comment parsing follows the database dialect', () => {
  const sql = 'SELECT 1; /* outer /* inner */ COMMIT; /* */';
  expect(() => validateMigrationSql(sql, 'sqlite')).toThrow();
  expect(validateMigrationSql(sql, 'postgres')).toBe(sql);
});

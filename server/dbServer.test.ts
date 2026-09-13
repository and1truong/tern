import { splitSqlStatements, executionUnits } from "../src/sqlConsole.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { isDbBinaryValue } from "../binaryValues.ts";
import {
  readSchema,
  runQuery,
  runExec,
  runRowChanges,
  createDatabase,
  explainQuery,
  readInsights,
  runMigration,
  DbError,
} from "./dbServer.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dbserver-"));
});

function seed(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, age INTEGER);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), status TEXT DEFAULT 'draft');
    CREATE TABLE accounts (email TEXT NOT NULL UNIQUE, display_name TEXT);
    CREATE VIEW active_users AS SELECT id, email FROM users WHERE age >= 18;
    CREATE INDEX idx_email ON users(email);
    CREATE TRIGGER tr AFTER INSERT ON users BEGIN SELECT 1; END;
  `);
  db.query("INSERT INTO users (email, age) VALUES (?, ?)").run("a@x", 21);
  db.query("INSERT INTO users (email, age) VALUES (?, ?)").run("b@x", 9);
  db.close();
}

describe("createDatabase", () => {
  test("creates a new absolute SQLite file without overwriting", () => {
    const path = join(dir, "new.sqlite");
    expect(createDatabase(path)).toEqual({ path, created: true });
    expect(readSchema(path).tables).toEqual([]);
    expect(() => createDatabase(path)).toThrow(DbError);
  });
});

describe("readSchema", () => {
  test("returns tables + views with columns, pk, fk, row count, ddl", () => {
    seed(join(dir, "app.db"));
    const s = readSchema(join(dir, "app.db"));
    const users = s.tables.find((t) => t.name === "users")!;
    expect(users.type).toBe("table");
    expect(users.rowCount).toBe(-1);
    const id = users.columns.find((c) => c.name === "id")!;
    expect(id.pk).toBe(true);
    // SQLite reports notnull=0 for INTEGER PRIMARY KEY (rowid alias), so assert
    // notNull mapping against an explicitly NOT NULL column instead.
    const email = users.columns.find((c) => c.name === "email")!;
    expect(email.notNull).toBe(true);
    const view = s.tables.find((t) => t.name === "active_users")!;
    expect(view.type).toBe("view");
    expect(s.indexes.map((i) => i.name)).toContain("idx_email");
    expect(s.indexes.find((i) => i.name === "idx_email")).toMatchObject({ table: "users", unique: false, columns: ["email"] });
    expect(s.triggers.map((t) => t.name)).toContain("tr");
    expect(s.triggers.find((t) => t.name === "tr")?.table).toBe("users");
    expect(s.constraints?.some((constraint) => constraint.table === "posts" && constraint.type === "FOREIGN KEY")).toBe(true);
    expect(s.tables.find((table) => table.name === "accounts")?.uniqueKeys).toEqual([["email"]]);
    expect(s.tables.find((table) => table.name === "posts")?.columns.find((column) => column.name === "status")?.defaultValue).toBe("'draft'");
    expect(s.pragmas.journal_mode).toBeTruthy();
    expect(s.pragmas.foreign_keys).toBe("1");
  });

  test("throws not_found for a missing file", () => {
    expect(() => readSchema(join(dir, "ghost.db"))).toThrow(DbError);
  });

  test("reports SQLite generated columns from table_xinfo", () => {
    const path = join(dir, "generated.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE totals (base INTEGER, doubled INTEGER GENERATED ALWAYS AS (base * 2) STORED)");
    db.close();
    expect(readSchema(path).tables[0].columns).toEqual([
      expect.objectContaining({ name: "base", generated: false }),
      expect.objectContaining({ name: "doubled", generated: true }),
    ]);
  });
});

describe("readInsights", () => {
  test("reports SQLite storage, integrity, and object counts", () => {
    const path = join(dir, "app.db");
    seed(path);
    const insights = readInsights(path);
    expect(insights.metrics.engine).toBe("SQLite");
    expect(Number(insights.metrics.file_bytes)).toBeGreaterThan(0);
    expect(insights.metrics.integrity).toBe("ok");
    expect(Number(insights.metrics.tables)).toBe(3);
    expect(insights.activity).toEqual([]);
  });
});

describe("runQuery", () => {
  test("runs a SELECT and returns columns + object rows + ms", () => {
    seed(join(dir, "app.db"));
    const r = runQuery(join(dir, "app.db"), "SELECT id, email FROM users WHERE age >= ?", [18], 100);
    expect(r.columns).toEqual(["id", "email"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].email).toBe("a@x");
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.hasMore).toBe(false);
  });

  test("bounds rows in SQL and reports when more rows exist", () => {
    seed(join(dir, "app.db"));
    const r = runQuery(join(dir, "app.db"), "SELECT id FROM users ORDER BY id", [], 1);
    expect(r.rows).toEqual([{ id: 1 }]);
    expect(r.hasMore).toBe(true);
    expect(r.offset).toBe(0);
  });

  test("pages rows with a non-negative offset", () => {
    seed(join(dir, "app.db"));
    const r = runQuery(join(dir, "app.db"), "SELECT id FROM users ORDER BY id", [], 1, 1);
    expect(r.rows).toEqual([{ id: 2 }]);
    expect(r.offset).toBe(1);
    expect(r.hasMore).toBe(false);
  });

  test("accepts leading comments and semicolons inside literals", () => {
    seed(join(dir, "app.db"));
    const r = runQuery(join(dir, "app.db"), "-- inspect\nSELECT ';' AS value;", [], 10);
    expect(r.rows).toEqual([{ value: ";" }]);
  });

  test("runs approved read-only PRAGMAs", () => {
    seed(join(dir, "app.db"));
    const result = runQuery(join(dir, "app.db"), "PRAGMA table_info(users)", [], 100);
    expect(result.rows.some((row) => row.name === "email")).toBe(true);
  });

  test("accepts a trailing terminator before a line comment", () => {
    seed(join(dir, "app.db"));
    expect(runQuery(join(dir, "app.db"), "SELECT 1 AS value; -- done", [], 10).rows)
      .toEqual([{ value: 1 }]);
  });

  test("round-trips BLOB values through optimistic update predicates", () => {
    const path = join(dir, "blobs.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, name TEXT NOT NULL, content BLOB NOT NULL)");
    db.query("INSERT INTO files VALUES (?, ?, ?)").run(1, "before", new Uint8Array([0, 127, 255]));
    db.close();
    const row = runQuery(path, "SELECT * FROM files", [], 10).rows[0];
    expect(isDbBinaryValue(row.content)).toBe(true);
    expect(runRowChanges(path, [{
      kind: "update", table: { name: "files" }, key: { id: 1 }, expected: row, values: { name: "after" },
    }]).rowsAffected).toBe(1);
    expect(runQuery(path, "SELECT name FROM files", [], 10).rows[0].name).toBe("after");
  });

  test("rejects a write statement", () => {
    seed(join(dir, "app.db"));
    expect(() => runQuery(join(dir, "app.db"), "DELETE FROM users", [], 100)).toThrow(DbError);
  });

  test("rejects multiple statements", () => {
    seed(join(dir, "app.db"));
    expect(() => runQuery(join(dir, "app.db"), "SELECT 1; SELECT 2", [], 100)).toThrow(DbError);
  });

  test("rejects a writable CTE", () => {
    seed(join(dir, "app.db"));
    expect(() => runQuery(
      join(dir, "app.db"),
      "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed",
      [],
      100,
    )).toThrow(DbError);
  });
});

describe("explainQuery", () => {
  test("returns SQLite query-plan rows and rejects writes", () => {
    const path = join(dir, "app.db");
    seed(path);
    const plan = explainQuery(path, "SELECT * FROM users WHERE email = ?", ["a@x"]);
    expect(plan.columns).toContain("detail");
    expect(plan.rows.length).toBeGreaterThan(0);
    expect(() => explainQuery(path, "DELETE FROM users", [])).toThrow(DbError);
  });
});

describe("runExec", () => {
  test("creates a view, then query can read it", () => {
    seed(join(dir, "app.db"));
    const r = runExec(join(dir, "app.db"), "CREATE VIEW adults AS SELECT id FROM users WHERE age >= 18");
    expect(r.rowsAffected).toBe(0);
    const q = runQuery(join(dir, "app.db"), "SELECT COUNT(*) AS n FROM adults", [], 100);
    expect(Number(q.rows[0].n)).toBe(1);
  });

  test("enforces declared foreign keys on every write connection", () => {
    const path = join(dir, "app.db");
    seed(path);
    expect(() => runExec(path, "INSERT INTO posts (id, user_id) VALUES (1, 999)")).toThrow(DbError);
  });
});

describe("runMigration", () => {
  test("dry-runs with rollback, then applies the same script atomically", () => {
    const path = join(dir, "app.db");
    seed(path);
    expect(runMigration(path, "CREATE TABLE migration_test (id INTEGER PRIMARY KEY);", false)).toMatchObject({ validated: true, applied: false });
    expect(readSchema(path).tables.some((table) => table.name === "migration_test")).toBe(false);
    expect(runMigration(path, "CREATE TABLE migration_test (id INTEGER PRIMARY KEY);", true)).toMatchObject({ validated: true, applied: true });
    expect(readSchema(path).tables.some((table) => table.name === "migration_test")).toBe(true);
  });

  test("rolls back all statements when one fails and owns transaction control", () => {
    const path = join(dir, "app.db");
    seed(path);
    expect(() => runMigration(path, "CREATE TABLE should_rollback (id); INVALID SQL;", true)).toThrow(DbError);
    expect(readSchema(path).tables.some((table) => table.name === "should_rollback")).toBe(false);
    expect(() => runMigration(path, "BEGIN; CREATE TABLE nope(id); COMMIT;", true)).toThrow(DbError);
  });
});

describe("runRowChanges", () => {
  test("preserves exact 64-bit integer strings", () => {
    const path = join(dir, "exact-integer.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE measurements (value INTEGER)");
    db.close();
    runRowChanges(path, [{ kind: "insert", table: { name: "measurements" }, values: { value: "9007199254740993" } }]);
    expect(runQuery(path, "SELECT CAST(value AS TEXT) AS value FROM measurements", [], 10).rows).toEqual([
      { value: "9007199254740993" },
    ]);
  });

  test("inserts a row using only database defaults", () => {
    const path = join(dir, "defaults.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)");
    db.close();
    expect(runRowChanges(path, [{ kind: "insert", table: { name: "settings" }, values: {} }]).rowsAffected).toBe(1);
    expect(runQuery(path, "SELECT id, enabled FROM settings", [], 10).rows).toEqual([{ id: 1, enabled: 1 }]);
  });

  test("applies insert, update, and delete atomically", () => {
    const path = join(dir, "app.db");
    seed(path);
    const result = runRowChanges(path, [
      { kind: "update", table: { name: "users" }, key: { id: 1 }, expected: { id: 1, email: "a@x", age: 21 }, values: { email: "updated@x" } },
      { kind: "delete", table: { name: "users" }, key: { id: 2 }, expected: { id: 2, email: "b@x", age: 9 } },
      { kind: "insert", table: { name: "users" }, values: { id: 3, email: "new@x", age: 30 } },
    ]);
    expect(result.applied).toBe(3);
    expect(result.rowsAffected).toBe(3);
    const rows = runQuery(path, "SELECT id, email FROM users ORDER BY id", [], 10).rows;
    expect(rows).toEqual([{ id: 1, email: "updated@x" }, { id: 3, email: "new@x" }]);
  });

  test("rolls back the whole batch on an optimistic conflict", () => {
    const path = join(dir, "app.db");
    seed(path);
    expect(() => runRowChanges(path, [
      { kind: "update", table: { name: "users" }, key: { id: 1 }, expected: { id: 1, email: "a@x", age: 21 }, values: { email: "should-rollback@x" } },
      { kind: "delete", table: { name: "users" }, key: { id: 2 }, expected: { id: 2, email: "stale@x", age: 9 } },
    ])).toThrow(DbError);
    const row = runQuery(path, "SELECT email FROM users WHERE id = 1", [], 10).rows[0];
    expect(row.email).toBe("a@x");
  });
});

test('duplicate query labels preserve every positional value, including empty result metadata', () => {
  const path = join(dir, 'duplicate.sqlite');
  createDatabase(path);
  const result = runQuery(path, 'SELECT 11 AS id, 22 AS id, 33 AS "id:1"', []);
  expect(new Set(result.columns).size).toBe(3);
  expect(result.columns.map(name => result.rows[0][name])).toEqual([11, 22, 33]);
  const empty = runQuery(path, 'SELECT 11 AS id, 22 AS id WHERE 0', []);
  expect(empty.columns).toHaveLength(2);
  expect(empty.rows).toEqual([]);
});


test('split trigger script executes both body statements', () => {
  const path = join(dir, 'trigger-split.sqlite');
  createDatabase(path);
  const script = `CREATE TABLE posts (id integer, comment text);
    CREATE TABLE logs (message text);
    CREATE TRIGGER audit AFTER INSERT ON posts BEGIN
      UPDATE posts SET comment = CASE WHEN new.id = 1 THEN 'updated' ELSE 'other' END;
      INSERT INTO logs VALUES ('logged');
    END;
    INSERT INTO posts VALUES (1, 'before');`;
  for (const statement of splitSqlStatements(script)) runExec(path, statement.sql);
  expect(runQuery(path, 'SELECT comment FROM posts', []).rows).toEqual([{ comment: 'updated' }]);
  expect(runQuery(path, 'SELECT message FROM logs', []).rows).toEqual([{ message: 'logged' }]);
});

test('large SQLite keys remain exact and mutations target only that row', () => {
  const path = join(dir, 'large-key.sqlite');
  createDatabase(path);
  runExec(path, "CREATE TABLE large_keys (id INTEGER PRIMARY KEY, name TEXT)");
  runExec(path, "INSERT INTO large_keys VALUES (9007199254740992, 'neighbor'), (9007199254740993, 'target')");
  const row = runQuery(path, 'SELECT * FROM large_keys ORDER BY id DESC', []).rows[0];
  expect(row.id).toBe('9007199254740993');
  expect(() => JSON.stringify(row)).not.toThrow();
  runRowChanges(path, [{ kind: 'update', table: { name: 'large_keys' }, key: { id: row.id }, expected: { name: row.name }, values: { name: 'changed' } }]);
  expect(runQuery(path, 'SELECT name FROM large_keys ORDER BY id', []).rows).toEqual([{ name: 'neighbor' }, { name: 'changed' }]);
  expect(runQuery(path, "SELECT replace('abc', 'a', 'z') AS value", []).rows).toEqual([{ value: 'zbc' }]);
});

test('execution persists writable PRAGMA values for later reads', () => {
  const path = join(dir, 'pragma-write.sqlite');
  createDatabase(path);
  runExec(path, 'PRAGMA user_version = 7');
  expect(runQuery(path, 'PRAGMA user_version', []).rows).toEqual([{ user_version: 7 }]);
});

test('migration preview rejects COMMIT hidden after an ordinary backslash string', () => {
  const path = join(dir, 'migration-backslash.sqlite');
  createDatabase(path);
  runExec(path, 'CREATE TABLE t (v integer)');
  expect(() => runMigration(path, "INSERT INTO t VALUES (1); SELECT '\\'; COMMIT; SELECT '';", false)).toThrow();
  expect(runQuery(path, 'SELECT * FROM t', []).rows).toEqual([]);
});

test('SQLite non-nesting comments cannot conceal a migration COMMIT', () => {
  const path = join(dir, 'migration-comment.sqlite');
  createDatabase(path);
  runExec(path, 'CREATE TABLE t (v integer)');
  expect(() => runMigration(path, 'INSERT INTO t VALUES (1); /* outer /* inner */ COMMIT; /* */', false)).toThrow();
  expect(runQuery(path, 'SELECT * FROM t', []).rows).toEqual([]);
});


test('SQL execution retains transaction rollback when a later statement fails', () => {
  const path = join(dir, 'console-transaction.sqlite');
  createDatabase(path);
  runExec(path, 'CREATE TABLE t(v integer); INSERT INTO t VALUES(1)');
  const units = executionUnits(splitSqlStatements('BEGIN; UPDATE t SET v=2; SELECT missing FROM t; ROLLBACK;').map(s => s.sql), 'sqlite');
  expect(() => runExec(path, units.statements[0])).toThrow();
  expect(runQuery(path, 'SELECT v FROM t', []).rows).toEqual([{ v: 1 }]);
});

test('SQLite top-level savepoints execute together and release their transaction', () => {
  const path = join(dir, 'savepoints.sqlite');
  seed(path);
  for (const script of [
    'SAVEPOINT [a;b]; SELECT 1; RELEASE "a;b";',
    'SAVEPOINT outer; SAVEPOINT inner; INSERT INTO users(email) VALUES (\'saved\'); RELEASE outer;',
    'SAVEPOINT "SAVEPOINT"; INSERT INTO users(email) VALUES (\'reverted\'); ROLLBACK TO "SAVEPOINT"; RELEASE "SAVEPOINT";',
  ]) {
    const units = executionUnits(splitSqlStatements(script).map(s => s.sql), 'sqlite');
    expect(units.transaction).toBe(true);
    runExec(path, units.statements[0]);
  }
  expect(runQuery(path, 'SELECT email FROM users WHERE email IN (\'saved\', \'reverted\')', []).rows).toEqual([{ email: 'saved' }]);
  expect(() => executionUnits(['SAVEPOINT s', 'SAVEPOINT t', 'RELEASE t'], 'sqlite')).toThrow('COMMIT or ROLLBACK');
});

test('SQLite retains all foreign keys sharing one source column', () => {
  const path = join(dir, 'foreign-keys.sqlite');
  createDatabase(path);
  runExec(path, 'CREATE TABLE a(id INTEGER PRIMARY KEY); CREATE TABLE b(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES a(id) REFERENCES b(id));');
  const schema = readSchema(path);
  expect([schema.tables.find(t => t.name === 'child')!.columns[0].fk].flat().sort()).toEqual(['a(id)', 'b(id)']);
  expect(schema.constraints?.filter(c => c.table === 'child' && c.type === 'FOREIGN KEY')).toHaveLength(2);
});

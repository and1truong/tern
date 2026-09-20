import { expect, test } from "bun:test";
import { boundConsoleHistory, redactSqlSecrets } from "./consoleHistory.ts";

test("history fits persisted state without truncating SQL, including JSON escapes", () => {
  const tabs = [{ id: "a", sql: '\\"\n'.repeat(90_000) }];
  const history = Array.from({ length: 100 }, (_, id) => ({ id, sql: '\\"\n'.repeat(40_000) }));
  const state = { tabs, activeId: "a", history };
  const bounded = boundConsoleHistory(state);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2_000_000);
  expect(bounded.tabs).toBe(tabs);
  expect(bounded.history.length).toBeGreaterThan(0);
  expect(bounded.history).toEqual(history.slice(0, bounded.history.length));
  const edited = boundConsoleHistory({ ...bounded, tabs: [{ id: "a", sql: 'x'.repeat(1_990_000) }] });
  expect(edited.history).toEqual([]);
  expect(edited.tabs[0].sql.length).toBe(1_990_000);
});

test("a pathological tab buffer is halved until the state fits", () => {
  // A multi-MB paste lives in tabs[].sql — without bounding it every
  // state.set would reject with "State exceeds size limit".
  const state = { tabs: [{ id: "a", sql: 'x'.repeat(3_000_000) }], activeId: "a", history: [] };
  const bounded = boundConsoleHistory(state);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2_000_000);
  expect(bounded.tabs[0].sql.length).toBeLessThan(3_000_000);
});

test("redactSqlSecrets covers escaped and dollar-quoted literals", () => {
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD 'pa''ss'"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD $$s3cret$$"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("CREATE USER u IDENTIFIED BY $tag$secret$tag$"))
    .toBe("CREATE USER u IDENTIFIED BY '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD 'x'"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
});

test("redactSqlSecrets catches secrets still being typed", () => {
  // The buffer persists mid-keystroke — an unterminated literal is still a
  // secret in flight and must not reach plaintext app state.
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD 'hunter2"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD \"hunter2"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  // Conninfo and escape-string forms.
  expect(redactSqlSecrets("CREATE USER u PASSWORD='hunter2'"))
    .toBe("CREATE USER u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD E'pa\\'ss'"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD E'hunter2"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  // Expression-valued passwords — the canonical pre-hashed form carries a
  // literal secret inside the call.
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD crypt('s3cret', gen_salt('bf'))"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD crypt('s3cret',gen_salt('bf'))"))
    .toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD ('x')")).not.toContain("'x'");
  // A column literally named password is not a secret — the bare-token
  // tail only applies after '='.
  expect(redactSqlSecrets("SELECT password FROM users")).toBe("SELECT password FROM users");
  expect(redactSqlSecrets("SELECT password_hash, t.password FROM t")).toBe("SELECT password_hash, t.password FROM t");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD NULL")).toBe("ALTER ROLE u PASSWORD NULL");
  expect(redactSqlSecrets("INSERT INTO t (password, email) VALUES ('s3cret','e')"))
    .toBe("INSERT INTO t (password, email) VALUES ('s3cret','e')");
  expect(redactSqlSecrets("password=hunter2 host=x")).toBe("password '(redacted)' host=x");
  // Dollar tags allow digits and non-ASCII past the first character.
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD $t1$s3cret$t1$")).toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD $té$s3cret$té$")).toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD $t1$s3cr")).toBe("ALTER ROLE u PASSWORD '(redacted)'");
  // A comment between keyword and value still bridges to the secret.
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD /*note*/ 'hunter2'")).toBe("ALTER ROLE u PASSWORD '(redacted)'");
  expect(redactSqlSecrets("password /*c*/ = 'hunter2'")).toBe("password '(redacted)'");
  expect(redactSqlSecrets("ALTER ROLE u PASSWORD --note\n'hunter2'")).toBe("ALTER ROLE u PASSWORD '(redacted)'");
  // A pasted DSN has no password keyword — its userinfo is stripped like the
  // redis console's URL redaction.
  expect(redactSqlSecrets("psql postgres://admin:hunter2@db.internal/mydb"))
    .toBe("psql postgres://(redacted)@db.internal/mydb");
  expect(redactSqlSecrets("\\connect postgres://u:p@h/d")).not.toContain("u:p");
  // The keyword inside a quoted literal or identifier is data — redacting it
  // would consume the closing quote and mangle the persisted buffer.
  expect(redactSqlSecrets("SELECT 'password' FROM t")).toBe("SELECT 'password' FROM t");
  expect(redactSqlSecrets(`SELECT 'password', 'x' FROM t`)).toBe("SELECT 'password', 'x' FROM t");
  expect(redactSqlSecrets('SELECT "password" FROM t')).toBe('SELECT "password" FROM t');
  // MySQL-style plugin auth still carries a secret literal.
  expect(redactSqlSecrets("CREATE USER u IDENTIFIED WITH mysql_native_password BY 's3cret'"))
    .toBe("CREATE USER u IDENTIFIED WITH mysql_native_password BY '(redacted)'");
});

# Verification

Verified locally with Bun 1.4.3-canary.1 on macOS and a disposable PostgreSQL 17.11 container.

- Clean source copy: `bun install --frozen-lockfile`, typecheck, build and all UI smoke scripts passed.
- Full suite with `TEST_PG_URL`: 104 tests passed, none skipped or failed.
- Added credential-failure/invalid-SSL regression: all 6 connection tests passed afterward.
- PostgreSQL API covers profiles, database selection, schema, read-only enforcement,
  migration rollback/apply, optimistic conflicts, activity, cancellation, timeout and SSL preference.
- SQLite API covers explicit opening, persistence across reopening, atomic changes,
  conflicts, migration validation, per-browser write access and query interruption.
- Actual HTTP disconnect cancelled a native SQLite query; its subprocess exited and
  the server immediately answered another query.
- Browser checks: SQLite opening and table data, SQL multiple results, persisted SQL
  and history after reload, SVG relationships, PostgreSQL Test/Save/Connect, and layouts
  at 1280×720 and 1024×768.
- Runtime source search found no former host dependency or directory-context awareness.
- `git diff --check` passed.

OS credential storage was verified through the injectable SecretStore boundary,
including failure without plaintext fallback. Interactive OS keychain authorization
and TLS certificate verification against a TLS-enabled PostgreSQL server were not
exercised; required/verified TLS modes are delegated to Bun.SQL.

## Docker + Playwright (2026-09-13)

`bun run test:e2e` passed in Chromium against PostgreSQL 17.11, database
`tern_verify`, loopback port 15432. The six browser steps cover connection testing
and saving, read-only controls, server paging/sorting, staged edit versus commit,
SQL execution, migration rollback/apply, and SQL/connection restoration after reload.
`psql` independently confirms staged changes do not write and migration dry-runs
leave no table. The browser reported no uncaught page errors.

This run found and fixed Run selecting no statement when the cursor follows the
last semicolon; `src/sqlConsole.test.ts` now covers this regression.
Typecheck passed, the existing live PostgreSQL suite passed (105 tests before the
new regression), and all five SQL selection tests passed after the fix.

Repeat with `bun run test:e2e`; see README for setup/reset scope. This is a real
Playwright browser run, separate from the existing happy-dom UI smoke scripts.

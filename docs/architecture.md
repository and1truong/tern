# Standalone Tern

Retain `server/dbServer.ts`, `server/pgServer.ts`, SQL safety, row mutation compilation,
and the data-grid, filter, transfer, SQL editor and catalog helpers. Their existing
transaction and conflict semantics remain the database boundary.

Remove module activation, the vendored host contract, host navigation and KV, and
current-directory discovery. A loopback Bun HTTP server owns explicit database APIs
and serves a bundled React application. An application SQLite database owns saved
profiles, recent files, SQL documents/history, preferences and layout. Credentials
remain in Bun.secrets (OS keychain); failure to store a secret must fail saving,
never fall back to plaintext.

Connections select databases; documents select tables, SQL, relationships, insights
or migrations. Keep the tree visible. Table documents contain Data/Structure/DDL.
React component state owns transient edits; persisted documents are independent of
connection metadata. Writes start disabled and require explicit session enablement.

Keep CodeMirror and the existing icon library. Promote React to runtime dependencies;
remove the host package. Build with Bun.build and the existing Tailwind CLI. No backend,
routing, state or desktop wrapper framework is needed.

Verification: standalone persistence/security tests plus existing engine and pure
helper tests; production build and typecheck; SQLite and PostgreSQL integration
checks; desktop browser smoke checks. No markup snapshot suite.

Runtime references: [Bun HTTP server](https://bun.sh/docs/runtime/http/server) and
[Bun SQL](https://bun.sh/docs/runtime/sql). PostgreSQL TLS `prefer` is implemented
as a strict TLS probe followed by plaintext only for `TLS_NOT_AVAILABLE`, working
around native negotiation stalls without weakening required/verified TLS modes.

## Tern storage migration

The package and UI are named Tern. The default app database is
`~/.tern/app.sqlite`; `TERN_DATA_FILE` selects an explicit alternative.
On default startup, an absent Tern database is initialized from the legacy
`DBM_DATA_FILE` override or `~/.dbm/app.sqlite`. The migration takes a SQLite
snapshot including committed WAL data and publishes it without replacing an
existing destination. The legacy database is left untouched. Explicit
`TERN_DATA_FILE` paths are treated as independent stores, so test and preview
instances do not unexpectedly import a user's default database.

Credentials use `dev.tern.credentials`. On lookup, an existing Tern credential
wins; otherwise the legacy `dev.dbm.credentials` entry is copied lazily. A failed
copy leaves the old entry intact. Legacy plaintext connection rows also honor
existing credentials before scrubbing their stored URL. No credentials are logged.

The only legacy-name code is `server/legacyMigration.ts`: the old environment
variable, data directory and keychain service are necessary migration inputs.
These names also occur here to document the fallback. Old HTTP headers, wire tags
and SQL aliases have no fallback: both client and server ship together, and wire
results are not persisted as application state. Reload open browser tabs after
upgrading. User-authored SQL and JSON are never rewritten during migration.

`README.md` and `assets/` retain the approved versions already on this PR. Historical Git objects,
external dependencies, and the existing checkout directory name are not rewritten.

## PostgreSQL schema context

The toolbar's Schema selector scopes the object explorer and the source captured
by new SQL/migration documents. Existing documents retain their source, including
the schema, across selector changes and restarts. Clicking an existing document
shows its context again. To use another schema, select it and open a new document.
Preferences are stored per connection and effective database. “All schemas” only
broadens the explorer; queries without an explicit schema use the server's default
search path. SQLite does not participate in schema selection.

Catalog namespace discovery uses `pg_namespace` and checks `USAGE`, so empty
schemas remain selectable. System namespaces are hidden by default. Enabling
System loads their objects; the catalog stays cached for already-open documents,
while the explorer can hide those objects again. A dropped/inaccessible selection
remains visible as unavailable, rather than silently changing the target schema.

Every SQL request carries its document's schema. Query, script, explain,
pagination, query export and migration execution validate the namespace and set
`search_path` on the same reserved connection that executes the SQL. The selected
identifier is quoted and passed as a parameter to `pg_catalog.set_config`.
The path is `"selected schema", pg_temp`: PostgreSQL implicitly searches
`pg_catalog` first, the selected schema next, and temporary relations last. There
is no automatic `public` or `$user` fallback. Fully qualified references keep
working, and this selection does not grant additional database permissions.

Each request owns and closes its connection, including failures/cancellation.
Session-level configuration survives explicit transaction boundaries within one
script but cannot leak to another request. A script can explicitly change its own
search path; the next request starts from the document's selected context again.
Generated table operations retain fully qualified table names. Migration dry-run
approval binds both the exact SQL and schema, preventing a preview in one schema
from authorizing an apply in another.

Validation: `bun test`, `bun run typecheck`, and `bun run test:ui`. Set
`TEST_PG_URL` to a disposable PostgreSQL database to run the native driver tests,
including concurrent schema isolation and migration approval. The tests create
and remove their own schemas.

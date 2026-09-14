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

## Datasource drivers

Backends plug in through `datasources/contracts.ts`: a `DataSourceDriver` owns
its protocol client, connection validation, server detection and capability
providers. The core app never branches on a product name — it dispatches
`/api/datasource/*` through `datasources/router.ts`, which resolves a saved
profile's driver from the static registry in `server/app.ts` and serves
whatever capability providers that driver exposes (`console`, `explorer`).
Composition over one giant interface: drivers implement only the providers
they support, and generic UI renders what is present.

The Redis-compatible driver (`datasources/redis/`) is one driver family for
Redis and Valkey: it connects over RESP, detects flavor/version/capabilities
from `INFO`, and every UI decision consumes the detected `Capabilities`, never
the product name. Pure modules (command catalog, autocomplete, explain, lint,
RESP encoding) are isomorphic — the browser bundle imports them directly and
they work offline. Bun's runtime `RedisClient` appears only inside
`datasources/redis/driver.ts` behind the injectable `SessionTransport`, so the
driver is unit-tested against fakes and remains replaceable.

To add a backend: implement `DataSourceDriver` (+ optional providers), register
it in `server/app.ts`'s registry, and add a URL validator to
`server/connections.ts`. No core restructuring is required.

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

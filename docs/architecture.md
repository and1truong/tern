# Standalone DBM

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

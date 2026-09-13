# DBM

Standalone Bun/React/TypeScript database workbench. Use Bun for package management,
runtime, build and tests. No host runtime, module contract, ORM or backend framework.

- `server.ts`: loopback HTTP server and built frontend assets.
- `server/app.ts`: application API, explicit file access, write access and migration validation.
- `server/appDatabase.ts`: SQLite application state and recent files.
- `server/connections.ts`: PostgreSQL profiles; secrets live in Bun.secrets.
- `server/dbServer.ts`, `server/pgServer.ts`: engine implementations and catalogs.
- `server/sqliteTask.ts`: cancellable native SQLite execution in a Bun subprocess.
- `src/App.tsx`: connection explorer and document shell.
- `src/TableDocument.tsx`, `src/DatabaseViews.tsx`: table data, structure, relationships, activity.
- `src/SqlEditor.tsx`: CodeMirror SQL documents and persisted history.
- `shared.ts`: client/server JSON types.

Run `bun dev`; production uses `bun run build` then `bun start`.
Gate: `make check`. Live PostgreSQL checks additionally use `TEST_PG_URL` pointing
at a disposable database. Tests may create and drop test objects there.

Preserve atomic mutations, optimistic conflict checks, explicit read-only enforcement
and migration rollback. Keep changes surgical and dependencies minimal.

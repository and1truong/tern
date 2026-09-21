# AGENTS.md

Guidance for coding agents working in this repository.

## Project

**Tern** — a standalone database workbench for SQLite, PostgreSQL, Redis and Valkey. Bun + TypeScript + React + Tailwind CSS. No backend framework, no ORM, no state-management library. See `README.md` and `docs/architecture.md` for design intent.

## Layout

- `server/` — Bun HTTP server entry and app-level policy. `app.ts` is the entry point (driver registry, writable/opened-file/migration gating); `routeHandlers.ts` (SQLite create + connection CRUD), `connections.ts`, `migrations.ts`, `appDatabase.ts` (app state in `~/.tern/app.sqlite`), `legacyMigration.ts`.
- `datasources/` — pluggable backends behind `contracts.ts` (`DataSourceDriver` + capability providers) and `router.ts` (unified `/api/datasource/*` dispatch). One family per engine: `sqlite/`, `postgres/`, `redis/` (Redis + Valkey).
- `shared/` — isomorphic modules imported by both server and browser: `types.ts`, `sqlSafety.ts`, `rowMutations.ts`, `migrationSafety.ts`, `sqlConsole.ts`, `sqlIdentifiers.ts`, `dataGrid.ts`, `dataTransfer.ts`, `dbFilter.ts`, `binaryValues.ts`.
- `src/` — React UI (document-area workbench). Focused modules per surface: `ObjectTree`, `DataGrid` + `gridDialogs`/`stagedRows` (staged-write lifecycle), `StructurePane`/`PragmasPane`/`SchemaDiagramPane`/`InsightsPane`, `SqlEditor`, Redis `KeyExplorer`/`KeyView`/`Console`.
- `scripts/` — `dev.ts`, `build.ts`, UI smoke scripts, `verify-postgres.ts`, `verify-redis.ts`.
- `e2e/` — Playwright e2e (`postgres.e2e.ts`, `seed.sql`).
- `docs/` — `architecture.md`, `verification.md`.
- `server.ts` — production entry.

## Commands

```bash
bun install            # install (use --frozen-lockfile for clean verify)
bun dev                # dev: rebuild on src changes + bun --watch server.ts
bun run build          # production bundle via Bun.build + Tailwind CLI
bun start              # serve production build
bun test               # unit tests (bun:test, colocated *.test.ts)
bun run typecheck      # tsc --noEmit
bun run test:ui        # happy-dom UI smoke scripts (no browser)
bun run test:e2e       # real Playwright + Docker PostgreSQL (compose.verify.yml)
bun run postgres:down  # tear down the verify container
make check             # typecheck + test + ui-smoke + build
```

`TEST_PG_URL` enables the live PostgreSQL test suite. `TERN_DATA_FILE` overrides the app database location (explicit paths never trigger legacy `~/.dbm` migration).

## Workflow: plan, code, review

Work in three passes, and keep clean architecture / clean code principles in view throughout — adapted to this codebase, which deliberately avoids framework-shaped abstraction.

**Plan**

- Locate the boundary before writing: server engine (`server/`), driver (`datasources/`), pure/isomorphic module, or UI (`src/`). New behavior belongs in exactly one layer.
- State the dependency direction: UI → API → driver → database. Never let the core branch on product names or UI concerns leak into engines.
- Prefer extending an existing module (e.g. a capability provider, a pure helper) over adding a new abstraction. If a change needs a new seam, say why.

**Code**

- Minimum code that solves the problem. No speculative configurability, no single-use abstractions, no handling for impossible cases.
- Surgical diffs: touch only what the request requires; don't reformat or "improve" adjacent code; match surrounding style.
- Keep domain logic pure and testable where possible — like `datasources/redis/`'s isomorphic modules and the injectable `SessionTransport`/`SecretStore` seams. Side effects live at the edges.
- Small focused modules, descriptive names, flat control flow — collapse duplicate branches, avoid nesting.

**Review**

- Re-read the diff: every changed line traces to the request. Remove orphans your change created (unused imports, dead branches) — but leave pre-existing dead code alone; mention it instead.
- Check the boundaries held: no DB access in `src/`, no product-name branching in core, credentials never logged or stored in plaintext.
- Verify: `bun run typecheck`, `bun test`, and the smoke/e2e scripts relevant to the touched layer (see below).

## Conventions

- **Bun first** — `bun:sqlite`, `Bun.serve`, `Bun.SQL`, `Bun.secrets`, `bun:test`. Reach for Bun/browser primitives before adding a dependency.
- **Server/client boundary** — all database access is server-side; the UI talks to `/api/*`.
- **Staged writes** — mutations are staged and applied explicitly in a transaction; never write on cell blur. Write access starts disabled per session.
- **Drivers, not branches** — new backends implement `DataSourceDriver` (+ capability providers), register in `server/app.ts`, add a URL validator in `server/connections.ts`. Core never branches on product names; Redis/Valkey UI consumes detected `Capabilities`.
- **Credentials** — stored via `Bun.secrets` (service `dev.tern.credentials`) behind the injectable SecretStore. Failure to store must fail the save — never fall back to plaintext, never log credentials.
- **Tests** — colocated `*.test.ts` using `bun:test`. Redis driver is unit-tested through the injectable `SessionTransport`; pure modules (command catalog, autocomplete, explain, lint, RESP) are isomorphic and imported directly by the browser bundle.
- **Style** — dense desktop UI, dark theme, Tailwind. Compact modules over framework-shaped abstractions. Match surrounding style.

## Verification expectations

Before considering work done: `bun run typecheck` and `bun test` pass; run the UI smoke scripts (`bun run test:ui`) when touching `src/`; run `bun run test:e2e` when touching connection/mutation/migration paths. See `docs/verification.md` for what a full verification covers.

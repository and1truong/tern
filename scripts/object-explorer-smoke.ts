// Real-DOM smoke for multi-schema object discovery and search.
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement",
  "Element", "Node", "Text", "Event", "MouseEvent", "CustomEvent", "getComputedStyle",
] as const) (globalThis as any)[key] = (win as any)[key];
(globalThis as any).window = win;
let clipboard = "";
Object.defineProperty((globalThis as any).navigator, "clipboard", { value: { writeText: async (value: string) => { clipboard = value; } }, configurable: true });
let loadInsights = async (_url: string) => Response.json({ metrics: { engine: "SQLite", file_bytes: 4096, integrity: "ok" }, activity: [] });
(globalThis as any).fetch = async (input: string | URL | Request) => {
  if (String(input).includes("/insights?")) return loadInsights(String(input));
  return Response.json({ error: "unexpected smoke request" }, { status: 500 });
};

function fail(message: string): never { console.error(`FAIL: ${message}`); process.exit(1); }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function exercise(width: number) {
  Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { InsightsPane } = await import("../src/InsightsPane.tsx");
  const { ObjectTree } = await import("../src/ObjectTree.tsx");
  const { SchemaDiagramPane } = await import("../src/SchemaDiagramPane.tsx");
  const schema = {
    schemas: ["audit", "public", "main"],
    tables: [
      { schema: "main", name: "main_table", type: "table", rowCount: 0, ddl: "", columns: [] },
      { schema: "public", name: "users", type: "table", rowCount: 20, ddl: "", columns: [{ name: "email", type: "text", notNull: true, pk: false, fk: null }] },
      { schema: "audit", name: "user_events", type: "materialized_view", rowCount: -1, ddl: "", columns: [{ name: "actor_id", type: "uuid", notNull: true, pk: false, fk: "users(id)" }] },
    ],
    indexes: [{ schema: "public", table: "users", name: "users_email_idx", unique: true, columns: ["email"], sql: "" }],
    triggers: [], constraints: [{ schema: "public", table: "users", name: "users_email_key", type: "UNIQUE", columns: ["email"], definition: "UNIQUE (email)" }],
    sequences: [{ schema: "public", name: "users_id_seq" }], routines: [{ schema: "public", name: "find_user", type: "FUNCTION" }],
    extensions: [{ name: "pgcrypto", definition: "1.3" }], pragmas: {},
  } as any;
  let selected = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(ObjectTree, { schema, activeTable: null, locked: false, onSelect: (key: string) => { selected = key; } })));
  if (!container.textContent?.includes("audit") || !container.textContent?.includes("Materialized") || !container.textContent?.includes("Routines")) {
    fail(`${width}px: schema/object sections are missing`);
  }
  if (!container.textContent?.includes("main_table")) fail("PostgreSQL main schema was hidden");
  const search = container.querySelector('[aria-label="Search database objects"]') as HTMLInputElement | null;
  if (!search) fail(`${width}px: object search is missing`);
  setValue(search, "email");
  await settle();
  if (!container.textContent?.includes("users_email_idx") || container.textContent?.includes("user_events")) fail(`${width}px: search did not filter catalog metadata`);
  const users = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("users"));
  users?.click();
  if (selected !== "public.users") fail(`${width}px: table selection did not preserve schema identity`);
  flushSync(() => root.render(React.createElement(ObjectTree, { schema, activeTable: "public.users", locked: true, onSelect: () => {} })));
  const lockedUsers = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("users")) as HTMLButtonElement | undefined;
  if (!lockedUsers?.disabled) fail(`${width}px: active table remains navigable while row changes are staged`);
  flushSync(() => root.unmount());
  container.remove();

  const diagramContainer = document.createElement("div");
  document.body.appendChild(diagramContainer);
  const diagramRoot = createRoot(diagramContainer);
  const diagramSchema = { ...schema, tables: schema.tables.map((table: any) => ({ ...table, type: "table" })) };
  flushSync(() => diagramRoot.render(React.createElement(SchemaDiagramPane, { schema: diagramSchema })));
  if (!diagramContainer.textContent?.includes("3 tables · 1 relationships") || !diagramContainer.textContent?.includes("actor_id")) {
    fail(`${width}px: relationship diagram is incomplete`);
  }
  const copy = [...diagramContainer.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy Mermaid");
  copy?.click();
  await settle();
  if (!clipboard.includes("erDiagram") || !clipboard.includes("audit_user_events")) fail(`${width}px: Mermaid export failed`);
  flushSync(() => diagramRoot.unmount());
  diagramContainer.remove();

  const insightsContainer = document.createElement("div");
  document.body.appendChild(insightsContainer);
  const insightsRoot = createRoot(insightsContainer);
  flushSync(() => insightsRoot.render(React.createElement(InsightsPane, { source: { kind: "sqlite", path: "/tmp/app.sqlite" } })));
  await settle(); await settle();
  if (!insightsContainer.textContent?.includes("Operational insights") || !insightsContainer.textContent?.includes("4.0 KB") || !insightsContainer.textContent?.includes("No other active")) {
    fail(`${width}px: operational insights did not render`);
  }

  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  loadInsights = (url) => new Promise((resolve) => {
    if (url.includes("old.sqlite")) resolveOld = resolve;
    else resolveNew = resolve;
  });
  flushSync(() => insightsRoot.render(React.createElement(InsightsPane, { source: { kind: "sqlite", path: "/tmp/old.sqlite" } })));
  await settle();
  if (insightsContainer.textContent?.includes("4.0 KB")) fail(`${width}px: old insights remain visible during a source switch`);
  flushSync(() => insightsRoot.render(React.createElement(InsightsPane, { source: { kind: "sqlite", path: "/tmp/new.sqlite" } })));
  await settle();
  resolveNew(Response.json({ metrics: { source: "new-source" }, activity: [] }));
  await settle(); await settle();
  resolveOld(Response.json({ metrics: { source: "old-source" }, activity: [] }));
  await settle(); await settle();
  if (!insightsContainer.textContent?.includes("new-source") || insightsContainer.textContent?.includes("old-source")) {
    fail(`${width}px: stale insights replaced the active source response`);
  }
  flushSync(() => insightsRoot.unmount());
  insightsContainer.remove();
  loadInsights = async () => Response.json({ metrics: { engine: "SQLite", file_bytes: 4096, integrity: "ok" }, activity: [] });
}

await exercise(1280);
await exercise(480);
console.log("PASS: multi-schema object explorer/search works at 1280px and 480px");

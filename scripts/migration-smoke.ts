// Real-DOM smoke for migration dry-run, invalidation, and atomic apply.
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement",
  "Element", "Node", "Text", "Event", "MouseEvent", "CustomEvent", "getComputedStyle",
] as const) (globalThis as any)[key] = (win as any)[key];
(globalThis as any).window = win;
let previews = 0;
let applies = 0;
(globalThis as any).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/migration/preview")) { previews++; return Response.json({ validated: true, applied: false, ms: 3 }); }
  if (url.endsWith("/migration/apply")) { applies++; return Response.json({ validated: true, applied: true, ms: 4 }); }
  return Response.json({ error: "unexpected smoke request" }, { status: 500 });
};

function fail(message: string): never { console.error(`FAIL: ${message}`); process.exit(1); }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function exercise(width: number) {
  Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { DatabaseMigrationModal } = await import("../src/DatabaseMigrationModal.tsx");
  let closed = 0; let applied = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(DatabaseMigrationModal, {
    source: { kind: "postgres", connId: "prod", label: "Prod", url: "postgres://prod/app", environment: "production", readOnly: false },
    writable: true, onClose: () => { closed++; }, onApplied: () => { applied++; },
  })));
  if (!container.textContent?.includes("not undone by rollback")) fail(`${width}px: sequence warning is missing`);
  if (!container.textContent?.includes("targets a production profile")) fail(`${width}px: production migration warning is missing`);
  const textarea = container.querySelector('[aria-label="Migration SQL"]') as HTMLTextAreaElement | null;
  if (!textarea) fail(`${width}px: migration editor is missing`);
  setValue(textarea, "CREATE TABLE audit_log (id bigint primary key);");
  await settle();
  const dryRun = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Dry run");
  dryRun?.click();
  await settle(); await settle();
  if (!container.textContent?.includes("Dry-run passed and rolled back")) fail(`${width}px: dry-run result is missing`);
  const apply = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Apply migration") as HTMLButtonElement | undefined;
  if (!apply || apply.disabled) fail(`${width}px: validated migration is not applicable`);
  apply.click();
  await settle(); await settle();
  if (!applied || !closed) fail(`${width}px: migration apply did not complete`);
  flushSync(() => root.unmount());
  container.remove();
}

await exercise(1280);
await exercise(480);
if (previews !== 2 || applies !== 2) fail(`unexpected endpoint counts: ${previews} previews, ${applies} applies`);
console.log("PASS: migration dry-run/apply flow works at 1280px and 480px");

// A pending CREATE must remain visible until the write completes.
{
  (globalThis as any).HTMLInputElement = win.HTMLInputElement;
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { DatabaseCreateViewModal } = await import("../src/DatabaseCreateViewModal.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  let closed = 0;
  let finish!: (response: Response) => void;
  (globalThis as any).fetch = () => new Promise<Response>(resolve => { finish = resolve; });
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(DatabaseCreateViewModal, {
    source: { kind: "sqlite", path: "/tmp/test.sqlite", label: "Test" },
    onClose: () => { closed++; }, onCreated: () => {},
  })));
  const name = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(name, "example");
  name.dispatchEvent(new Event("input", { bubbles: true }));
  setValue(container.querySelector("textarea")!, "SELECT 1");
  await settle();
  const buttons = () => [...container.querySelectorAll("button")];
  buttons().find(b => b.textContent === "Create")!.click();
  await settle();
  (container.firstElementChild as HTMLElement).click();
  buttons()[0].click();
  buttons().find(b => b.textContent === "Cancel")!.click();
  if (closed) fail("pending view creation allowed dismissal");
  finish(Response.json({ rowsAffected: 0, ms: 1 }));
  await settle(); await settle();
  if (closed !== 1) fail("view creation did not close after completion");
  flushSync(() => root.unmount());
  container.remove();
}
console.log("PASS: view creation blocks dismissal while its write is pending");

// Real-DOM interaction smoke for the professional data-grid controls.
// Keep this as a standalone script: it must install happy-dom globals before
// react-dom is imported. Run with `bun scripts/data-grid-smoke.ts`.
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "Element", "Node", "Text", "Event", "MouseEvent",
  "CustomEvent", "Blob", "getComputedStyle",
] as const) {
  (globalThis as any)[key] = (win as any)[key];
}
(globalThis as any).window = win;

let clipboard = "";
Object.defineProperty((globalThis as any).navigator, "clipboard", {
  value: { writeText: async (value: string) => { clipboard = value; } },
  configurable: true,
});
(globalThis as any).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/rows/preview")) {
    return Response.json({ statements: [{ kind: "update", sql: `UPDATE "users" SET "name" = ? WHERE "id" IS ?`, params: ["Augusta", 1] }] });
  }
  if (url.endsWith("/rows/apply")) return Response.json({ applied: 1, rowsAffected: 1, ms: 1 });
  return Response.json({ error: "unexpected smoke request" }, { status: 500 });
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor((globalThis as any).HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function exercise(width: number) {
  Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { DataGrid } = await import("../src/DatabaseViews.tsx");

  const events: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(DataGrid, {
    table: {
      name: "users", type: "table", rowCount: -1, ddl: "",
      columns: [
        { name: "id", type: "integer", notNull: true, pk: true, fk: null },
        { name: "name", type: "text", notNull: true, pk: false, fk: null },
        { name: "computed", type: "integer", notNull: true, pk: false, fk: null, generated: true },
      ],
    },
    source: { kind: "sqlite", path: "/tmp/smoke.sqlite" },
    writable: true,
    columns: ["id", "name", "computed"],
    result: {
      columns: ["id", "name", "computed"],
      rows: [
        { id: 1, name: "Ada", computed: 2 },
        { id: 2, name: "G".repeat(200), computed: 4 },
        { id: 3, name: { __ternWire: { kind: "binary", base64: "AA==" } }, computed: 6 },
        { id: 4, name: { ok: true }, computed: 8 },
      ],
      ms: 1.2,
      hasMore: true,
      offset: 0,
    },
    sorts: [],
    pageSize: 100,
    onSort: (column: string, additive: boolean) => events.push(`sort:${column}:${additive}`),
    onPrevious: () => events.push("previous"),
    onNext: () => events.push("next"),
    onPageSize: (size: number) => events.push(`size:${size}`),
    onDirtyChange: (dirty: boolean) => events.push(`dirty:${dirty}`),
    onApplied: () => events.push("applied"),
    onExportAll: async () => ({ columns: ["id", "name", "computed"], rows: [{ id: 1, name: "Ada", computed: 2 }, { id: 2, name: "Grace", computed: 4 }] }),
  })));

  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  const sort = byLabel("Sort by name");
  if (!sort) fail(`${width}px: sort control is not visible`);
  sort.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));

  const row = byLabel("Select row 1") as HTMLInputElement | null;
  if (!row) fail(`${width}px: row selection is not visible`);
  row.click();
  await settle();

  const copy = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy CSV");
  if (!copy) fail(`${width}px: copy control is not visible`);
  copy.click();
  await settle();
  if (clipboard !== "id,name,computed\n1,Ada,2") fail(`${width}px: selected-row CSV was ${JSON.stringify(clipboard)}`);

  const next = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next");
  if (!next || next.hasAttribute("disabled")) fail(`${width}px: next page is not available`);
  next.click();

  const pageSize = byLabel("Rows per page") as HTMLSelectElement | null;
  if (!pageSize) fail(`${width}px: page-size selector is not visible`);
  pageSize.value = "50";
  pageSize.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();

  if (!events.includes("sort:name:true")) fail(`${width}px: shift-sort interaction did not fire`);
  if (!events.includes("next")) fail(`${width}px: next-page interaction did not fire`);
  if (!events.includes("size:50")) fail(`${width}px: page-size interaction did not fire`);
  if (!container.textContent?.includes("1–4+")) fail(`${width}px: result range is missing`);

  const columnsButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Columns 3/3");
  columnsButton?.click();
  await settle();
  if (!container.querySelectorAll('input[type="checkbox"]').length) fail(`${width}px: column chooser is missing`);
  columnsButton?.click();
  const largeValue = container.querySelector('button[title="Open large value"]') as HTMLElement | null;
  largeValue?.click();
  await settle();
  if (!container.querySelector('[role="dialog"][aria-label="Large value inspector"]')) fail(`${width}px: large-value inspector is missing`);
  byLabel("Close large value")?.click();

  const binaryCell = [...container.querySelectorAll("td")].find((cell) => cell.textContent?.trim() === "<binary 1 bytes>");
  if (!binaryCell) fail(`${width}px: binary cell is missing`);
  binaryCell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
  if (byLabel("Edit row 3 name")) fail(`${width}px: binary cell incorrectly opened the text editor`);

  binaryCell.querySelector("button")?.click();
  await settle();
  const binaryInspector = container.querySelector('[role="dialog"][aria-label="Large value inspector"]');
  if (!binaryInspector?.textContent?.includes("Base64:") || !binaryInspector.textContent.includes("AA==")) fail(`${width}px: binary inspector is missing payload`);
  byLabel("Close large value")?.click();
  await settle();

  const objectCell = [...container.querySelectorAll("td")].find((cell) => cell.textContent?.trim() === '{"ok":true}');
  if (!objectCell) fail(`${width}px: object-valued cell is missing`);
  objectCell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
  if (byLabel("Edit row 4 name")) fail(`${width}px: object-valued cell incorrectly opened the text editor`);

  const generatedCell = container.querySelectorAll("tbody tr")[0]?.querySelectorAll("td")[3] as HTMLElement | undefined;
  if (!generatedCell) fail(`${width}px: generated cell is missing`);
  generatedCell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
  if (byLabel("Edit row 1 computed")) fail(`${width}px: generated cell incorrectly opened the editor`);

  const addRow = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add row");
  addRow?.click();
  await settle();
  if (!byLabel("Close add row")) fail(`${width}px: add-row modal is not visible`);
  if (byLabel("New computed")) fail(`${width}px: generated column is editable in the add-row modal`);
  const stageDefault = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stage row");
  stageDefault?.click();
  await settle();
  if (![...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Review 1 change"))) fail(`${width}px: default-values row was not staged`);
  [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Revert")?.click();
  await settle();

  const importCsv = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Import CSV");
  importCsv?.click();
  await settle();
  const csvContent = container.querySelector('[aria-label="CSV content"]') as HTMLTextAreaElement | null;
  if (!csvContent) fail(`${width}px: CSV import modal is not visible`);
  setValue(csvContent, "id,name,computed\n3,Katherine,6");
  await settle();
  const stageImport = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stage import");
  stageImport?.click();
  await settle();
  if (!container.textContent?.includes("not writable: computed")) fail(`${width}px: CSV import accepted a generated column`);
  setValue(csvContent, "id,name\n3,Katherine\n4,Dorothy");
  await settle();
  stageImport?.click();
  await settle();
  if (![...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Review 2 changes"))) fail(`${width}px: CSV rows were not staged`);
  const revertImport = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Revert");
  revertImport?.click();
  await settle();

  const adaCell = [...container.querySelectorAll("td")].find((cell) => cell.textContent?.trim() === "Ada");
  if (!adaCell) fail(`${width}px: editable cell is missing`);
  adaCell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
  const editor = byLabel("Edit row 1 name") as HTMLInputElement | null;
  if (!editor) fail(`${width}px: double-click did not open the cell editor`);
  editor.value = "Augusta";
  editor.dispatchEvent(new Event("focusout", { bubbles: true }));
  await settle();

  const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Review 1 change"));
  if (!review) fail(`${width}px: staged change is not reviewable`);
  review.click();
  await settle();
  if (!container.querySelector('[role="dialog"][aria-label="Review row changes"]')) fail(`${width}px: review modal is not visible`);
  const apply = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Apply transaction");
  apply?.click();
  await settle();
  await settle();
  if (!events.includes("dirty:true")) fail(`${width}px: staged edit did not lock navigation`);
  if (!events.includes("applied")) fail(`${width}px: apply transaction did not complete`);

  flushSync(() => root.unmount());
  container.remove();
}

await exercise(1280);
await exercise(480);
console.log("PASS: data grid browse/edit/review/apply works at 1280px and 480px");

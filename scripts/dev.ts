import { watch } from "node:fs";
import { build } from "./build.ts";
await build();
let pending = false;
watch("src", { recursive: true }, async () => {
  if (pending) return;
  pending = true;
  try { await build(); console.log("Rebuilt frontend; refresh the browser."); }
  catch (error) { console.error(error); }
  finally { pending = false; }
});
const server = Bun.spawn(["bun", "--watch", "server.ts"], { stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", () => { server.kill(); process.exit(); });
await server.exited;

import { mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
export async function build() {
  const result = await Bun.build({ entrypoints: ["src/index.tsx"], outdir: "dist", naming: "client.js", target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!result.success) throw new AggregateError(result.logs, "Client build failed");
  const css = Bun.spawn(["bun", "node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "src/tailwind.css", "-o", "dist/style.css", "--minify"], { stdout: "inherit", stderr: "inherit" });
  if (await css.exited) throw new Error("CSS build failed");
  await Bun.write("dist/index.html", Bun.file("src/index.html"));
}
if (import.meta.main) await build();

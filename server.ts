import { resolve } from "node:path";
import { openAppDatabase } from "./server/appDatabase.ts";
import { makeApp } from "./server/app.ts";

const db = openAppDatabase();
const app = makeApp(db, { appPath: resolve(db.filename) });
const assets = new Map([ ["/", "index.html"], ["/index.html", "index.html"], ["/client.js", "client.js"], ["/style.css", "style.css"] ]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4310),
  idleTimeout: 120,
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return app(req);
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== "GET") return new Response("Not found", { status: 404 });
    const file = Bun.file(new URL(`./dist/${asset}`, import.meta.url));
    if (!await file.exists()) return new Response("Run bun run build first.", { status: 503 });
    return new Response(file, { headers: {
      "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    } });
  },
});
console.log(`DBM → ${server.url}`);

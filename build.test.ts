import { expect, test } from "bun:test";
import { build } from "./scripts/build.ts";
test("standalone frontend bundles React and links its own CSS", async () => {
  await build();
  const html = await Bun.file("dist/index.html").text();
  expect(html).toContain('/client.js');
  expect(html).toContain('/style.css');
  const code = await Bun.file("dist/client.js").text();
  expect(code).not.toMatch(/from["'](?:react|@tabterm)/);
  expect(await Bun.file("dist/style.css").text()).toContain('--surface');
});

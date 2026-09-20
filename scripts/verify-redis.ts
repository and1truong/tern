// End-to-end verification of the Redis-compatible driver against real
// servers: redis:7 on :6380 and valkey:8 on :6381 (compose.verify.yml).
// Exercises connection, flavor/capability detection, SCAN exploration,
// type-aware inspection, key ops, console exec, lint and read-only gating.
import { makeRedisDriver } from "../datasources/redis/driver.ts";
import { lintCommand } from "../datasources/redis/lint.ts";

const TARGETS = [
  { name: "redis", url: "redis://127.0.0.1:6380", expectFlavor: "redis" as const },
  { name: "valkey", url: "redis://127.0.0.1:6381", expectFlavor: "valkey" as const },
];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const probe = makeRedisDriver(undefined, { connectTimeoutMs: 1500 });
    await probe.test({ url });
    return true;
  } catch { return false; }
}

async function verify(name: string, url: string, expectFlavor: "redis" | "valkey") {
  console.log(`\n== ${name} (${url})`);
  const failuresBefore = failures;
  const driver = makeRedisDriver();
  const info = await driver.test({ url });
  check(`${name}: flavor is ${expectFlavor}`, info.flavor === expectFlavor, info.flavor);
  check(`${name}: version detected`, /^\d+\.\d+\.\d+$/.test(info.version), info.version);
  check(`${name}: streams capability`, info.capabilities!.streams === true);

  const session = await driver.connect({ url });
  try {
    const console_ = session.console!, explorer = session.explorer!;
    // Seed one key per type (namespaced so repeated runs stay clean).
    const prefix = `tern-verify:${Date.now()}`;
    const keys = { s: `${prefix}:str`, h: `${prefix}:hash`, l: `${prefix}:list`, set: `${prefix}:set`, z: `${prefix}:zset`, st: `${prefix}:stream` };
    for (const command of [
      ["SET", keys.s, "hello"], ["HSET", keys.h, "f1", "v1", "f2", "v2"], ["RPUSH", keys.l, "a", "b"],
      ["SADD", keys.set, "m1", "m2"], ["ZADD", keys.z, "1.5", "member"], ["XADD", keys.st, "*", "sensor", "temp"],
    ] as const) {
      const result = await console_.exec(command.join(" "), { writable: true });
      check(`${name}: seed ${command[0]}`, result.reply.t !== "err", result.reply);
    }

    // SCAN finds the seeded keys with correct types.
    const scanAll = async (match: string) => {
      const found = new Map<string, string>();
      let cursor = "0";
      do {
        const page = await explorer.scan({ cursor, match, count: 100 });
        cursor = page.cursor;
        for (const k of page.keys) found.set(k.key, k.type);
      } while (cursor !== "0");
      return found;
    };
    const keyspace = await scanAll(`${prefix}:*`);
    check(`${name}: SCAN finds 6 keys`, keyspace.size === 6, keyspace);
    check(`${name}: SCAN types`, keyspace.get(keys.h) === "hash" && keyspace.get(keys.z) === "zset" && keyspace.get(keys.st) === "stream", keyspace);

    // Type-aware inspection.
    const s = await explorer.inspect(keys.s);
    check(`${name}: string value`, s.value.kind === "string" && s.value.value === "hello", s.value);
    const h = await explorer.inspect(keys.h);
    check(`${name}: hash fields`, h.value.kind === "hash" && h.value.entries.some(e => e.field === "f1" && e.value === "v1"), h.value);
    const l = await explorer.inspect(keys.l);
    check(`${name}: list items`, l.value.kind === "list" && l.value.items.join() === "a,b", l.value);
    const set = await explorer.inspect(keys.set);
    check(`${name}: set members`, set.value.kind === "set" && set.value.members.length === 2, set.value);
    const z = await explorer.inspect(keys.z);
    check(`${name}: zset score`, z.value.kind === "zset" && z.value.entries[0]?.score === 1.5, z.value);
    const st = await explorer.inspect(keys.st);
    check(`${name}: stream entry`, st.value.kind === "stream" && st.value.entries[0]?.fields.sensor === "temp", st.value);

    // Key ops: expire, persist, rename, edit, delete.
    check(`${name}: expire`, (await explorer.keyOp({ op: "expire", key: keys.s, seconds: 999 })).n === 1);
    check(`${name}: TTL set`, (await explorer.inspect(keys.s)).ttlSeconds > 0);
    check(`${name}: persist`, (await explorer.keyOp({ op: "persist", key: keys.s })).n === 1);
    check(`${name}: TTL cleared`, (await explorer.inspect(keys.s)).ttlSeconds === -1);
    check(`${name}: setString keeps hash-less value`, (await explorer.keyOp({ op: "setString", key: keys.s, value: "edited" })).ok);
    const edited = await explorer.inspect(keys.s);
    check(`${name}: edited value visible`, edited.value.kind === "string" && edited.value.value === "edited");
    check(`${name}: rename`, (await explorer.keyOp({ op: "rename", from: keys.s, to: `${keys.s}-renamed` })).ok);
    check(`${name}: renamed key gone`, (await explorer.inspect(keys.s)).type === "none");
    check(`${name}: delete`, (await explorer.keyOp({ op: "delete", keys: [`${keys.s}-renamed`, keys.h, keys.l, keys.set, keys.z, keys.st] })).n === 6);

    // Console semantics: read-only gating, error replies, blocking refusal.
    const writeBlocked = await console_.exec("SET should-fail 1", { writable: false }).then(() => null, (e: Error) => e);
    check(`${name}: write blocked read-only`, writeBlocked !== null && "code" in writeBlocked! && (writeBlocked as unknown as { code: string }).code === "not_read_only");
    await console_.exec(`SET ${keys.s} plain`, { writable: true });
    const bad = await console_.exec(`HGET ${keys.s} f`, { writable: true });
    check(`${name}: WRONGTYPE surfaces as err reply`, bad.reply.t === "err" && /WRONGTYPE/.test((bad.reply as { s?: string }).s ?? ""), bad.reply);
    await explorer.keyOp({ op: "delete", keys: [keys.s] });
    const indefinite = await console_.exec("BLPOP no-queue 0", { writable: true });
    check(`${name}: indefinite BLPOP refused`, indefinite.reply.t === "err", indefinite.reply);

    // Lint flags KEYS.
    const warnings = lintCommand("KEYS *", { writable: true, cluster: info.capabilities!.cluster });
    check(`${name}: lint warns on KEYS`, warnings.some(w => w.rule === "keys-full-scan"), warnings);
  } finally {
    await session.close();
  }
  if (failures === failuresBefore) console.log(`PASS ${name}`);
}

async function main() {
  const available: typeof TARGETS = [];
  for (const target of TARGETS) {
    if (await reachable(target.url)) available.push(target);
    else console.warn(`skip: no server at ${target.url} (docker compose -f compose.verify.yml up -d redis valkey)`);
  }
  if (!available.length) { console.log("nothing to verify"); return; }
  for (const t of available) await verify(t.name, t.url, t.expectFlavor);
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall redis/valkey integration checks passed");
}

await main();

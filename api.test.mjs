// Tests for the API routes, run against fake request/response objects.
// Supabase and Anthropic are stood in for by a fake fetch, so no accounts or network are needed.
import assert from "node:assert";
import { Readable } from "node:stream";

process.env.TEAM_PASSCODE = "correct-horse-battery";
process.env.TP_DEV_MEMORY = "1";
const data = (await import("../api/data.js")).default;
const { default: read, parseJson } = await import("../api/read.js");
const { store } = await import("../lib/server.js");

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok", name); };
async function call(handler, { method = "GET", url = "/api/data", code = "correct-horse-battery", body } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers: code ? { "x-team-code": code } : {} });
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s; } };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}
const post = (body, extra) => call(data, { method: "POST", body, ...extra });

await t("health is public and shows only booleans", async () => {
  const r = await call(data, { url: "/api/data?health=1", code: "" });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { passcode: true, storage: true, reading: false });
});
await t("everything else needs the passcode", async () => {
  assert.equal((await call(data, { code: "" })).status, 401);
  assert.equal((await call(data, { code: "wrong-passcode" })).status, 401);
  assert.equal((await post({ op: "set", path: "trips/a", data: {} }, { code: "nope" })).status, 401);
  assert.equal((await call(read, { method: "POST", url: "/api/read", code: "", body: {} })).status, 401);
  assert.equal((await call(data, { url: "/api/data?ping=1" })).status, 200);
});
await t("a short passcode locks the site rather than opening it", async () => {
  process.env.TEAM_PASSCODE = "abc";
  assert.equal((await call(data, { code: "abc" })).status, 401);
  process.env.TEAM_PASSCODE = "correct-horse-battery";
});
await t("set, list, get, merge-update, delete", async () => {
  const s = await post({ op: "set", path: "trips/t1", data: { name: "Trip", lines: { a: { q: 1, st: "open", fl: ["qty"] }, b: { q: 2, st: "open" } } } });
  assert.equal(s.status, 200); assert.equal(s.json.path, "trips/t1");
  const list = await call(data);
  assert.deepEqual(list.json.docs.map((d) => d.path), ["trips/t1"]); assert.equal(list.json.docs[0].data, undefined);
  const u = await post({ op: "update", path: "trips/t1", patch: { lines: { a: { st: "picked", fl: [] } } } });
  assert.deepEqual(u.json.data.lines, { a: { q: 1, st: "picked", fl: [] }, b: { q: 2, st: "open" } });
  assert.notEqual(u.json.v, s.json.v);
  const g = await call(data, { url: "/api/data?paths=trips/t1,trips/none" });
  assert.equal(g.json.docs.length, 1); assert.equal(g.json.docs[0].data.name, "Trip");
  assert.equal((await post({ op: "update", path: "trips/none", patch: { a: 1 } })).status, 404);
  await post({ op: "delete", path: "trips/t1" });
  assert.equal((await call(data)).json.docs.length, 0);
});
await t("bad paths, bad bodies and oversized documents are refused", async () => {
  for (const path of ["users/x", "trips/../x", "trips/a/b", "trips/", 5]) assert.equal((await post({ op: "set", path, data: {} })).status, 400);
  assert.equal((await post({ op: "set", path: "trips/a", data: [1] })).status, 400);
  assert.equal((await post({ op: "nuke", path: "trips/a" })).status, 400);
  assert.equal((await post({ op: "set", path: "trips/big", data: { s: "x".repeat(300000) } })).status, 413);
  await post({ op: "set", path: "trips/p", data: {} });
  const r = await post({ op: "update", path: "trips/p", patch: JSON.parse('{"__proto__":{"polluted":1},"ok":1}') });
  assert.equal(r.json.data.ok, 1); assert.equal({}.polluted, undefined);
  store._reset();
});

await t("Supabase path: request shapes, and a simultaneous edit is retried not overwritten", async () => {
  delete process.env.TP_DEV_MEMORY;
  process.env.SUPABASE_URL = "https://example.supabase.co/"; process.env.SUPABASE_SERVICE_KEY = "secret-key";
  const rows = new Map(); const seen = []; let sneak = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const p = u.searchParams; seen.push(`${init.method} ${u.pathname}${u.search}`);
    assert.equal(u.origin + u.pathname, "https://example.supabase.co/rest/v1/tp_docs");
    assert.equal(init.headers.apikey, "secret-key"); assert.equal(init.headers.authorization, "Bearer secret-key");
    const eq = (k) => (p.get(k) || "").replace(/^eq\./, "");
    const reply = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (init.method === "POST") { const b = JSON.parse(init.body); assert.match(init.headers.prefer, /merge-duplicates/); rows.set(b.key, b); return reply([b]); }
    if (init.method === "GET" && p.get("key")?.startsWith("eq.")) { const r = rows.get(eq("key")); return reply(r ? [r] : []); }
    if (init.method === "GET") return reply([...rows.values()].map((r) => ({ key: r.key, v: r.v })));
    if (init.method === "PATCH") {
      const r = rows.get(eq("key"));
      if (sneak) { sneak = false; r.v = "changed-by-the-other-phone"; r.data = { ...r.data, other: true }; } // someone else writes first
      if (!r || r.v !== eq("v")) return reply([]);
      Object.assign(r, JSON.parse(init.body)); return reply([r]);
    }
    if (init.method === "DELETE") { rows.delete(eq("key")); return new Response(null, { status: 204 }); }
    throw new Error("unexpected " + init.method);
  };
  try {
    await post({ op: "set", path: "trips/s1", data: { a: 1 } });
    assert(rows.has("trips__s1"));
    const u = await post({ op: "update", path: "trips/s1", patch: { b: 2 } });
    assert.deepEqual(u.json.data, { a: 1, other: true, b: 2 }, "the other phone's write survived");
    assert.equal(seen.filter((s) => s.startsWith("PATCH")).length, 2);
    assert.deepEqual((await call(data)).json.docs.map((d) => d.path), ["trips/s1"]);
    assert.equal((await post({ op: "delete", path: "trips/s1" })).status, 200); assert.equal(rows.size, 0);
  } finally { globalThis.fetch = realFetch; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.TP_DEV_MEMORY = "1"; }
});

await t("tolerant JSON reading", () => {
  assert.deepEqual(parseJson('{"items":[]}'), { items: [] });
  assert.deepEqual(parseJson('Here you go:\n```json\n{"items":[{"name":"Milk"}]}\n```'), { items: [{ name: "Milk" }] });
  assert.deepEqual(parseJson('Sure. {"items":[1]} Hope that helps'), { items: [1] });
  assert.equal(parseJson("no json here"), undefined);
});
await t("read route: validates input, calls the Messages API, maps failures", async () => {
  const img = { media_type: "image/jpeg", data: "AAAA" };
  assert.equal((await call(read, { method: "POST", url: "/api/read", body: { prompt: "x", images: [img] } })).status, 503, "no key = switched off");
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal((await call(read, { method: "POST", url: "/api/read", body: { prompt: "x", images: [] } })).status, 400);
  assert.equal((await call(read, { method: "POST", url: "/api/read", body: { prompt: "x", images: [{ media_type: "image/gif", data: "AAAA" }] } })).status, 400);
  assert.equal((await call(read, { method: "POST", url: "/api/read", body: { prompt: "x", images: Array(6).fill(img) } })).status, 400);
  const realFetch = globalThis.fetch; let sent; let mode = "ok";
  globalThis.fetch = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    if (mode === "429") return new Response("{}", { status: 429 });
    if (mode === "404") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: '```json\n{"items":[{"name":"Eggs","qty":2}]}\n```' }] }), { status: 200 });
  };
  try {
    const r = await call(read, { method: "POST", url: "/api/read", body: { prompt: "read these", images: [img, img], tier: "quick" } });
    assert.equal(r.status, 200); assert.deepEqual(r.json.result, { items: [{ name: "Eggs", qty: 2 }] });
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages"); assert.equal(sent.headers["x-api-key"], "sk-test"); assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    assert.equal(sent.body.model, "claude-haiku-5-5"); assert.equal(sent.body.messages[0].content.length, 3); assert.equal(sent.body.messages[0].content[0].source.type, "base64");
    process.env.ANTHROPIC_MODEL = "my-model";
    await call(read, { method: "POST", url: "/api/read", body: { prompt: "p", images: [img] } }); assert.equal(sent.body.model, "my-model");
    mode = "429"; assert.equal((await call(read, { method: "POST", url: "/api/read", body: { prompt: "p", images: [img] } })).status, 429);
    mode = "404"; const nf = await call(read, { method: "POST", url: "/api/read", body: { prompt: "p", images: [img] } }); assert.equal(nf.status, 502); assert.match(nf.json.error, /ANTHROPIC_MODEL/);
  } finally { globalThis.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_MODEL; }
});
console.log(n + " api tests passed");

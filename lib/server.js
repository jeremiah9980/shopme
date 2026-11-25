// Shared by api/data.js and api/read.js. No dependencies: Node 20+ only.
import crypto from "node:crypto";

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

// Works on Vercel (which may pre-parse the body) and on the plain Node dev server.
export async function readBody(req, limit = 4_400_000) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export const query = (req) => new URL(req.url, "http://x").searchParams;

export function settings() {
  const e = process.env;
  return {
    passcode: (e.TEAM_PASSCODE || "").length >= 8,
    storage: !!(e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY) || e.TP_DEV_MEMORY === "1",
    reading: !!e.ANTHROPIC_API_KEY,
  };
}

// One shared passcode for the two of you, compared in constant time. No passcode set = locked.
export function authed(req) {
  const want = process.env.TEAM_PASSCODE || "";
  if (want.length < 8) return false;
  const got = String(req.headers["x-team-code"] || "");
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = deepMerge(out[k], patch[k]);
  }
  return out;
}

/* ---------- storage ---------- */
const PATH_RE = /^(trips|prefs)\/[A-Za-z0-9_-]{1,64}$/;
export const validPath = (p) => typeof p === "string" && PATH_RE.test(p);
const toKey = (p) => p.replace("/", "__");
const toPath = (k) => k.replace("__", "/");
const stamp = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const MAX_DOC = 256 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

const memory = new Map(); // local dev only: a serverless host does not keep memory between requests

async function sb(method, qs, body, prefer) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${base}/rest/v1/tp_docs${qs}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...(prefer ? { prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw fail(502, `storage answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}
const useMemory = () => !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const row = (r) => ({ path: toPath(r.key), v: r.v, ...(r.data !== undefined ? { data: r.data } : {}) });

export const store = {
  async list() {
    if (useMemory()) return [...memory.entries()].map(([key, r]) => ({ path: toPath(key), v: r.v }));
    return (await sb("GET", "?select=key,v&order=updated_at.desc&limit=80")).map(row);
  },
  async get(paths) {
    const keys = paths.filter(validPath).map(toKey).slice(0, 80);
    if (!keys.length) return [];
    if (useMemory()) return keys.filter((k) => memory.has(k)).map((k) => row({ key: k, ...memory.get(k) }));
    return (await sb("GET", `?select=key,v,data&key=in.(${keys.join(",")})`)).map(row);
  },
  async set(path, data) {
    if (JSON.stringify(data).length > MAX_DOC) throw fail(413, "document too large");
    const rec = { key: toKey(path), data, v: stamp(), updated_at: new Date().toISOString() };
    if (useMemory()) { memory.set(rec.key, { data, v: rec.v }); return row(rec); }
    const rows = await sb("POST", "?on_conflict=key", rec, "resolution=merge-duplicates,return=representation");
    return row(rows[0] || rec);
  },
  // Merge a patch into the stored document. If someone else wrote in between, re-read and try again,
  // so two phones ticking items at the same moment never overwrite each other.
  async update(path, patch) {
    const key = toKey(path);
    for (let attempt = 0; attempt < 6; attempt++) {
      const cur = useMemory() ? (memory.has(key) ? { key, ...memory.get(key) } : null) : (await sb("GET", `?select=key,v,data&key=eq.${key}`))[0];
      if (!cur) throw fail(404, "no such document");
      const data = deepMerge(cur.data, patch);
      if (JSON.stringify(data).length > MAX_DOC) throw fail(413, "document too large");
      const next = { data, v: stamp(), updated_at: new Date().toISOString() };
      if (useMemory()) { memory.set(key, { data, v: next.v }); return row({ key, ...next }); }
      const rows = await sb("PATCH", `?key=eq.${key}&v=eq.${cur.v}`, next, "return=representation");
      if (rows.length) return row(rows[0]);
    }
    throw fail(503, "busy, try again");
  },
  async remove(path) {
    const key = toKey(path);
    if (useMemory()) { memory.delete(key); return; }
    await sb("DELETE", `?key=eq.${key}`);
  },
  _reset() { memory.clear(); },
};

// Shared trips: list, fetch, create, merge-update, delete. Everything except ?health needs the team passcode.
import { send, readBody, query, settings, authed, store, validPath } from "../lib/server.js";

export default async function handler(req, res) {
  try {
    const q = query(req);
    const cfg = settings();
    if (req.method === "GET" && q.has("health")) return send(res, 200, cfg); // booleans only, no secrets
    if (!authed(req)) return send(res, 401, { error: "passcode" });
    if (req.method === "GET" && q.has("ping")) return send(res, 200, { ok: true });
    if (!cfg.storage) return send(res, 503, { error: "storage is not set up" });

    if (req.method === "GET") {
      const paths = (q.get("paths") || "").split(",").filter(Boolean);
      return send(res, 200, { docs: paths.length ? await store.get(paths) : await store.list() });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!validPath(body.path)) return send(res, 400, { error: "bad path" });
      const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
      if (body.op === "set" && isObj(body.data)) return send(res, 200, await store.set(body.path, body.data));
      if (body.op === "update" && isObj(body.patch)) return send(res, 200, await store.update(body.path, body.patch));
      if (body.op === "delete") { await store.remove(body.path); return send(res, 200, { ok: true }); }
      return send(res, 400, { error: "bad request" });
    }
    res.setHeader("allow", "GET, POST");
    return send(res, 405, { error: "method" });
  } catch (e) {
    if (!e.status) console.error(e);
    return send(res, e.status || 500, { error: e.status ? e.message : "server error" });
  }
}

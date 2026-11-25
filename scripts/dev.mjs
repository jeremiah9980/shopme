// Local server: serves public/ and runs the same /api routes Vercel would.
// Without Supabase settings it keeps trips in memory, so you can try everything with no accounts.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!process.env.SUPABASE_URL) process.env.TP_DEV_MEMORY = "1";
if (!process.env.TEAM_PASSCODE) { process.env.TEAM_PASSCODE = "local-dev-passcode"; console.log('No TEAM_PASSCODE set, using "local-dev-passcode"'); }

const routes = { "/api/data": (await import("../api/data.js")).default, "/api/read": (await import("../api/read.js")).default };
const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
const pageHeaders = (vercel.headers || []).flatMap((h) => h.headers);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (routes[url.pathname]) return routes[url.pathname](req, res);
  const file = path.join(root, "public", path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(path.join(root, "public")) || !existsSync(file)) { res.statusCode = 404; return res.end("Not found"); }
  for (const h of pageHeaders) res.setHeader(h.key, h.value);
  res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
  res.end(readFileSync(file));
}).listen(port, () => console.log(`TeamPick on http://localhost:${port}  (storage: ${process.env.TP_DEV_MEMORY ? "memory" : "Supabase"}, reading: ${process.env.ANTHROPIC_API_KEY ? "on" : "off"})`));

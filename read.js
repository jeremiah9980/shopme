// Sends a few still frames to Claude and returns the shopping-list rows it reads.
// The API key lives only here, on the server. Nothing is stored by this route.
import { send, readBody, settings, authed } from "../lib/server.js";

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Accepts plain JSON, JSON in a code fence, or JSON with a sentence around it.
export function parseJson(text) {
  const tries = [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1]];
  const a = text.search(/[[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { if (!t) continue; try { return JSON.parse(t); } catch {} }
  return undefined;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.setHeader("allow", "POST"); return send(res, 405, { error: "method" }); }
    if (!authed(req)) return send(res, 401, { error: "passcode" });
    if (!settings().reading) return send(res, 503, { error: "reading is not set up" });

    const body = await readBody(req);
    const images = Array.isArray(body.images) ? body.images : [];
    if (typeof body.prompt !== "string" || !body.prompt || body.prompt.length > 20000) return send(res, 400, { error: "bad prompt" });
    if (!images.length || images.length > 5) return send(res, 400, { error: "send 1 to 5 images" });
    for (const im of images) {
      if (!im || !TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return send(res, 400, { error: "bad image" });
    }
    // Model IDs change over time. Set these in the host's environment to whatever your key can use.
    const model = body.tier === "quick" ? process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-5-5" : process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    const r = await fetch(base + "/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(110_000),
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [{ role: "user", content: [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text: body.prompt }] }],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("anthropic", r.status, detail);
      if (r.status === 429) return send(res, 429, { error: "rate limited" });
      if (r.status === 404) return send(res, 502, { error: `model "${model}" is not available to this API key; set ANTHROPIC_MODEL` });
      if (r.status === 401 || r.status === 403) return send(res, 502, { error: "the Anthropic API key was rejected" });
      return send(res, 502, { error: "reading service error " + r.status });
    }
    const out = await r.json();
    if (out.stop_reason === "refusal") return send(res, 422, { error: "refused" });
    const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const result = parseJson(text);
    if (result === undefined || out.stop_reason === "max_tokens") return send(res, 422, { error: "invalid_json" });
    return send(res, 200, { result, model });
  } catch (e) {
    if (e.name === "TimeoutError") return send(res, 504, { error: "timed out" });
    if (!e.status) console.error(e);
    return send(res, e.status || 500, { error: e.status ? e.message : "server error" });
  }
}

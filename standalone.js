/* Standalone adapter.
   Inside Claude the page is handed a `window.claude` with shared storage and image reading.
   On your own host there is no such thing, so this file provides the same small surface
   backed by this repo's /api routes. If neither exists (a bare static host, or the file opened
   from disk) it steps aside and the app keeps everything on the one phone. */
(() => {
  "use strict";
  if (window.claude && window.claude.use) return;
  const LS = "tp.code";
  const lsGet = () => { try { return localStorage.getItem(LS) || ""; } catch { return ""; } };
  const lsSet = (v) => { try { localStorage.setItem(LS, v); } catch {} };
  let code = lsGet();
  const headers = () => ({ "content-type": "application/json", "x-team-code": code });
  const domReady = new Promise((r) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r, { once: true }) : r()));

  function askCode(problem) {
    return domReady.then(() => new Promise((resolve) => {
      const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
      const scrim = mk("div", "scrim"), sheet = mk("div", "sheet"), input = mk("input", "in"), go = mk("button", "btn primary wide", "Open TeamPick");
      sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Team passcode");
      input.type = "password"; input.autocomplete = "current-password"; input.setAttribute("aria-label", "Team passcode"); input.placeholder = "Team passcode";
      go.type = "button"; go.style.marginTop = "12px";
      const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } scrim.remove(); resolve(v); };
      go.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      sheet.append(mk("h2", "", "Team passcode"), mk("p", "muted", problem || "Enter the passcode you two share to open your trips."), mk("div", "", ""), input, go);
      sheet.children[2].style.height = "12px";
      scrim.append(sheet); document.body.append(scrim); input.focus();
    }));
  }

  const boot = (async () => {
    let info = null;
    try { const r = await fetch("/api/data?health=1", { cache: "no-store" }); if (r.ok) info = await r.json(); } catch {}
    if (!info || !info.passcode || (!info.storage && !info.reading)) return null;
    window.TP_STANDALONE = true;
    let problem = "";
    for (;;) {
      if (code) {
        const r = await fetch("/api/data?ping=1", { headers: headers(), cache: "no-store" }).catch(() => null);
        if (r && r.ok) break;
        if (!r || r.status !== 401) return null; // server trouble: fall back to this phone only
        problem = "That passcode didn’t work. Try again.";
      }
      code = await askCode(problem);
      lsSet(code);
    }
    return info;
  })();

  /* ---------- shared storage: polls for changes, writes go straight through ---------- */
  const cache = new Map(); // path -> { v, data }
  const subs = new Set();
  let loaded = false, polling = false, writeSeq = 0, started = false;
  const META = { fromCache: false, hasPendingWrites: false };
  const notify = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  async function api(method, qs, body) {
    let r;
    try { r = await fetch("/api/data" + qs, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, cache: "no-store" }); }
    catch { throw { code: "unavailable", message: "network" }; }
    if (!r.ok) throw { code: r.status === 401 ? "not_granted" : [400, 404, 413].includes(r.status) ? "invalid_argument" : "unavailable", message: "HTTP " + r.status };
    return r.json();
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const seq = writeSeq;
      const { docs } = await api("GET", "");
      const want = docs.filter((d) => !cache.has(d.path) || cache.get(d.path).v !== d.v).map((d) => d.path);
      const got = want.length ? (await api("GET", "?paths=" + encodeURIComponent(want.join(",")))).docs : [];
      if (seq !== writeSeq) return; // we wrote while this was in flight: these answers may be older than ours
      let changed = !loaded;
      const seen = new Set(docs.map((d) => d.path));
      for (const p of [...cache.keys()]) if (!seen.has(p)) { cache.delete(p); changed = true; }
      for (const d of got) { cache.set(d.path, { v: d.v, data: d.data }); changed = true; }
      loaded = true;
      if (changed) notify();
    } catch {} finally { polling = false; }
  }
  function start() {
    if (started) return;
    started = true;
    poll();
    setInterval(() => { if (document.visibilityState === "visible") poll(); }, 4000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
  }
  async function write(body) {
    writeSeq++;
    try {
      const d = await api("POST", "", body);
      if (body.op === "delete") cache.delete(body.path); else cache.set(d.path, { v: d.v, data: d.data });
    } finally { writeSeq++; }
    setTimeout(notify, 0);
  }
  const db = {
    doc(path) {
      const id = path.split("/").pop();
      return {
        id, path,
        set: (data) => write({ op: "set", path, data }),
        update: (patch) => write({ op: "update", path, patch }),
        delete: () => write({ op: "delete", path }),
        onSnapshot(next) {
          const f = () => { if (!loaded) return; const c = cache.get(path); next({ id, exists: !!c, data: () => (c ? c.data : undefined), metadata: META }); };
          subs.add(f); start(); if (loaded) setTimeout(f, 0);
          return () => subs.delete(f);
        },
      };
    },
    collection(name) {
      const q = {
        orderBy: () => q, limit: () => q,
        onSnapshot(next) {
          const f = () => {
            if (!loaded) return;
            const docs = [...cache].filter(([p]) => p.startsWith(name + "/")).map(([p, c]) => ({ id: p.slice(name.length + 1), exists: true, data: () => c.data, metadata: META }));
            next({ docs, size: docs.length, empty: !docs.length, metadata: META });
          };
          subs.add(f); start(); if (loaded) setTimeout(f, 0);
          return () => subs.delete(f);
        },
      };
      return q;
    },
  };

  /* ---------- reading: frames go to /api/read, which holds the API key ---------- */
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej({ code: "image_rejected" }); r.readAsDataURL(blob); });
  async function prep(blob) {
    if (blob.type === "image/jpeg" && blob.size < 450_000) return { media_type: "image/jpeg", data: await b64(blob) };
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { throw { code: "image_rejected", message: "could not open image" }; }
    const s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const jpg = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    if (!jpg) throw { code: "image_rejected", message: "could not convert image" };
    return { media_type: "image/jpeg", data: await b64(jpg) };
  }
  const sample = async () => { throw { code: "capability_removed", message: "only sample.json is available here" }; };
  sample.limits = async () => ({ maxPromptBytes: 20000, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });
  sample.json = async (prompt, opts = {}) => {
    const list = opts.images ? (opts.images instanceof Blob ? [opts.images] : [...opts.images]) : [];
    const images = [];
    for (const b of list) images.push(await prep(b));
    let r;
    try { r = await fetch("/api/read", { method: "POST", headers: headers(), signal: opts.signal, body: JSON.stringify({ prompt, images, tier: opts.modelTier === "quick" ? "quick" : "default" }) }); }
    catch (e) { throw { code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: "network" }; }
    if (r.ok) return (await r.json()).result;
    let msg = "HTTP " + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    console.warn("TeamPick reading:", msg);
    const code = r.status === 401 ? "not_granted" : r.status === 429 ? "rate_limited" : r.status === 413 || r.status === 400 ? "image_rejected" : r.status === 422 ? (msg === "refused" ? "refused" : "invalid_json") : "upstream_error";
    throw { code, message: msg };
  };

  window.claude = {
    use: async (name) => {
      const info = await boot;
      if (!info) return null;
      if (name === "db") return info.storage ? db : null;
      if (name === "sample") return info.reading ? sample : null;
      if (name === "user") return { can: async () => true };
      return null;
    },
  };
})();

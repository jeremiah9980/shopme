"use strict";
/* TeamPick logic: no DOM, no network. Everything here is unit-tested in node. */
const TP = (() => {
  const RUNNERS = { jere: "Jere", jesica: "Jesica" };
  const other = (r) => (r === "jere" ? "jesica" : "jere");

  // id, name, icon, zone, seconds per product, fixed seconds (walk + counter wait), pick order.
  // Times are rough planning estimates, not measurements. Pick order runs shelf-stable first, cold last.
  const DEPTS = [
    ["pharmacy", "Pharmacy and OTC", "💊", "nonfood", 35, 60, 1],
    ["hb", "Health and beauty", "🧴", "nonfood", 35, 60, 2],
    ["baby", "Baby", "🍼", "nonfood", 30, 60, 3],
    ["household", "Household", "🧻", "nonfood", 25, 60, 4],
    ["cleaning", "Cleaning", "🧽", "nonfood", 25, 60, 5],
    ["pet", "Pet", "🐾", "nonfood", 30, 60, 6],
    ["pantry", "Pantry", "🍝", "center", 30, 60, 7],
    ["canned", "Canned goods", "🥫", "center", 25, 45, 8],
    ["snacks", "Snacks", "🥨", "center", 25, 45, 9],
    ["beverages", "Beverages", "🥤", "center", 25, 60, 10],
    ["other", "Other", "📦", "other", 40, 60, 11],
    ["floral", "Floral", "💐", "fresh", 40, 45, 12],
    ["produce", "Produce", "🥬", "fresh", 45, 60, 13],
    ["bakery", "Bakery", "🍞", "fresh", 30, 45, 14],
    ["deli", "Deli", "🧀", "counter", 50, 240, 15],
    ["prepared", "Prepared foods", "🍗", "counter", 30, 45, 16],
    ["meat", "Meat", "🥩", "counter", 40, 60, 17],
    ["seafood", "Seafood", "🐟", "counter", 45, 210, 18],
    ["dairy", "Dairy", "🥛", "cold", 25, 60, 19],
    ["frozen", "Frozen", "🧊", "cold", 25, 60, 20],
  ].map(([id, name, icon, zone, per, fixed, order]) => ({ id, name, icon, zone, per, fixed, order }));
  const DEPT = Object.fromEntries(DEPTS.map((d) => [d.id, d]));
  const ZONE_NAMES = { nonfood: "non-food aisles", center: "center aisles", fresh: "fresh departments", counter: "service counters", cold: "cold cases", other: "other" };

  const KEYWORDS = [
    ["produce", /\b(banana|avocado|tomato|onion|lettuce|spinach|pepper|cilantro|lemon|lime|apple|berr(y|ies)|grape|potato|carrot|celery|garlic|cucumber|squash|kale|orange|melon|mushroom)s?\b/],
    ["meat", /\b(chicken breast|ground beef|steak|pork|bacon|sausage|ribs|brisket|ground turkey|chicken thigh)s?\b/],
    ["seafood", /\b(salmon|shrimp|tilapia|cod|crab|tuna steak|catfish|scallop)s?\b/],
    ["deli", /\b(sliced|deli|provolone|salami|prosciutto|hummus)\b/],
    ["bakery", /\b(bread|tortilla|bun|bagel|muffin|loaf|croissant|donut|cake|roll)s?\b/],
    ["dairy", /\b(milk|egg|butter|cheese|yogurt|cream|creamer)s?\b/],
    ["frozen", /\b(frozen|ice cream|pizza|waffle|popsicle)s?\b/],
    ["beverages", /\b(water|juice|soda|cola|coffee|tea|sparkling|beer|wine|gatorade)\b/],
    ["snacks", /\b(chip|cracker|cookie|pretzel|popcorn|candy|granola bar)s?\b/],
    ["canned", /\b(canned|beans|broth|soup|diced tomatoes|tuna)\b/],
    ["cleaning", /\b(detergent|bleach|dish soap|cleaner|sponge|disinfect\w*)\b/],
    ["household", /\b(paper towel|toilet paper|trash bag|foil|napkin|ziploc|batter(y|ies))s?\b/],
    ["hb", /\b(shampoo|conditioner|toothpaste|deodorant|lotion|razor|body wash|soap)\b/],
    ["pharmacy", /\b(ibuprofen|tylenol|acetaminophen|allergy|vitamin|bandage|cough)s?\b/],
    ["baby", /\b(diaper|wipes|formula|baby)s?\b/],
    ["pet", /\b(dog|cat|pet|litter)\b/],
    ["pantry", /\b(rice|pasta|spaghetti|sauce|flour|sugar|oil|cereal|peanut butter|salsa|spice|honey|oats)\b/],
  ];

  /* ---------- text matching ---------- */
  const normName = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/h[\s\-‑.]?e[\s\-‑.]?b\b/g, "heb")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9%/.]+/g, " ")
      .replace(/(^|\s)[./]+|[./]+(\s|$)/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  const normSize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/fluid ounces?|fl\.? ?oz\.?/g, "floz")
      .replace(/ounces?|oz\./g, "oz")
      .replace(/pounds?|lbs?\.?/g, "lb")
      .replace(/gallons?|gal\./g, "gal")
      .replace(/quarts?|qt\./g, "qt")
      .replace(/counts?|ct\./g, "ct")
      .replace(/packs?|pk\./g, "pk")
      .replace(/approx(imately)?\.?|about|avg\.?/g, "")
      .replace(/[^a-z0-9/.]+/g, "");
  const productKey = (name, size) => normName(name) + "|" + normSize(size);

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m + n;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const nearTok = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && lev(a, b) <= (Math.max(a.length, b.length) > 6 ? 2 : 1));

  /* Same row seen twice (OCR wobble), never two different flavours. */
  function sameProduct(a, b) {
    const sa = normSize(a.size), sb = normSize(b.size);
    if (sa && sb && sa !== sb) return false;
    const na = normName(a.name), nb = normName(b.name);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ta = na.split(" "), tb = nb.split(" ");
    if (a.cut || b.cut) {
      // A row cut off at the frame edge: its words must be a leading run of the full row's words.
      const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
      if (short.length < 2) return false;
      return short.every((t, i) => long[i] === t || (i === short.length - 1 && long[i] && long[i].startsWith(t)));
    }
    if (ta.length !== tb.length) return false;
    let diffs = 0;
    for (let i = 0; i < ta.length; i++) {
      if (ta[i] === tb[i]) continue;
      if (!nearTok(ta[i], tb[i]) || /\d/.test(ta[i] + tb[i])) return false;
      diffs++;
    }
    return diffs <= Math.max(1, Math.floor(ta.length / 4));
  }

  /* ---------- cleaning what the model returned ---------- */
  const str = (v, max = 160) => (v == null ? "" : String(v).trim().slice(0, max));
  function guessDept(name) {
    const n = normName(name);
    for (const [id, re] of KEYWORDS) if (re.test(n)) return id;
    return "other";
  }
  function cleanItem(raw, frameBase = 0) {
    if (!raw || typeof raw !== "object") return null;
    const name = str(raw.name);
    if (!name) return null;
    const flags = [];
    let qty = Number(raw.qty);
    const qtyShown = raw.qtyShown !== false;
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999) { qty = 1; flags.push("qty"); }
    else if (!qtyShown) flags.push("qty");
    qty = Math.round(qty * 100) / 100;
    let dept = str(raw.dept, 20).toLowerCase();
    if (!DEPT[dept]) { dept = guessDept(name); flags.push("dept"); }
    else if (dept === "other") flags.push("dept");
    let conf = Number(raw.conf);
    if (!Number.isFinite(conf)) conf = 0.5;
    conf = Math.max(0, Math.min(1, conf));
    if (conf < 0.7) flags.push("conf");
    const cut = raw.cut === true;
    if (cut) flags.push("cut");
    const price = Number(raw.price);
    return {
      name, brand: str(raw.brand, 60), qty, qtyShown, size: str(raw.size, 40), customer: str(raw.customer, 60),
      dept, aisle: str(raw.aisle, 40), note: str(raw.note, 240), sub: str(raw.sub, 160),
      price: Number.isFinite(price) && price > 0 ? price : null, conf, cut,
      done: raw.done === true, frame: frameBase + (Number.isFinite(Number(raw.frame)) ? Math.max(0, Number(raw.frame) - 1) : 0), flags,
    };
  }

  const custEq = (a, b) => normName(a) === normName(b);

  /* Collapse repeat sightings of one row across overlapping frames of ONE recording.
     Quantities are never added together here: a second sighting is the same row, not more units. */
  function dedupe(items) {
    const out = [];
    const sorted = [...items].sort((a, b) => a.frame - b.frame);
    for (const it of sorted) {
      const hit = out.find((r) => (!r.customer || !it.customer || custEq(r.customer, it.customer)) && sameProduct(r, it));
      if (!hit) { out.push({ ...it, flags: [...it.flags], seen: 1 }); continue; }
      const flags = new Set([...hit.flags, ...it.flags]);
      const bothShown = hit.qtyShown && it.qtyShown;
      if (hit.qty !== it.qty) {
        if (bothShown) { hit.qtyClash = true; if (it.conf > hit.conf) hit.qty = it.qty; }
        else if (it.qtyShown) hit.qty = it.qty;
      }
      hit.qtyShown = hit.qtyShown || it.qtyShown;
      if (hit.qtyClash || !hit.qtyShown) flags.add("qty"); else flags.delete("qty");
      if (hit.cut && !it.cut) { hit.name = it.name; hit.cut = false; }
      else if (!hit.cut && !it.cut && it.conf > hit.conf) hit.name = it.name;
      if (!hit.cut) flags.delete("cut");
      for (const k of ["brand", "size", "customer", "aisle", "note", "sub"]) if (!hit[k] && it[k]) hit[k] = it[k];
      if (hit.price == null) hit.price = it.price;
      if (hit.dept === "other" && it.dept !== "other") { hit.dept = it.dept; flags.delete("dept"); }
      hit.conf = Math.max(hit.conf, it.conf);
      if (hit.conf >= 0.7) flags.delete("conf");
      hit.done = hit.done || it.done;
      hit.seen++;
      hit.flags = [...flags];
    }
    return out;
  }

  /* Rows with no visible customer: use the runner's label for the recording if given,
     otherwise carry the last header forward and flag it. Never invent a name. */
  function fillCustomers(items, label) {
    let last = "";
    return items.map((it) => {
      const o = { ...it, flags: [...it.flags] };
      if (o.customer) { last = o.customer; return o; }
      if (label) { o.customer = label; return o; }
      o.customer = last;
      if (!o.flags.includes("cust")) o.flags.push("cust");
      return o;
    });
  }

  /* ---------- workload ---------- */
  // lines: [{dept, key, qty, open}]  ->  { dept: {secs, products, units} }
  function effort(lines, onlyOpen) {
    const by = {};
    for (const l of lines) {
      if (onlyOpen && !l.open) continue;
      const d = (by[l.dept] ||= { keys: new Set(), units: 0 });
      d.keys.add(l.key);
      d.units += l.qty;
    }
    const res = {};
    for (const [id, d] of Object.entries(by)) {
      const def = DEPT[id] || DEPT.other;
      const products = d.keys.size;
      const extra = Math.max(0, Math.min(20, Math.round(d.units) - products));
      res[id] = { secs: def.fixed + def.per * products + 4 * extra, products, units: d.units };
    }
    return res;
  }

  /* Choose an owner per department to finish soonest: minimise the slower shopper's time,
     with a penalty for splitting neighbouring departments and for moving work already assigned. */
  function balance(eff, opts = {}) {
    const { pins = {}, current = {}, stick = 0 } = opts;
    const ids = Object.keys(eff).sort((a, b) => (DEPT[a] || DEPT.other).order - (DEPT[b] || DEPT.other).order);
    const free = ids.filter((d) => !pins[d]);
    const base = { jere: 0, jesica: 0 };
    for (const d of ids) if (pins[d]) base[pins[d]] += eff[d].secs;
    const zones = {};
    ids.forEach((d) => (zones[(DEPT[d] || DEPT.other).zone] ||= []).push(d));
    const zoneList = Object.values(zones).filter((z) => z.length > 1);
    const SPLIT = 45;
    let best = null, bestCost = Infinity;
    const n = Math.min(free.length, 20);
    const owner = { ...pins };
    for (let mask = 0; mask < 1 << n; mask++) {
      let a = base.jere, b = base.jesica, moved = 0;
      for (let i = 0; i < n; i++) {
        const r = mask & (1 << i) ? "jesica" : "jere";
        owner[free[i]] = r;
        if (r === "jere") a += eff[free[i]].secs; else b += eff[free[i]].secs;
        if (current[free[i]] && current[free[i]] !== r) moved++;
      }
      let cost = Math.max(a, b) + 0.05 * Math.abs(a - b) + stick * moved + 0.001 * moved;
      for (const z of zoneList) if (z.some((d) => owner[d] !== owner[z[0]])) cost += SPLIT;
      if (cost < bestCost - 1e-9) { bestCost = cost; best = { ...owner }; }
    }
    const owners = best || { ...pins };
    for (const d of free.slice(n)) owners[d] = "jere";
    const totals = { jere: 0, jesica: 0 };
    ids.forEach((d) => (totals[owners[d]] += eff[d].secs));
    const reasons = explain(Object.keys(eff), owners, pins);
    return { owners, totals, reasons };
  }

  // Plain-language reason for each department's owner.
  function explain(ids, owners, pins = {}) {
    const zones = {};
    ids.forEach((d) => (zones[(DEPT[d] || DEPT.other).zone] ||= []).push(d));
    const out = {};
    for (const d of ids) {
      const z = (DEPT[d] || DEPT.other).zone;
      const mates = zones[z].filter((x) => x !== d);
      if (pins[d]) out[d] = "You set this one";
      else if (mates.length && mates.every((x) => owners[x] === owners[d])) out[d] = "Kept with the other " + ZONE_NAMES[z];
      else out[d] = "Evens out the estimated time";
    }
    return out;
  }

  /* ---------- scroll detection for screen recordings ---------- */
  const BANDS = 12;
  // rgba pixel data -> per-row luminance signature over the middle of the screen
  function rowSig(data, w, h) {
    const sig = new Float32Array(h * BANDS);
    const x0 = Math.floor(w * 0.06), x1 = Math.ceil(w * 0.94), bw = (x1 - x0) / BANDS;
    for (let y = 0; y < h; y++) {
      for (let b = 0; b < BANDS; b++) {
        let s = 0, c = 0;
        for (let x = Math.floor(x0 + b * bw); x < Math.floor(x0 + (b + 1) * bw); x++) {
          const i = (y * w + x) * 4;
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          c++;
        }
        sig[y * BANDS + b] = c ? s / c : 0;
      }
    }
    return sig;
  }
  // How far did the content move between two frames? Ignores the top and bottom 14% (status and tab bars).
  function motion(a, b, h) {
    const y0 = Math.floor(h * 0.14), y1 = Math.ceil(h * 0.86), span = y1 - y0, maxS = Math.floor(span * 0.7);
    const score = (s) => {
      let sum = 0, n = 0;
      const from = Math.max(y0, y0 - s), to = Math.min(y1, y1 - s);
      for (let y = from; y < to; y++) {
        const ia = (y + s) * BANDS, ib = y * BANDS;
        for (let k = 0; k < BANDS; k++) { sum += Math.abs(a[ia + k] - b[ib + k]); n++; }
      }
      return n ? sum / n : Infinity;
    };
    const zero = score(0);
    if (zero < 1.5) return { kind: "still", shift: 0, frac: 0 };
    let bestS = 0, best = zero;
    for (let s = -maxS; s <= maxS; s++) { const v = score(s); if (v < best) { best = v; bestS = s; } }
    if (bestS !== 0 && best < 5 && best < zero * 0.3) return { kind: "scroll", shift: bestS, frac: Math.abs(bestS) / span };
    if (zero < 10 || (Math.abs(bestS) <= 3 && best < zero)) return { kind: "scroll", shift: bestS, frac: 0.05 }; // barely moved: not worth a frame yet
    return { kind: "change", shift: 0, frac: 1 };
  }

  /* ---------- misc ---------- */
  function deepMerge(base, patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
    const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
    for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
    return out;
  }
  const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100));
  const mins = (secs) => Math.max(1, Math.round(secs / 60));

  return { RUNNERS, other, DEPTS, DEPT, ZONE_NAMES, normName, normSize, productKey, sameProduct, guessDept, cleanItem, dedupe, fillCustomers, custEq, effort, balance, explain, rowSig, motion, deepMerge, fmtQty, mins, BANDS };
})();


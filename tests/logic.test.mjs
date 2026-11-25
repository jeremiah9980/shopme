// Unit tests for the matching, de-duplication, balancing and scroll-detection logic.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const TP = new Function(readFileSync(new URL('../src/logic.js', import.meta.url), 'utf8') + '\nreturn TP;')();
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const item = (o) => TP.cleanItem({ qty: 1, dept: 'dairy', conf: 0.95, frame: 1, ...o });

t('normalises H-E-B and sizes', () => {
  assert.equal(TP.normName('H-E-B Whole Milk'), TP.normName('HEB whole milk'));
  assert.equal(TP.normSize('1 Gallon'), TP.normSize('1 gal'));
  assert.equal(TP.normSize('16 OZ'), TP.normSize('16 ounces'));
  assert.notEqual(TP.productKey('Whole Milk', '1 gal'), TP.productKey('Whole Milk', '1/2 gal'));
});
t('same row in overlapping frames collapses, quantity not doubled', () => {
  const out = TP.dedupe([item({ name: 'H-E-B Whole Milk', size: '1 gal', qty: 2, customer: 'Sydney', frame: 1 }), item({ name: 'HEB Whole Milk', size: '1 gal', qty: 2, customer: 'Sydney', frame: 2 })]);
  assert.equal(out.length, 1); assert.equal(out[0].qty, 2); assert.equal(out[0].seen, 2);
});
t('same product for different customers stays separate', () => {
  const out = TP.dedupe([item({ name: 'Whole Milk', size: '1 gal', qty: 2, customer: 'Sydney' }), item({ name: 'Whole Milk', size: '1 gal', qty: 1, customer: 'Dana' })]);
  assert.equal(out.length, 2);
});
t('different sizes stay separate', () => {
  assert.equal(TP.dedupe([item({ name: 'Whole Milk', size: '1 gal', customer: 'A' }), item({ name: 'Whole Milk', size: '1/2 gal', customer: 'A' })]).length, 2);
});
t('different flavours stay separate, even with long names', () => {
  assert.equal(TP.dedupe([item({ name: 'Chobani Greek Yogurt Strawberry', size: '5.3 oz', customer: 'A' }), item({ name: 'Chobani Greek Yogurt Blueberry', size: '5.3 oz', customer: 'A' })]).length, 2);
  assert.equal(TP.dedupe([item({ name: 'Brand Organic Low Fat Greek Style Probiotic Yogurt Cup Peach', customer: 'A' }), item({ name: 'Brand Organic Low Fat Greek Style Probiotic Yogurt Cup Mango', customer: 'A' })]).length, 2);
  assert.equal(TP.dedupe([item({ name: 'Milk 2%', customer: 'A' }), item({ name: 'Milk 1%', customer: 'A' })]).length, 2);
});
t('OCR wobble merges', () => {
  assert.equal(TP.dedupe([item({ name: 'Shredded Cheddar Cheese', customer: 'A' }), item({ name: 'Shreded Cheddar Cheese', customer: 'A' })]).length, 1);
});
t('cut-off row merges into the full row and loses the flag', () => {
  const out = TP.dedupe([item({ name: 'Boneless Skinless Chick', cut: true, customer: 'A', frame: 1 }), item({ name: 'Boneless Skinless Chicken Breast', size: '2 lb', customer: 'A', frame: 2 })]);
  assert.equal(out.length, 1); assert.equal(out[0].name, 'Boneless Skinless Chicken Breast'); assert(!out[0].flags.includes('cut'));
});
t('conflicting quantities across sightings get flagged', () => {
  const out = TP.dedupe([item({ name: 'Eggs', qty: 1, customer: 'A' }), item({ name: 'Eggs', qty: 2, customer: 'A', frame: 2 })]);
  assert.equal(out.length, 1); assert(out[0].flags.includes('qty'));
});
t('missing quantity is flagged, never invented silently', () => {
  assert(item({ name: 'Eggs', qtyShown: false }).flags.includes('qty'));
  assert(item({ name: 'Eggs', qty: 'lots' }).flags.includes('qty'));
});
t('customer carried forward and flagged; label wins; unknown stays empty', () => {
  const a = TP.fillCustomers([item({ name: 'x' }), item({ name: 'y', customer: 'Sydney' }), item({ name: 'z' })]);
  assert.equal(a[0].customer, ''); assert(a[0].flags.includes('cust'));
  assert.equal(a[2].customer, 'Sydney'); assert(a[2].flags.includes('cust'));
  const b = TP.fillCustomers([item({ name: 'x' })], 'Marcus');
  assert.equal(b[0].customer, 'Marcus'); assert(!b[0].flags.includes('cust'));
});
t('bad department falls back to keywords and is flagged', () => {
  const i = item({ name: 'Frozen Pepperoni Pizza', dept: 'aisle 9' });
  assert.equal(i.dept, 'frozen'); assert(i.flags.includes('dept'));
});
t('balance keeps whole departments, respects pins, evens time', () => {
  const lines = [];
  const add = (dept, n) => { for (let i = 0; i < n; i++) lines.push({ dept, key: dept + i, qty: 1, open: true }); };
  add('produce', 12); add('meat', 5); add('seafood', 3); add('deli', 4); add('dairy', 8); add('bakery', 4); add('pantry', 16); add('hb', 3); add('frozen', 7); add('beverages', 5); add('household', 3);
  const eff = TP.effort(lines);
  const r = TP.balance(eff);
  const tot = r.totals.jere + r.totals.jesica;
  assert(Math.abs(r.totals.jere - r.totals.jesica) / tot < 0.15, 'within 15%: ' + JSON.stringify(r.totals));
  assert.equal(Object.keys(r.owners).length, 11);
  const p = TP.balance(eff, { pins: { produce: 'jesica', frozen: 'jesica' } });
  assert.equal(p.owners.produce, 'jesica'); assert.equal(p.owners.frozen, 'jesica'); assert.equal(p.reasons.produce, 'You set this one');
});
t('rebalance with stickiness moves little', () => {
  const eff = TP.effort([{ dept: 'pantry', key: 'a', qty: 1, open: true }, { dept: 'dairy', key: 'b', qty: 1, open: true }, { dept: 'dairy', key: 'c', qty: 1, open: false }], true);
  assert.equal(eff.dairy.products, 1);
  const r = TP.balance(eff, { current: { pantry: 'jesica', dairy: 'jere' }, stick: 30 });
  assert.equal(r.owners.pantry, 'jesica'); assert.equal(r.owners.dairy, 'jere');
});
t('single department goes to one runner', () => {
  const r = TP.balance(TP.effort([{ dept: 'dairy', key: 'a', qty: 3, open: true }]));
  assert.equal(Object.keys(r.owners).length, 1);
});
t('deepMerge merges nested maps, replaces arrays', () => {
  const m = TP.deepMerge({ lines: { a: { q: 1, fl: ['x'] }, b: { q: 2 } } }, { lines: { a: { st: 'picked', fl: [] } } });
  assert.deepEqual(m, { lines: { a: { q: 1, fl: [], st: 'picked' }, b: { q: 2 } } });
});
t('scroll detection finds shift, stillness and screen changes', () => {
  const w = 72, h = 160, tall = 1200;
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const page = new Uint8Array(tall * w);
  let len = 0; for (let y = 0; y < tall; y++) { if (y % 24 === 0) len = 14 + Math.floor(rnd() * 50); const rowText = (y % 24) < 14; for (let x = 0; x < w; x++) page[y * w + x] = (x < 12 && rowText) ? 120 : (rowText && (y % 24) % 5 < 3 && x > 14 && x < 14 + len * ((y % 24) < 5 ? 1 : 0.6) && rnd() > 0.4 ? 40 : 245); }
  const frame = (top, other) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = y < 16 || y >= h - 16 ? 200 : page[(top + y) * w + x]; if (other) v = (x * 7 + y * 13) % 255; v = Math.max(0, Math.min(255, v + (rnd() - 0.5) * 2)); const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } return TP.rowSig(d, w, h); };
  const a = frame(100), b = frame(137), c = frame(100), z = frame(0, true);
  const m1 = TP.motion(a, b, h); assert.equal(m1.kind, 'scroll'); assert.equal(Math.abs(m1.shift), 37);
  assert.equal(TP.motion(a, c, h).kind, 'still');
  assert.equal(TP.motion(a, z, h).kind, 'change');
  assert.equal(TP.motion(a, frame(900), h).kind, 'change');
});
console.log(n + ' logic tests passed');

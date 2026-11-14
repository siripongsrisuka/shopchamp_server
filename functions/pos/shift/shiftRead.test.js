// เทส DEV-0010 คลื่น 2 กลุ่ม shift · รัน: node --test pos/shift/shiftRead.test.js
//   ของที่ชุด case ของสัญญาวัดไม่ได้: harness เทียบ body แบบบางส่วน (ช่องเกินไม่ฟ้อง) · ไม่เห็นรูป query
//   ⇒ ที่นี่พิสูจน์: shift.get คืน doc เต็มทุกช่อง (ไม่ตัด) · อ่าน 2 doc · shift.history ค้น shopId == ช่องร้าน + lastShiftDate in · ไม่ orderBy/limit
// ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const CENTER = path.resolve(FUNCTIONS, "..", "..", "shopchamp-center");
const NEW_SCHEMAS = ["ShiftGetRequest", "ShiftHistoryRequest"];

// คำขอใหม่ยังไม่อยู่ใน vendor tarball (แม่ bump รวม) ⇒ build จาก src ของ center แล้วเติมเฉพาะตัวที่ขาด
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  if (NEW_SCHEMAS.every((k) => pkg[k])) return;
  const src = path.join(CENTER, "packages", "schema", "src", "requests", "shiftRead.ts");
  if (!fs.existsSync(src)) throw new Error(`ไม่พบ ${src}`);
  const esbuild = require(require.resolve("esbuild", { paths: [CENTER] }));
  const out = esbuild.buildSync({
    entryPoints: [src], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error",
    nodePaths: [path.join(CENTER, "packages", "schema", "node_modules"), path.join(CENTER, "node_modules")],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  for (const k of NEW_SCHEMAS) if (!pkg[k]) pkg[k] = m.exports[k];
}

// ── ฐานปลอม (อ่านอย่างเดียว · นับการอ่าน) ──
let DATA = {};
let QUERIES = [];
let DOC_GETS = [];
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const coll = (c) => (DATA[c] = DATA[c] || {});
const snapOf = (c, id) => {
  const d = coll(c)[id];
  return { exists: d !== undefined, id, data: () => clone(d) };
};
const match = (doc, [f, op, v]) => (op === "==" ? doc[f] === v : op === "in" ? v.includes(doc[f]) : false);
function query(c, st) {
  return {
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f, dir) => query(c, { ...st, order: [f, dir || "asc"] }),
    limit: (n) => query(c, { ...st, limit: n }),
    get: async () => {
      QUERIES.push({ c, ...st });
      const ids = Object.keys(coll(c)).filter((id) => st.filters.every((flt) => match(coll(c)[id], flt)));
      const docs = ids.map((id) => snapOf(c, id));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}
const fakeDb = {
  collection: (c) => ({
    doc: (id) => ({ c, id, get: async () => { DOC_GETS.push(`${c}/${id}`); return snapOf(c, id); } }),
    where: (f, op, v) => query(c, { filters: [[f, op, v]] }),
  }),
};
const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {} } };
installSchemas();

const { get } = require("./get");
const { history } = require("./history");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const call = async (h, body, req) => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ body, ...(req || {}) }, res);
  return res;
};
const PREM = [{ type: "premium", expire: new Date("2027-01-31T17:00:00.000Z") }];
const HR = [
  { id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active" },
  { id: "u-cash", name: "แคชเชียร์", position: [], status: "active", rights: ["100", "108", "115", "117"] },
  { id: "u-shift", name: "คุมกะ", position: [], status: "active", rights: ["102"] },
];
const SHOP_A = { shopId: "shopA", name: "ร้าน A", vip: PREM, humanResource: HR, POSs: [{ id: "p1", shiftId: "sh-1" }] };
const SHOP_S5 = { shopId: "uid-s5", name: "ร้านเก่า", vip: PREM, humanResource: [{ id: "u-s5", position: ["001"], status: "active" }] };
const SHIFT_1 = {
  shopId: "shopA", posId: "p1", status: false, lastShiftDate: "20261109", shiftCount: 3, openName: "เจ้าของ", openId: "u-owner",
  openTime: new Date("2026-11-09T01:00:00.000Z"), openCash: "500", duringShift: [], closeCash: "", someFieldUnknown: { x: 1 },
};
const acc = (shopId, uid, role, rights) => ({ shopAccess: { shopId, uid, role, rights } });

test("shift.get: แคชเชียร์ทั่วไป (ไม่มี 102) อ่านกะได้ · doc เต็มทุกช่อง (รวมช่องที่ไม่รู้จัก) · เวลาเป็น ISO · อ่าน 2 doc", async () => {
  DATA = { shop: { shopA: SHOP_A }, shift: { "sh-1": SHIFT_1 } };
  DOC_GETS = []; QUERIES = [];
  const r = await call(get({}), { shopId: "shopA", shiftId: "sh-1" }, acc("shopA", "u-cash", "staff", ["100", "108", "115", "117"]));
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.shift, { ...SHIFT_1, openTime: "2026-11-09T01:00:00.000Z", id: "sh-1" });
  assert.deepEqual(DOC_GETS.sort(), ["shift/sh-1", "shop/shopA"]);
  assert.equal(QUERIES.length, 0);
});

test("shift.get: doc เก็บ id ผิด ⇒ id ในคำตอบ = doc id เสมอ", async () => {
  DATA = { shop: { shopA: SHOP_A }, shift: { "sh-1": { ...SHIFT_1, id: "stale" } } };
  const r = await call(get({}), { shopId: "shopA", shiftId: "sh-1" }, acc("shopA", "u-owner", "owner", []));
  assert.equal(r.body.shift.id, "sh-1");
});

test("shift.get: กะของร้านอื่น 409 · ไม่มี 404 · ไม่คืน doc", async () => {
  DATA = { shop: { shopA: SHOP_A }, shift: { "sh-b": { ...SHIFT_1, shopId: "shopB" }, "sh-x": { ...SHIFT_1, shopId: "" } } };
  for (const [id, code, err] of [["sh-b", 409, "shift_other_shop"], ["sh-x", 409, "shift_other_shop"], ["nope", 404, "shift_not_found"]]) {
    const r = await call(get({}), { shopId: "shopA", shiftId: id }, acc("shopA", "u-owner", "owner", []));
    assert.equal(r.code, code, id);
    assert.equal(r.body.error, err);
    assert.equal("shift" in r.body, false);
  }
});

test("shift.get: ร้าน S5 กะถือ field หรือ doc id ได้ทั้งคู่ · ไม่อ่านเพิ่ม (Pack ข้อ 8)", async () => {
  DATA = { shop: { s5doc: SHOP_S5 }, shift: { f: { ...SHIFT_1, shopId: "uid-s5" }, d: { ...SHIFT_1, shopId: "s5doc" } } };
  for (const id of ["f", "d"]) {
    DOC_GETS = []; QUERIES = [];
    const r = await call(get({}), { shopId: "s5doc", shiftId: id }, acc("s5doc", "u-s5", "owner", []));
    assert.equal(r.code, 200, id);
    assert.equal(DOC_GETS.length, 2);
    assert.equal(QUERIES.length, 0);
  }
});

const HIST = {
  h1: { shopId: "shopA", lastShiftDate: "20261109", shiftCount: 1, openTime: new Date("2026-11-09T01:00:00.000Z"), closeTime: new Date("2026-11-09T10:00:00.000Z"), thisTotalNet: 100, thisProduct: [{ id: "x", thisQty: 1 }] },
  h2: { shopId: "shopA", lastShiftDate: "20261101", shiftCount: 1, openTime: { _seconds: 1761958800, _nanoseconds: 0 }, closeTime: new Date("2026-11-01T10:00:00.000Z") },
  hb: { shopId: "shopB", lastShiftDate: "20261109", shiftCount: 1 },
  hd: { shopId: "shopA", lastShiftDate: "20261108", shiftCount: 2 },
};

test("shift.history: ค้น shopId == ช่องร้าน + lastShiftDate in (ไม่ orderBy/limit แบบแอปเดิม) · doc เต็ม · เวลา map รุ่นแรกคงเดิม", async () => {
  DATA = { shop: { shopA: SHOP_A }, shiftHistory: HIST };
  QUERIES = [];
  const r = await call(history({ now: () => NOW }), { shopId: "shopA", dates: ["20261109", "20261108", "20261101", "20261109"] }, acc("shopA", "u-shift", "staff", ["102"]));
  assert.equal(r.code, 200);
  const byId = Object.fromEntries(r.body.history.map((h) => [h.id, h]));
  assert.deepEqual(Object.keys(byId).sort(), ["h1", "h2", "hd"]);
  assert.deepEqual(byId.h1, { ...HIST.h1, openTime: "2026-11-09T01:00:00.000Z", closeTime: "2026-11-09T10:00:00.000Z", id: "h1" });
  assert.deepEqual(byId.h2.openTime, { _seconds: 1761958800, _nanoseconds: 0 });
  assert.equal(QUERIES.length, 1);
  const q = QUERIES[0];
  assert.deepEqual(q.filters, [["shopId", "==", "shopA"], ["lastShiftDate", "in", ["20261109", "20261108", "20261101"]]]);
  assert.equal(q.order, undefined);
  assert.equal(q.limit, undefined);
});

test("shift.history: ร้าน S5 ค้นด้วยช่อง shopId ของร้าน (ใบที่ถือ doc id ไม่โผล่ แบบแอปเดิม)", async () => {
  DATA = { shop: { s5doc: SHOP_S5 }, shiftHistory: { f: { shopId: "uid-s5", lastShiftDate: "20261109" }, d: { shopId: "s5doc", lastShiftDate: "20261109" } } };
  const r = await call(history({ now: () => NOW }), { shopId: "s5doc", dates: ["20261109"] }, acc("s5doc", "u-s5", "owner", []));
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.history.map((h) => h.id), ["f"]);
});

test("shift.history: แคชเชียร์ไม่มี 102 → 403 right_required ก่อนอ่านฐาน · พรีเมียมหมด → 403 premium_required", async () => {
  DATA = { shop: { shopA: SHOP_A, shopN: { ...SHOP_A, shopId: "shopN", vip: [{ type: "premium", expire: new Date("2026-01-01T00:00:00.000Z") }] } }, shiftHistory: HIST };
  DOC_GETS = [];
  const r1 = await call(history({ now: () => NOW }), { shopId: "shopA", dates: ["20261109"] }, acc("shopA", "u-cash", "staff", ["100"]));
  assert.equal(r1.code, 403);
  assert.equal(r1.body.error, "right_required");
  assert.equal(DOC_GETS.length, 0);
  const r2 = await call(history({ now: () => NOW }), { shopId: "shopN", dates: ["20261109"] }, acc("shopN", "u-owner", "owner", []));
  assert.equal(r2.code, 403);
  assert.equal(r2.body.error, "premium_required");
});

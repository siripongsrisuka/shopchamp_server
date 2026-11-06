// เทส sale/discardPending.js (handler) · รัน: node --test functions/pos/sale/discardPending.test.js
//   harness ของสัญญาวัดได้แค่คำตอบ (tx.set = no-op) ⇒ ของที่เขียนลง pendingDiscard พิสูจน์ที่นี่
//   ครอบช่องที่ case ไม่ครอบ (chunk4-verify/sale.discardPending.md): doc ที่เขียน · ไม่เขียนทับ · รอยทีมงาน ·
//   guard รูปแอปเก่า · ลำดับ already_synced กับ duplicate · ร้านไม่มีในฐาน · key `__proto__` ใน body
//   ฐานปลอม: บันทึกทุกการเขียน · ปัดการอ่านหลังเขียนใน transaction เดียว · ❌ ไม่แตะ Firestore จริง (แทน functions/firebase ใน require.cache)
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const U = "6f1c2d3e-0000-4000-8000-0000000000dd";
const RID = `shopA${U}`; // รูป receiptUUID ของแอป: `${shop.shopId}${uuid}`

let DATA = {};
let LOG = [];
function makeDb() {
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  // อ่านนอก transaction (auth.resolveShopRef พิสูจน์ field ของร้าน S5): doc.get · where(==).limit().get
  const ref = (c, id) => ({ c, id, get: async () => snapOf(c, id) });
  const where = (c, f, v) => ({
    limit: (n) => ({ isQuery: true, get: async () => ({ docs: Object.keys(DATA[c] || {}).filter((id) => DATA[c][id][f] === v).slice(0, n).map((id) => snapOf(c, id)) }) }),
  });
  return {
    collection: (c) => ({ doc: (id) => ref(c, id), where: (f, op, v) => where(c, f, v) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (r && r.isQuery) { if (writes.length) throw new Error("query หลังเขียน (Firestore ปัด)"); return r.get(); }
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id} หลังเขียน (Firestore ปัด)`);
          const d = (DATA[r.c] || {})[r.id];
          return { exists: d !== undefined, id: r.id, data: () => d };
        },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); },
      };
      const out = await fn(tx);
      for (const w of writes) {
        DATA[w.c] = DATA[w.c] || {};
        DATA[w.c][w.id] = w.v;
      }
      LOG.push(...writes);
      return out;
    },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
const { discardPending } = require("./discardPending");

const handler = discardPending({ now: () => NOW });
async function call(body, shopAccess) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const OWNER = { shopId: "docA", uid: "u-owner", role: "owner", rights: [] };
const ADMIN = { shopId: "docA", uid: "u-company", role: "owner", rights: [], byAdmin: true };
const req = (x) => ({ shopId: "docA", receiptUUID: RID, offlineRef: "T1", body: { cart: [{ id: 1, qty: 1.2345 }], money: 0.1 }, reason: "ใบเสีย ลบทิ้ง", deviceAt: "2026-11-09T10:00:00+07:00", ...x });

beforeEach(() => {
  DATA = { shop: { docA: { shopId: "shopA" }, docB: { shopId: "shopB" } } };
  LOG = [];
});

test("ไม่มีร่องรอย → เขียน pendingDiscard/{uuid} ครั้งเดียว field ครบตามหัวสัญญา", async () => {
  const r = await call(req(), OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, discardId: RID, duplicate: false });
  assert.equal(LOG.length, 1);
  assert.equal(LOG[0].c, "pendingDiscard");
  assert.equal(LOG[0].id, RID);
  assert.deepEqual(LOG[0].v, {
    shopId: "docA", receiptUUID: RID, offlineRef: "T1",
    body: { cart: [{ id: 1, qty: 1.2345 }], money: 0.1 },
    reason: "ใบเสีย ลบทิ้ง", by: "u-owner", at: NOW, deviceAt: "2026-11-09T10:00:00+07:00",
  });
});

test("shopId ใน doc = ร้านที่ผ่านด่าน ไม่ใช่ body.shopId ของบิลค้าง", async () => {
  const r = await call(req({ body: { shopId: "docB", x: 1 } }), OWNER);
  assert.equal(r.code, 200);
  assert.equal(LOG[0].v.shopId, "docA");
});

test("ส่งซ้ำ → duplicate:true · ไม่เขียนทับ (เหตุผลตัวแรกยังอยู่)", async () => {
  await call(req(), OWNER);
  LOG = [];
  const r = await call(req({ reason: "เหตุผลรอบสอง" }), OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(LOG.length, 0);
  assert.equal(DATA.pendingDiscard[RID].reason, "ใบเสีย ลบทิ้ง");
});

test("ทีมงาน → doc มี byAdmin adminUid · by = uid ทีมงาน · คำตอบมี byAdmin", async () => {
  const r = await call(req(), ADMIN);
  assert.equal(r.code, 200);
  assert.equal(r.body.byAdmin, true);
  assert.equal(LOG.length, 1);
  assert.equal(LOG[0].v.byAdmin, true);
  assert.equal(LOG[0].v.adminUid, "u-company");
  assert.equal(LOG[0].v.by, "u-company");
});

test("guard รูปแอปเก่าของร้านนี้ + มีบิล → 409 already_synced พร้อมเลขจากบิล · ไม่เขียน", async () => {
  DATA.receiptGuard = { [RID]: { createdAt: 1, usedBy: "billX" } };
  DATA.bill = { billX: { shopId: "docA", receiptNumber: "202611000010" } };
  const r = await call(req(), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_synced");
  assert.equal(r.body.billId, "billX");
  assert.equal(r.body.receiptNumber, "202611000010");
  assert.equal(LOG.length, 0);
});

test("ร้านที่ doc ไม่มี field shopId: guard แอปเก่า `undefined<uuid>` ของตัวเอง → 409 already_synced (ไม่ใช่ร้านอื่น)", async () => {
  DATA.shop.docN = { name: "ร้านไม่มี field" };
  const gid = `undefined${U}`;
  DATA.receiptGuard = { [gid]: { createdAt: 1, usedBy: "billN" } };
  DATA.bill = { billN: { receiptNumber: "202611000011" } };
  const r = await call(req({ shopId: "docN", receiptUUID: gid }), { ...OWNER, shopId: "docN" });
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_synced");
  assert.equal(r.body.billId, "billN");
  assert.equal(r.body.receiptNumber, "202611000011");
  assert.equal(LOG.length, 0);
});

test("🔴 ร้าน A ตั้ง field shopId = ค่าของร้าน S5 อื่น → guard แอปเก่าของร้านนั้น = receipt_uuid_other_shop", async () => {
  DATA.shop.docA = { shopId: "uidVictim" };
  DATA.shop.docV = { shopId: "uidVictim" };
  const gid = `uidVictim${U}`;
  DATA.receiptGuard = { [gid]: { createdAt: 1, usedBy: "billV" } };
  DATA.bill = { billV: { shopId: "uidVictim", receiptNumber: "R-V" } };
  const r = await call(req({ receiptUUID: gid }), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "receipt_uuid_other_shop");
  assert.equal("receiptNumber" in r.body, false);
});

test("guard รูปแอปเก่า doc id ขึ้นต้นด้วยร้านอื่น → 409 receipt_uuid_other_shop · ไม่คืนเลข · ไม่เขียน", async () => {
  const other = `shopB${U}`;
  DATA.receiptGuard = { [other]: { createdAt: 1, usedBy: "billY" } };
  DATA.bill = { billY: { shopId: "docB", receiptNumber: "R-B" } };
  const r = await call(req({ receiptUUID: other }), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "receipt_uuid_other_shop");
  assert.equal("billId" in r.body, false);
  assert.equal("receiptNumber" in r.body, false);
  assert.equal(LOG.length, 0);
});

test("มีร่องรอยแล้ว แล้วบิลขึ้น server ทีหลัง → already_synced มาก่อน duplicate", async () => {
  DATA.pendingDiscard = { [RID]: { shopId: "docA", receiptUUID: RID, reason: "ก่อน" } };
  DATA.receiptGuard = { [RID]: { createdAt: 1, usedBy: "202611000011", billId: "b2", shopId: "docA" } };
  const r = await call(req(), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_synced");
  assert.equal(r.body.billId, "b2");
  assert.equal(LOG.length, 0);
});

test("ร่องรอยเป็นของร้านอื่น → 409 · ไม่เขียนทับ", async () => {
  DATA.pendingDiscard = { [RID]: { shopId: "docB", receiptUUID: RID, reason: "ของร้าน B" } };
  const r = await call(req(), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "receipt_uuid_other_shop");
  assert.equal(LOG.length, 0);
  assert.equal(DATA.pendingDiscard[RID].reason, "ของร้าน B");
});

test("ร้านไม่มีในฐาน → 404 shop_not_found · ไม่เขียน", async () => {
  delete DATA.shop.docA;
  const r = await call(req(), OWNER);
  assert.equal(r.code, 404);
  assert.equal(LOG.length, 0);
});

test("body มี key `__proto__` (จาก JSON) → ร่องรอยไม่หาย · เก็บเป็น bodyJson ตรงตามที่เครื่องส่ง", async () => {
  const raw = JSON.parse(JSON.stringify(req()).replace('"body":{', '"body":{"__proto__":{"x":1},'));
  assert.deepEqual(Object.keys(raw.body), ["__proto__", "cart", "money"]);
  const r = await call(raw, OWNER);
  assert.equal(r.code, 200);
  const v = LOG[0].v;
  assert.equal("body" in v, false);
  assert.equal(v.bodyJson, JSON.stringify(raw.body));
  assert.ok(v.bodyJson.includes("__proto__"));
});

// ── B-7 · รหัสรูป `<prefix><uuid>` ที่ prefix เป็นของร้านอื่น (agent เลือกทาง: ปัด · ไม่เปลี่ยน doc id ของร่องรอย) ──
test("B-7 · ร้าน B จองรหัส `shopA<uuid>` (prefix = field ของร้าน A) → 409 receipt_uuid_other_shop · ไม่เขียน", async () => {
  const r = await call(req({ shopId: "docB" }), { ...OWNER, shopId: "docB" });
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "receipt_uuid_other_shop");
  assert.equal(LOG.length, 0);
  // แล้วร้าน A ยังจองรหัสของตัวเองได้ (ทิศที่ควรผ่าน)
  const a = await call(req(), OWNER);
  assert.equal(a.code, 200);
  assert.equal(LOG.length, 1);
});

test("B-7 · prefix = doc id ของร้านอื่น → 409 · prefix = doc id ของร้านนี้ → 200", async () => {
  const other = await call(req({ receiptUUID: `docB${U}`, body: { receiptUUID: `docB${U}` } }), OWNER);
  assert.equal(other.code, 409);
  const mine = await call(req({ receiptUUID: `docA${U}` }), OWNER);
  assert.equal(mine.code, 200);
});

test("B-7 · uuid ล้วน · prefix ที่ไม่ใช่ร้านใด → 200 (ไม่ปัดเกิน)", async () => {
  assert.equal((await call(req({ receiptUUID: U }), OWNER)).code, 200);
  assert.equal((await call(req({ receiptUUID: `ghost${U}` }), OWNER)).code, 200);
});

test("B-7 · prefix `undefined` จากร้านที่มี field → 409 · จากร้านที่ไม่มี field → 200", async () => {
  assert.equal((await call(req({ receiptUUID: `undefined${U}` }), OWNER)).code, 409);
  DATA.shop.docC = {};
  assert.equal((await call(req({ shopId: "docC", receiptUUID: `undefined${U}` }), { ...OWNER, shopId: "docC" })).code, 200);
});

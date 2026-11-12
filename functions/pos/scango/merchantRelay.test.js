// เทส pos/scango/merchantRelay.js — เว็บร้าน ScanGo relay สินค้า (products/list · products/set) ผ่าน handler แกนตัวจริง
//   ฐานปลอม shop/_testDb (orderBy __name__ · startAfter · transaction) · ❌ ไม่แตะ Firebase จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installFakeDb } = require("./shop/_testDb");

const F = installFakeDb();
const R = require("./merchantRelay");

const NOW = new Date("2026-11-12T05:00:00.000Z");
const FUTURE = new Date("2027-12-31T00:00:00.000Z");
const shopDoc = (scango) => ({
  shopId: "shopA", name: "ร้าน A", vip: [{ type: "staff", expire: FUTURE }],
  humanResource: [
    { id: "u-owner", position: ["001"], status: "active" },
    { id: "u-staff", position: ["002"], status: "active", rights: ["100"] },
    { id: "u-stock", position: ["002"], status: "active", rights: ["111"] },
    { id: "u-gone", position: ["001"], status: "inActive" },
  ],
  smartCategory: [{ level: 1, value: [{ id: "c1", name: "เครื่องดื่ม" }, { id: "c2", name: "น้ำอัดลม" }] }],
  scango: { enabled: false, productIds: ["p2"], ...(scango || {}) },
});
const prod = (o = {}) => ({ shopId: "shopA", name: "น้ำดื่ม", price: 10, barcode: "885000", unit: "ขวด", imageId: "", category: ["c1"], stock: 5, stockCountStatus: true, ...o });
const seed = (scango, more) => ({
  shop: { shopA: shopDoc(scango) },
  stock: { p1: prod({ name: "โค้ก", imageId: "https://img/c.jpg", category: ["c1", "c2"] }), p2: prod({ category: ["zz"] }), pDel: prod({ deleted: true }), pB: prod({ shopId: "shopB" }), ...(more || {}) },
});
const actor = (personRef, uid) => ({ uid: uid || `mo:shopchamp:${personRef}`, personRef, name: "คนกด" });

async function call(factory, body, deps) {
  const lines = [];
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await factory({ now: () => NOW, audit: (l) => lines.push(l), ...(deps || {}) })({ body }, res);
  return { ...res, lines };
}

test("products/list: เจ้าของ → รูปเว็บ {items[productId,name,price,imageUrl?,category?,selected], selectedCount, max, nextCursor} · ลบแล้ว/ร้านอื่นไม่โผล่ · log 1 บรรทัด", async () => {
  F.reset(seed());
  const r = await call(R.merchantProductsList, { externalId: "shopA", actor: actor("u-owner") });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true,
    items: [
      { productId: "p1", name: "โค้ก", price: 10, imageUrl: "https://img/c.jpg", category: "น้ำอัดลม", selected: false },
      { productId: "p2", name: "น้ำดื่ม", price: 10, selected: true }, // ไม่มีรูป / หมวดไม่รู้จัก = ไม่ใส่ช่อง
    ],
    selectedCount: 1, max: 1000, nextCursor: null,
  });
  assert.deepEqual(r.lines, [{ message: "scango.merchantRelay", op: "products/list", shopId: "shopA", actor: "mo:shopchamp:u-owner", personRef6: "u-owne", result: "ok" }]);
  assert.equal(F.log.length, 0, "อ่านอย่างเดียว");
  const q = await call(R.merchantProductsList, { externalId: "shopA", q: "โค้ก", actor: actor("u-owner") });
  assert.deepEqual(q.body.items.map((i) => i.productId), ["p1"]);
});

test("products/list: cursor ข้ามหน้าเดินจนจบ (แกน productSearch หน้าละ 50)", async () => {
  const many = {};
  for (let i = 0; i < 120; i++) many[`m${String(i).padStart(3, "0")}`] = prod({ name: `ของ ${i}` });
  F.reset(seed(undefined, many));
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await call(R.merchantProductsList, { externalId: "shopA", actor: actor("u-owner"), ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    seen.push(...r.body.items.map((i) => i.productId));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 122);
  assert.equal(new Set(seen).size, 122);
});

test("products/set: เจ้าของ/พนักงานสิทธิ์ 111 ตั้งได้ (ตัดซ้ำ) · เขียนช่อง scango.productIds ช่องเดียว · คำตอบ {selectedCount}", async () => {
  for (const who of [actor("u-owner"), actor("u-stock", "ms:v1:u-stock")]) {
    F.reset(seed());
    const r = await call(R.merchantProductsSet, { externalId: "shopA", productIds: ["p1", "p2", "p1"], actor: who });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, selectedCount: 2 });
    assert.deepEqual(F.data.shop.shopA.scango.productIds, ["p1", "p2"]);
    assert.deepEqual(F.log.map((w) => [w.op, w.path, Object.keys(w.v)]), [["update", "shop/shopA", ["scango.productIds"]]]);
  }
});

test("products/set: ซองปฏิเสธของแกนส่งต่อเดิม (product_not_found · too_many_products · invalid_request) · ไม่เขียน · C2 ทำแทนเจ้าของ = พนักงานไม่มี 111 ก็ตั้งได้", async () => {
  F.reset(seed());
  const nf = await call(R.merchantProductsSet, { externalId: "shopA", productIds: ["p1", "pB", "pDel"], actor: actor("u-owner") });
  assert.deepEqual([nf.code, nf.body.error, nf.body.productIds, nf.body.count], [409, "product_not_found", ["pB", "pDel"], 2]);
  assert.equal(nf.lines[0].result, "product_not_found");
  const many = await call(R.merchantProductsSet, { externalId: "shopA", productIds: Array.from({ length: 1001 }, (_, i) => `x${i}`), actor: actor("u-owner") });
  assert.deepEqual([many.code, many.body.error, many.body.limit, many.body.count], [409, "too_many_products", 1000, 1001]);
  const badArr = await call(R.merchantProductsSet, { externalId: "shopA", productIds: "p1", actor: actor("u-owner") });
  assert.deepEqual([badArr.code, badArr.body.error], [400, "invalid_request"]);
  assert.equal(F.log.length, 0);
  // C2 (Pack เคาะ 2026-11-12 · ต้นแบบ asPlatformOwner): ทุกคำขอที่มี actor = ทำแทนเจ้าของ (ScanGo ตรวจสิทธิ์รายแท็บมาแล้ว)
  for (const who of [actor("u-staff"), actor("u-gone"), actor("someone", "md:venue1"), { uid: "admin:x" }]) {
    F.reset(seed());
    const r = await call(R.merchantProductsSet, { externalId: "shopA", productIds: ["p1"], actor: who });
    assert.deepEqual([r.code, r.body.selectedCount], [200, 1], JSON.stringify([who, r.body]));
    assert.equal("byAdmin" in r.body, false, "ธงภายในไม่หลุดถึงเว็บ");
  }
});

test("ด่าน relay: actor บังคับ (uid) · ปิดรายร้าน 403 · ร้านไม่มี 404 · ช่องเกิน 400 · ทุกคำขอลง log", async () => {
  F.reset(seed());
  for (const [body, code, error] of [
    [{ externalId: "shopA", productIds: ["p1"] }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: "u-owner" }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: { uid: "u-owner", personRef: "u-owner" } }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: { personRef: "u-owner" } }, 400, "actor_required"],
    [{ externalId: "ghost", productIds: ["p1"], actor: actor("u-owner") }, 404, "shop_not_found"],
    [{ externalId: "shopA", shopId: "shopA", productIds: ["p1"], actor: actor("u-owner") }, 400, "invalid_request"],
    [{ externalId: "a/b", productIds: ["p1"], actor: actor("u-owner") }, 400, "invalid_request"],
  ]) {
    const r = await call(R.merchantProductsSet, body);
    assert.deepEqual([r.code, r.body.error], [code, error], JSON.stringify(body));
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].result, error);
  }
  F.reset(seed({ merchantRelay: false }));
  for (const f of [R.merchantProductsList, R.merchantProductsSet]) {
    const r = await call(f, { externalId: "shopA", productIds: ["p1"], actor: actor("u-owner") });
    assert.equal(r.body.error, f === R.merchantProductsList ? "invalid_request" : "merchant_relay_disabled");
  }
  const off = await call(R.merchantProductsList, { externalId: "shopA", actor: actor("u-owner") });
  assert.deepEqual([off.code, off.body.error], [403, "merchant_relay_disabled"]);
  assert.equal(F.log.length, 0);
});

// ── รอบ 5: ordering · fee/preview ─────────────────────────────────────────────────────────
const MODEL = { baseKm: 2, baseFee: 25, bands: [{ toKm: 5, perKm: 5 }, { toKm: 15, perKm: 10 }] };
const venueSpy = (status) => {
  const calls = [];
  const fn = async (_deps, a) => { calls.push(a); if (status === "throw") throw new Error("boom"); return { status: status || "sent", sent: status === "sent" || !status, ...(status === "queued" ? { queued: true, reason: "status_503" } : {}) }; };
  fn.calls = calls;
  return fn;
};

test("ordering: เจ้าของตั้งเปิดรับ + ขั้นต่ำ + สูตร → เขียน scango.<3 ช่อง> (dotted) · ยิง venue ก่อนตอบ · คำตอบ {ordering, synced, venue}", async () => {
  F.reset(seed({ productIds: ["p1"] }));
  const spy = venueSpy();
  const r = await call(R.merchantOrdering, { externalId: "shopA", actor: actor("u-owner"), enabled: true, minOrder: "99.999", deliveryFeeModel: MODEL, maxKm: 15 }, { sendVenue: spy });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true,
    ordering: { enabled: true, minOrder: 100, deliveryFee: 25, deliveryFeeModel: { distance: "road", ...MODEL }, deliveryFeeSource: "model", maxKm: 15 },
    synced: true, venue: "sent",
  });
  assert.deepEqual(F.log.map((w) => [w.op, w.path, Object.keys(w.v).sort()]), [["update", "shop/shopA", ["scango.deliveryFeeModel", "scango.enabled", "scango.minOrder"]]]);
  assert.deepEqual(F.data.shop.shopA.scango.productIds, ["p1"], "ช่องอื่นไม่ถูกแตะ");
  assert.deepEqual(spy.calls, [{ shopId: "shopA" }]);
  assert.equal(r.lines[0].op, "ordering");
  assert.equal(r.lines[0].result, "ok");
  // ส่งแค่ช่องเดียว = เขียนช่องเดียว · ค่าเดิมของร้านยังอ่านรวม (สูตรเดิม · ขั้นต่ำเดิม)
  const one = await call(R.merchantOrdering, { externalId: "shopA", actor: actor("u-owner"), enabled: false }, { sendVenue: spy });
  assert.deepEqual([one.code, one.body.ordering.enabled, one.body.ordering.minOrder, one.body.ordering.maxKm], [200, false, 100, 15]);
  assert.deepEqual(Object.keys(F.log[1].v), ["scango.enabled"]);
});

test("ordering: ยิง venue ไม่ออก = บันทึกแล้ว synced:false (queued · failed · โยน) · ไม่ล้มคำตอบ", async () => {
  for (const [st, venue] of [["queued", "queued"], ["skipped", "skipped"], ["throw", "failed"]]) {
    F.reset(seed({ productIds: ["p1"] }));
    const r = await call(R.merchantOrdering, { externalId: "shopA", actor: actor("u-owner"), minOrder: 10 }, { sendVenue: venueSpy(st) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.synced, r.body.venue], [false, venue]);
    assert.equal(F.data.shop.shopA.scango.minOrder, 10);
  }
});

test("ordering: ปัดแบบต้นแบบ — field_not_relayed · bad_delivery_model (สูตร · maxKm) · ไม่มีช่อง · ยังไม่เลือกสินค้า 409 · ไม่เขียน ไม่ยิง · C2 พนักงาน/คนนอกที่มี actor = ทำแทนเจ้าของ", async () => {
  F.reset(seed({ productIds: [] }));
  const spy = venueSpy();
  const o = (extra, who) => call(R.merchantOrdering, { externalId: "shopA", actor: actor(who || "u-owner"), ...extra }, { sendVenue: spy });
  const nr = await o({ enabled: true, prepMinutes: 10, hours: [] });
  assert.deepEqual([nr.code, nr.body.error, nr.body.details], [400, "field_not_relayed", { errors: [{ field: "prepMinutes", message: "ไม่ได้ส่งต่อทางนี้" }, { field: "hours", message: "ไม่ได้ส่งต่อทางนี้" }] }]);
  const bm = await o({ deliveryFeeModel: { baseKm: 0, baseFee: -1, bands: [{ toKm: 1, perKm: 1 }] } });
  assert.deepEqual([bm.code, bm.body.error], [400, "bad_delivery_model"]);
  assert.deepEqual(bm.body.details.errors.map((e) => e.field), ["baseKm", "baseFee"]);
  const six = await o({ deliveryFeeModel: { baseKm: 1, baseFee: 1, bands: [2, 3, 4, 5, 6, 7].map((k) => ({ toKm: k, perKm: 1 })) } });
  assert.deepEqual([six.code, six.body.details.errors[0].field], [400, "bands"]);
  const kmOnly = await o({ maxKm: 15 });
  assert.deepEqual([kmOnly.code, kmOnly.body.error, kmOnly.body.details.errors[0].field], [400, "bad_delivery_model", "maxKm"]);
  const kmBad = await o({ deliveryFeeModel: MODEL, maxKm: 10 });
  assert.deepEqual([kmBad.code, kmBad.body.error, kmBad.body.details.errors[0].field], [400, "bad_delivery_model", "maxKm"]);
  assert.match(kmBad.body.message, /ไกลสุด \(10 กม\.\) ไม่ตรงกับขอบช่วงสุดท้ายของสูตร \(15 กม\.\)/);
  const none = await o({});
  assert.deepEqual([none.code, none.body.error], [400, "invalid_request"]);
  const badType = await o({ enabled: "yes" });
  assert.deepEqual([badType.code, badType.body.error], [400, "invalid_request"]);
  const neg = await o({ minOrder: -1 });
  assert.deepEqual([neg.code, neg.body.error], [400, "invalid_request"]);
  const ready = await o({ enabled: true });
  assert.deepEqual([ready.code, ready.body.error, ready.body.missing], [409, "scango_not_ready", ["products"]]);
  assert.equal(F.log.length, 0);
  assert.equal(spy.calls.length, 0);
  for (const who of ["u-stock", "u-gone", "outsider"]) {
    const r = await o({ minOrder: 10 }, who);
    assert.equal(r.code, 200, JSON.stringify([who, r.body]));
  }
  // แกนยังมีด่านเจ้าของ (ทางอื่นที่ไม่ใช่เจ้าของ = 403 owner_only) — relay ไม่มีทางส่ง role อื่น
  const core = R._orderingCore({ sendVenue: spy, now: () => NOW });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await core({ body: { shopId: "shopA", minOrder: 1 }, shopAccess: { shopId: "shopA", uid: "u-stock", role: "staff", rights: ["111"] } }, res);
  assert.deepEqual([res.code, res.body.error], [403, "owner_only"]);
  F.reset(seed({ merchantRelay: false, productIds: ["p1"] }));
  assert.equal((await o({ enabled: true })).body.error, "merchant_relay_disabled");
  // ปิดรับได้เสมอแม้ไม่มีสินค้า
  F.reset(seed({ productIds: [] }));
  assert.equal((await o({ enabled: false })).code, 200);
});

test("fee/preview: คิดอย่างเดียว · ระยะตั้งต้น (ต้นแบบ) · ที่มาตัวเลข · ขอบไกลสุด · สูตรผิด/maxKm ไม่ตรง/ระยะผิด = 200 valid:false · ไม่เขียน", async () => {
  F.reset(seed());
  const p = (extra, who) => call(R.merchantFeePreview, { externalId: "shopA", actor: actor(who || "u-owner"), ...extra });
  const r = await p({ deliveryFeeModel: MODEL });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true, valid: true, errors: [], maxKm: 15, stepsLeft: 3,
    examples: [
      { km: 1.5, fee: 25, outOfRange: false, how: "base" },
      { km: 4, fee: 35, outOfRange: false, how: "25 + 2×5" },
      { km: 10, fee: 90, outOfRange: false, how: "25 + 3×5 + 5×10" },
      { km: 15, fee: 140, outOfRange: false, how: "25 + 3×5 + 10×10", edge: "max" },
      { km: 16, fee: null, outOfRange: true, how: "out_of_range" },
    ],
  });
  const d = await p({ deliveryFeeModel: MODEL, distancesKm: [3.21] });
  assert.deepEqual(d.body.examples, [{ km: 3.21, fee: 32, outOfRange: false, how: "25 + 1.3×5" }]);
  const bad = await p({ deliveryFeeModel: { baseKm: "x" } });
  assert.deepEqual([bad.code, bad.body.valid, bad.body.errors[0].field, bad.body.examples], [200, false, "baseKm", []]);
  const km = await p({ deliveryFeeModel: MODEL, maxKm: 5 });
  assert.deepEqual([km.body.valid, km.body.errors[0].field, km.body.maxKm], [false, "maxKm", 15]);
  const ds = await p({ deliveryFeeModel: MODEL, distancesKm: [-1] });
  assert.deepEqual([ds.body.valid, ds.body.errors[0].field], [false, "distancesKm"]);
  const staff = await p({ deliveryFeeModel: MODEL }, "u-staff");
  assert.equal(staff.code, 200);
  const extra = await p({ deliveryFeeModel: MODEL, enabled: true });
  assert.deepEqual([extra.code, extra.body.error], [400, "invalid_request"]);
  const out = await p({ deliveryFeeModel: MODEL }, "u-gone");
  assert.equal(out.code, 200, "C2 ทำแทนเจ้าของ");
  assert.equal(F.log.length, 0);
});

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

test("products/set: ซองปฏิเสธของแกนส่งต่อเดิม (product_not_found · too_many_products · right_required · invalid_request) · ไม่เขียน", async () => {
  F.reset(seed());
  const nf = await call(R.merchantProductsSet, { externalId: "shopA", productIds: ["p1", "pB", "pDel"], actor: actor("u-owner") });
  assert.deepEqual([nf.code, nf.body.error, nf.body.productIds, nf.body.count], [409, "product_not_found", ["pB", "pDel"], 2]);
  assert.equal(nf.lines[0].result, "product_not_found");
  const many = await call(R.merchantProductsSet, { externalId: "shopA", productIds: Array.from({ length: 1001 }, (_, i) => `x${i}`), actor: actor("u-owner") });
  assert.deepEqual([many.code, many.body.error, many.body.limit, many.body.count], [409, "too_many_products", 1000, 1001]);
  const noRight = await call(R.merchantProductsSet, { externalId: "shopA", productIds: ["p1"], actor: actor("u-staff") });
  assert.deepEqual([noRight.code, noRight.body.error, noRight.body.right], [403, "right_required", "111"]);
  const badArr = await call(R.merchantProductsSet, { externalId: "shopA", productIds: "p1", actor: actor("u-owner") });
  assert.deepEqual([badArr.code, badArr.body.error], [400, "invalid_request"]);
  assert.equal(F.log.length, 0);
});

test("ด่าน relay: actor บังคับ · คนนอก/ไม่ active 403 not_shop_member · ปิดรายร้าน 403 · ร้านไม่มี 404 · ช่องเกิน 400 · ทุกคำขอลง log", async () => {
  F.reset(seed());
  for (const [body, code, error] of [
    [{ externalId: "shopA", productIds: ["p1"] }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: "u-owner" }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: { uid: "u-owner", personRef: "u-owner" } }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: { uid: "mo:shopchamp:x" } }, 400, "actor_required"],
    [{ externalId: "shopA", productIds: ["p1"], actor: actor("someone", "md:venue1") }, 403, "not_shop_member"],
    [{ externalId: "shopA", productIds: ["p1"], actor: actor("u-gone") }, 403, "not_shop_member"],
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

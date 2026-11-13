// เทส pos/scango/shop/*.js (เส้นฝั่งแอปร้าน scango.*) · รัน: node --test functions/pos/scango/shop/shop.test.js
//   ❌ ไม่แตะ Firestore จริง (ฐานปลอม ./_testDb.js)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installFakeDb, call } = require("./_testDb");

const F = installFakeDb();
const { productsSet } = require("./productsSet");
const { productSearch, PAGE_SIZE, SCAN_LIMIT } = require("./productSearch");
const { orderList } = require("./orderList");

const NOW = new Date("2026-11-11T03:00:00.000Z");
const FUTURE = new Date("2027-12-31T00:00:00.000Z");
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const STAFF = (rights) => ({ shopId: "shopA", uid: "u-staff", role: "staff", rights });
const WATCHER = { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true };

const shopDoc = (scango) => ({
  shopId: "shopA",
  vip: [{ type: "staff", expire: FUTURE }],
  humanResource: [{ id: "u-owner", position: ["001"], status: "active" }, { id: "u-staff", position: ["002"], status: "active" }],
  name: "ร้าน A",
  ...(scango ? { scango } : {}),
});
const prod = (o = {}) => ({ shopId: "shopA", name: "น้ำดื่ม", price: 10, barcode: "885000", unit: "ขวด", imageId: "", category: ["c1"], stock: 5, stockCountStatus: true, ...o });
// ── productsSet ────────────────────────────────────────────────────────────────
test("productsSet: ตั้งรายการ (ตัดซ้ำ คงลำดับ) เขียนช่องเดียว · พนักงานที่มี '111' ได้ · ไม่มี 403", async () => {
  F.reset({ shop: { shopA: shopDoc({ enabled: false }) }, stock: { p1: prod(), p2: prod({ name: "ขนม" }) } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p2", "p1", "p2"] }, STAFF(["111"]));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.productCount, 2);
  assert.deepEqual(F.data.shop.shopA.scango.productIds, ["p2", "p1"]);
  assert.deepEqual(Object.keys(F.log[0].v), ["scango.productIds"]);
  assert.equal(F.data.shop.shopA.scango.enabled, false);
  const no = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1"] }, STAFF(["110"]));
  assert.equal(no.code, 403);
  assert.equal(no.body.error, "right_required");
});

test("productsSet: ไม่มี / ร้านอื่น / ลบแล้ว = 409 product_not_found พร้อมรายการ · ไม่เขียน", async () => {
  F.reset({ shop: { shopA: shopDoc(), shopB: { shopId: "shopB" } }, stock: { p1: prod(), pB: prod({ shopId: "shopB" }), pDel: prod({ deleted: true }) } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1", "pB", "pDel", "nope"] }, OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "product_not_found");
  assert.deepEqual(r.body.productIds, ["pB", "pDel", "nope"]);
  assert.equal(r.body.count, 3);
  assert.equal(F.log.length, 0);
});

test("productsSet: 1000 ตัวผ่าน · 1001 ตัว 409 too_many_products (นับหลังตัดซ้ำ) ก่อนอ่าน stock", async () => {
  const stock = {};
  for (let i = 0; i < 1001; i++) stock[`p${i}`] = prod();
  F.reset({ shop: { shopA: shopDoc() }, stock });
  const ids = Object.keys(stock);
  const k = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [...ids.slice(0, 1000), "p0"] }, OWNER);
  assert.equal(k.code, 200, JSON.stringify(k.body));
  assert.equal(F.data.shop.shopA.scango.productIds.length, 1000);
  const readsBefore = F.reads;
  const over = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ids }, OWNER);
  assert.equal(over.code, 409);
  assert.equal(over.body.error, "too_many_products");
  assert.equal(over.body.count, 1001);
  assert.equal(F.reads, readsBefore);
});

test("productsSet: ร้านเปิดรับใบอยู่ ส่งรายการว่าง = 409 scango_not_ready · ปิดอยู่ ส่งว่างได้", async () => {
  F.reset({ shop: { shopA: shopDoc({ enabled: true, productIds: ["p1"] }) }, stock: { p1: prod() } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [] }, OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "scango_not_ready");
  F.reset({ shop: { shopA: shopDoc({ enabled: false, productIds: ["p1"] }) } });
  const ok = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [] }, OWNER);
  assert.equal(ok.code, 200);
  assert.deepEqual(F.data.shop.shopA.scango.productIds, []);
});

test("productsSet: ร้าน S5 (field shopId ≠ doc id ที่พิสูจน์แล้ว) สินค้าที่ถือ field ผ่าน", async () => {
  F.reset({ shop: { shopA: { ...shopDoc(), shopId: "legacy-A" } }, stock: { p1: prod({ shopId: "legacy-A" }), p2: prod() } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1", "p2"] }, OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
});

// ── productSearch ──────────────────────────────────────────────────────────────
test("productSearch: ค้นชื่อ/บาร์โค้ด/หมวด · ข้ามที่ลบ · ธง selected · ร้านอื่นไม่ปน", async () => {
  F.reset({
    shop: { shopA: shopDoc({ productIds: ["p2"] }) },
    stock: {
      p1: prod({ name: "น้ำดื่มสิงห์", barcode: "111" }), p2: prod({ name: "ขนมปัง", barcode: "222", category: ["c2"] }),
      p3: prod({ name: "น้ำส้ม", deleted: true }), p4: prod({ shopId: "shopB", name: "น้ำแร่" }), p5: prod({ name: 12, barcode: 333, price: "15" }),
    },
  });
  const all = await call(productSearch, {}, { shopId: "shopA" }, OWNER);
  assert.equal(all.code, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.items.map((i) => i.productId), ["p1", "p2", "p5"]);
  assert.equal(all.body.nextCursor, null);
  assert.equal(all.body.selectedCount, 1);
  assert.equal(all.body.items.find((i) => i.productId === "p2").selected, true);
  const p5 = all.body.items.find((i) => i.productId === "p5");
  assert.equal(p5.name, "12"); assert.equal(p5.barcode, "333"); assert.equal(p5.price, 15);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", q: "น้ำ" }, OWNER)).body.items.map((i) => i.productId), ["p1"]);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", q: "22" }, OWNER)).body.items.map((i) => i.productId), ["p2"]);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", categoryId: "c2" }, OWNER)).body.items.map((i) => i.productId), ["p2"]);
  const sel = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true }, OWNER);
  assert.deepEqual(sel.body.items.map((i) => i.productId), ["p2"]);
  assert.equal((await call(productSearch, {}, { shopId: "shopA" }, STAFF(["100"]))).code, 403);
  assert.equal((await call(productSearch, {}, { shopId: "shopA", cursor: "zzz" }, OWNER)).code, 400);
});

test("productSearch: หน้าละ 50 ต่อด้วย cursor จนครบไม่ซ้ำ · อ่านต่อคำขอไม่เกินเพดาน", async () => {
  const stock = {};
  for (let i = 0; i < 1200; i++) stock[`p${String(i).padStart(4, "0")}`] = prod({ name: i % 10 === 0 ? `หายาก ${i}` : `ทั่วไป ${i}` });
  F.reset({ shop: { shopA: shopDoc() }, stock });
  const seen = [];
  let cursor;
  let rounds = 0;
  do {
    const before = F.reads;
    const r = await call(productSearch, {}, { shopId: "shopA", ...(cursor ? { cursor } : {}) }, OWNER);
    assert.equal(r.code, 200);
    assert.ok(r.body.items.length <= PAGE_SIZE);
    assert.ok(F.reads - before <= SCAN_LIMIT + 3, `อ่าน ${F.reads - before}`);
    seen.push(...r.body.items.map((i) => i.productId));
    cursor = r.body.nextCursor;
    rounds++;
  } while (cursor && rounds < 100);
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200);
  // ค้นของหายาก: บางหน้าได้น้อยกว่า 50 แต่ cursor ยังไม่ null · รวมครบ 120
  const rare = [];
  cursor = undefined; rounds = 0;
  do {
    const r = await call(productSearch, {}, { shopId: "shopA", q: "หายาก", ...(cursor ? { cursor } : {}) }, OWNER);
    rare.push(...r.body.items.map((i) => i.productId));
    cursor = r.body.nextCursor; rounds++;
  } while (cursor && rounds < 100);
  assert.equal(rare.length, 120);
});

test("productSearch: selectedOnly แบ่งหน้าตามรายการที่เลือก", async () => {
  const stock = {}; const ids = [];
  for (let i = 0; i < 120; i++) { stock[`s${i}`] = prod(); ids.push(`s${i}`); }
  F.reset({ shop: { shopA: shopDoc({ productIds: ids }) }, stock });
  const a = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true }, OWNER);
  assert.equal(a.body.items.length, 50);
  assert.equal(a.body.nextCursor, "i|50");
  const c = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true, cursor: "i|100" }, OWNER);
  assert.equal(c.body.items.length, 20);
  assert.equal(c.body.nextCursor, null);
});

// ── orderList ──────────────────────────────────────────────────────────────────
test("orderList: ของร้านนี้ ใหม่สุดก่อน · กรอง states · เวลาเป็น ISO · state ผิด 400", async () => {
  F.reset({
    shop: { shopA: shopDoc() },
    scangoOrder: {
      o1: { shopId: "shopA", state: "requested", createdAt: new Date("2026-11-11T01:00:00Z") },
      o2: { shopId: "shopA", state: "accepted", createdAt: new Date("2026-11-11T02:00:00Z") },
      o3: { shopId: "shopB", state: "requested", createdAt: new Date("2026-11-11T03:00:00Z") },
    },
  });
  const all = await call(orderList, {}, { shopId: "shopA" }, STAFF([]));
  assert.equal(all.code, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.orders.map((o) => o.orderRef), ["o2", "o1"]);
  assert.equal(all.body.orders[0].createdAt, "2026-11-11T02:00:00.000Z");
  const req = await call(orderList, {}, { shopId: "shopA", states: ["requested"] }, WATCHER);
  assert.deepEqual(req.body.orders.map((o) => o.orderRef), ["o1"]);
  assert.equal((await call(orderList, {}, { shopId: "shopA", states: ["cooking"] }, OWNER)).code, 400);
  assert.equal((await call(orderList, {}, { shopId: "shopA", states: [] }, OWNER)).code, 400);
});


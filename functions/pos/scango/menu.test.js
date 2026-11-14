// เทส pos/scango/menu.js — เมนูจาก productIds ของร้านเท่านั้น (ไม่ลบ · ร้านตัวเอง) · ลำดับตาม productIds · 404 · 400 · ไม่เขียนฐาน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SHOP, load, call, shop } = require("./_testSeed");

test("เมนู: เฉพาะสินค้าที่ร้านเลือก ยังไม่ลบ และเป็นของร้านนี้ · ลำดับตาม productIds · ราคา/หมด/หมวด", async () => {
  const { mem, deps, mod } = load();
  const r = await call(mod("menu.js").menu(deps), { externalId: SHOP });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.products.map((p) => [p.productId, p.price, p.status]), [["p1", 15, "available"], ["p2", 7, "available"], ["p3", 40, "available"], ["pOut", 20, "out"]]);
  assert.equal(r.body.products[2].fullPrice, 50);
  assert.deepEqual(r.body.products[0].categoryPath, ["c1", "c2"]);
  assert.equal(r.body.categoryTree[0].children[0].id, "c2");
  assert.equal(mem.writes.length, 0, "อ่านอย่างเดียว");
});

test("เมนู: สวิตช์ปิด = ยังตอบ acceptingOrders true (ScanGo ตัดสินเอง) · ไม่เลือกสินค้าเลย = products ว่าง", async () => {
  const { deps, mod } = load({ [`shop/${SHOP}`]: shop({ enabled: false, productIds: [] }) });
  const r = await call(mod("menu.js").menu(deps), { externalId: SHOP });
  assert.deepEqual([r.code, r.body.acceptingOrders, "closedReason" in r.body, r.body.products.length], [200, true, false, 0]);
});

test("เมนู: ร้านไม่มี = 404 shop_not_found · ช่องเกิน/externalId ผิดรูป = 400 invalid_request", async () => {
  const { deps, mod } = load();
  const h = mod("menu.js").menu(deps);
  assert.deepEqual([(await call(h, { externalId: "nope" })).code, (await call(h, { externalId: "nope" })).body.error], [404, "shop_not_found"]);
  for (const body of [{ externalId: SHOP, shopId: SHOP }, {}, { externalId: "a/b" }, { externalId: 5 }]) {
    const r = await call(h, body);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(body));
  }
});

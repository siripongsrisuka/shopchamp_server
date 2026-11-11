// เทส pos/scango/_menu.js — สูตรล้วน: เวลาเปิด · ประตูรับ · ราคา (linePrice qty 1) · ของหมด · หมวด · ค่าส่ง · เมนู
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("./_menu");
const { NOW, shop, stock } = require("./_testSeed");

// NOW = พุธ (3) 12:00 ไทย
const at = (iso) => new Date(iso);

test("isOpenAt: ไม่มีแถว = เปิดตลอด · ช่วงปกติ · ปิดวัน · ข้ามเที่ยงคืน · 24 ชม. · แถวผิดรูปไม่นับ", () => {
  assert.equal(M.isOpenAt([], NOW), true);
  assert.equal(M.isOpenAt(undefined, NOW), true);
  assert.equal(M.isOpenAt([{ day: 3, open: "09:00", close: "18:00" }], NOW), true);
  assert.equal(M.isOpenAt([{ day: 3, open: "13:00", close: "18:00" }], NOW), false);
  assert.equal(M.isOpenAt([{ day: 3, open: "09:00", close: "12:00" }], NOW), false, "close ไม่รวม");
  assert.equal(M.isOpenAt([{ day: 2, open: "09:00", close: "18:00" }], NOW), false, "วันอื่น");
  // ข้ามเที่ยงคืน: อังคาร 20:00-02:00 → พุธ 01:00 ไทย เปิด · พุธ 03:00 ปิด
  const night = [{ day: 2, open: "20:00", close: "02:00" }];
  assert.equal(M.isOpenAt(night, at("2026-11-10T18:00:00Z")), true);
  assert.equal(M.isOpenAt(night, at("2026-11-10T20:00:00Z")), false);
  assert.equal(M.isOpenAt(night, at("2026-11-10T13:30:00Z")), true, "อังคาร 20:30");
  assert.equal(M.isOpenAt([{ day: 3, open: "00:00", close: "00:00" }], NOW), true, "24 ชม.");
  assert.equal(M.isOpenAt([{ day: 9, open: "x", close: "18:00" }], NOW), true, "แถวผิดรูปทั้งหมด = เหมือนไม่มี");
});

test("acceptingOf: ปิดสวิตช์ = ordering_disabled · นอกเวลา = shop_closed · เปิด = รับ", () => {
  assert.deepEqual(M.acceptingOf(shop({ enabled: false }), NOW), { accepting: false, reason: "ordering_disabled" });
  assert.deepEqual(M.acceptingOf({}, NOW), { accepting: false, reason: "ordering_disabled" });
  assert.deepEqual(M.acceptingOf(shop({ hours: [{ day: 3, open: "13:00", close: "14:00" }] }), NOW), { accepting: false, reason: "shop_closed" });
  assert.deepEqual(M.acceptingOf(shop(), NOW), { accepting: true, reason: null });
});

test("unitPriceOf: ราคาปกติ · โปรชุด qty 1 ได้ fullPrice · ราคาส่งขั้น qty 1 · ลบแล้ว/ราคากำหนดเอง/ราคาเสีย = null", () => {
  assert.deepEqual(M.unitPriceOf(stock({ price: 15 }), NOW), { price: 15, priceType: "ราคาขายทั่วไป" });
  const promo = { status: true, qty: 1, price: 40, startDate: at("2026-11-01T00:00:00Z"), endDate: at("2026-12-01T00:00:00Z") };
  assert.deepEqual(M.unitPriceOf(stock({ price: 50, promotion: promo }), NOW), { price: 40, fullPrice: 50, priceType: "ราคาโปรโมชั่น" });
  assert.deepEqual(M.unitPriceOf(stock({ price: 50, promotion: { ...promo, qty: 2 } }), NOW), { price: 50, priceType: "ราคาขายทั่วไป" }, "ชุด 2 ชิ้น ไม่ลดที่ qty 1");
  assert.deepEqual(M.unitPriceOf(stock({ price: 50, promotion: { ...promo, endDate: at("2026-11-10T00:00:00Z") } }), NOW).price, 50, "โปรหมดเวลา");
  assert.equal(M.unitPriceOf(stock({ deleted: true }), NOW), null);
  assert.equal(M.unitPriceOf(stock({ sku: "delete" }), NOW), null);
  assert.equal(M.unitPriceOf(stock({ customPriceStatus: true }), NOW), null);
  assert.equal(M.unitPriceOf(stock({ price: "" }), NOW), null);
  assert.equal(M.unitPriceOf(stock({ price: "abc" }), NOW), null);
  assert.equal(M.unitPriceOf(stock({ price: "12.50" }), NOW).price, 12.5);
});

test("isOut / stockLeft: นับเฉพาะ stockCountStatus · ≤0 หรืออ่านไม่ออก = หมด", () => {
  assert.equal(M.isOut(stock({ stock: 0 })), true);
  assert.equal(M.isOut(stock({ stock: -3 })), true);
  assert.equal(M.isOut(stock({ stock: "" })), true);
  assert.equal(M.isOut(stock({ stock: "4" })), false);
  assert.equal(M.isOut(stock({ stock: 0, stockCountStatus: false })), false);
  assert.equal(M.stockLeft(stock({ stock: 4 })), 4);
  assert.equal(M.stockLeft(stock({ stockCountStatus: false })), Infinity);
});

test("categoryTreeOf: แม่ = aboveId ตัวสุดท้าย · แม่หาย = ราก", () => {
  assert.deepEqual(M.categoryTreeOf(shop().smartCategory), [{ id: "c1", name: "เครื่องดื่ม", kind: "category", children: [{ id: "c2", name: "น้ำอัดลม", kind: "category" }] }]);
  assert.deepEqual(M.categoryTreeOf([{ value: [{ id: "x", name: "X", aboveId: ["gone"] }] }]), [{ id: "x", name: "X", kind: "category" }]);
  assert.deepEqual(M.categoryTreeOf(undefined), []);
});

test("quoteDelivery: เหมาในระยะ · ปัดขึ้น 0.1 · ส่งฟรีครบยอด (ร้านออก) · เกินระยะ · ไม่ตั้ง maxKm = นอกระยะ · ไม่รู้ยอด = ไม่ฟรี", () => {
  const s = shop();
  const q = M.quoteDelivery(s, { distanceKm: 3.21, foodSubtotal: 100 });
  assert.deepEqual([q.roundedKm, q.fee, q.riderFee, q.shopPays, q.free, q.outOfRange], [3.3, 30, 30, 0, false, false]);
  assert.deepEqual(q.nextDeliveryTier, { minSubtotal: 500, maxOff: null, shortBy: 400, discount: 30, feeAfterDiscount: 0 });
  const f = M.quoteDelivery(s, { distanceKm: 1, foodSubtotal: 500 });
  assert.deepEqual([f.fee, f.riderFee, f.shopPays, f.free, f.deliveryDiscount], [0, 30, 30, true, 30]);
  assert.deepEqual(f.deliveryDiscountTier, { minSubtotal: 500, maxOff: null });
  assert.equal(M.quoteDelivery(s, { distanceKm: 1, foodSubtotal: null }).free, false);
  assert.equal(M.quoteDelivery(s, { distanceKm: 5, foodSubtotal: 0 }).outOfRange, false, "5.0 = ไกลสุดพอดี");
  const far = M.quoteDelivery(s, { distanceKm: 5.01, foodSubtotal: 0 });
  assert.deepEqual([far.outOfRange, far.fee, far.riderFee, far.roundedKm], [true, null, null, 5.1]);
  assert.equal(M.quoteDelivery(shop({ maxKm: null }), { distanceKm: 0, foodSubtotal: 0 }).outOfRange, true);
  assert.deepEqual(M.quoteDelivery(shop({ freeDeliveryMin: null }), { distanceKm: 1, foodSubtotal: 9999 }).deliveryDiscountRule, { enabled: false, tiers: [] });
});

test("buildMenu: รูปเมนู · ไม่มีโปร/สมาชิก/ส่วนลดกลุ่ม · ปิดรับมี closedReason · version เปลี่ยนเมื่อราคา/ค่าส่งเปลี่ยน", () => {
  const products = [{ id: "p1", ...stock({ price: 15 }) }, { id: "pOut", ...stock({ stock: 0 }) }, { id: "pC", ...stock({ customPriceStatus: true }) }];
  const m = M.buildMenu({ shop: shop(), products, now: NOW });
  assert.equal(m.providerId, "shopchamp");
  assert.deepEqual(m.products.map((p) => [p.productId, p.status, p.price]), [["p1", "available", 15], ["pOut", "out", 20]]);
  assert.deepEqual(m.products[0].optionGroups, []);
  assert.deepEqual([m.acceptingOrders, m.minOrder, m.deliveryFee, m.freeDeliveryMin, m.maxKm, m.prepMin], [true, 0, 30, 500, 5, 10]);
  for (const k of ["promos", "loyalty", "newCustomer", "groupDiscount", "closedReason"]) assert.equal(k in m, false, k);
  assert.deepEqual(m.rails, []);
  assert.match(m.menuVersion, /^[0-9a-f]{16}$/);
  const off = M.buildMenu({ shop: shop({ enabled: false }), products, now: NOW });
  assert.deepEqual([off.acceptingOrders, off.closedReason], [false, "ordering_disabled"]);
  const v2 = M.buildMenu({ shop: shop(), products: [{ id: "p1", ...stock({ price: 16 }) }, products[1]], now: NOW }).menuVersion;
  const v3 = M.buildMenu({ shop: shop({ deliveryFee: 35 }), products, now: NOW }).menuVersion;
  assert.notEqual(v2, m.menuVersion);
  assert.notEqual(v3, m.menuVersion);
  assert.equal(M.buildMenu({ shop: shop(), products, now: NOW }).menuVersion, m.menuVersion, "เนื้อเดิม = version เดิม");
});

test("configOf: productIds ตัดซ้ำ/ค่าแปลก/เกิน 1000", () => {
  const ids = Array.from({ length: 1005 }, (_, i) => `p${i}`);
  assert.equal(M.configOf(shop({ productIds: ids })).productIds.length, 1000);
  assert.deepEqual(M.configOf(shop({ productIds: ["a", "a", "", 5, "b/c", "b"] })).productIds, ["a", "b"]);
});

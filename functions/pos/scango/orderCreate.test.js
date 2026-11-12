// เทส pos/scango/orderCreate.js — สร้างใบ scangoOrder/{orderRef} · ส่งซ้ำไม่เขียนซ้ำ · server คิดราคาเอง · 409 รหัสเดียวกับสัญญา · push หลัง commit
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NOW, SHOP, OTHER, load, call, shop } = require("./_testSeed");

const order = (over) => ({
  orderId: "ord_ABC123", code: "C123", uid: "x", venueName: "ร้าน", // ScanGo ส่ง Order ทั้งก้อน (ช่องเกินใน order รับได้)
  items: [{ productId: "p1", name: "โค้ก", qty: 2, unitPrice: 15, lineTotal: 30, options: [], note: "เย็น ๆ" }, { productId: "p3", qty: 1, unitPrice: 40 }],
  subtotal: 70, deliveryFee: 30, total: 100, distanceKm: 2.04,
  payment: { method: "cash" }, customer: { name: "ลูกค้า", phone: "0811111111" }, dropPoint: { buildingName: "ตึก A", room: "101" },
  ...(over || {}),
});
const body = (over, top) => ({ externalId: SHOP, order: order(over), ...(top || {}) });

test("สร้างใบ: เขียน scangoOrder ด้วยราคาที่ server คิด · ค่าส่ง · ตัดเบอร์ไม่ทำ (ใบยังวิ่ง) · push ถึงร้าน kind shop", async () => {
  const { mem, deps, mod } = load();
  const r = await call(mod("orderCreate.js").orderCreate(deps), body());
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { providerOrderRef: "ord_ABC123", state: "requested", ok: true });
  const d = mem.store.get("scangoOrder/ord_ABC123");
  assert.deepEqual([d.shopId, d.state, d.code, d.source, d.subtotal, d.deliveryFee, d.total], [SHOP, "requested", "C123", "scango", 70, 30, 100]);
  assert.deepEqual(d.items.map((l) => [l.productId, l.qty, l.unitPrice, l.lineTotal, l.fullUnitPrice]), [["p1", 2, 15, 30, undefined], ["p3", 1, 40, 40, 50]]);
  assert.equal(d.items[0].name, "โค้ก");
  assert.equal(d.items[0].note, "เย็น ๆ");
  assert.equal(d.items[0].unit, "ขวด");
  assert.deepEqual(d.feeBreakdown, { customerFee: 30, riderFee: 30, shopPays: 0, free: false, distanceKm: 2.04, roundedKm: 2.1, estimated: false, maxKm: 5, source: "flat" });
  assert.deepEqual(d.customer, { name: "ลูกค้า", phone: "0811111111" });
  assert.deepEqual(d.payment, { method: "cash" });
  assert.equal(d.stateAt.requested.getTime(), NOW.getTime());
  assert.equal(d.billId, null);
  assert.equal(deps.pushes.length, 1);
  assert.deepEqual(deps.pushes[0].to, { kind: "shop", shopId: SHOP });
  assert.deepEqual(deps.pushes[0].data, { type: "scango_order", orderRef: "ord_ABC123" });
  assert.equal(mem.store.get("stock/p1").stock, 10, "ไม่ตัดสต๊อกตอนสั่ง");
});

test("ส่งซ้ำ: 200 duplicate คืนสถานะเดิม ไม่เขียนทับ ไม่ push ซ้ำ · แม้เมนูเปลี่ยนแล้ว · orderRef ของร้านอื่น = 409 order_ref_conflict", async () => {
  const { mem, deps, mod } = load();
  const h = mod("orderCreate.js").orderCreate(deps);
  await call(h, body());
  mem.store.set("scangoOrder/ord_ABC123", { ...mem.store.get("scangoOrder/ord_ABC123"), state: "accepted" });
  mem.store.set("stock/p1", { ...mem.store.get("stock/p1"), price: 99 });
  const n = mem.writes.length;
  const r = await call(h, body());
  assert.deepEqual([r.code, r.body.duplicate, r.body.state], [200, true, "accepted"]);
  assert.equal(mem.writes.length, n);
  assert.equal(deps.pushes.length, 1);
  const o = await call(h, { externalId: OTHER, order: order() });
  assert.deepEqual([o.code, o.body.error], [409, "order_ref_conflict"]);
});

test("ปิดรับ: สวิตช์ปิด = ordering_disabled (409 venue_not_accepting ไม่เขียน) · รอบ 5 เวลาทำการเดิมในฐานไม่ปิดรับแล้ว (ScanGo ถือ)", async () => {
  {
    const { mem, deps, mod } = load({ [`shop/${SHOP}`]: shop({ enabled: false }) });
    const r = await call(mod("orderCreate.js").orderCreate(deps), body());
    assert.deepEqual([r.code, r.body.error, r.body.reason], [409, "venue_not_accepting", "ordering_disabled"]);
    assert.equal(mem.writes.length, 0);
    assert.equal(deps.pushes.length, 0);
  }
  const { deps, mod } = load({ [`shop/${SHOP}`]: shop({ hours: [{ day: 3, open: "18:00", close: "22:00" }] }) });
  const r = await call(mod("orderCreate.js").orderCreate(deps), body());
  assert.equal(r.code, 200, JSON.stringify(r.body));
});

test("menu_changed: ราคาไม่ตรง · ไม่ส่งราคา · ไม่ได้เลือกขาย · ลบแล้ว · ร้านอื่น · ไม่มี doc · หมด · ของไม่พอ · มีตัวเลือก", async () => {
  const cases = [
    [{ productId: "p1", qty: 1, unitPrice: 14 }, "price_changed"],
    [{ productId: "p1", qty: 1 }, "price_changed"],
    [{ productId: "pNotListed", qty: 1, unitPrice: 20 }, "product_missing"],
    [{ productId: "pDel", qty: 1, unitPrice: 20 }, "product_missing"],
    [{ productId: "pOther", qty: 1, unitPrice: 20 }, "product_missing"],
    [{ productId: "ghost", qty: 1, unitPrice: 20 }, "product_missing"],
    [{ productId: "pOut", qty: 1, unitPrice: 20 }, "product_out"],
    [{ productId: "p1", qty: 11, unitPrice: 15 }, "product_out"],
    [{ productId: "p1", qty: 1, unitPrice: 15, options: [{ groupId: "g", choiceId: "c" }] }, "choice_missing"],
  ];
  for (const [item, kind] of cases) {
    const { mem, deps, mod } = load();
    const r = await call(mod("orderCreate.js").orderCreate(deps), body({ items: [item], deliveryFee: undefined }));
    assert.deepEqual([r.code, r.body.error], [409, "menu_changed"], JSON.stringify(item));
    assert.deepEqual(r.body.details.issues.map((i) => i.kind), [kind], JSON.stringify(item));
    assert.equal(mem.writes.length, 0);
  }
  const { deps, mod } = load();
  const r = await call(mod("orderCreate.js").orderCreate(deps), body({ items: [{ productId: "p1", qty: 1, unitPrice: 14 }], deliveryFee: undefined }));
  assert.deepEqual([r.body.details.issues[0].from, r.body.details.issues[0].to], [14, 15]);
  const ok = await call(mod("orderCreate.js").orderCreate(deps), body({ orderId: "ord_p2", items: [{ productId: "p2", qty: 99, unitPrice: 7 }], deliveryFee: undefined }));
  assert.equal(ok.code, 200, "ไม่ตัดสต๊อก = สั่งได้ไม่จำกัด");
});

test("ค่าส่ง: นอกระยะ 409 out_of_delivery_range · ค่าส่งไม่ตรง 409 delivery_fee_changed · ส่วนลดค่าส่งไม่ตรง 409 delivery_discount_changed · ไม่ส่งค่าส่ง = server คิดให้", async () => {
  const { mem, deps, mod } = load();
  const h = mod("orderCreate.js").orderCreate(deps);
  const far = await call(h, body({ distanceKm: 5.2 }));
  assert.deepEqual([far.code, far.body.error, far.body.maxKm, far.body.distanceKm], [409, "out_of_delivery_range", 5, 5.2]);
  const fee = await call(h, body({ deliveryFee: 25 }));
  assert.deepEqual([fee.code, fee.body.error, fee.body.from, fee.body.to], [409, "delivery_fee_changed", 25, 30]);
  const dd = await call(h, body({ deliveryDiscount: 30 }));
  assert.deepEqual([dd.code, dd.body.error, dd.body.to], [409, "delivery_discount_changed", 0]);
  assert.equal(mem.writes.length, 0);
  const none = await call(h, body({ deliveryFee: undefined }));
  assert.equal(none.code, 200);
  assert.equal(mem.store.get("scangoOrder/ord_ABC123").deliveryFee, 30);
});

test("ส่งฟรีครบยอด: ลูกค้าจ่ายค่าส่ง 0 · ไรเดอร์ได้เต็ม · ร้านออก", async () => {
  const { mem, deps, mod } = load({ [`shop/${SHOP}`]: shop({ freeDeliveryMin: 60 }) });
  const r = await call(mod("orderCreate.js").orderCreate(deps), body({ deliveryFee: 0, deliveryDiscount: 30 }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const d = mem.store.get("scangoOrder/ord_ABC123");
  assert.deepEqual([d.deliveryFee, d.total, d.feeBreakdown.riderFee, d.feeBreakdown.shopPays, d.feeBreakdown.free], [0, 70, 30, 30, true]);
});

test("ส่วนลดที่ฝั่งนี้ไม่มี (D1): โปรร้าน · ลูกค้าประจำ/ใหม่ · ส่วนลดกลุ่ม = 409 รหัสเดียวกับพี่น้อง · ส่ง 0 = ผ่าน", async () => {
  const cases = [
    [{ promotionId: "pr1", promotionDiscount: 10 }, "promotion_unavailable"],
    [{ loyaltyDiscount: 10 }, "customer_discount_changed"],
    [{ newCustomerDiscount: 5 }, "customer_discount_changed"],
    [{ groupDiscount: 7 }, "group_discount_changed"],
    [{ group: { groupId: "g", members: [{ memberId: "m" }], discount: { amount: 3 } } }, "group_discount_changed"],
  ];
  for (const [over, code] of cases) {
    const { mem, deps, mod } = load();
    const r = await call(mod("orderCreate.js").orderCreate(deps), body(over));
    assert.deepEqual([r.code, r.body.error], [409, code], JSON.stringify(over));
    assert.equal(mem.writes.length, 0);
  }
  const { deps, mod } = load();
  assert.equal((await call(mod("orderCreate.js").orderCreate(deps), body({ loyaltyDiscount: 0, groupDiscount: 0 }))).code, 200);
});

test("รูปคำขอ: ช่องเกินระดับบน · orderId ผิด · items ว่าง/qty ผิด · ไม่มีระยะ · วิธีจ่ายผิด = 400 invalid_request ไม่เขียน", async () => {
  const bads = [
    body({}, { shopId: SHOP }),
    { externalId: SHOP },
    body({ orderId: "a/b" }),
    body({ items: [] }),
    body({ items: [{ productId: "p1", qty: 0, unitPrice: 15 }] }),
    body({ items: [{ productId: "p1", qty: 1.5, unitPrice: 15 }] }),
    body({ items: [{ productId: "p1", qty: 100, unitPrice: 15 }] }),
    body({ items: [{ productId: "p1", qty: 1, unitPrice: "15" }] }),
    body({ distanceKm: undefined }),
    body({ distanceKm: -1 }),
    body({ payment: { method: "card" } }),
    body({ payment: undefined }),
    body({ deliveryFee: -1 }),
    body({ customer: "x" }),
  ];
  for (const b of bads) {
    const { mem, deps, mod } = load();
    const r = await call(mod("orderCreate.js").orderCreate(deps), b);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(b).slice(0, 120));
    assert.equal(mem.writes.length, 0);
  }
});

test("ร้านไม่มี = 404 · push พัง/โยน = ใบยังสร้างและตอบ 200", async () => {
  const { deps, mod } = load();
  assert.equal((await call(mod("orderCreate.js").orderCreate(deps), { externalId: "nope", order: order() })).code, 404);
  const x = load();
  x.deps.push = () => { throw new Error("fcm down"); };
  const r = await call(x.mod("orderCreate.js").orderCreate(x.deps), body());
  assert.equal(r.code, 200);
  assert.ok(x.mem.store.get("scangoOrder/ord_ABC123"));
});

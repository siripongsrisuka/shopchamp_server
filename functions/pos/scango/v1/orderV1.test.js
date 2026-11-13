// เทส pos/scango/v1/orderV1.js — รับใบ ScanGo Order API v1 (ฐานปลอมที่เขียนลงจริง announcement/_testDb · ❌ ไม่แตะ Firestore จริง)
//   newcomer drill: ใบใหม่ที่ราคาไม่ตรง / สินค้าหมด / ไม่มีในร้าน / มีส่วนลด / ร้านปิดสวิตช์ = ต้อง**รับ** (Pack เคาะ A 2026-11-12)
//   ปัดได้แค่รูปข้อมูลผิด · ไม่มีร้าน · orderId ซ้ำ = duplicate · เหตุการณ์ร้านกดรับ = ตัวนับใบใหม่ (scango.orderList) ลด
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { install, makeRes } = require("../../announcement/_testDb");

const NOW = new Date("2026-11-13T05:00:00.000Z");
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const OWNER = { shopId: SHOP, uid: "u-owner", role: "owner", rights: [] };

const seed = () => ({
  [`shop/${SHOP}`]: { shopId: SHOP, name: "TEST Shopchamp", humanResource: [{ id: "u-owner", position: ["001"], status: "active" }], scango: { enabled: false, productIds: ["p1"] } },
  "stock/p1": { shopId: SHOP, name: "โค้ก", price: 15, stock: 0, stockCountStatus: true },
});
const FILES = ["../_core.js", "./orderV1.js", "../shop/orderList.js"].map((f) => path.join(__dirname, f));

function load() {
  const mem = install(seed(), FILES, () => NOW);
  const pushes = [];
  const deps = { now: () => NOW, push: (m) => { pushes.push(m); return { sent: 1 }; } };
  return { mem, pushes, deps, V: require("./orderV1"), list: require("../shop/orderList").orderList };
}
async function call(factory, deps, body, params) {
  const res = makeRes();
  await factory(deps)({ body, ...(params ? { params } : {}) }, res);
  return res;
}

const ORDER = (over) => ({
  schema: "scango.order.v1", orderId: "sg-0001", code: "AB12", venueRef: SHOP, channel: "scango", placedAt: "2026-11-13T04:59:00.000Z", test: false,
  fulfillment: { mode: "delivery", timing: "asap", promisedAt: null, round: null },
  customer: { name: "ลูกค้า", phone: "0900000001", note: null },
  dropPoint: { address: "บ้าน 12", building: null, room: null, note: null, lat: 13.7, lng: 100.5, zone: null },
  // ราคา 99 ไม่ตรง POS (15) · สินค้าหมด (stock 0) · ghost ไม่มีในร้าน · มีส่วนลดโปร · ร้านปิดสวิตช์ (enabled false)
  items: [
    { lineId: "L1", productRef: "p1", name: "โค้ก", qty: 2, note: null, options: [], unitPrice: 99, lineTotal: 198 },
    { lineId: "L2", productRef: "ghost", name: "ของที่ร้านไม่มี", qty: 1, note: "ไม่ใส่น้ำแข็ง", options: [{ groupRef: "g", groupName: "ขนาด", choiceRef: "c", name: "ใหญ่", qty: 1 }], unitPrice: 10, lineTotal: 10 },
  ],
  bill: { currency: "THB", subtotal: 208, discounts: [{ kind: "promotion", title: "ลด 20", amount: 20 }], deliveryFee: 30, deliveryFeePaidBy: "customer", total: 218, payment: { method: "cash", state: "unpaid", collectedBy: "rider" } },
  group: null,
  ...(over || {}),
});
const EVENT = (type, over) => ({ schema: "scango.order-event.v1", eventId: `e-${type}`, orderId: "sg-0001", partnerOrderRef: "sg-0001", type, at: "2026-11-13T05:01:00.000Z", actor: "venue", reason: null, note: null, rider: null, ...(over || {}) });
/** ตัวนับใบใหม่ของแอป = scango.orderList {states:['requested']} (useScangoNewCount) */
async function newCount(t) {
  const res = makeRes();
  await t.list(t.deps)({ body: { shopId: SHOP, states: ["requested"] }, shopAccess: OWNER }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}

test("รับใบใหม่: ราคาไม่ตรง · สินค้าหมด · สินค้าไม่มีในร้าน · มีส่วนลด · ร้านปิดสวิตช์ = **รับ** 200 · เก็บตามที่ ScanGo ส่ง · push รูปเดิม", async () => {
  const t = load();
  const r = await call(t.V.v1OrderCreate, t.deps, ORDER());
  assert.deepEqual([r.code, r.body], [200, { ok: true, partnerOrderRef: "sg-0001" }]);
  const d = t.mem.store.get("scangoOrder/sg-0001");
  assert.equal(d.shopId, SHOP);
  assert.equal(d.orderRef, "sg-0001");
  assert.equal(d.source, "scango");
  assert.equal(d.state, "requested");
  assert.equal(d.code, "AB12");
  assert.deepEqual(d.items.map((l) => [l.productId, l.qty, l.unitPrice, l.lineTotal]), [["p1", 2, 99, 198], ["ghost", 1, 10, 10]]);
  assert.equal(d.items[1].options[0].name, "ใหญ่");
  assert.deepEqual([d.subtotal, d.deliveryFee, d.total], [208, 30, 218]);
  assert.deepEqual(d.bill.discounts, [{ kind: "promotion", title: "ลด 20", amount: 20 }]);
  assert.deepEqual(d.customer, { name: "ลูกค้า", phone: "0900000001", note: null });
  assert.deepEqual(d.payment, { method: "cash", state: "unpaid", collectedBy: "rider" });
  assert.deepEqual(d.eventIds, []);
  // ไม่แตะร้าน/สต็อก
  assert.deepEqual(t.mem.store.get(`shop/${SHOP}`).scango, { enabled: false, productIds: ["p1"] });
  assert.equal(t.mem.store.get("stock/p1").stock, 0);
  // push ถึงทั้งร้าน · data รูปเดียวกับ orderCreate รุ่นก่อน (ป๊อปอัปในแอปอ่าน)
  assert.equal(t.pushes.length, 1);
  assert.deepEqual(t.pushes[0], { to: { kind: "shop", shopId: SHOP }, heading: "ออเดอร์ ScanGo ใหม่", content: "#AB12 · 2 รายการ · ฿218", data: { type: "scango_order", orderRef: "sg-0001" } });
  // ใบใหม่โผล่ในตัวนับของแอป
  const c = await newCount(t);
  assert.deepEqual(c.orders.map((o) => o.orderRef), ["sg-0001"]);
});

test("ใบที่ไม่มี bill/code/ช่องเสริม = รับ · ยอดคิดจากบรรทัด · code = 4 ตัวท้าย orderId", async () => {
  const t = load();
  const o = ORDER({ code: undefined, bill: undefined, fulfillment: undefined, customer: undefined, dropPoint: undefined, items: [{ productRef: "p1", qty: 3, unitPrice: 15 }] });
  const r = await call(t.V.v1OrderCreate, t.deps, o);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const d = t.mem.store.get("scangoOrder/sg-0001");
  assert.deepEqual([d.code, d.subtotal, d.total, d.deliveryFee, d.items[0].lineId, d.items[0].lineTotal], ["0001", 45, 45, 0, "L1", 45]);
  assert.deepEqual(d.customer, { name: "", phone: null, note: null });
});

test("orderId ซ้ำ (ScanGo ส่งซ้ำ) = 200 duplicate · ไม่เขียนทับ (แม้ร้านกดรับไปแล้ว) · ไม่ push ซ้ำ", async () => {
  const t = load();
  await call(t.V.v1OrderCreate, t.deps, ORDER());
  await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted"), { orderId: "sg-0001" });
  const again = await call(t.V.v1OrderCreate, t.deps, ORDER({ items: [{ productRef: "p1", qty: 9, unitPrice: 1 }] }));
  assert.deepEqual([again.code, again.body], [200, { ok: true, partnerOrderRef: "sg-0001", duplicate: true }]);
  const d = t.mem.store.get("scangoOrder/sg-0001");
  assert.equal(d.state, "accepted");
  assert.equal(d.items[0].qty, 2);
  assert.equal(t.pushes.length, 1);
});

test("🔒 ปัดได้แค่รูปข้อมูลผิด → 409 order_invalid (มี code + field) · ไม่เขียน ไม่ push", async () => {
  const t = load();
  const bad = [
    [null, "body"], [ORDER({ schema: "scango.order.v0" }), "schema"], [ORDER({ orderId: "" }), "orderId"], [ORDER({ orderId: "a/b" }), "orderId"],
    [ORDER({ orderId: "x".repeat(129) }), "orderId"], [ORDER({ venueRef: "" }), "venueRef"], [ORDER({ venueRef: "a/b" }), "venueRef"], [ORDER({ items: [] }), "items"],
    [ORDER({ items: [{ qty: 1 }] }), "items[0].productRef"], [ORDER({ items: [{ productRef: "p1", qty: 0 }] }), "items[0].qty"], [ORDER({ items: [{ productRef: "p1", qty: 1.5 }] }), "items[0].qty"],
    [ORDER({ items: [{ lineId: "L1", productRef: "p1", qty: 1 }, { lineId: "L1", productRef: "p1", qty: 1 }] }), "items[1].lineId"],
    [ORDER({ fulfillment: { mode: "teleport" } }), "fulfillment.mode"], [ORDER({ customer: "x" }), "customer"], [ORDER({ bill: [] }), "bill"],
  ];
  for (const [o, field] of bad) {
    const r = await call(t.V.v1OrderCreate, t.deps, o);
    assert.deepEqual([r.code, r.body.ok, r.body.error, r.body.code, r.body.details && r.body.details.field], [409, false, "order_invalid", "order_invalid", field], JSON.stringify(o && o.orderId));
  }
  assert.equal(t.mem.writes.length, 0);
  assert.equal(t.pushes.length, 0);
});

test("🔒 ไม่มีร้านนี้ในระบบ → 409 venue_unknown · ไม่เขียน ไม่ push", async () => {
  const t = load();
  const r = await call(t.V.v1OrderCreate, t.deps, ORDER({ venueRef: "ghostShop000000000001" }));
  assert.deepEqual([r.code, r.body.error, r.body.code, r.body.details], [409, "venue_unknown", "venue_unknown", { venueRef: "ghostShop000000000001" }]);
  assert.equal(t.mem.writes.length, 0);
  assert.equal(t.pushes.length, 0);
});

test("push ล้ม = ใบยังรับ 200 (ไม่กระทบคำตอบ)", async () => {
  const t = load();
  const r = await call(t.V.v1OrderCreate, { now: () => NOW, push: () => { throw new Error("push down"); } }, ORDER());
  assert.equal(r.code, 200);
  assert.ok(t.mem.store.get("scangoOrder/sg-0001"));
});

test("เหตุการณ์: ร้านกดรับบนเว็บ ScanGo → accepted · ตัวนับใบใหม่ลด · eventId ซ้ำ = duplicate_event · ลูกค้ายกเลิกหลังรับ = ไม่มีผล · พร้อม → ready", async () => {
  const t = load();
  await call(t.V.v1OrderCreate, t.deps, ORDER());
  await call(t.V.v1OrderCreate, t.deps, ORDER({ orderId: "sg-0002", code: "CD34" }));
  assert.equal((await newCount(t)).orders.length, 2);

  const acc = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted"), { orderId: "sg-0001" });
  assert.deepEqual([acc.code, acc.body], [200, { ok: true, applied: true }]);
  const d = t.mem.store.get("scangoOrder/sg-0001");
  assert.equal(d.state, "accepted");
  assert.equal(new Date(d.stateAt.accepted).toISOString(), "2026-11-13T05:01:00.000Z");
  assert.ok(d.stateAt.requested, "stateAt เดิมคงอยู่ (dotted)");
  assert.deepEqual(d.eventIds, ["e-venue.accepted"]);
  assert.deepEqual((await newCount(t)).orders.map((o) => o.orderRef), ["sg-0002"], "ใบที่รับแล้วไม่นับเป็นใบใหม่");

  const dup = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted"), { orderId: "sg-0001" });
  assert.deepEqual(dup.body, { ok: true, applied: false, ignored: "duplicate_event" });
  const late = await call(t.V.v1OrderEvent, t.deps, EVENT("customer.cancelled", { eventId: "e-cc" }), { orderId: "sg-0001" });
  assert.deepEqual(late.body, { ok: true, applied: false, ignored: "already_in_state" });
  assert.equal(t.mem.store.get("scangoOrder/sg-0001").state, "accepted");
  const ready = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.ready", { eventId: "e-r" }), { orderId: "sg-0001" });
  assert.deepEqual([ready.body.applied, t.mem.store.get("scangoOrder/sg-0001").state], [true, "ready"]);
});

test("เหตุการณ์: ปฏิเสธ/ยกเลิก → cancelled + ลบเบอร์ · ไรเดอร์ = ข้อมูลเท่านั้นไม่แตะ state · เตือน = remindCount · ใบจบแล้วไม่ขยับ", async () => {
  const t = load();
  await call(t.V.v1OrderCreate, t.deps, ORDER());
  const rem = await call(t.V.v1OrderEvent, t.deps, EVENT("platform.reminder", { actor: "platform" }), { orderId: "sg-0001" });
  assert.equal(rem.body.applied, true);
  assert.equal(t.mem.store.get("scangoOrder/sg-0001").remindCount, 1);
  const rid = await call(t.V.v1OrderEvent, t.deps, EVENT("rider.assigned", { rider: { name: "วิน", phone: "0811111111", plate: "กข 1" } }), { orderId: "sg-0001" });
  assert.equal(rid.body.applied, true);
  let d = t.mem.store.get("scangoOrder/sg-0001");
  assert.deepEqual([d.state, d.deliveryState, d.rider], ["requested", "assigned", { name: "วิน", phone: "0811111111", plate: "กข 1" }]);
  const rej = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.rejected", { reason: "out_of_stock" }), { orderId: "sg-0001" });
  assert.equal(rej.body.applied, true);
  d = t.mem.store.get("scangoOrder/sg-0001");
  assert.deepEqual([d.state, d.cancelledBy, d.cancelReason, d.customer.phone, d.customer.name], ["cancelled", "venue", "out_of_stock", null, "ลูกค้า"]);
  const after = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted"), { orderId: "sg-0001" });
  assert.deepEqual(after.body, { ok: true, applied: false, ignored: "already_in_state" });
  assert.equal(t.mem.store.get("scangoOrder/sg-0001").state, "cancelled");
});

test("🔒 เหตุการณ์: รูปผิด = 400 order_invalid · orderId ใน body ไม่ตรง path = 400 · ไม่มีใบ/ใบไม่ใช่ scango/id ผิดรูป = 404 order_unknown · ไม่เขียน", async () => {
  const t = load();
  t.mem.store.set("scangoOrder/legacy", { shopId: SHOP, source: "other", state: "requested" });
  await call(t.V.v1OrderCreate, t.deps, ORDER());
  const w0 = t.mem.writes.length;
  for (const ev of [null, EVENT("venue.accepted", { schema: "x" }), EVENT("venue.accepted", { eventId: "" }), EVENT("venue.teleport"), EVENT("venue.accepted", { orderId: "sg-9999" })]) {
    const r = await call(t.V.v1OrderEvent, t.deps, ev, { orderId: "sg-0001" });
    assert.deepEqual([r.code, r.body.error, r.body.code], [400, "order_invalid", "order_invalid"], JSON.stringify(ev));
  }
  for (const id of ["sg-9999", "legacy", "a..b/c", ""]) {
    const r = await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted", { orderId: undefined }), { orderId: id });
    assert.deepEqual([r.code, r.body.error, r.body.code], [404, "order_unknown", "order_unknown"], id);
  }
  assert.equal(t.mem.writes.length, w0);
});

test("ถามสถานะ: pending → accepted → ready · ปฏิเสธก่อนรับ = rejected · ยกเลิกหลังรับ = cancelled · ไม่มีใบ 404 · อ่านอย่างเดียว", async () => {
  const t = load();
  await call(t.V.v1OrderCreate, t.deps, ORDER());
  const st = async (id) => (await call(t.V.v1OrderState, t.deps, {}, { orderId: id || "sg-0001" })).body;
  const w0 = t.mem.writes.length;
  assert.deepEqual(await st(), { ok: true, state: "pending", partnerOrderRef: "sg-0001", at: NOW.toISOString() });
  assert.equal(t.mem.writes.length, w0);
  await call(t.V.v1OrderEvent, t.deps, EVENT("venue.accepted"), { orderId: "sg-0001" });
  assert.equal((await st()).state, "accepted");
  await call(t.V.v1OrderEvent, t.deps, EVENT("venue.ready", { eventId: "e2" }), { orderId: "sg-0001" });
  assert.equal((await st()).state, "ready");
  await call(t.V.v1OrderEvent, t.deps, EVENT("venue.cancelled", { eventId: "e3" }), { orderId: "sg-0001" });
  assert.equal((await st()).state, "cancelled");

  await call(t.V.v1OrderCreate, t.deps, ORDER({ orderId: "sg-0002" }));
  await call(t.V.v1OrderEvent, t.deps, EVENT("venue.rejected", { orderId: "sg-0002" }), { orderId: "sg-0002" });
  assert.equal((await st("sg-0002")).state, "rejected");
  const none = await call(t.V.v1OrderState, t.deps, {}, { orderId: "sg-9999" });
  assert.deepEqual([none.code, none.body.error], [404, "order_unknown"]);
});

test("pure: partnerStateOf ครอบทุก state ของ scangoOrder (รวมใบรุ่นก่อนที่มี picked_up/delivering/delivered/failed)", () => {
  const { partnerStateOf } = require("./orderV1");
  const cases = [
    [{ state: "requested" }, "pending"], [{ state: "accepted" }, "accepted"], [{ state: "ready" }, "ready"], [{ state: "picked_up" }, "ready"], [{ state: "delivering" }, "ready"],
    [{ state: "delivered" }, "completed"], [{ state: "failed", cancelledBy: "rider", stateAt: { accepted: 1 } }, "cancelled"], [{ state: "cancelled", cancelledBy: "venue" }, "rejected"],
    [{ state: "cancelled", cancelledBy: "venue", stateAt: { accepted: 1 } }, "cancelled"], [{ state: "cancelled", cancelledBy: "customer" }, "cancelled"],
  ];
  for (const [d, want] of cases) assert.equal(partnerStateOf(d), want, JSON.stringify(d));
});

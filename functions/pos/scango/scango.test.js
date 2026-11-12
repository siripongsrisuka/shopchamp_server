// เทส pos/scango (ท่อข่าวออก · outbox sweep · สถานะไรเดอร์ · ปิดบิล · ปุ่มร้าน) · รัน: node --test functions/pos/scango/scango.test.js
//   ฐานปลอม = announcement/_testDb.js (เขียนลงจริงในหน่วยความจำ) · ❌ ไม่แตะ Firestore จริง · ❌ ไม่ออกเน็ต (http ฉีด)
//   closeBill เดินผ่าน sale/create.js ตัวจริงในโปรเซส ⇒ พิสูจน์ว่าเลขบิล/ตัดสต็อก/guard มาจากแกนเดียวกัน
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const T = require("../announcement/_testDb");

const NOW = new Date("2026-11-11T05:00:00.000Z");
const mem = T.install({}, [], () => NOW);
const here = (f) => path.join(__dirname, f);
for (const f of ["_outbound.js", "_orderActions.js", "closeBill.js", "orderDelivery.js", "outboxSweep.js", "../sale/create.js"]) {
  delete require.cache[require.resolve(here(f))];
}
const OB = require("./_outbound");
const OA = require("./_orderActions");
const CB = require("./closeBill");
const OD = require("./orderDelivery");
const SW = require("./outboxSweep");

const ENV = { SCANGO_BASE_URL: "https://scango.example/api/", SCANGO_SHOPCHAMP_KEY: "k-test" };
const quiet = { info() {}, warn() {}, error() {} };
let calls = [];
const httpOk = async (url, body, opts) => { calls.push({ url, body, opts }); return { status: 200, data: { ok: true } }; };
const httpStatus = (status) => async (url, body, opts) => {
  calls.push({ url, body, opts });
  const e = new Error(`status ${status}`); e.response = { status, data: { ok: false, error: "x" } }; throw e;
};
const deps = (x = {}) => ({ env: ENV, http: httpOk, log: quiet, now: () => NOW, ...x });

const get = (p) => { const d = mem.store.get(p); return d === undefined ? undefined : structuredClone(d); };
const docsOf = (coll) => [...mem.store.keys()].filter((k) => k.startsWith(coll + "/") && k.split("/").length === 2);

function seed(extra = {}) {
  mem.store.clear();
  const base = {
    "shop/shopA": {
      shopId: "shopA", name: "ร้านเอ", tel: "021234567", receiptPattern: "month",
      shopchampPayment: [{ id: 1, name: "เงินสด" }, { id: 2, name: "โอน/พร้อมเพย์" }],
      scango: { enabled: true, location: { lat: 13.7, lng: 100.5 }, hours: [{ day: 1, open: "08:00", close: "20:00" }], minOrder: 50, deliveryFee: 20, freeDeliveryMin: null, maxKm: 5, prepMinutes: 15, paymentQr: "qr://shopA", pickupNote: "หน้าร้าน", productIds: ["p1", "p2"] },
    },
    "billId/shopA": { month: 11, receipts: 41 },
    "stock/p1": { shopId: "shopA", name: "น้ำดื่ม", stockCountStatus: true, stock: 10, cost: 4, category: ["c1"], barcode: "885" },
    "stock/p2": { shopId: "shopA", name: "ขนม", stockCountStatus: false, stock: 0, cost: 7 },
    "scangoOrder/R1": order(),
  };
  for (const [p, d] of Object.entries({ ...base, ...extra })) if (d !== null) mem.store.set(p, structuredClone(d));
  calls = [];
}
function order(x = {}) {
  return {
    shopId: "shopA", code: "A7", state: "requested", payment: { method: "cash" },
    lines: [
      { id: "p1", name: "น้ำดื่ม", qty: 2, unitPrice: 10, lineTotal: 20 },
      { id: "p2", name: "ขนม", qty: 1, unitPrice: 15, lineTotal: 12, fullLineTotal: 15, priceType: "ราคาโปรโมชั่น" },
    ],
    subtotal: 32, deliveryFee: 25, total: 57, notified: {},
    ...x,
  };
}
beforeEach(() => seed());

// ───────────── _outbound ─────────────
test("outbound · ยิงออก: URL ตัด / ท้าย base · header กุญแจ · timeout 5 วิ · ไม่ลง outbox", async () => {
  const out = await OB.sendEvent({ path: OB.ORDER_EVENT_PATH, payload: { orderRef: "R1", type: "accepted" }, eventId: "R1:accepted" }, deps());
  assert.deepEqual(out, { sent: true, queued: false });
  assert.equal(calls[0].url, "https://scango.example/api/provider/shopchamp/order/event");
  assert.equal(calls[0].opts.headers["x-scango-platform-key"], "k-test");
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(docsOf("scangoOutbox").length, 0);
});
test("outbound · 503 = ลง scangoOutbox/{eventId} pending · queued true · ไม่โยน", async () => {
  const out = await OB.sendEvent({ path: OB.ORDER_EVENT_PATH, payload: { orderRef: "R1", type: "ready", at: "x" }, eventId: "R1:ready" }, deps({ http: httpStatus(503) }));
  assert.equal(out.sent, false); assert.equal(out.queued, true); assert.equal(out.status, 503);
  const row = get("scangoOutbox/R1:ready");
  assert.equal(row.state, "pending"); assert.equal(row.path, OB.ORDER_EVENT_PATH); assert.equal(row.orderRef, "R1");
  assert.equal(row.attempts, 1); assert.equal(row.nextAttemptAt.getTime(), NOW.getTime());
});
test("outbound · 400 (ScanGo ปฏิเสธ) = แถว dead ไม่ลองซ้ำ · queued false", async () => {
  const out = await OB.sendEvent({ path: OB.VENUE_EVENT_PATH, payload: { type: "venue_ordering" }, eventId: "v1" }, deps({ http: httpStatus(400) }));
  assert.equal(out.queued, false); assert.equal(out.reason, "rejected");
  assert.equal(get("scangoOutbox/v1").state, "dead"); assert.equal(get("scangoOutbox/v1").nextAttemptAt, null);
});
test("outbound · env ไม่ครบ = ไม่ยิง ไม่ลง outbox · reason not_configured", async () => {
  const out = await OB.sendEvent({ path: OB.ORDER_EVENT_PATH, payload: {}, eventId: "e" }, deps({ env: { SCANGO_BASE_URL: "https://x" } }));
  assert.deepEqual(out, { sent: false, queued: false, reason: "not_configured" });
  assert.equal(calls.length, 0); assert.equal(docsOf("scangoOutbox").length, 0);
});
test("outbound · ลง outbox ซ้ำ eventId เดิม = ไม่ทับแถวเดิม", async () => {
  mem.store.set("scangoOutbox/R1:ready", { state: "pending", attempts: 4, payload: { orderRef: "R1" } });
  await OB.sendEvent({ path: OB.ORDER_EVENT_PATH, payload: { orderRef: "R1" }, eventId: "R1:ready" }, deps({ http: httpStatus(500) }));
  assert.equal(get("scangoOutbox/R1:ready").attempts, 4);
});
test("outbound · notifyOrder: ยิงแล้วเขียนธง notified · รอบสองไม่ยิงซ้ำ", async () => {
  const a = await OB.notifyOrder({ orderRef: "R1", type: "accepted" }, deps());
  assert.equal(a.sent, true);
  assert.deepEqual(calls[0].body, { orderRef: "R1", type: "accepted", at: NOW.toISOString(), eventId: "R1:accepted" });
  assert.equal(get("scangoOrder/R1").notified.accepted, true);
  const b = await OB.notifyOrder({ orderRef: "R1", type: "accepted" }, deps());
  assert.equal(b.reason, "already_notified"); assert.equal(calls.length, 1);
});
test("outbound · notifyOrder: ยิงไม่ออกแต่ลง outbox = เขียนธง (ตัวกวาดรับช่วง) · env ไม่ตั้ง = ไม่เขียนธง", async () => {
  await OB.notifyOrder({ orderRef: "R1", type: "cancelled", reason: "หมด" }, deps({ http: httpStatus(502) }));
  assert.equal(get("scangoOrder/R1").notified.cancelled, true);
  assert.equal(get("scangoOutbox/R1:cancelled").payload.reason, "หมด");
  await OB.notifyOrder({ orderRef: "R1", type: "ready" }, deps({ env: {} }));
  assert.equal(get("scangoOrder/R1").notified.ready, undefined);
});
test("outbound · venuePayloadOf: รูป venue_ordering ที่ ScanGo อ่าน (paymentQr เป็นลิงก์รูป = null · pickup มีพิกัด/เบอร์ · รอบ 5 ไม่ส่งเวลา/เวลาเตรียม/ส่งฟรี · สูตรค่าส่ง)", () => {
  const p = OB.venuePayloadOf("shopA", get("shop/shopA"), NOW);
  assert.equal(p.type, "venue_ordering"); assert.equal(p.externalId, "shopA"); assert.equal(p.name, "ร้านเอ");
  assert.deepEqual(p.geo, { lat: 13.7, lng: 100.5 }); assert.equal(p.phone, "021234567"); assert.equal(p.address, null);
  assert.equal(p.enabled, true); assert.equal(p.acceptingOrders, true); assert.equal(p.maxKm, 5);
  assert.deepEqual(p.deliveryFeeModel, { distance: "road", baseKm: 5, baseFee: 20, bands: [] }); assert.equal(p.deliveryFee, 20); assert.equal(p.deliveryFeeSource, "legacy");
  for (const k of ["businessHours", "prepMinutes", "freeDeliveryMin"]) assert.equal(k in p, false, k);
  // "qr://shopA" ไม่ใช่เลขพร้อมเพย์ ⇒ ScanGo ใช้สร้าง QR ไม่ได้ = ส่ง null (ร้านรับเงินสดอย่างเดียวบน ScanGo)
  assert.equal(p.transferEnabled, false); assert.equal(p.paymentQr, null); assert.equal(p.vertical, "retail");
  assert.deepEqual(p.pickup, { name: "ร้านเอ", address: "", lat: 13.7, lng: 100.5, phone: "021234567", note: "หน้าร้าน" });
  assert.equal(p.at, NOW.toISOString()); assert.equal(p.eventId, `venue:shopA:${NOW.getTime()}`);
  const off = OB.venuePayloadOf("shopB", { scango: { enabled: true, productIds: [] } }, NOW);
  assert.equal(off.acceptingOrders, false); assert.equal("geo" in off, false, "ไม่รู้พิกัด = ไม่ส่งช่อง (ScanGo ถือพิกัด)"); assert.equal(off.transferEnabled, false); assert.equal(off.paymentQr, null);
  assert.deepEqual(off.pickup, { name: "", address: "", lat: null, lng: null, phone: "", note: null });
  // เลขพร้อมเพย์ (เบอร์ 10 · บัตร 13 · e-wallet 15 · มีขีด/ช่องว่างได้) = ส่งรูป {type, id, name} · เลขผิดหลัก = null
  const pp = OB.venuePayloadOf("shopA", { ...get("shop/shopA"), scango: { ...get("shop/shopA").scango, paymentQr: "081-234-5678" } }, NOW);
  assert.deepEqual(pp.paymentQr, { type: "promptpay", id: "0812345678", name: "ร้านเอ" }); assert.equal(pp.transferEnabled, true);
  assert.equal(OB.promptpayIdOf("1 2345 67890 12 3"), "1234567890123"); assert.equal(OB.promptpayIdOf("123456789012345"), "123456789012345");
  assert.equal(OB.promptpayIdOf("12345"), null); assert.equal(OB.promptpayIdOf("https://x/qr.png"), null);
  assert.equal(OB.promptpayIdOf("1812345678"), null, "เบอร์ 10 หลักต้องขึ้นต้น 0 (กฎต้นแบบ)");
  // ไม่ผูกพิกัด: เปิด + มีสินค้า = acceptingOrders true แม้ไม่มีพิกัด
  assert.equal(OB.venuePayloadOf("shopB", { scango: { enabled: true, productIds: ["p1"] } }, NOW).acceptingOrders, true);
  // รอบ 5 พร้อมเพย์ = ค่าตั้ง POS (shop.receipt.promptpayId + promptpayStatus) ก่อน · ปิดสถานะ = ถอยไป scango.paymentQr เดิม
  const base = get("shop/shopA");
  const rc = OB.venuePayloadOf("shopA", { ...base, receipt: { promptpayStatus: true, promptpayId: "0899999999" }, scango: { ...base.scango, paymentQr: "081-234-5678" } }, NOW);
  assert.deepEqual(rc.paymentQr, { type: "promptpay", id: "0899999999", name: "ร้านเอ" });
  const rcOff = OB.venuePayloadOf("shopA", { ...base, receipt: { promptpayStatus: false, promptpayId: "0899999999" }, scango: { ...base.scango, paymentQr: "081-234-5678" } }, NOW);
  assert.equal(rcOff.paymentQr.id, "0812345678");
  assert.equal(OB.venuePayloadOf("shopA", { ...base, receipt: { promptpayStatus: false, promptpayId: "0899999999" } }, NOW).paymentQr, null);
  // สูตรแบบช่วงที่ตั้งจากเว็บ = ชนะค่าเดิม · maxKm = ขอบช่วงสุดท้าย
  const md = OB.venuePayloadOf("shopA", { ...base, scango: { ...base.scango, deliveryFeeModel: { baseKm: 2, baseFee: 25, bands: [{ toKm: 8, perKm: 5 }] } } }, NOW);
  assert.deepEqual([md.maxKm, md.deliveryFee, md.deliveryFeeSource], [8, 25, "model"]);
});
test("outbound · notifyVenue ยิงไปเส้น /provider/shopchamp/event", async () => {
  const r = await OB.notifyVenue("shopA", null, deps());
  assert.equal(r.sent, true); assert.ok(calls[0].url.endsWith("/provider/shopchamp/event"));
});

// ───────────── _orderActions ─────────────
const sent = [];
const fakeNotify = async (ev) => { sent.push(ev); return { sent: true, queued: false }; };
test("actions · accept → ready ตามลำดับ · ยิงข่าวทุกขั้น", async () => {
  sent.length = 0;
  const a = await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "accept", by: { uid: "u1", name: "แคชเชียร์" } }, deps({ notifyOrder: fakeNotify }));
  assert.equal(a.ok, true); assert.equal(a.state, "accepted"); assert.equal(a.changed, true);
  assert.equal(get("scangoOrder/R1").state, "accepted");
  assert.equal(get("scangoOrder/R1").stateAt.accepted.getTime(), NOW.getTime());
  const r = await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "ready" }, deps({ notifyOrder: fakeNotify }));
  assert.equal(r.state, "ready");
  assert.deepEqual(sent.map((e) => e.type), ["accepted", "ready"]);
});
test("actions · ready ก่อนรับ = 409 invalid_state · ใบร้านอื่น = 404 · action แปลก = 400", async () => {
  assert.equal((await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "ready" }, deps({ notifyOrder: fakeNotify }))).error, "invalid_state");
  assert.equal((await OA.applyAction({ shopId: "shopB", orderRef: "R1", action: "accept" }, deps({ notifyOrder: fakeNotify }))).status, 404);
  assert.equal((await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "cook" }, deps())).status, 400);
  assert.equal(get("scangoOrder/R1").state, "requested");
});
test("actions · reject ต้องมีเหตุผล · ไรเดอร์รับงานแล้วปฏิเสธไม่ได้ · ปฏิเสธได้ = cancelled + reason", async () => {
  assert.equal(OA.planAction(order(), "reject", { now: NOW }).error, "reason_required");
  assert.equal(OA.planAction(order({ state: "accepted", rider: { name: "วิน" } }), "reject", { reason: "หมด", now: NOW }).error, "rider_assigned");
  sent.length = 0;
  const r = await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "reject", reason: "ของหมด" }, deps({ notifyOrder: fakeNotify }));
  assert.equal(r.state, "cancelled");
  const o = get("scangoOrder/R1");
  assert.equal(o.cancelReason, "ของหมด"); assert.equal(o.cancelledBy, "shop");
  assert.deepEqual({ type: sent[0].type, reason: sent[0].reason }, { type: "cancelled", reason: "ของหมด" });
  assert.equal(OA.planAction(o, "accept", { now: NOW }).error, "invalid_state");
});
test("actions · กดรับซ้ำ = changed false ไม่เขียน · ยังส่งข่าว (ธงกันซ้ำที่ _outbound)", async () => {
  seed({ "scangoOrder/R1": order({ state: "accepted" }) });
  const before = mem.writes.length;
  sent.length = 0;
  const r = await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "accept" }, deps({ notifyOrder: fakeNotify }));
  assert.equal(r.changed, false); assert.equal(mem.writes.length, before); assert.equal(sent.length, 1);
});
test("actions · ใช้ _outbound จริง: accept ยิง order/event + ธง notified", async () => {
  const r = await OA.applyAction({ shopId: "shopA", orderRef: "R1", action: "accept" }, deps());
  assert.equal(r.notify.sent, true);
  assert.equal(calls[0].body.type, "accepted"); assert.equal(get("scangoOrder/R1").notified.accepted, true);
});

// ───────────── closeBill (sale.create ตัวจริง) ─────────────
const bills = () => docsOf("bill").map((p) => ({ id: p.slice(5), ...get(p) }));
test("closeBill · ปิดบิลด้วยแกน sale.create: เลขบิล · ตัดสต็อก · guard · ค่าส่งไม่เข้าบิล · ช่องเงินสด id 1", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered" }) });
  const r = await CB.closeBill({ orderRef: "R1" }, deps());
  assert.equal(r.ok, true, JSON.stringify(r));
  const [b] = bills();
  assert.equal(bills().length, 1);
  assert.equal(b.receiptNumber, "202611000042");
  assert.equal(b.moneyMustPaid, 32);
  assert.equal(b.productDiscount, 3);
  assert.deepEqual(b.payment, [{ id: 1, amount: 32, name: "เงินสด", change: 0 }]);
  assert.equal(b.note, "ScanGo #A7"); assert.equal(b.cashierName, "ScanGo");
  assert.equal(b.receiptUUID, "scango-R1");
  assert.deepEqual(b.scango, { orderRef: "R1", code: "A7" });
  assert.equal(b.product[0].totalCost, 8); assert.deepEqual(b.product[0].category, ["c1"]); assert.equal(b.product[0].barcode, "885");
  assert.equal(b.product[1].totalPrice, 15); assert.equal(b.product[1].net, 12);
  assert.equal(get("stock/p1").stock, 8, "ตัดสต็อกตัวที่นับ");
  assert.equal(get("stock/p2").stock, 0, "ตัวที่ไม่นับสต็อกไม่ถูกตัด");
  assert.equal(get("billId/shopA").receipts, 42);
  assert.equal(get("receiptGuard/scango-R1").billId, b.id);
  const o = get("scangoOrder/R1");
  assert.equal(o.billId, b.id); assert.equal(o.receiptNumber, "202611000042"); assert.equal(o.billPending, null);
});
test("closeBill · โอน = แถวจ่าย id 2 ชื่อจากร้าน", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered", payment: { method: "transfer" } }) });
  await CB.closeBill({ orderRef: "R1" }, deps());
  assert.deepEqual(bills()[0].payment, [{ id: 2, amount: 32, name: "โอน/พร้อมเพย์", change: 0 }]);
});
test("closeBill · เรียกซ้ำ = alreadyClosed · ประทับ billId หาย = sale.create ตอบ duplicate บิลเดิม (ไม่มีบิลที่ 2 · สต็อกไม่ตัดซ้ำ)", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered" }) });
  const first = await CB.closeBill({ orderRef: "R1" }, deps());
  assert.equal((await CB.closeBill({ orderRef: "R1" }, deps())).alreadyClosed, true);
  const o = get("scangoOrder/R1"); delete o.billId; mem.store.set("scangoOrder/R1", o);
  const again = await CB.closeBill({ orderRef: "R1" }, deps());
  assert.equal(again.ok, true); assert.equal(again.duplicate, true); assert.equal(again.billId, first.billId);
  assert.equal(bills().length, 1); assert.equal(get("stock/p1").stock, 8);
});
test("closeBill · ใบที่ยังไม่ delivered = ไม่ออกบิล", async () => {
  const r = await CB.closeBill({ orderRef: "R1" }, deps());
  assert.equal(r.reason, "not_delivered"); assert.equal(bills().length, 0);
});
test("closeBill · ล้ม = billPending + เลื่อนเวลา · retryPending ถึงเวลาแล้วปิดได้", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered" }) });
  const r = await CB.closeBill({ orderRef: "R1" }, deps({ createSale: async () => ({ ok: false, status: 500, error: "counter_failed" }) }));
  assert.equal(r.pending, true);
  let o = get("scangoOrder/R1");
  assert.equal(o.billPending.attempts, 1); assert.equal(o.billPending.reason, "sale_create_failed");
  assert.equal(o.billNextAttemptAt.getTime(), NOW.getTime() + 60000);
  assert.deepEqual(await CB.retryPending({ now: NOW }, deps()), { picked: 0, closed: 0, failed: 0 }, "ยังไม่ถึงเวลา");
  const later = new Date(NOW.getTime() + 61000);
  const st = await CB.retryPending({ now: later }, deps({ now: () => later }));
  assert.deepEqual(st, { picked: 1, closed: 1, failed: 0 });
  o = get("scangoOrder/R1");
  assert.ok(o.billId); assert.equal(o.billPending, null); assert.equal(o.billNextAttemptAt, null);
});
test("closeBill · ล้มครบ MAX_ATTEMPTS = หยุดลอง (billNextAttemptAt null)", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered", billPending: { attempts: CB.MAX_ATTEMPTS - 1 } }) });
  await CB.closeBill({ orderRef: "R1" }, deps({ createSale: async () => ({ ok: false, status: 500 }) }));
  assert.equal(get("scangoOrder/R1").billNextAttemptAt, null);
});
test("closeBill · saleBodyOf ไม่มีแถว / แถวเพี้ยน = ไม่ส่งให้ sale.create", () => {
  assert.equal(CB.saleBodyOf({ shopId: "s", orderRef: "R", order: { lines: [] }, shop: {} }).reason, "no_lines");
  assert.equal(CB.saleBodyOf({ shopId: "s", orderRef: "R", order: { lines: [{ id: "a/b", qty: 1, lineTotal: 1 }] }, shop: {} }).reason, "bad_line");
});

// ───────────── orderDelivery ─────────────
const partnerOk = () => null;
async function deliver(body, x = {}) {
  const res = T.makeRes();
  await OD.orderDelivery(deps({ checkPartner: partnerOk, ...x }))({ body, headers: {} }, res);
  return res;
}
test("delivery · partner ไม่ผ่าน = ตอบตาม gate ไม่แตะฐาน", async () => {
  const res = await deliver({ externalId: "shopA", orderRef: "R1", state: "picked_up" }, { checkPartner: () => ({ status: 401, error: "bad_platform_key" }) });
  assert.equal(res.code, 401); assert.equal(res.body.error, "bad_platform_key");
  assert.equal(get("scangoOrder/R1").state, "requested");
});
test("delivery · 400 state แปลก · 404 ใบร้านอื่น", async () => {
  assert.equal((await deliver({ externalId: "shopA", orderRef: "R1", state: "eaten" })).code, 400);
  assert.equal((await deliver({ externalId: "shopB", orderRef: "R1", state: "picked_up" })).code, 404);
});
test("delivery · assigned เก็บไรเดอร์ไม่แตะ state · picked_up เดินหน้า · eventId ซ้ำ = duplicate", async () => {
  seed({ "scangoOrder/R1": order({ state: "ready" }) });
  let res = await deliver({ externalId: "shopA", orderRef: "R1", state: "assigned", rider: { name: "วิน", phone: "08" }, eventId: "e1", at: "2026-11-11T04:59:00.000Z" });
  assert.equal(res.code, 200); assert.equal(res.body.riderAssigned, true);
  let o = get("scangoOrder/R1");
  assert.equal(o.state, "ready"); assert.equal(o.rider.name, "วิน");
  res = await deliver({ externalId: "shopA", orderRef: "R1", state: "picked_up", eventId: "e2" });
  assert.equal(res.body.state, "picked_up"); assert.equal(res.body.changed, true);
  res = await deliver({ externalId: "shopA", orderRef: "R1", state: "picked_up", eventId: "e2" });
  assert.equal(res.body.duplicate, true);
  res = await deliver({ externalId: "shopA", orderRef: "R1", state: "assigned", rider: { name: "เก่า" }, eventId: "e3", at: "2026-11-11T04:00:00.000Z" });
  assert.equal(get("scangoOrder/R1").rider.name, "วิน", "assigned ที่ at เก่ากว่า = ทิ้ง");
  o = get("scangoOrder/R1"); assert.deepEqual(o.deliveryEvents, ["e1", "e2", "e3"]);
});
test("delivery · ย้อนลำดับไม่ได้ · ใบยกเลิกแล้ว = 409", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivering" }) });
  const res = await deliver({ externalId: "shopA", orderRef: "R1", state: "picked_up" });
  assert.equal(res.body.changed, false); assert.equal(get("scangoOrder/R1").state, "delivering");
  seed({ "scangoOrder/R1": order({ state: "cancelled" }) });
  assert.equal((await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered" })).code, 409);
});
test("delivery · failed = state failed + ธง notified.cancelled (ไม่ยิงกลับ) · ไม่มีบิล", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivering" }) });
  let closeCalls = 0;
  const res = await deliver({ externalId: "shopA", orderRef: "R1", state: "failed", reason: "ติดต่อลูกค้าไม่ได้" }, { closeBill: async () => { closeCalls++; } });
  assert.equal(res.body.state, "failed");
  const o = get("scangoOrder/R1");
  assert.equal(o.failReason, "ติดต่อลูกค้าไม่ได้"); assert.equal(o.notified.cancelled, true); assert.equal(closeCalls, 0);
});
test("delivery · delivered = ปิดบิล (closeBill ตัวจริง) · ส่งซ้ำ = บิลใบเดียว", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivering" }) });
  const res = await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered", eventId: "d1" });
  assert.equal(res.code, 200); assert.equal(res.body.state, "delivered");
  assert.ok(get("scangoOrder/R1").billId);
  await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered", eventId: "d1" });
  await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered", eventId: "d2" });
  assert.equal(bills().length, 1);
});
test("delivery · closeBill ล้ม/โยน = คำตอบ ScanGo ยัง 200 · ข่าวซ้ำของใบที่บิลยังค้าง = ลองปิดอีกรอบ", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivering" }) });
  let n = 0;
  const err = console.error; console.error = () => {};
  try {
    const res = await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered", eventId: "d1" }, { closeBill: async () => { n++; throw new Error("boom"); } });
    assert.equal(res.code, 200);
    await deliver({ externalId: "shopA", orderRef: "R1", state: "delivered", eventId: "d1" }, { closeBill: async () => { n++; return { ok: true }; } });
  } finally { console.error = err; }
  assert.equal(n, 2);
});

// ───────────── outboxSweep ─────────────
function outboxRow(id, x = {}) {
  return { eventId: id, path: OB.ORDER_EVENT_PATH, payload: { orderRef: "R1", type: "accepted", at: "2026-11-11T04:00:00.000Z", eventId: id }, state: "pending", attempts: 1, createdAt: new Date(NOW.getTime() - 60000), nextAttemptAt: new Date(NOW.getTime() - 1000), ...x };
}
test("sweep · สำเร็จ = ลบแถว · พัง 5xx = attempts+1 + backoff · 4xx = dead · ยังไม่ถึงเวลา = ไม่แตะ", async () => {
  seed({
    "scangoOutbox/ok": outboxRow("ok"),
    "scangoOutbox/retry": outboxRow("retry", { payload: { orderRef: "R2", at: "2026-11-11T04:00:00.000Z" } }),
    "scangoOutbox/reject": outboxRow("reject", { payload: { orderRef: "R3" } }),
    "scangoOutbox/later": outboxRow("later", { nextAttemptAt: new Date(NOW.getTime() + 60000) }),
    "scangoOutbox/dead": outboxRow("dead", { state: "dead", nextAttemptAt: null }),
  });
  const post = async (p, payload) => {
    calls.push(payload);
    if (payload.orderRef === "R2") return { sent: false, reason: "failed", status: 503 };
    if (payload.orderRef === "R3") return { sent: false, reason: "failed", status: 400 };
    return { sent: true };
  };
  const st = await SW.sweepOutbox({ now: NOW, post }, deps());
  assert.deepEqual(st, { picked: 3, sent: 1, retry: 1, dead: 1 });
  assert.equal(get("scangoOutbox/ok"), undefined);
  const r = get("scangoOutbox/retry");
  assert.equal(r.attempts, 2); assert.equal(r.nextAttemptAt.getTime(), NOW.getTime() + SW.backoffMs(2));
  assert.equal(get("scangoOutbox/reject").state, "dead");
  assert.equal(get("scangoOutbox/later").attempts, 1);
});
test("sweep · ใบเดียวกันยิงตาม at เก่า→ใหม่ · payload เดิมทุกไบต์", async () => {
  seed({
    "scangoOutbox/b": outboxRow("b", { payload: { orderRef: "R1", type: "ready", at: "2026-11-11T04:30:00.000Z" } }),
    "scangoOutbox/a": outboxRow("a", { payload: { orderRef: "R1", type: "accepted", at: "2026-11-11T04:10:00.000Z" } }),
  });
  const order_ = [];
  await SW.sweepOutbox({ now: NOW, post: async (p, payload) => { order_.push(payload.type); return { sent: true }; } }, deps());
  assert.deepEqual(order_, ["accepted", "ready"]);
});
test("sweep · ครบ MAX_ATTEMPTS / อายุเกิน 24 ชม. = dead", () => {
  const nowMs = NOW.getTime();
  assert.equal(SW.nextStateOf({ attempts: SW.MAX_ATTEMPTS - 1 }, { sent: false, status: 503 }, nowMs).state, "dead");
  assert.equal(SW.nextStateOf({ attempts: 1, createdAt: new Date(nowMs - SW.MAX_AGE_MS - 1) }, { sent: false }, nowMs).state, "dead");
  assert.equal(SW.nextStateOf({ attempts: 1 }, { sent: false, reason: "not_configured" }, nowMs).state, "pending");
});
test("sweep · runSweep ทำ outbox แล้วปิดบิลค้าง · ยิงจริงผ่าน postRaw ด้วย env", async () => {
  seed({
    "scangoOutbox/x": outboxRow("x"),
    "scangoOrder/R1": order({ state: "delivered", billPending: { attempts: 1 }, billNextAttemptAt: new Date(NOW.getTime() - 1) }),
  });
  const s = await SW.runSweep({ now: NOW }, deps());
  assert.deepEqual(s.outbox, { picked: 1, sent: 1, retry: 0, dead: 0 });
  assert.deepEqual(s.bills, { picked: 1, closed: 1, failed: 0 });
  assert.equal(calls[0].opts.headers["x-scango-platform-key"], "k-test");
  assert.ok(get("scangoOrder/R1").billId);
});

// ───────────── ต่อกับไฟล์ของจออื่น ─────────────
test("delivery · ด่านกุญแจจริง (_partnerAuth): ไม่มี header = 401 · กุญแจถูก = ผ่าน", async () => {
  const h = OD.orderDelivery(deps());
  let res = T.makeRes();
  await h({ body: { externalId: "shopA", orderRef: "R1", state: "picked_up" }, headers: {} }, res);
  assert.equal(res.code, 401);
  res = T.makeRes();
  await h({ body: { externalId: "shopA", orderRef: "R1", state: "picked_up" }, headers: { "x-scango-platform-key": "k-test" } }, res);
  assert.equal(res.code, 200);
});
test("closeBill · รูปใบจาก orderCreate.js (items · productId · fullUnitPrice)", async () => {
  seed({ "scangoOrder/R1": order({ state: "delivered", lines: undefined, items: [
    { lineId: "1", productId: "p1", name: "น้ำดื่ม", qty: 3, unitPrice: 9, fullUnitPrice: 10, lineTotal: 27, priceType: "ราคาโปรโมชั่น", category: ["x"], barcode: "" },
  ] }) });
  const r = await CB.closeBill({ orderRef: "R1" }, deps());
  assert.equal(r.ok, true, JSON.stringify(r));
  const b = bills()[0];
  assert.deepEqual({ id: b.product[0].id, qty: b.product[0].qty, net: b.product[0].net, totalPrice: b.product[0].totalPrice, totalCost: b.product[0].totalCost }, { id: "p1", qty: 3, net: 27, totalPrice: 30, totalCost: 12 });
  assert.equal(b.moneyMustPaid, 27); assert.equal(get("stock/p1").stock, 7);
});
test("actions · รูปที่ shop/orderAction.js เรียก: accept(deps, {order, actor}) · ปัด = deny มี extra.state", async () => {
  const ok1 = await OA.accept(deps({ notifyOrder: fakeNotify }), { order: { ...get("scangoOrder/R1"), orderRef: "R1" }, actor: { uid: "u1", role: "staff" } });
  assert.equal(ok1.ok, true); assert.equal(ok1.state, "accepted");
  assert.deepEqual(get("scangoOrder/R1").acceptBy, { uid: "u1", name: null });
  const bad = await OA.reject(deps({ notifyOrder: fakeNotify }), { order: { ...get("scangoOrder/R1"), orderRef: "R1" }, actor: {}, reason: "" });
  assert.deepEqual(bad, { ok: false, status: 400, error: "reason_required" });
  seed({ "scangoOrder/R1": order({ state: "delivered" }) });
  const st = await OA.ready(deps({ notifyOrder: fakeNotify }), { order: { ...get("scangoOrder/R1"), orderRef: "R1" } });
  assert.deepEqual(st, { ok: false, status: 409, error: "invalid_state", extra: { state: "delivered" } });
});
test("outbound · sendVenue(deps, {shopId}) อ่านร้านล่าสุดแล้วยิง · คืน status ตามจริง: sent · queued · skipped · failed", async () => {
  const r = await OB.sendVenue(deps(), { shopId: "shopA", enabled: true, settings: {} });
  assert.equal(r.status, "sent"); assert.equal(r.sent, true); assert.equal(calls[0].body.externalId, "shopA"); assert.equal(calls[0].body.type, "venue_ordering");
  const q = await OB.sendVenue(deps({ http: httpStatus(503) }), { shopId: "shopA" });
  assert.equal(q.status, "queued"); assert.equal(q.httpStatus, 503); assert.equal(docsOf("scangoOutbox").length, 1);
  const s = await OB.sendVenue(deps({ env: {} }), { shopId: "shopA" });
  assert.equal(s.status, "skipped"); assert.equal(s.reason, "not_configured");
  const f = await OB.sendVenue(deps({ http: httpStatus(400) }), { shopId: "shopA" });
  assert.equal(f.status, "failed"); assert.equal(f.reason, "rejected");
  const nf = await OB.sendVenue(deps(), { shopId: "ไม่มีร้านนี้" });
  assert.equal(nf.status, "failed"); assert.equal(nf.reason, "shop_not_found");
  assert.deepEqual(["sent", "queued", "skipped", "failed"].map((x) => OB.venueStatusOf({ sent: x === "sent", queued: x === "queued", reason: x === "skipped" ? "not_configured" : "rejected" })), ["sent", "queued", "skipped", "failed"]);
});

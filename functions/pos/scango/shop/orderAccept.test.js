// เทส pos/scango/shop/orderAccept.js + ../v1/eventOut.js (ร้านกดรับใบ ScanGo ในแอป → ยิง OrderEvent v1 accepted · DEV-0009 สเปกข้อ 6)
//   รัน: node --test functions/pos/scango/shop/orderAccept.test.js · ❌ ไม่แตะ Firestore จริง (ฐานปลอม ./_testDb.js) · ❌ ไม่ยิงเน็ตจริง (deps.scangoSend)
//   ลายเซ็นที่ยิงออก ตรวจด้วยสูตรฝั่ง ScanGo ที่คิดเองในไฟล์นี้ (scango_server _shared/partnerSign.js: HMAC-SHA256(trim(key), ts + "." + rawBody))
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { installFakeDb, call } = require("./_testDb");

const F = installFakeDb();
const { orderAccept } = require("./orderAccept");
const { orderList } = require("./orderList");
const E = require("../v1/eventOut");

const NOW = new Date("2026-11-14T03:00:00.000Z");
const KEY = "k-shopchamp-test";
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const STAFF = (rights) => ({ shopId: "shopA", uid: "u-staff", role: "staff", rights });
const WATCHER = { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true };

const order = (over) => ({
  shopId: "shopA", orderRef: "sg1", code: "AB12", source: "scango", schema: "scango.order.v1", state: "requested",
  stateAt: { requested: new Date("2026-11-14T02:50:00.000Z") }, placedAt: "2026-11-14T02:50:00.000Z",
  fulfillment: { mode: "delivery", timing: "round", round: { id: "r1", name: "รอบบ่าย", deliverFrom: "13:00", deliverTo: "14:00" } },
  items: [{ lineId: "L1", productId: "p1", name: "โค้ก", qty: 2, unitPrice: 15, lineTotal: 30, note: "", options: [] }],
  subtotal: 30, deliveryFee: 20, total: 50,
  bill: { subtotal: 30, deliveryFee: 20, total: 50, payment: { method: "cash", state: "unpaid" } },
  customer: { name: "ลูกค้า", phone: "0900000001", note: null }, dropPoint: { address: "บ้าน 12", zone: { id: "z1", name: "โซน A" } },
  payment: { method: "cash", state: "unpaid", collectedBy: "rider" },
  createdAt: new Date("2026-11-14T02:50:00.000Z"), updatedAt: new Date("2026-11-14T02:50:00.000Z"),
  ...(over || {}),
});
const seed = (orders) => ({ shop: { shopA: { shopId: "shopA" } }, scangoOrder: orders || { sg1: order() } });

/** ตัวยิงปลอม: เก็บทุกคำขอ · ตอบตาม reply (object = {status, data} · Error = โยน) */
function sender(reply) {
  const sent = [];
  const fn = async (req) => { sent.push(req); const r = typeof reply === "function" ? reply(sent.length) : reply; if (r instanceof Error) throw r; return r; };
  return { sent, fn };
}
const deps = (s, env) => ({ now: () => NOW, env: env || { SCANGO_SHOPCHAMP_KEY: KEY }, scangoSend: s.fn });
const OK200 = { status: 200, data: { ok: true, orderId: "sg1", state: "accepted", applied: true } };
const scangoSig = (key, ts, raw) => "v1=" + crypto.createHmac("sha256", key.trim()).update(`${ts}.`, "utf8").update(Buffer.from(raw, "utf8")).digest("hex");

test("requested → accepted (stateAt/acceptedAt/acceptedBy pos) · ยิง accepted 1 ครั้งไป /v1/partners/shopchamp/order-events ลายเซ็นตรงสูตร ScanGo · scangoAck sent · คืนใบเต็ม", async () => {
  F.reset(seed());
  const s = sender(OK200);
  const r = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, STAFF(["100"]));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.acceptedNow, true);
  // ฐาน
  const d = F.data.scangoOrder.sg1;
  assert.equal(d.state, "accepted");
  assert.equal(d.stateAt.accepted.getTime(), NOW.getTime());
  assert.equal(d.stateAt.requested.toISOString(), "2026-11-14T02:50:00.000Z");
  assert.equal(d.acceptedAt.getTime(), NOW.getTime());
  assert.equal(d.acceptedBy, "pos");
  assert.equal(d.acceptedByUid, "u-staff");
  assert.deepEqual({ ...d.scangoAck, at: d.scangoAck.at.toISOString() }, { type: "accepted", eventId: "sg1:accepted", state: "sent", status: 200, error: null, at: NOW.toISOString(), attempts: 1 });
  // คำขอที่ยิง
  assert.equal(s.sent.length, 1);
  const q = s.sent[0];
  assert.equal(q.url, `${E.DEFAULT_BASE}/v1/partners/shopchamp/order-events`);
  assert.equal(q.timeoutMs, 5000);
  assert.deepEqual(JSON.parse(q.raw), { schema: "scango.order-event.v1", eventId: "sg1:accepted", orderId: "sg1", partnerOrderRef: "sg1", type: "accepted", at: NOW.toISOString(), actor: "venue", reason: null, note: null, rider: null });
  assert.equal(q.headers["x-scango-partner"], "shopchamp");
  assert.equal(q.headers["x-scango-timestamp"], String(NOW.getTime()));
  assert.equal(q.headers["idempotency-key"], "sg1:accepted");
  assert.equal(q.headers["x-scango-signature"], scangoSig(KEY, String(NOW.getTime()), q.raw));
  assert.equal(q.headers["x-scango-platform-key"], undefined, "ไม่แนบกุญแจดิบ");
  // คำตอบ = ใบเต็มที่แอปต้องใช้
  const o = r.body.order;
  assert.equal(o.orderRef, "sg1");
  assert.equal(o.state, "accepted");
  assert.equal(o.code, "AB12");
  assert.deepEqual(o.items[0], { lineId: "L1", productId: "p1", productRef: "p1", name: "โค้ก", qty: 2, unitPrice: 15, lineTotal: 30, note: "", options: [] });
  assert.equal(o.fulfillment.round.name, "รอบบ่าย");
  assert.equal(o.dropPoint.zone.name, "โซน A");
  assert.deepEqual([o.total, o.deliveryFee, o.bill.payment.method, o.customer.phone], [50, 20, "cash", "0900000001"]);
  assert.equal(o.stateAt.accepted, NOW.toISOString());
  assert.equal(r.body.scangoAck.state, "sent");
});

test("กดซ้ำหลังยิงสำเร็จ → 200 acceptedNow:false · ไม่เขียน ไม่ยิง (idempotent)", async () => {
  F.reset(seed());
  const s = sender(OK200);
  await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  const logN = F.log.length;
  const again = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(again.code, 200);
  assert.equal(again.body.acceptedNow, false);
  assert.equal(again.body.order.state, "accepted");
  assert.equal(s.sent.length, 1);
  assert.equal(F.log.length, logN);
});

test("ScanGo ล่ม (เน็ตหลุด / 503) → ใบยัง accepted · scangoAck failed · 200 · กดซ้ำ = ยิงใหม่ eventId เดิม · สำเร็จแล้วหยุด", async () => {
  F.reset(seed());
  const s = sender((n) => (n === 1 ? Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" }) : n === 2 ? { status: 503, data: { ok: false, error: "x" } } : { status: 200, data: { ok: true, applied: false, ignored: "duplicate_event" } }));
  const a = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(a.code, 200);
  assert.equal(a.body.acceptedNow, true);
  assert.equal(F.data.scangoOrder.sg1.state, "accepted");
  assert.deepEqual([F.data.scangoOrder.sg1.scangoAck.state, F.data.scangoOrder.sg1.scangoAck.error, F.data.scangoOrder.sg1.scangoAck.attempts], ["failed", "ECONNABORTED", 1]);
  const b = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(b.body.acceptedNow, false);
  assert.deepEqual([b.body.scangoAck.state, b.body.scangoAck.status, b.body.scangoAck.error, b.body.scangoAck.attempts], ["failed", 503, "x", 2]);
  const c = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.deepEqual([c.body.scangoAck.state, c.body.scangoAck.attempts], ["sent", 3]);
  assert.equal(s.sent.length, 3);
  assert.deepEqual(s.sent.map((q) => JSON.parse(q.raw).eventId), ["sg1:accepted", "sg1:accepted", "sg1:accepted"]);
  assert.deepEqual(s.sent.map((q) => JSON.parse(q.raw).at), [NOW.toISOString(), NOW.toISOString(), NOW.toISOString()], "at = เวลารับจริง ไม่ใช่ตอนยิงซ้ำ");
  await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(s.sent.length, 3);
});

test("ScanGo ปัด 4xx (order_unknown) → scangoAck failed status 404 error order_unknown · ใบยัง accepted", async () => {
  F.reset(seed());
  const s = sender({ status: 404, data: { ok: false, error: "order_unknown", code: "order_unknown" } });
  const r = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.scangoAck.state, r.body.scangoAck.status, r.body.scangoAck.error], ["failed", 404, "order_unknown"]);
  assert.equal(F.data.scangoOrder.sg1.state, "accepted");
});

test("กุญแจไม่ได้ตั้ง → ไม่ยิง · scangoAck not_configured · ใบยัง accepted 200 · SCANGO_BASE_URL ตั้งได้ (ตัด / ท้าย)", async () => {
  F.reset(seed());
  const s = sender(OK200);
  const r = await call(orderAccept, deps(s, {}), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.scangoAck.state, "not_configured");
  assert.equal(s.sent.length, 0);
  assert.equal(F.data.scangoOrder.sg1.state, "accepted");
  // กดซ้ำหลังตั้งกุญแจ = ยิง
  const r2 = await call(orderAccept, deps(s, { SCANGO_SHOPCHAMP_KEY: KEY, SCANGO_BASE_URL: "https://sg.example/scango/" }), { shopId: "shopA", orderRef: "sg1" }, OWNER);
  assert.equal(r2.body.scangoAck.state, "sent");
  assert.equal(s.sent[0].url, "https://sg.example/scango/v1/partners/shopchamp/order-events");
});

test("ร้านรับบนเว็บร้าน ScanGo แล้ว (acceptedBy scango-web) / ready / delivering → 200 acceptedNow:false ไม่ยิง ไม่เขียน", async () => {
  for (const over of [{ state: "accepted", acceptedBy: "scango-web" }, { state: "ready" }, { state: "delivering" }, { state: "picked_up" }]) {
    F.reset(seed({ sg1: order(over) }));
    const s = sender(OK200);
    const r = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
    assert.equal(r.code, 200, JSON.stringify(over));
    assert.equal(r.body.acceptedNow, false);
    assert.equal(r.body.scangoAck, null);
    assert.equal(r.body.order.state, over.state);
    assert.equal(s.sent.length, 0);
    assert.equal(F.log.length, 0);
  }
});

test("🔒 ยกเลิกแล้ว / ล้มเหลว → 409 order_cancelled · ส่งถึงแล้ว → 409 order_completed · ไม่เขียน ไม่ยิง", async () => {
  for (const [st, code] of [["cancelled", "order_cancelled"], ["failed", "order_cancelled"], ["delivered", "order_completed"]]) {
    F.reset(seed({ sg1: order({ state: st }) }));
    const s = sender(OK200);
    const r = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "sg1" }, OWNER);
    assert.deepEqual([r.code, r.body.error], [409, code], st);
    assert.equal(r.body.state, st);
    assert.equal(s.sent.length, 0);
    assert.equal(F.log.length, 0);
  }
});

test("🔒 ใบไม่มี / ใบร้านอื่น → 404 order_not_found · ไม่ยิง", async () => {
  F.reset(seed({ sg1: order(), sgB: order({ shopId: "shopB" }) }));
  const s = sender(OK200);
  for (const ref of ["ghost", "sgB"]) {
    const r = await call(orderAccept, deps(s), { shopId: "shopA", orderRef: ref }, OWNER);
    assert.deepEqual([r.code, r.body.error], [404, "order_not_found"], ref);
    assert.equal(r.body.order, undefined);
  }
  assert.equal(s.sent.length, 0);
  assert.equal(F.data.scangoOrder.sgB.state, "requested");
});

test("🔒 ด่าน: watcher 403 · พนักงานไม่มีสิทธิ์ขาย 403 right_required · shopId ไม่ตรง 403 · ไม่มี access 401 · ช่องเกิน/orderRef ผิดรูป 400", async () => {
  F.reset(seed());
  const s = sender(OK200);
  const b = { shopId: "shopA", orderRef: "sg1" };
  assert.deepEqual([(await call(orderAccept, deps(s), b, WATCHER)).body.error], ["watcher_read_only"]);
  const noRight = await call(orderAccept, deps(s), b, STAFF(["111"]));
  assert.deepEqual([noRight.code, noRight.body.error], [403, "right_required"]);
  assert.equal((await call(orderAccept, deps(s), { ...b, shopId: "shopB" }, OWNER)).body.error, "wrong_shop");
  assert.equal((await call(orderAccept, deps(s), b, undefined)).code, 401);
  assert.equal((await call(orderAccept, deps(s), { ...b, extra: 1 }, OWNER)).code, 400);
  assert.equal((await call(orderAccept, deps(s), { shopId: "shopA", orderRef: "a/b" }, OWNER)).code, 400);
  assert.equal((await call(orderAccept, deps(s), { shopId: "shopA" }, OWNER)).code, 400);
  assert.equal(s.sent.length, 0);
  assert.equal(F.data.scangoOrder.sg1.state, "requested");
});

test("orderList: รายการมี productRef (ซ้ำ productId) + เนื้อใบที่แอปใช้ครบ", async () => {
  F.reset(seed({ sg1: order(), sg2: order({ state: "accepted", createdAt: new Date("2026-11-14T02:55:00.000Z") }) }));
  const r = await call(orderList, {}, { shopId: "shopA", states: ["requested", "accepted", "ready", "picked_up", "delivering"] }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.orders.map((o) => o.orderRef), ["sg2", "sg1"]);
  const o = r.body.orders[1];
  assert.equal(o.items[0].productRef, "p1");
  for (const k of ["code", "state", "placedAt", "fulfillment", "dropPoint", "customer", "bill", "total", "deliveryFee", "items"]) assert.ok(o[k] !== undefined, k);
});

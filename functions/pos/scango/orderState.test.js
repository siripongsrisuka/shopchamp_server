// เทส pos/scango/orderState.js — อ่านสถานะให้ตัวกวาด ScanGo (posState/deliveryState รูปเดียวกับพี่น้อง) · 404 ใบร้านอื่น · ไม่เขียน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SHOP, OTHER, load, call } = require("./_testSeed");
const { stateView } = require("./orderState");

test("stateView: แปลง state เดียวของใบเป็น posState + deliveryState", () => {
  const map = { requested: ["requested", "requested"], accepted: ["accepted", "requested"], ready: ["ready", "requested"], picked_up: ["ready", "picked_up"], delivering: ["ready", "delivering"], delivered: ["ready", "delivered"], failed: ["ready", "failed"], cancelled: ["cancelled", "cancelled"] };
  for (const [st, [pos, del]] of Object.entries(map)) {
    const v = stateView({ orderRef: "o1", state: st });
    assert.deepEqual([v.posState, v.deliveryState], [pos, del], st);
  }
  const c = stateView({ orderRef: "o1", state: "cancelled", cancelReason: "x", cancelledBy: "customer", notified: { cancelled: true } });
  assert.deepEqual([c.cancelReason, c.cancelledBy, c.notified], ["x", "customer", { accepted: false, ready: false, cancelled: true }]);
  assert.equal(stateView({ state: "accepted", cancelReason: "x" }).cancelReason, null);
  const b = stateView({ state: "delivered", billId: "B1", stateAt: { accepted: new Date("2026-11-11T05:00:00Z") }, rider: { name: "ไรเดอร์", phone: "09" } });
  assert.deepEqual([b.bill, b.acceptedAt, b.rider], [{ closed: true, pending: null }, "2026-11-11T05:00:00.000Z", { name: "ไรเดอร์", phone: "09", plate: null }]);
});

test("handler: อ่านใบของร้าน · ใบร้านอื่น/ไม่มี = 404 · ช่องเกิน = 400 · ไม่เขียน", async () => {
  const { mem, deps, mod } = load({ "scangoOrder/o1": { shopId: SHOP, orderRef: "o1", state: "accepted" } });
  const h = mod("orderState.js").orderState(deps);
  const r = await call(h, { externalId: SHOP, orderRef: "o1" });
  assert.deepEqual([r.code, r.body.ok, r.body.posState, r.body.orderRef], [200, true, "accepted", "o1"]);
  assert.deepEqual([(await call(h, { externalId: OTHER, orderRef: "o1" })).body.error], ["order_not_found"]);
  assert.equal((await call(h, { externalId: SHOP, orderRef: "o1", at: "x" })).code, 400);
  assert.equal(mem.writes.length, 0);
});

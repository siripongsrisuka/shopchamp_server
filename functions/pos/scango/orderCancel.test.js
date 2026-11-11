// เทส pos/scango/orderCancel.js — ยกเลิกได้เฉพาะ requested · ซ้ำ = 200 changed false · รับแล้ว 409 cancel_window_closed · ลบเบอร์ · notified.cancelled
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NOW, SHOP, OTHER, load, call } = require("./_testSeed");

const ord = (over) => ({ shopId: SHOP, orderRef: "o1", code: "O1", state: "requested", stateAt: { requested: new Date("2026-11-11T04:50:00Z") }, customer: { name: "ก", phone: "081" }, notified: {}, ...(over || {}) });

test("ยกเลิกโดยลูกค้า: state cancelled · เหตุ · ลบเบอร์ · notified.cancelled true · ซ้ำ = changed false ไม่เขียน", async () => {
  const { mem, deps, mod } = load({ "scangoOrder/o1": ord() });
  const h = mod("orderCancel.js").orderCancel(deps);
  const r = await call(h, { externalId: SHOP, orderRef: "o1", by: "customer", reason: "เปลี่ยนใจ", at: "2026-11-11T05:00:00Z", eventId: "e1" });
  assert.deepEqual([r.code, r.body.state, r.body.changed], [200, "cancelled", true]);
  const d = mem.store.get("scangoOrder/o1");
  assert.deepEqual([d.state, d.cancelledBy, d.cancelReason, d.customer.phone, d.customer.name, d.notified.cancelled], ["cancelled", "customer", "เปลี่ยนใจ", null, "ก", true]);
  assert.equal(d.stateAt.cancelled.getTime(), NOW.getTime());
  assert.ok(d.stateAt.requested, "ไม่ทับเวลาเดิม");
  const n = mem.writes.length;
  const again = await call(h, { externalId: SHOP, orderRef: "o1" });
  assert.deepEqual([again.code, again.body.changed], [200, false]);
  assert.equal(mem.writes.length, n);
});

test("ระบบยกเลิก ไม่ส่งเหตุ = venue_unresponsive · ลูกค้าไม่ส่ง by = customer_cancelled", async () => {
  const { mem, deps, mod } = load({ "scangoOrder/o1": ord(), "scangoOrder/o2": ord({ orderRef: "o2" }) });
  const h = mod("orderCancel.js").orderCancel(deps);
  await call(h, { externalId: SHOP, orderRef: "o1", by: "system" });
  await call(h, { externalId: SHOP, orderRef: "o2" });
  assert.deepEqual([mem.store.get("scangoOrder/o1").cancelledBy, mem.store.get("scangoOrder/o1").cancelReason], ["system", "venue_unresponsive"]);
  assert.equal(mem.store.get("scangoOrder/o2").cancelReason, "customer_cancelled");
});

test("ร้านรับแล้ว/กำลังส่ง/ส่งแล้ว = 409 cancel_window_closed ไม่เขียน · ใบร้านอื่น/ไม่มี = 404 · รูปผิด = 400", async () => {
  for (const st of ["accepted", "ready", "delivering", "delivered", "failed"]) {
    const { mem, deps, mod } = load({ "scangoOrder/o1": ord({ state: st }) });
    const r = await call(mod("orderCancel.js").orderCancel(deps), { externalId: SHOP, orderRef: "o1" });
    assert.deepEqual([r.code, r.body.error, r.body.state], [409, "cancel_window_closed", st]);
    assert.equal(mem.writes.length, 0);
  }
  const { deps, mod } = load({ "scangoOrder/o1": ord() });
  const h = mod("orderCancel.js").orderCancel(deps);
  assert.deepEqual([(await call(h, { externalId: OTHER, orderRef: "o1" })).body.error], ["order_not_found"]);
  assert.equal((await call(h, { externalId: SHOP, orderRef: "zz" })).code, 404);
  for (const b of [{ externalId: SHOP, orderRef: "o1", by: "venue" }, { externalId: SHOP, orderRef: "o1", x: 1 }, { externalId: SHOP }, { externalId: SHOP, orderRef: "o1", reason: 5 }]) {
    assert.equal((await call(h, b)).code, 400, JSON.stringify(b));
  }
});

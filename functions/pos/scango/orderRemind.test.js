// เทส pos/scango/orderRemind.js — ประทับเตือน + push ซ้ำ · ใบไม่ใช่ requested = ignored · eventId ซ้ำ = ไม่ push ซ้ำ
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NOW, SHOP, OTHER, load, call } = require("./_testSeed");

const ord = (over) => ({ shopId: SHOP, orderRef: "o1", code: "O1", state: "requested", remindedAt: null, remindCount: 0, ...(over || {}) });

test("เตือน: ประทับ remindedAt/remindCount · push ถึงร้าน type scango_order · eventId เดิม = duplicate ไม่ push", async () => {
  const { mem, deps, mod } = load({ "scangoOrder/o1": ord() });
  const h = mod("orderRemind.js").orderRemind(deps);
  const r = await call(h, { externalId: SHOP, orderRef: "o1", eventId: "ev1", at: "2026-11-11T05:00:00Z" });
  assert.deepEqual([r.code, r.body.remindCount], [200, 1]);
  const d = mem.store.get("scangoOrder/o1");
  assert.deepEqual([d.remindedAt.getTime(), d.remindCount, d.remindEventId], [NOW.getTime(), 1, "ev1"]);
  assert.equal(deps.pushes.length, 1);
  assert.deepEqual([deps.pushes[0].to, deps.pushes[0].data], [{ kind: "shop", shopId: SHOP }, { type: "scango_order", orderRef: "o1" }]);
  const dup = await call(h, { externalId: SHOP, orderRef: "o1", eventId: "ev1" });
  assert.deepEqual([dup.code, dup.body.duplicate], [200, true]);
  assert.equal(deps.pushes.length, 1);
  const again = await call(h, { externalId: SHOP, orderRef: "o1", eventId: "ev2" });
  assert.equal(again.body.remindCount, 2);
  assert.equal(deps.pushes.length, 2);
});

test("ใบไม่ใช่ requested = 200 ignored ไม่เขียน ไม่ push · ใบร้านอื่น = 404 · ช่องเกิน = 400", async () => {
  const { mem, deps, mod } = load({ "scangoOrder/o1": ord({ state: "accepted" }) });
  const h = mod("orderRemind.js").orderRemind(deps);
  const r = await call(h, { externalId: SHOP, orderRef: "o1" });
  assert.deepEqual([r.code, r.body.ignored], [200, true]);
  assert.equal(mem.writes.length, 0);
  assert.equal(deps.pushes.length, 0);
  assert.equal((await call(h, { externalId: OTHER, orderRef: "o1" })).code, 404);
  assert.equal((await call(h, { externalId: SHOP, orderRef: "o1", by: "x" })).code, 400);
});

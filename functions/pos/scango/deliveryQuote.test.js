// เทส pos/scango/deliveryQuote.js — ค่าส่งจากระยะ ScanGo · ส่งฟรี · นอกระยะ 200 · 404 · 400
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SHOP, load, call, shop } = require("./_testSeed");

test("quote: ในระยะ · ส่งฟรี · นอกระยะตอบ 200 พร้อมธง · ไม่ขึ้นกับสวิตช์เปิดรับ", async () => {
  const { deps, mod } = load({ [`shop/${SHOP}`]: shop({ enabled: false }) });
  const h = mod("deliveryQuote.js").deliveryQuote(deps);
  const a = await call(h, { externalId: SHOP, distanceKm: 2, foodSubtotal: 100 });
  assert.deepEqual([a.code, a.body.fee, a.body.riderFee, a.body.free, a.body.outOfRange, a.body.maxKm], [200, 30, 30, false, false, 5]);
  const f = await call(h, { externalId: SHOP, distanceKm: 2, foodSubtotal: 600 });
  assert.deepEqual([f.body.fee, f.body.shopPays, f.body.free], [0, 30, true]);
  const n = await call(h, { externalId: SHOP, distanceKm: 2 });
  assert.equal(n.body.free, false, "ไม่ส่งยอด = ไม่ฟรี");
  const o = await call(h, { externalId: SHOP, distanceKm: 9 });
  assert.deepEqual([o.code, o.body.outOfRange, o.body.fee], [200, true, null]);
});

test("quote: 404 ร้านไม่มี · 400 ระยะผิด/ยอดติดลบ/ช่องเกิน", async () => {
  const { deps, mod } = load();
  const h = mod("deliveryQuote.js").deliveryQuote(deps);
  assert.equal((await call(h, { externalId: "nope", distanceKm: 1 })).code, 404);
  for (const body of [{ externalId: SHOP }, { externalId: SHOP, distanceKm: -1 }, { externalId: SHOP, distanceKm: "2" }, { externalId: SHOP, distanceKm: 1, foodSubtotal: -5 }, { externalId: SHOP, distanceKm: 1, x: 1 }]) {
    const r = await call(h, body);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(body));
  }
});

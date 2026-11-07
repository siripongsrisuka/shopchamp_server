// pos/e2e/web-credit.e2e.js — รับชำระเงินเซ็นผ่านเว็บแยกตามช่องทาง บน emulator (DEV-0002 · Pack เคาะ 2026-11-07)
//   ร้านใช้กะ: เปิดกะ → เว็บถามกะที่เปิด (shift.openList) → รับเงินสดเข้ากะนั้น · รับพร้อมเพย์ไม่ผูกกะ · เงินสดไม่เลือกกะถูกปัด
//   → ปิดกะ: เงินคาดนับเงินสดจากเว็บ ไม่นับพร้อมเพย์ · ปิดแล้วเว็บรับเงินสดเข้ากะนั้นไม่ได้
// รัน: cd functions && node pos/e2e/run.js pos/e2e/web-credit.e2e.js
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const { manage } = require("../shift/manage");
const { openList } = require("../shift/openList");
const { payCredit } = require("../member/payCredit");

const { call, seed, get, ms, clock, reqId } = E;
const OPEN = "2026-11-10T01:00:00.000Z";

before(() => E.ready());

test("เว็บ: เงินสดเข้ากะที่เลือก · พร้อมเพย์ไม่ผูกกะ · ปิดกะนับเฉพาะเงินสด · กะปิดแล้วรับเงินสดไม่ได้", async () => {
  const f = E.shopFixture({ shopA: { shift: true, POSs: [] } });
  f.data.shop[f.id.shopA].POSs = [{ id: "pos-1", name: "หน้าร้าน", shiftId: f.id.sh1 }];
  f.data.shift[f.id.sh1] = { ...E.INITIAL_SHIFT, shopId: f.id.shopA, posId: "pos-1", id: f.id.sh1, status: false, lastShiftDate: "20261109", shiftCount: 3, openCash: "300", openTime: E.T("2026-11-09T01:00:00.000Z"), openId: f.id.owner, openName: "เจ้าของ" };
  f.data.member[f.id.m1] = { ...f.data.member[f.id.m1], credit: 0, creditArray: [{ billId: "b-old", receiptNumber: "202611000001", totalCredit: 100, remainCredit: 100, timestamp: E.T("2026-11-01T05:00:00.000Z") }] };
  await seed(f.data);
  const at = (iso) => clock(iso);
  const sb = (over) => ({ shopId: f.id.shopA, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), ...over });
  const web = (over) => ({ shopId: f.id.shopA, memberId: f.id.m1, amount: 10, paymentId: 1, staffId: f.id.owner, staffName: "เจ้าของ", payUUID: reqId(), source: "web", ...over });

  // ยังไม่เปิดกะ: รายการว่าง · เงินสดถูกปัดด้วยข้อความที่ Pack เคาะ · พร้อมเพย์ผ่าน
  let l = await call(openList, {}, { body: { shopId: f.id.shopA }, shopAccess: f.access.owner });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual([l.body.usesShift, l.body.posQty, l.body.shifts], [true, 1, []]);
  const noShift = await call(payCredit, at("2026-11-10T00:30:00.000Z"), { body: web(), shopAccess: f.access.owner });
  assert.equal(noShift.status, 409);
  assert.deepEqual([noShift.body.error, noShift.body.message], ["cash_shift_required", "ต้องเปิดกะก่อน หรือรับเป็นโอน"]);

  const o = await call(manage, at(OPEN), { body: sb({ op: "open", openCash: "500" }), shopAccess: f.access.owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));

  l = await call(openList, {}, { body: { shopId: f.id.shopA }, shopAccess: f.access.owner });
  assert.equal(l.body.shifts.length, 1);
  assert.deepEqual([l.body.shifts[0].shiftId, l.body.shifts[0].posName, l.body.shifts[0].openTime], [f.id.sh1, "หน้าร้าน", OPEN]);

  // เงินสด 15 เข้ากะที่เลือก
  const cashBody = web({ amount: 15, shiftId: l.body.shifts[0].shiftId });
  const c = await call(payCredit, at("2026-11-10T02:00:00.000Z"), { body: cashBody, shopAccess: f.access.owner });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const phCash = await get("paidHistory", cashBody.payUUID);
  assert.deepEqual([phCash.shiftId, ms(phCash.shiftOpenTime), phCash.paymentId, phCash.source], [f.id.sh1, Date.parse(OPEN), 1, "web"]);
  assert.ok(S.PaidHistory.safeParse(phCash).success);

  // พร้อมเพย์ 20 ไม่ผูกกะ · ส่ง shiftId มาด้วยถูกปัด
  const bad = await call(payCredit, at("2026-11-10T02:10:00.000Z"), { body: web({ amount: 20, paymentId: 2, shiftId: f.id.sh1 }), shopAccess: f.access.owner });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "noncash_no_shift");
  const ppBody = web({ amount: 20, paymentId: 2 });
  const p = await call(payCredit, at("2026-11-10T02:15:00.000Z"), { body: ppBody, shopAccess: f.access.owner });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.existCredit, 65);
  const phPp = await get("paidHistory", ppBody.payUUID);
  assert.deepEqual([phPp.shiftId, phPp.shiftOpenTime, phPp.paymentId, phPp.source], [null, null, 2, "web"]);
  assert.ok(S.PaidHistory.safeParse(phPp).success);

  // ปิดกะ: เงินคาด = เปิด 500 + เงินสดจากเว็บ 15 (พร้อมเพย์ไม่นับ)
  const closeAt = at("2026-11-10T03:00:00.000Z");
  const wrong = await call(manage, closeAt, { body: sb({ op: "close", closeCash: "515", closeWithDraw: "0", expectedCash: 1 }), shopAccess: f.access.owner });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.expectedCash, 515, "เปิด 500 + เงินสดรับชำระจากเว็บ 15 · พร้อมเพย์ 20 ไม่เข้าเงินคาด");
  const cl = await call(manage, closeAt, { body: sb({ op: "close", closeCash: "515", closeWithDraw: "0", expectedCash: 515 }), shopAccess: f.access.owner });
  assert.equal(cl.status, 200, JSON.stringify(cl.body));
  assert.equal(cl.body.closeDiff, 0);

  // กะปิดแล้ว: เงินสดเข้ากะนั้นไม่ได้ · รายการกะเปิดว่าง
  const late = await call(payCredit, at("2026-11-10T04:00:00.000Z"), { body: web({ amount: 5, shiftId: f.id.sh1 }), shopAccess: f.access.owner });
  assert.equal(late.status, 409);
  assert.deepEqual([late.body.error, late.body.message], ["shift_not_open", "ต้องเปิดกะก่อน หรือรับเป็นโอน"]);
  l = await call(openList, {}, { body: { shopId: f.id.shopA }, shopAccess: f.access.owner });
  assert.deepEqual(l.body.shifts, []);
  const m = await get("member", f.id.m1);
  assert.equal(m.creditArray[0].remainCredit, 65);
});

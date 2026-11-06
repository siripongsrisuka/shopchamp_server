// pos/e2e/shift-credit.e2e.js — 1 กะเต็มบน emulator: เปิดกะ · เงินเข้า · ขาย · ยกเลิก · รับชำระเงินเซ็น · ปิดกะ (ก้อน 4 · DEV-0001)
//   ของที่เขียน: shift · shiftHistory · paidHistory · member · notification · แล้วเทียบกับตัวอ่านของแอปเก่า/server เก่า
// รัน: cd functions && npm run test:e2e
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const O = require("./_old");
const { create } = require("../sale/create");
const { void: makeVoid } = require("../sale/void");
const { manage } = require("../shift/manage");
const { payCredit } = require("../member/payCredit");

const { call, seed, get, ms, clock, saleBody, reqId, dump } = E;
const OPEN = "2026-11-10T01:00:00.000Z";
const parseOk = (schema, doc, label) => {
  const r = schema.safeParse(doc);
  assert.ok(r.success, `${label} ไม่ผ่าน schema: ${String(JSON.stringify(r.error && r.error.issues)).slice(0, 800)}`);
};

before(() => E.ready());

/** ร้านที่กะยังปิด (รอบก่อนเป็นของเมื่อวาน กะที่ 3) */
async function closedShop() {
  const f = E.shopFixture();
  f.data.shift[f.id.sh1] = { ...E.INITIAL_SHIFT, shopId: f.id.shopA, posId: "pos-1", id: f.id.sh1, status: false, lastShiftDate: "20261109", shiftCount: 3, openCash: "300", openTime: E.T("2026-11-09T01:00:00.000Z"), openId: f.id.owner, openName: "เจ้าของ" };
  await seed(f.data);
  return f;
}
const sb = (f, over) => ({ shopId: f.id.shopA, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), ...over });
const pay = (f, over) => ({ shopId: f.id.shopA, memberId: f.id.m1, amount: 15, paymentId: 1, shiftId: f.id.sh1, staffId: f.id.staff, staffName: "พนักงานบี", payUUID: reqId(), ...over });

test("กะเต็มวัน: shift · shiftHistory · paidHistory · member ถูกรูป · ยอดเทียบสูตรกะของ server เก่า", async () => {
  const f = await closedShop();
  const at = (iso) => clock(iso);

  const o = await call(manage, at(OPEN), { body: sb(f, { op: "open", openCash: "500" }), shopAccess: f.access.owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.deepEqual([o.body.shiftCount, o.body.lastShiftDate], [1, "20261110"]);
  let shift = await get("shift", f.id.sh1);
  assert.equal(shift.status, true);
  assert.equal(ms(shift.openTime), Date.parse(OPEN));
  assert.deepEqual(shift.duringShift, []);
  parseOk(S.Shift, shift, "shift เปิด");

  const d = await call(manage, at("2026-11-10T01:30:00.000Z"), { body: sb(f, { op: "during", type: 1, amount: "50", comment: "เติมเหรียญ" }), shopAccess: f.access.owner });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  shift = await get("shift", f.id.sh1);
  assert.equal(shift.duringShift.length, 1);
  assert.equal(shift.duringShift[0].entryId, d.body.entryId);
  parseOk(S.Shift, shift, "shift มีเงินเข้า");

  const T2 = at("2026-11-10T02:00:00.000Z");
  const sell = (over) => call(create, T2, { body: saleBody(f, { shiftOpenTime: OPEN, ...over }), shopAccess: f.access.owner });
  const cash = await sell({ product: [{ id: f.id.pWater, qty: 10, name: "น้ำดื่ม", net: 100, totalPrice: 100, totalCost: 60 }], payment: [{ id: 1, amount: 100, name: "เงินสด" }], moneyMustPaid: 100, change: 0 });
  const pp = await sell({ product: [{ id: f.id.pWater, qty: 3, name: "น้ำดื่ม", net: 30, totalPrice: 30, totalCost: 18 }], payment: [{ id: 2, amount: 30, name: "พร้อมเพย์" }], moneyMustPaid: 30, change: 0 });
  const credit = await sell({ member: { id: f.id.m1, name: "ลูกค้าเอ" }, product: [{ id: f.id.pWater, qty: 4, name: "น้ำดื่ม", net: 40, totalPrice: 40, totalCost: 24 }], payment: [{ id: 3, amount: 40, name: "เงินเซ็น" }], moneyMustPaid: 40, change: 0, currentCredit: 40 });
  const voided = await sell({ moneyMustPaid: 20, payment: [{ id: 1, amount: 20, name: "เงินสด" }], change: 0 });
  for (const r of [cash, pp, credit, voided]) assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await call(makeVoid, T2, { body: { shopId: f.id.shopA, billId: voided.body.billId, requestId: reqId(), reason: "คีย์ผิด", staffId: f.id.owner, staffName: "เจ้าของ", shiftId: f.id.sh1 }, shopAccess: f.access.owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));

  // รับชำระเงินเซ็น 15 เงินสด โดยพนักงานที่มีสิทธิ์ 124
  const memberBefore = await get("member", f.id.m1);
  const pb = pay(f);
  const p = await call(payCredit, at("2026-11-10T02:30:00.000Z"), { body: pb, shopAccess: f.access.staff });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.paid, p.body.existCredit], [15, 25]);
  const ph = await get("paidHistory", pb.payUUID);
  assert.equal(ph.shopId, f.id.shopA);
  assert.equal(ph.paid, 15);
  assert.equal(ph.existCredit, 25);
  assert.equal(ph.memberId, f.id.m1);
  assert.equal(ph.billDate, "20261110");
  assert.equal(ph.shiftId, f.id.sh1);
  assert.equal(ms(ph.shiftOpenTime), Date.parse(OPEN));
  assert.equal(ph.paymentId, 1);
  assert.deepEqual(ph.cutBills, [{ billId: credit.body.billId, amount: 15, receiptNumber: credit.body.receiptNumber }]);
  parseOk(S.PaidHistory, ph, "paidHistory");
  const m = await get("member", f.id.m1);
  assert.equal(m.creditArray[0].remainCredit, 25);
  parseOk(S.Member, m, "member หลังรับชำระ");
  if (O.HAVE_OLD) {
    const op = await O.old("member").oldPayCredit({ currentMember: memberBefore, memberData: memberBefore, pay: 15 });
    assert.equal(op.existCredit, p.body.existCredit);
    assert.equal(op.memberObj.credit, m.credit);
    assert.deepEqual(op.memberObj.creditArray.map((r) => r.remainCredit), m.creditArray.map((r) => r.remainCredit));
    assert.equal(O.old("member").oldTotalCredit(m), 25);
  }

  // ปิดกะ: ส่งยอดผิดก่อน → 409 summary_changed บอกยอดจริง (ไม่เขียน) → ส่งยอดจริง
  const closeAt = at("2026-11-10T03:00:00.000Z");
  let oldView = null;
  if (O.HAVE_OLD) oldView = await O.oldShiftTest(E.db, { shiftId: f.id.sh1 }); // จอกะของแอปเก่า ณ ก่อนปิด
  const wrong = await call(manage, closeAt, { body: sb(f, { op: "close", closeCash: "660", closeWithDraw: "100", expectedCash: 1 }), shopAccess: f.access.owner });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, "summary_changed");
  assert.equal(await get("shiftHistory", `${f.id.sh1}_${Date.parse(OPEN)}`), undefined);
  const expectedCash = wrong.body.expectedCash;
  assert.equal(expectedCash, 665, "เปิด 500 + ขายเงินสด 100 + เงินเข้า 50 + รับชำระหนี้เงินสด 15 (#17)");
  const closeReq = sb(f, { op: "close", closeCash: "660", closeWithDraw: "100", expectedCash });
  const c = await call(manage, closeAt, { body: closeReq, shopAccess: f.access.owner });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.closeDiff, -5);
  const hid = `${f.id.sh1}_${Date.parse(OPEN)}`;
  assert.equal(c.body.shiftHistoryId, hid);
  const h = await get("shiftHistory", hid);
  assert.equal(h.id, f.id.sh1);
  assert.equal(h.shopId, f.id.shopA);
  assert.equal(h.closeCash, "660");
  assert.equal(h.closeWithDraw, "100");
  assert.equal(h.closeDiff, -5);
  assert.equal(h.currentCash, 665);
  assert.equal(h.thisSelectedQty, 3);
  assert.equal(h.thisVoidQty, 1);
  assert.equal(h.thisTotalNet, 170);
  assert.equal(h.thisTotalCash, 100);
  assert.equal(h.lateSales, 0);
  assert.equal(h.duringShift.length, 1);
  parseOk(S.ShiftHistory, h, "shiftHistory");
  shift = await get("shift", f.id.sh1);
  assert.deepEqual([shift.status, shift.duringShift], [false, []]);
  parseOk(S.Shift, shift, "shift ปิด");

  if (oldView) {
    // สูตรสรุปกะของ server เก่า (manageSummary) กับบิลที่ handler ใหม่เขียน ได้ยอดชุดเดียวกับประวัติที่ server ใหม่เขียน
    const t = oldView.thisSummary;
    assert.deepEqual([t.thisSelectedQty, t.thisVoidQty, t.thisTotalNet, t.thisTotalCash, t.totalPointDiscount], [h.thisSelectedQty, h.thisVoidQty, h.thisTotalNet, h.thisTotalCash, h.totalPointDiscount]);
    assert.deepEqual(t.thisPayment.map((x) => [x.id, x.amount]).sort(), h.thisPayment.map((x) => [x.id, x.amount]).sort());
    // จอกะของแอปเก่า (ShiftScreen.js:91-110) คิดเงินคาดไม่รวมรับชำระหนี้ = 650 · server ใหม่ 665 (#17 ตั้งใจ)
    const sc = O.old("shift").shiftCash({ thisTotalCash: t.thisTotalCash, openCash: "500", closeCash: "660", duringShift: oldView.shiftData.duringShift });
    assert.equal(sc.currentCash, 650);
    assert.equal(O.old("shift").cashRemain({ closeCash: h.closeCash, closeWithDraw: h.closeWithDraw }), c.body.cashRemain);
  }

  // ปิดซ้ำ requestId เดิม = ผลเดิม ไม่เขียนเพิ่ม
  const snap = await dump();
  const again = await call(manage, closeAt, { body: closeReq, shopAccess: f.access.owner });
  assert.equal(again.body.duplicate, true);
  assert.deepEqual(await dump(), snap);
});

test("รับชำระเงินเซ็น: พนักงานไม่มีสิทธิ์ 124 → 403 ไม่เขียนอะไร · payUUID ซ้ำ → duplicate ไม่ตัดหนี้ซ้ำ", async () => {
  const f = E.shopFixture();
  f.data.member[f.id.m1].creditArray = [{ receiptNumber: "202611000005", billId: "b5", totalCredit: 300, remainCredit: 300, timestamp: E.T("2026-11-05T05:00:00.000Z") }];
  await seed(f.data);
  const now = clock("2026-11-10T03:00:00.000Z");
  const before = await dump();
  const no = await call(payCredit, now, { body: pay(f, { staffId: f.id.staffNo }), shopAccess: f.access.staffNo });
  assert.deepEqual([no.status, no.body.error], [403, "right_required"]);
  assert.deepEqual(await dump(), before);

  const body = pay(f, { amount: 300 });
  const rs = await Promise.all([1, 2].map(() => call(payCredit, now, { body, shopAccess: f.access.owner })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  assert.deepEqual(rs.map((r) => r.body.duplicate).sort(), [false, true]);
  const m = await get("member", f.id.m1);
  assert.deepEqual(m.creditArray.map((r) => r.remainCredit), [0], "แถวที่ชำระครบยังอยู่ remainCredit 0 (F22 · แอปเก่าลบแถวทิ้ง)");
  if (O.HAVE_OLD) assert.equal(O.old("member").oldTotalCredit(m), 0, "แอปเก่าอ่านยอดหนี้รวม 0 ถูก แม้แถว 0 ยังอยู่");
  assert.equal((await E.where("paidHistory", "memberId", f.id.m1)).length, 1);
});

// C-2 (agent เลือกทางปลอดภัย · Pack ให้เลือกเอง 2026-11-06): ประวัติกะ = {...ค่าตั้งต้น initialShift ที่ขาด, ...doc กะ}
//   doc กะรุ่นก่อน มี.ค. 2025 ไม่มี receiptNumber ⇒ handler เติม '' ให้ (ไม่ผ่อน schema) ⇒ ประวัติผ่าน schema ShiftHistory
test("doc กะรุ่นก่อน มี.ค. 2025 (ไม่มี receiptNumber status lastShiftDate shiftCount): เปิด-ปิดกะได้ · ประวัติผ่าน schema อ่าน", async () => {
  const f = E.shopFixture();
  const { status, lastShiftDate, shiftCount, receiptNumber, ...pre } = E.INITIAL_SHIFT; // eslint-disable-line no-unused-vars
  f.data.shift[f.id.sh1] = { ...pre, shopId: f.id.shopA, posId: "pos-1" };
  await seed(f.data);
  const o = await call(manage, clock(OPEN), { body: sb(f, { op: "open", openCash: "100" }), shopAccess: f.access.owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const c = await call(manage, clock("2026-11-10T02:00:00.000Z"), { body: sb(f, { op: "close", closeCash: "100", closeWithDraw: "0", expectedCash: 100 }), shopAccess: f.access.owner });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const h = await get("shiftHistory", c.body.shiftHistoryId);
  parseOk(S.AnyShiftHistory, h, "shiftHistory จาก doc กะรุ่นเก่า");
});

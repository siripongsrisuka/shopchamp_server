// pos/e2e/report-web.e2e.js — เส้นรายงานของเว็บเจ้าของร้านบน emulator (DEV-0002)
//   report.breakdown (item · payment · total รายวัน) · report.billList detail · report.memberBills · report.shiftHistory dayBy open
//   ฐานจริงของ emulator (Timestamp จริง · where/orderBy/limit จริง · path ซ้อน member.id จริง) · ร้านอื่นไม่ปน · ไม่เขียนอะไร
// รัน: cd functions && node pos/e2e/run.js pos/e2e/report-web.e2e.js
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./_env");
const { breakdown } = require("../report/breakdown");
const { billList } = require("../report/billList");
const { memberBills } = require("../report/memberBills");
const { shiftHistory } = require("../report/shiftHistory");

const { call, seed, clock, T, ns, dump } = E;
const NOW = clock("2026-11-12T03:00:00.000Z");

before(() => E.ready());

test("รายงานเว็บครบวง: ยอดแยกมิติ · บิลเต็ม · บิลสมาชิก · ประวัติกะตามวันเปิด", async () => {
  const n = ns();
  const A = `shopA${n}`, B = `shopB${n}`, owner = `u-owner${n}`, mem = `m-${n}`;
  const shop = (id) => ({
    shopId: id, name: "ร้าน", cutOff: T("2010-12-31T20:00:00.000Z"), // 03:00 ไทย
    vip: [{ type: "premium", expire: T("2027-01-01T00:00:00.000Z") }],
    humanResource: [{ id: owner, name: "เจ้าของ", position: ["001"], status: "active" }],
    smartCategory: [{ level: 1, value: [{ id: "drink", name: "เครื่องดื่ม" }] }],
  });
  const bill = (x) => ({
    shopId: A, receiptNumber: `202611${n.slice(0, 6)}`, dateTime: T("2026-11-10T03:00:00.000Z"), moneyMustPaid: 100,
    product: [{ id: "p1", qty: 1, name: "น้ำ", net: 100, totalPrice: 100, totalCost: 40, category: ["drink"] }],
    payment: [{ id: 1, name: "เงินสด", amount: 100 }], manualDiscount: 0, productDiscount: 0, pointDiscount: { value: 0, point: 0 }, campaign: [], member: {}, ...x,
  });
  await seed({
    shop: { [A]: shop(A), [B]: shop(B) },
    bill: {
      [`b1${n}`]: bill({ moneyMustPaid: 90, manualDiscount: 10, payment: [{ id: 1, name: "เงินสด", amount: 100, change: 10 }], member: { id: mem, name: "สมใจ" } }),
      // 01:30 ไทยของวันที่ 11 = วันธุรกิจ 10
      [`b2${n}`]: bill({ dateTime: T("2026-11-10T18:30:00.000Z"), moneyMustPaid: 40, product: [{ id: "p2", qty: 2, name: "ขนม", net: 40, totalPrice: 40, totalCost: 10 }], payment: [{ id: 2, name: "พร้อมเพย์", amount: 40 }], member: { id: mem } }),
      [`b3${n}`]: bill({ dateTime: T("2026-11-11T05:00:00.000Z"), void: true, member: { id: mem } }),
      [`b4${n}`]: bill({ dateTime: T("2026-11-11T06:00:00.000Z"), moneyMustPaid: 60, product: [{ id: "p1", qty: 1, name: "น้ำ", net: 60, totalPrice: 60, totalCost: 24, category: ["drink"] }], payment: [{ id: 1, name: "เงินสด", amount: 60 }] }),
      [`bB${n}`]: bill({ shopId: B, moneyMustPaid: 999, member: { id: mem } }),
    },
    shiftHistory: {
      [`h1${n}`]: { id: "sh1", shopId: A, posId: "pos-1", openTime: T("2026-11-10T13:00:00.000Z"), closeTime: T("2026-11-10T21:00:00.000Z"), openCash: "500", closeCash: "700", closeWithDraw: "100",
        duringShift: [{ type: 1, amount: 50, staff: "เจ้าของ", comment: "", timestamp: T("2026-11-10T14:00:00.000Z") }], thisPayment: [{ id: 1, name: "เงินสด", amount: 150, qty: 2 }],
        thisTotalCash: 150, thisTotalNet: 150, thisSelectedQty: 2, thisVoidQty: 0, closeDiff: 0, lastShiftDate: "20261110" },
      [`hB${n}`]: { id: "sh1", shopId: B, openTime: T("2026-11-10T13:00:00.000Z"), closeTime: T("2026-11-10T21:00:00.000Z"), thisPayment: [], thisTotalNet: 9999 },
    },
  });
  const before0 = await dump();
  const access = { shopId: A, uid: owner, role: "owner", rights: [] };
  const range = { shopId: A, fromDay: "20261110", toDay: "20261111" };

  const item = await call(breakdown, NOW, { body: { ...range, dimension: "item" }, shopAccess: access });
  assert.equal(item.status, 200, JSON.stringify(item.body));
  assert.deepEqual(item.body.rows.map((r) => [r.id, r.qty, r.netAfterBillDiscount, r.billDiscountShare]), [["p1", 2, 150, 10], ["p2", 2, 40, 0]]);
  assert.deepEqual([item.body.totals.billQty, item.body.totals.totalSale, item.body.totals.voidQty], [3, 190, 1]);

  const pay = await call(breakdown, NOW, { body: { ...range, dimension: "payment" }, shopAccess: access });
  assert.deepEqual(pay.body.rows.map((r) => [r.id, r.amount]), [[1, 150], [2, 40]]);

  const day = await call(breakdown, NOW, { body: { ...range, dimension: "total", granularity: "day" }, shopAccess: access });
  assert.deepEqual(day.body.rows.map((r) => [r.period, r.billQty, r.totalSale, r.totalCost]), [["20261110", 2, 130, 50], ["20261111", 1, 60, 24]]);

  const full = await call(billList, NOW, { body: { ...range, detail: true }, shopAccess: access });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.deepEqual(full.body.rows.map((r) => r.id), [`b4${n}`, `b3${n}`, `b2${n}`, `b1${n}`]);
  const r1 = full.body.rows.find((r) => r.id === `b1${n}`);
  assert.equal(r1.bill.dateTime, "2026-11-10T03:00:00.000Z"); // Timestamp จริงเป็น ISO
  assert.deepEqual(r1.detail.payments, [{ id: 1, name: "เงินสด", amount: 90 }]);
  assert.equal(r1.detail.memberId, mem);

  const mb = await call(memberBills, NOW, { body: { shopId: A, memberId: mem }, shopAccess: access });
  assert.equal(mb.status, 200, JSON.stringify(mb.body));
  assert.deepEqual(mb.body.rows.map((r) => r.id), [`b2${n}`, `b1${n}`]); // ใบยกเลิกไม่นับ · ร้าน B ไม่ปน
  assert.equal(mb.body.nextCursor, null);

  const open = await call(shiftHistory, NOW, { body: { shopId: A, fromDay: "20261110", toDay: "20261110", dayBy: "open" }, shopAccess: access });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.deepEqual(open.body.rows.map((r) => [r.businessDay, r.cashIn, r.cashExpected, r.cashRemain]), [["20261110", 50, 700, 600]]);
  const close10 = await call(shiftHistory, NOW, { body: { shopId: A, fromDay: "20261110", toDay: "20261110" }, shopAccess: access });
  assert.equal(close10.body.rows.length, 0); // ปิด 04:00 วันที่ 11 = วันธุรกิจ 11

  assert.deepEqual(await dump(), before0, "เส้นอ่านต้องไม่เขียนอะไรลงฐาน");
});

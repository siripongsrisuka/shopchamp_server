// pos/e2e/tax-invoice.e2e.js — ออกใบกำกับพร้อมกันจริงบน Firestore emulator (ก้อน 5 ข้อ ② · DEV-0001)
//   ① server หลายคำขอ + สูตรแอปเก่า (old-logic/docNumber.js › taxCounter) หลาย transaction พร้อมกัน บนตัวนับ taxId doc เดียว ⇒ เลขไม่ซ้ำ ไม่ข้าม
//   ② server ยิงบิลเดียวกันพร้อมกัน ⇒ ได้เลขเดียว ตัวนับขยับครั้งเดียว
//   ③ ร้านไม่ใช้ระบบกะ (ก้อน 5 ข้อ ①) ขาย + รับชำระ ⇒ ตัวอ่านของ server เก่านับยอดวันได้ · สรุปกะแอปเก่าไม่นับ (เหมือนแอปเก่า)
//   สูตรแอปเก่ารันผ่าน admin SDK transaction (แอปจริงใช้ client SDK) · ทั้งสองแบบเรียงกันที่ doc เดียวกันใน Firestore
// รัน: cd functions && npm run test:e2e   (หรือ node pos/e2e/run.js pos/e2e/tax-invoice.e2e.js)
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./_env");
const O = require("./_old");
const { issueTaxInvoice } = require("../sale/issueTaxInvoice");
const { create } = require("../sale/create");
const { payCredit } = require("../member/payCredit");

const { db, call, seed, get, clock, saleBody, reqId, NOW_ISO } = E;
const CUST = { id: "c1", name: "บริษัท ลูกค้า จำกัด", tel: "0000000000", address: "กรุงเทพ", taxNumber: "0105500000000", branch: "สำนักงานใหญ่" };

before(() => E.ready());

async function shopWithBills(n) {
  const f = E.shopFixture();
  f.data.taxId = { [f.id.shopA]: { month: 11, receipts: 5 } };
  f.data.bill = {};
  for (let i = 1; i <= n; i++) {
    f.data.bill[`b${i}${f.id.n}`] = { shopId: f.id.shopA, receiptNumber: `2026110000${String(i).padStart(2, "0")}`, moneyMustPaid: 107, dateTime: E.T("2026-11-10T02:00:00.000Z"), payment: [{ id: 1, amount: 107, name: "เงินสด" }], product: [] };
  }
  await seed(f.data);
  return f;
}
const billId = (f, i) => `b${i}${f.id.n}`;
const serverIssue = (f, i) => call(issueTaxInvoice, clock(NOW_ISO), {
  body: { shopId: f.id.shopA, billId: billId(f, i), taxCustomer: CUST, staffId: f.id.owner, staffName: "เจ้าของ" },
  shopAccess: f.access.owner,
});
// สูตรแอปเก่า (main3 BillHistoryScreen.js:508-538) ใน transaction จริง · นาฬิกาเครื่องตรึงเป็นเวลาเดียวกับ server
function oldAppIssue(f, i) {
  const { taxCounter } = O.old("docNumber");
  const taxRef = db.collection("taxId").doc(f.id.shopA);
  const billRef = db.collection("bill").doc(billId(f, i));
  return db.runTransaction(async (transaction) => {
    const taxDoc = await transaction.get(taxRef);
    return O.withFrozenDate(NOW_ISO, () => taxCounter({ transaction, taxDoc, taxRef, billRef, taxNumber: undefined, taxCustomer: CUST })).taxNumber;
  });
}

test("① server 6 คำขอ + แอปเก่า 4 transaction พร้อมกัน ⇒ 10 เลขไม่ซ้ำ ต่อเนื่อง 6..15 · ตัวนับจบที่ 15", { skip: O.skipOld }, async () => {
  const f = await shopWithBills(10);
  const jobs = [];
  for (let i = 1; i <= 10; i++) {
    jobs.push(i % 5 === 0 || i % 5 === 3 ? oldAppIssue(f, i).then((n) => ({ who: "old", n })) : serverIssue(f, i).then((r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { who: "server", n: r.body.taxNumber };
    }));
  }
  const got = await Promise.all(jobs);
  const nums = got.map((g) => g.n).sort();
  assert.equal(new Set(nums).size, 10, `เลขซ้ำ: ${nums.join(" ")}`);
  assert.deepEqual(nums, Array.from({ length: 10 }, (_, k) => `2026110000${String(k + 6).padStart(2, "0")}`));
  assert.equal(got.filter((g) => g.who === "old").length, 4);
  const counter = await get("taxId", f.id.shopA);
  assert.equal(counter.month, 11);
  assert.equal(counter.receipts, 15);
  // เลขบนบิล = เลขที่ผู้ออกได้รับ (ไม่มีใครทับใคร)
  for (let i = 1; i <= 10; i++) assert.ok(nums.includes((await get("bill", billId(f, i))).taxNumber));
});

test("② บิลเดียวกัน server ยิงพร้อมกัน 5 ครั้ง ⇒ เลขเดียว · ตัวนับขยับครั้งเดียว", async () => {
  const f = await shopWithBills(1);
  const rs = await Promise.all(Array.from({ length: 5 }, () => serverIssue(f, 1)));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  const nums = new Set(rs.map((r) => r.body.taxNumber));
  assert.deepEqual([...nums], ["202611000006"]);
  assert.equal(rs.filter((r) => r.body.reused === false).length, 1);
  assert.equal((await get("taxId", f.id.shopA)).receipts, 6);
  assert.equal((await get("bill", billId(f, 1))).taxNumber, "202611000006");
});

test("②b แอปเก่าออกต่อจาก server ⇒ อ่าน month/receipts ที่ server เขียนแล้วนับต่อ ไม่รีเซ็ต", { skip: O.skipOld }, async () => {
  const f = await shopWithBills(3);
  assert.equal((await serverIssue(f, 1)).body.taxNumber, "202611000006");
  assert.equal(await oldAppIssue(f, 2), "202611000007");
  assert.equal((await serverIssue(f, 3)).body.taxNumber, "202611000008");
  const c = await get("taxId", f.id.shopA);
  assert.deepEqual([c.receipts, c.serverRun, c.serverKey], [8, 8, 202611]);
});

test("③ ร้านไม่ใช้ระบบกะ: ขายไม่ส่งเวลาเปิดรอบ + รับชำระเงินเซ็นตอนกะประจำจุดปิด ⇒ สำเร็จ · ยอดวันของ server เก่านับบิล · สรุปกะแอปเก่าไม่นับ", { skip: O.skipOld }, async () => {
  const f = E.shopFixture();
  f.data.shift[f.id.sh1] = { ...E.INITIAL_SHIFT, shopId: f.id.shopA, posId: "pos-1", id: f.id.sh1 }; // ไม่เคยเปิดกะ status false
  f.data.member[f.id.m1].creditArray = [{ billId: "bx", receiptNumber: "202611000001", totalCredit: 50, remainCredit: 50 }];
  await seed(f.data);
  const { shiftOpenTime, ...noOpen } = saleBody(f);
  const s = await call(create, clock(NOW_ISO), { body: noOpen, shopAccess: f.access.owner });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.shift, { status: "off" });
  const b = await get("bill", s.body.billId);
  assert.equal(b.shiftId, f.id.sh1);
  assert.equal("shiftOpenTime" in b, false);
  assert.equal("shiftUnassigned" in b, false);

  const day = await O.oldBillSummary(db, { shopId: f.id.shopA, startDate: "2026-11-09T17:00:00.000Z", endDate: "2026-11-10T16:59:59.000Z" });
  assert.deepEqual(day, { qty: 1, totalSale: 20 });
  const sh = await O.oldShiftTest(db, { shiftId: f.id.sh1 });
  assert.equal(sh.billData.length, 0);

  const payUUID = reqId();
  const p = await call(payCredit, clock(NOW_ISO), { body: { shopId: f.id.shopA, memberId: f.id.m1, amount: 20, paymentId: 1, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", payUUID }, shopAccess: f.access.owner });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const ph = await get("paidHistory", payUUID);
  assert.equal(ph.shiftId, f.id.sh1);
  assert.equal(ph.shiftOpenTime, null);
  assert.equal(ph.paid, 20);
});

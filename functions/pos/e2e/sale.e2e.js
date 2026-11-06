// pos/e2e/sale.e2e.js — sale.create / sale.void บน Firestore emulator: ของที่เขียนลงฐานจริง (ก้อน 4 · DEV-0001)
// รัน: cd functions && npm run test:e2e   (ห้ามรันตรงด้วย node --test · _env.js ปัดถ้าไม่ได้ต่อ emulator)
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const O = require("./_old");
const { create } = require("../sale/create");
const { void: makeVoid } = require("../sale/void");
const { issueTaxInvoice } = require("../sale/issueTaxInvoice");
const { manage } = require("../shift/manage");

const { call, seed, get, where, ms, clock, saleBody, reqId, OPEN_ISO, NOW_ISO } = E;
const NOW = clock(NOW_ISO);
const sell = (f, over, access = f.access.owner, deps = NOW) => call(create, deps, { body: saleBody(f, over), shopAccess: access });
const voidBody = (f, billId, over = {}) => ({ shopId: f.id.shopA, billId, requestId: reqId(), reason: "ลูกค้าเปลี่ยนใจ", staffId: f.id.owner, staffName: "เจ้าของ", ...over });
const parseOk = (schema, doc, label) => {
  const r = schema.safeParse(doc);
  assert.ok(r.success, `${label} ไม่ผ่าน schema: ${String(JSON.stringify(r.error && r.error.issues)).slice(0, 800)}`);
};
const fresh = async (opts) => { const f = E.shopFixture(opts); await seed(f.data); return f; };

before(() => E.ready());

test("ขายเงินสดออนไลน์: bill · receiptGuard · ตัวนับ billId · สต็อก · ทุกตัวผ่าน schema อ่าน", async () => {
  const f = await fresh();
  const body = saleBody(f);
  const r = await call(create, NOW, { body, shopAccess: f.access.owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receiptNumber, "202611000042");
  assert.deepEqual(r.body.shift, { status: "open" });

  const bill = await get("bill", r.body.billId);
  assert.equal(bill.shopId, f.id.shopA);
  assert.equal(bill.receiptNumber, "202611000042");
  assert.equal(bill.billDate, "20261110");
  assert.equal(bill.receiptType, "month");
  assert.equal(bill.receiptUUID, body.receiptUUID);
  assert.equal(ms(bill.dateTime), Date.parse(NOW_ISO));
  assert.equal(ms(bill.shiftOpenTime), Date.parse(OPEN_ISO));
  assert.equal(bill.shiftId, f.id.sh1);
  assert.equal(bill.existPoint, "");
  assert.equal(bill.gainPoint, 0);
  assert.equal(bill.usedPoint, 0);
  assert.equal(bill.franchiseId, "");
  assert.equal(bill.offline, undefined, "ป้าย offline ของคำขอไม่ลงบิลออนไลน์");
  assert.deepEqual(bill.product[0].stockSnapshot, { stockCountStatus: true, linkMultiply: 0, linkIds: [] });
  assert.equal(bill.byAdmin, undefined);
  parseOk(S.Bill, bill, "bill");
  parseOk(S.AnyBill, bill, "bill (AnyBill)");

  const guard = await get("receiptGuard", body.receiptUUID);
  assert.equal(guard.usedBy, "202611000042");
  assert.equal(guard.billId, r.body.billId);
  assert.equal(guard.shopId, f.id.shopA);
  assert.equal(ms(guard.createdAt), Date.parse(NOW_ISO));
  parseOk(S.ReceiptGuard, guard, "receiptGuard");

  const counter = await get("billId", f.id.shopA);
  assert.equal(counter.month, 11);
  assert.equal(counter.receipts, 42);
  assert.notEqual(counter.serverKey, undefined);
  assert.equal(counter.serverRun, 42);
  parseOk(S.BillId, counter, "billId");

  const st = await get("stock", f.id.pWater);
  assert.equal(st.stock, 48);
  assert.equal(ms(st.updateTime), Date.parse(NOW_ISO));
  assert.equal(ms(st.latestSaleDate), Date.parse(NOW_ISO));
  parseOk(S.Stock, st, "stock");
});

test("ร้านรายวัน: เลข 14 หลักจาก billDayId · billId ไม่ขยับ", async () => {
  const f = await fresh({ receiptPattern: "day" });
  const r = await sell(f);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receiptNumber, "20261110000006");
  const day = await get("billDayId", f.id.shopA);
  assert.equal(day.date, 10);
  assert.equal(day.receipts, 6);
  parseOk(S.BillDayId, day, "billDayId");
  assert.deepEqual(await get("billId", f.id.shopA), { month: 11, receipts: 41 });
  assert.equal((await get("bill", r.body.billId)).receiptType, "day");
});

test("สินค้าชั่ง qty ทศนิยม 4 ตำแหน่ง: สต็อกลดตรงเป๊ะ ไม่มีเศษ float", async () => {
  const f = await fresh();
  const line = (qty) => ({ product: [{ id: f.id.pMeat, qty, name: "หมูสับ", net: 1, totalPrice: 1, totalCost: 0, qtyUnit: "กิโลกรัม", unitPrice: 120 }], payment: [{ id: 1, amount: 1, name: "เงินสด" }], moneyMustPaid: 1, change: 0 });
  for (const q of [0.8765, 0.1, 0.2, 0.0001]) {
    const r = await sell(f, line(q));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await get("bill", r.body.billId)).product[0].qty, q);
  }
  assert.equal((await get("stock", f.id.pMeat)).stock, 8.8234); // 10 − 0.8765 − 0.1 − 0.2 − 0.0001
});

test("สต็อกกลุ่มผูก: ขาย 1 แพ็ก (×6) ตัดทุก doc ในกลุ่ม · snapshot เก็บ linkIds", async () => {
  const f = await fresh();
  const r = await sell(f, { product: [{ id: f.id.pPack, qty: 1, name: "โซดาแพ็ก 6", net: 110, totalPrice: 110, totalCost: 60 }], payment: [{ id: 1, amount: 110, name: "เงินสด" }], moneyMustPaid: 110, change: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await get("stock", f.id.pPack)).stock, 54);
  assert.equal((await get("stock", f.id.pCan)).stock, 54);
  const bill = await get("bill", r.body.billId);
  assert.deepEqual(bill.product[0].stockSnapshot, { stockCountStatus: true, linkMultiply: 6, linkIds: [f.id.pPack, f.id.pCan] });
  // แผนตัดของแอปเก่า (CheckoutScreen.js:783-811) กับค่าตั้งเดียวกัน ได้จำนวนเท่ากัน
  if (O.HAVE_OLD) {
    const { checkoutStockPlan } = O.old("stock");
    const doc = f.data.stock[f.id.pPack];
    const plan = checkoutStockPlan([{ id: f.id.pPack, qty: 1, stockCountStatus: true, linkMultiply: doc.linkMultiply, linkDetail: doc.linkDetail }]);
    assert.deepEqual(plan.newStock.map((x) => [x.id, 60 - x.qty]).sort(), [[f.id.pCan, 54], [f.id.pPack, 54]].sort());
  }
});

test("สมาชิก: แต้ม bought lastTime · existPoint บนบิล · เทียบสูตรเขียนสมาชิกของแอปเก่า", async () => {
  const f = await fresh();
  const before = await get("member", f.id.m1);
  const r = await sell(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, gainPoint: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await get("member", f.id.m1);
  const bill = await get("bill", r.body.billId);
  assert.equal(m.point, 32);
  assert.equal(bill.existPoint, 32);
  assert.equal(bill.gainPoint, 2);
  assert.equal(ms(m.lastTime), Date.parse(NOW_ISO));
  parseOk(S.Member, m, "member");
  if (O.HAVE_OLD) {
    const { oldSaleMember } = O.old("member");
    const o = await oldSaleMember({ memberData: before, moneyMustPaid: 20, diffPoint: 2, currentCredit: 0, trueReceiptNumber: bill.receiptNumber, billId: r.body.billId, now: new Date(NOW_ISO) });
    assert.equal(m.point, o.memberObj.point);
    assert.deepEqual(m.bought.map(({ yearMonth, buy, time, year }) => ({ yearMonth, buy, time, year })), o.memberObj.bought);
  }
});

test("เงินเซ็น: creditArray เพิ่มแถว {receiptNumber billId totalCredit remainCredit timestamp receiptUUID} · ไม่ได้แต้มเมื่อร้านปิด creditPoint", async () => {
  const f = await fresh();
  const body = saleBody(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }], change: 0, gainPoint: 2, currentCredit: 20 });
  const r = await call(create, NOW, { body, shopAccess: f.access.owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await get("member", f.id.m1);
  assert.equal(m.point, 30, "เซ็น + creditPoint false = ไม่ได้แต้ม (แอปเก่า CheckoutScreen.js:313)");
  assert.equal(m.creditArray.length, 1);
  const row = m.creditArray[0];
  assert.equal(row.billId, r.body.billId);
  assert.equal(row.receiptNumber, r.body.receiptNumber);
  assert.equal(row.totalCredit, 20);
  assert.equal(row.remainCredit, 20);
  assert.equal(row.receiptUUID, body.receiptUUID);
  parseOk(S.Member, m, "member");
  if (O.HAVE_OLD) assert.equal(O.old("member").oldTotalCredit(m), 20, "แอปเก่าอ่านยอดหนี้รวมได้");
});

test("ส่ง receiptUUID เดิมซ้ำทีละครั้ง: duplicate · ไม่มีบิลที่ 2 · ตัวนับ สต็อก แต้ม ไม่ขยับ", async () => {
  const f = await fresh();
  const body = saleBody(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, gainPoint: 2 });
  const a = await call(create, NOW, { body, shopAccess: f.access.owner });
  const b = await call(create, NOW, { body, shopAccess: f.access.owner });
  assert.equal(a.body.duplicate, false);
  assert.deepEqual([b.status, b.body.duplicate, b.body.billId, b.body.receiptNumber], [200, true, a.body.billId, a.body.receiptNumber]);
  assert.equal((await where("bill", "receiptUUID", body.receiptUUID)).length, 1);
  assert.equal((await get("billId", f.id.shopA)).receipts, 42);
  assert.equal((await get("stock", f.id.pWater)).stock, 48);
  assert.equal((await get("member", f.id.m1)).point, 32);
});

test("sale.create ซ้ำพร้อมกัน 2 คำขอ (receiptUUID เดียวกัน): บิลเดียว · เลขเดียว · ตัดสต็อกครั้งเดียว", async () => {
  const f = await fresh();
  const body = saleBody(f);
  const rs = await Promise.all([1, 2].map(() => call(create, NOW, { body, shopAccess: f.access.owner })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  assert.deepEqual(rs.map((r) => r.body.duplicate).sort(), [false, true]);
  assert.equal(rs[0].body.billId, rs[1].body.billId);
  const bills = await where("bill", "receiptUUID", body.receiptUUID);
  assert.equal(bills.length, 1);
  assert.equal((await get("billId", f.id.shopA)).receipts, 42);
  assert.equal((await get("stock", f.id.pWater)).stock, 48);
});

test("ขายพร้อมกัน 5 ใบคนละ receiptUUID: เลขไม่ชน 42..46 · สต็อกตัดครบ", async () => {
  const f = await fresh();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => sell(f)));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.body)));
  assert.deepEqual(rs.map((r) => r.body.receiptNumber).sort(), ["202611000042", "202611000043", "202611000044", "202611000045", "202611000046"]);
  assert.equal((await get("billId", f.id.shopA)).receipts, 46);
  assert.equal((await get("stock", f.id.pWater)).stock, 40);
});

test("แอปเก่านับเลขต่อจากตัวนับที่ server เขียน: เลขถัดไปไม่ชน (old checkoutCounter)", { skip: O.skipOld }, async () => {
  const f = await fresh();
  const r = await sell(f);
  const counterSnap = await E.db.collection("billId").doc(f.id.shopA).get();
  const writes = [];
  const fakeTx = { set: (_r, v) => writes.push(["set", v]), update: (_r, v) => writes.push(["update", v]) };
  const out = O.withFrozenDate(NOW_ISO, () => O.old("docNumber").checkoutCounter({ transaction: fakeTx, billIdDoc: counterSnap, billIdRef: {}, receiptType: "month" }));
  assert.equal(r.body.receiptNumber, "202611000042");
  assert.equal(out.trueReceiptNumber, "202611000043");
  assert.deepEqual(writes, [["update", { receipts: 43 }]]);
});

test("ออฟไลน์มาช้าหลังปิดกะ: เข้ารอบที่ขายจริงทาง shiftOpenTime · lateSales lateBillQty · กะใหม่ของแอปเก่าไม่นับ", async () => {
  const f = await fresh();
  const openMs = Date.parse(OPEN_ISO);
  const histId = `${f.id.sh1}_${openMs}`;
  // ปิดรอบ 08:00 ตอน 09:30 แล้วเปิดรอบใหม่ 10:00 ด้วย handler shift.manage ตัวจริง (ประวัติรอบ = ของที่ server เขียนจริง)
  const shiftBody = (over) => ({ shopId: f.id.shopA, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), ...over });
  const at = clock("2026-11-10T02:30:00.000Z");
  const c = await call(manage, at, { body: shiftBody({ op: "close", closeCash: "500", closeWithDraw: "0", expectedCash: 500 }), shopAccess: f.access.owner });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.shiftHistoryId, histId);
  const o = await call(manage, NOW, { body: shiftBody({ op: "open", openCash: "300" }), shopAccess: f.access.owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const soldAt = "2026-11-10T02:00:00.000Z";
  const late = (over) => sell(f, { offline: true, soldAt, offlineRef: "T261110-AB12-01", ...over });
  const r = await late({ shiftOpenTime: OPEN_ISO });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.shift, { status: "late", shiftHistoryId: histId });
  const bill = await get("bill", r.body.billId);
  assert.equal(bill.shiftHistoryId, histId);
  assert.equal(bill.offlineSync, true);
  assert.equal(ms(bill.dateTime), Date.parse(soldAt));
  assert.equal(ms(bill.soldAt), Date.parse(soldAt));
  assert.equal(ms(bill.syncedAt), Date.parse(NOW_ISO));
  assert.equal(bill.offlineRef, "T261110-AB12-01");
  assert.equal(bill.shiftUnassigned, undefined);
  parseOk(S.Bill, bill, "bill ออฟไลน์");
  const h = await get("shiftHistory", histId);
  assert.equal(h.lateSales, 20);
  assert.equal(h.lateBillQty, 1);
  parseOk(S.AnyShiftHistory, h, "shiftHistory");

  // ใบที่ 2 เข้ารอบเดิม · ใบที่หารอบไม่เจอ = unassigned (ไม่ปัด)
  await late({ shiftOpenTime: OPEN_ISO });
  assert.deepEqual([(await get("shiftHistory", histId)).lateSales, (await get("shiftHistory", histId)).lateBillQty], [40, 2]);
  const u = await late({ shiftOpenTime: "2026-11-09T01:00:00.000Z" });
  assert.equal(u.body.shift.status, "unassigned");
  assert.equal((await get("bill", u.body.billId)).shiftUnassigned, true);

  if (O.HAVE_OLD) {
    // จอกะของแอปเก่า (/shift/test) ดูรอบที่เปิดอยู่ (เปิด 10:00) · บิลมาช้าขาย 09:00 ไม่เข้ากะนี้ = เหมือนแอปเก่าเดิม
    const o = await O.oldShiftTest(E.db, { shiftId: f.id.sh1 });
    assert.equal(o.thisSummary.thisSelectedQty, 0);
  }
});

test("ยกเลิกบิล: void · คืนสต็อก · คืนแต้ม · notification · เทียบสูตรยกเลิกของแอปเก่า", async () => {
  const f = await fresh();
  const s = await sell(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, gainPoint: 2, product: [{ id: f.id.pWater, qty: 2, name: "น้ำดื่ม", net: 20, totalPrice: 20, totalCost: 12 }, { id: f.id.pMeat, qty: 0.25, name: "หมูสับ", net: 30, totalPrice: 30, totalCost: 20 }], payment: [{ id: 1, amount: 50, name: "เงินสด" }], moneyMustPaid: 50, change: 0 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const billBefore = await get("bill", s.body.billId);
  const memberBefore = await get("member", f.id.m1);
  const stocksBefore = { w: await get("stock", f.id.pWater), m: await get("stock", f.id.pMeat) };
  const vb = voidBody(f, s.body.billId, { shiftId: f.id.sh1 });
  const v = await call(makeVoid, NOW, { body: vb, shopAccess: f.access.owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.voidShift.status, "open");

  const bill = await get("bill", s.body.billId);
  assert.equal(bill.void, true);
  assert.equal(bill.voidStaff, "เจ้าของ");
  assert.equal(bill.reason, "ลูกค้าเปลี่ยนใจ");
  assert.equal(bill.voidRequestId, vb.requestId);
  assert.equal(bill.voidShiftId, f.id.sh1);
  assert.equal(ms(bill.voidAt), Date.parse(NOW_ISO));
  parseOk(S.Bill, bill, "bill ที่ยกเลิก");
  assert.equal((await get("stock", f.id.pWater)).stock, 50);
  assert.equal((await get("stock", f.id.pMeat)).stock, 10);
  const m = await get("member", f.id.m1);
  assert.equal(m.point, 30);
  const noti = (await where("notification", "shopId", f.id.shopA)).filter((n) => n.heading === "ยกเลิกใบเสร็จ");
  assert.equal(noti.length, 1);
  assert.equal(noti[0].categoryId, 1);

  if (O.HAVE_OLD) {
    const { voidStockPlan, voidRestore } = O.old("stock");
    const plan = voidStockPlan(billBefore.product, (id) => f.data.stock[id]);
    const oldNext = Object.fromEntries(plan.map((mv) => [mv.id, voidRestore(mv.id === f.id.pWater ? stocksBefore.w : stocksBefore.m, mv).stock]));
    assert.equal(oldNext[f.id.pWater], 50);
    assert.equal(Math.round(oldNext[f.id.pMeat] * 1e4) / 1e4, 10);
    const o = await O.old("member").oldVoidMember({ memberData: memberBefore, bill: { ...billBefore, id: s.body.billId }, formatTime: (t) => t.toDate() });
    assert.equal(m.point, o.point);
    assert.deepEqual(m.bought.map(({ yearMonth, buy, time }) => ({ yearMonth, buy, time })), o.bought.map(({ yearMonth, buy, time }) => ({ yearMonth, buy, time })));
  }
});

test("บิลที่ออกใบกำกับแล้วยกเลิกไม่ได้ (Pack เคาะ 2026-11-06): ขาย → ออกใบกำกับ → ยกเลิก 409 tax_invoice_issued · บิล สต็อก แจ้งเตือน ไม่เปลี่ยน", async () => {
  const f = await fresh();
  const s = await sell(f);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const cust = { id: "c1", name: "บริษัท ลูกค้า จำกัด", tel: "0000000000", address: "กรุงเทพ", taxNumber: "0105500000000", branch: "สำนักงานใหญ่" };
  const t = await call(issueTaxInvoice, NOW, { body: { shopId: f.id.shopA, billId: s.body.billId, taxCustomer: cust, staffId: f.id.owner, staffName: "เจ้าของ" }, shopAccess: f.access.owner });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const billBefore = await get("bill", s.body.billId);
  const stockBefore = (await where("stock", "shopId", f.id.shopA)).map((d) => d.stock).sort();
  for (const acc of [f.access.owner, f.access.staff]) {
    const v = await call(makeVoid, NOW, { body: voidBody(f, s.body.billId, { staffId: acc.uid, shiftId: f.id.sh1 }), shopAccess: acc });
    assert.equal(v.status, 409, JSON.stringify(v.body));
    assert.equal(v.body.error, "tax_invoice_issued");
  }
  assert.deepEqual(await get("bill", s.body.billId), billBefore);
  assert.deepEqual((await where("stock", "shopId", f.id.shopA)).map((d) => d.stock).sort(), stockBefore);
  assert.equal((await where("notification", "shopId", f.id.shopA)).filter((n) => n.heading === "ยกเลิกใบเสร็จ").length, 0);
});

test("ยกเลิกพร้อมกัน 2 เครื่อง (คนละ requestId): คืนสต็อกครั้งเดียว · ใบหนึ่ง 200 อีกใบ 409 already_void", async () => {
  const f = await fresh();
  const s = await sell(f, { product: [{ id: f.id.pMeat, qty: 1.2345, name: "หมูสับ", net: 148.14, totalPrice: 148.14, totalCost: 98.76 }], payment: [{ id: 1, amount: 148.14, name: "เงินสด" }], moneyMustPaid: 148.14, change: 0 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await get("stock", f.id.pMeat)).stock, 8.7655);
  const rs = await Promise.all([f.access.owner, f.access.staff].map((acc) => call(makeVoid, NOW, { body: voidBody(f, s.body.billId, { staffId: acc.uid }), shopAccess: acc })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
  assert.equal(rs.find((r) => r.status === 409).body.error, "already_void");
  assert.equal((await get("stock", f.id.pMeat)).stock, 10);
  assert.equal((await where("notification", "shopId", f.id.shopA)).length, 1);
});

test("ยกเลิกพร้อมกัน requestId เดียวกัน (กดรัว): คืนสต็อกครั้งเดียว · อีกคำตอบเป็น alreadyVoid", async () => {
  const f = await fresh();
  const s = await sell(f);
  const body = voidBody(f, s.body.billId);
  const rs = await Promise.all([1, 2].map(() => call(makeVoid, NOW, { body, shopAccess: f.access.owner })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  assert.deepEqual(rs.map((r) => r.body.alreadyVoid).sort(), [false, true]);
  assert.equal((await get("stock", f.id.pWater)).stock, 50);
});

test("ยกเลิกบิลเงินเซ็น: แถวหนี้ของบิลนั้นหายจาก creditArray เหมือนแอปเก่า", async () => {
  const f = await fresh();
  const s = await sell(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }], change: 0, currentCredit: 20 });
  const memberBefore = await get("member", f.id.m1);
  const billBefore = await get("bill", s.body.billId);
  const v = await call(makeVoid, NOW, { body: voidBody(f, s.body.billId), shopAccess: f.access.owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const m = await get("member", f.id.m1);
  assert.deepEqual(m.creditArray, []);
  if (O.HAVE_OLD) {
    const o = await O.old("member").oldVoidMember({ memberData: memberBefore, bill: { ...billBefore, id: s.body.billId }, formatTime: (t) => t.toDate() });
    assert.deepEqual(m.creditArray, o.creditArray);
    assert.equal(O.old("member").oldTotalCredit(m), 0);
  }
});

test("ร้าน S5 (doc id ≠ field shopId): บิล สมาชิก เขียน shopId = field แบบแอปเก่า · ยกเลิกได้", async () => {
  const f = E.shopFixture();
  const field = `ownerUid${f.id.n}`;
  f.data.shop[f.id.shopA].shopId = field;
  f.data.shift[f.id.sh1].shopId = field;
  f.data.member[f.id.m1].shopId = field;
  f.data.stock[f.id.pWater].shopId = field;
  await seed(f.data);
  const s = await sell(f, { receiptUUID: E.uuid(field), member: { id: f.id.m1, name: "ลูกค้าเอ" }, gainPoint: 1 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const bill = await get("bill", s.body.billId);
  assert.equal(bill.shopId, field);
  assert.equal((await get("stock", f.id.pWater)).stock, 48);
  const v = await call(makeVoid, NOW, { body: voidBody(f, s.body.billId), shopAccess: f.access.owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await get("stock", f.id.pWater)).stock, 50);
  if (O.HAVE_OLD) {
    const list = await O.oldBillList(E.db, { shopId: field, limit: 10, startDate: "2026-11-09T17:00:00.000Z", endDate: "2026-11-10T17:00:00.000Z" });
    assert.equal(list.newData.length, 1, "จอประวัติบิลแอปเก่า query ด้วย field shop.shopId เห็นบิล");
  }
});

test("ทีมงาน (byAdmin): ทุกเอกสารที่เขียนมี byAdmin adminUid · คำตอบมี byAdmin", async () => {
  const f = await fresh();
  const admin = { shopId: f.id.shopA, uid: "u-admin-e2e", role: "owner", rights: [], byAdmin: true };
  const body = saleBody(f);
  const r = await call(create, NOW, { body, shopAccess: admin });
  assert.equal(r.body.byAdmin, true);
  for (const [c, id] of [["bill", r.body.billId], ["receiptGuard", body.receiptUUID], ["billId", f.id.shopA], ["stock", f.id.pWater]]) {
    const d = await get(c, id);
    assert.deepEqual([d.byAdmin, d.adminUid], [true, "u-admin-e2e"], c);
  }
  parseOk(S.Bill, await get("bill", r.body.billId), "bill byAdmin");
});

test("สต็อกของร้านอื่นในแถวสินค้า: ข้ามแถวนั้น ไม่แตะ doc ร้านบี (บิลยังออก)", async () => {
  const f = await fresh();
  const r = await sell(f, { product: [{ id: f.id.pB, qty: 1, name: "x", net: 20, totalPrice: 20, totalCost: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = await get("stock", f.id.pB);
  assert.equal(b.stock, 9);
  assert.equal(ms(b.updateTime), Date.parse("2026-11-05T17:12:29Z"));
  assert.equal((await get("bill", r.body.billId)).product[0].stockSnapshot, undefined);
});

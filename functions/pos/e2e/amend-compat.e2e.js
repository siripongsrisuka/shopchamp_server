// pos/e2e/amend-compat.e2e.js — sale.amend ลิงก์ 2 ทาง · ปัดข้ามร้านไม่เขียนอะไร · จอประวัติบิลของแอปเก่าอ่านของใหม่ได้ (ก้อน 4 · DEV-0001)
// รัน: cd functions && npm run test:e2e
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const O = require("./_old");
const { create } = require("../sale/create");
const { void: makeVoid } = require("../sale/void");
const { amend } = require("../sale/amend");
const { get: makeGet } = require("../sale/get");
const { manage } = require("../shift/manage");
const { payCredit } = require("../member/payCredit");
const { discardPending } = require("../sale/discardPending");
const { makeRequireShopAccess } = require("../_shared/auth");

const { call, seed, get, ms, clock, saleBody, reqId, dump, NOW_ISO } = E;
const NOW = clock(NOW_ISO);
const parseOk = (schema, doc, label) => {
  const r = schema.safeParse(doc);
  assert.ok(r.success, `${label} ไม่ผ่าน schema: ${String(JSON.stringify(r.error && r.error.issues)).slice(0, 800)}`);
};
const fresh = async () => { const f = E.shopFixture(); await seed(f.data); return f; };
const twoWater = (f) => ({ product: [{ id: f.id.pWater, qty: 2, name: "น้ำดื่ม", net: 100, totalPrice: 100, totalCost: 12 }], payment: [{ id: 1, amount: 100, name: "เงินสด" }], moneyMustPaid: 100, change: 0 });
const amendBody = (f, billId, over = {}) => ({
  shopId: f.id.shopA, billId, requestId: reqId(), reason: "ลูกค้าคืน 1 ขวด", staffId: f.id.owner, staffName: "เจ้าของ",
  product: [{ fromIndex: 0, id: f.id.pWater, qty: 1, name: "น้ำดื่ม", net: 50, totalPrice: 50, totalCost: 6 }],
  payment: [{ id: 1, amount: 50, name: "เงินสด" }], moneyMustPaid: 50, ...over,
});

before(() => E.ready());

test("แก้บิล: ใบเดิม void + ลิงก์ไปใบใหม่ · ใบใหม่ลิงก์กลับ · สต็อกสุทธิถูก · ทั้ง 2 ใบผ่าน Bill · จอเก่าอ่านได้", async () => {
  const f = await fresh();
  const s = await call(create, clock("2026-11-10T02:00:00.000Z"), { body: saleBody(f, twoWater(f)), shopAccess: f.access.owner });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await get("stock", f.id.pWater)).stock, 48);
  const body = amendBody(f, s.body.billId);
  const a = await call(amend, NOW, { body, shopAccess: f.access.owner });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, "done");
  assert.equal(a.body.refundDue, 50);

  const oldBill = await get("bill", s.body.billId);
  const newBill = await get("bill", a.body.newBillId);
  assert.equal(oldBill.void, true);
  assert.equal(oldBill.amendedBy, a.body.newBillId);
  assert.equal(oldBill.amend.status, "done");
  assert.equal(oldBill.amend.newBillId, a.body.newBillId);
  assert.equal(oldBill.amend.newReceiptNumber, a.body.newReceiptNumber);
  assert.equal(oldBill.amend.requestId, body.requestId);
  assert.equal(newBill.amendOf, s.body.billId);
  assert.equal(newBill.amend.ofBillId, s.body.billId);
  assert.equal(newBill.amend.ofReceiptNumber, s.body.receiptNumber);
  assert.equal(newBill.receiptUUID, `amend:${s.body.billId}:${body.requestId}`);
  assert.equal(newBill.moneyMustPaid, 50);
  assert.deepEqual([newBill.pointDiscount, newBill.campaign], [{ value: 0, point: 0 }, []], "ช่องที่แอปเก่าอ่านตรง (usePrintAction) มีค่าว่างเสมอ");
  assert.equal(ms(newBill.dateTime), Date.parse("2026-11-10T02:00:00.000Z"), "ใบใหม่ถือเวลาใบเดิม");
  assert.equal(newBill.shiftId, oldBill.shiftId);
  assert.equal(ms(newBill.shiftOpenTime), ms(oldBill.shiftOpenTime));
  assert.equal((await get("stock", f.id.pWater)).stock, 49, "คืน 2 ตัด 1");
  parseOk(S.Bill, oldBill, "บิลเดิม");
  parseOk(S.Bill, newBill, "บิลใหม่");

  // sale.get อ่านทั้ง 2 ใบได้ shape current
  for (const id of [s.body.billId, a.body.newBillId]) {
    const g = await call(makeGet, {}, { body: { shopId: f.id.shopA, billId: id }, shopAccess: f.access.owner });
    assert.deepEqual([g.status, g.body.shape], [200, "current"], JSON.stringify(g.body));
  }
  // ยิงซ้ำ requestId เดิม = duplicate ไม่มีใบที่ 3
  const again = await call(amend, NOW, { body, shopAccess: f.access.owner });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.newBillId, a.body.newBillId);
  assert.equal((await E.where("bill", "shopId", f.id.shopA)).length, 2);
  assert.equal((await get("stock", f.id.pWater)).stock, 49);

  if (O.HAVE_OLD) {
    // จอประวัติบิลแอปเก่า (/bill/test) วันนี้ตามรอบตัดวัน 00:00 · เห็นใบใหม่ปกติ และใบเดิมในแท็บยกเลิก พร้อมเหตุผล
    const list = await O.oldBillList(E.db, { shopId: f.id.shopA, limit: 10, startDate: "2026-11-09T17:00:00.000Z", endDate: "2026-11-10T17:00:00.000Z" });
    const byId = Object.fromEntries(list.newData.map((b) => [b.id, b]));
    assert.equal(byId[a.body.newBillId].voidStatus, false);
    assert.equal(byId[s.body.billId].voidStatus, true);
    assert.equal(byId[s.body.billId].reason, `แก้ไข → ${a.body.newReceiptNumber} · ${body.reason}`, "แท็บยกเลิกแอปเก่าแสดงเหตุผลพร้อมเลขใบใหม่");
    for (const b of list.newData) assert.ok(b.dateTime instanceof Date && Array.isArray(b.payment) && typeof b.receiptNumber === "string");
    const sum = await O.oldBillSummary(E.db, { shopId: f.id.shopA, startDate: "2026-11-09T17:00:00.000Z", endDate: "2026-11-10T17:00:00.000Z" });
    assert.deepEqual(sum, { qty: 1, totalSale: 50 });
    // จอกะของแอปเก่า: ใบเดิมนับเป็นยกเลิก ใบใหม่นับขาย
    const sh = await O.oldShiftTest(E.db, { shiftId: f.id.sh1 });
    assert.deepEqual([sh.thisSummary.thisSelectedQty, sh.thisSummary.thisVoidQty, sh.thisSummary.thisTotalNet], [1, 1, 50]);
    // พิมพ์ใบกำกับเต็มจากจอประวัติ (usePrintAction) อ่าน field ของใบใหม่ได้ไม่ throw
    assert.doesNotThrow(() => O.oldPrintFields(newBill));
  }
});

test("พิมพ์ซ้ำ/ใบกำกับของแอปเก่า กับบิลที่คำขอไม่ส่ง pointDiscount campaign (schema ยอมให้ขาด)", { skip: O.skipOld, todo: "แอปเก่าอ่าน pointDiscount.value และ campaign.length ตรง ๆ · บิลขาด 2 ช่องนี้ = จอพิมพ์ใบกำกับแอปเก่า throw · รอ Pack เลือก: server เติมค่าตั้งต้น หรือบังคับแอปใหม่ส่ง" }, async () => {
  const f = await fresh();
  const body = saleBody(f);
  delete body.pointDiscount;
  delete body.campaign;
  const s = await call(create, NOW, { body, shopAccess: f.access.owner });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const bill = await get("bill", s.body.billId);
  parseOk(S.Bill, bill, "บิลไม่มี pointDiscount campaign");
  assert.doesNotThrow(() => O.oldPrintFields(bill));
});

test("ปัดข้ามร้านทุก route: ไม่เขียนอะไรลงฐานเลยสักตัว", async () => {
  const f = await fresh();
  const own = await call(create, NOW, { body: saleBody(f), shopAccess: f.access.owner });
  const billB = `billB${f.id.n}`;
  const guardB = E.uuid(f.id.shopB);
  await seed({
    bill: { [billB]: { ...(await get("bill", own.body.billId)), shopId: f.id.shopB, receiptUUID: guardB } },
    receiptGuard: { [guardB]: { createdAt: E.T(NOW_ISO), usedBy: "202611000001", billId: billB, shopId: f.id.shopB } },
  });
  const A = f.access.owner;
  const vb = (over) => ({ shopId: f.id.shopA, billId: billB, requestId: reqId(), reason: "x", staffId: f.id.owner, staffName: "เจ้าของ", ...over });
  const pc = (over) => ({ shopId: f.id.shopA, memberId: f.id.m1, amount: 1, paymentId: 1, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", payUUID: reqId(), ...over });
  const tries = [
    ["create wrong_shop", create, { body: saleBody(f, { shopId: f.id.shopB }), shopAccess: A }, 403, "wrong_shop"],
    ["create member ร้านบี", create, { body: saleBody(f, { member: { id: f.id.mB, name: "x" } }), shopAccess: A }, 409, "member_other_shop"],
    ["create shift ร้านบี", create, { body: saleBody(f, { shiftId: f.id.shB }), shopAccess: A }, 409, "shift_other_shop"],
    ["create guard ร้านบี", create, { body: saleBody(f, { receiptUUID: guardB }), shopAccess: A }, 409, "receipt_uuid_other_shop"],
    ["void บิลร้านบี", makeVoid, { body: vb(), shopAccess: A }, 409, "bill_other_shop"],
    ["void ร้านบีด้วยสิทธิ์ร้านเอ", makeVoid, { body: vb({ shopId: f.id.shopB }), shopAccess: A }, 403, "wrong_shop"],
    ["amend บิลร้านบี", amend, { body: amendBody(f, billB), shopAccess: A }, 409, "bill_other_shop"],
    ["get บิลร้านบี", makeGet, { body: { shopId: f.id.shopA, billId: billB }, shopAccess: A }, 409, "bill_other_shop"],
    ["payCredit สมาชิกร้านบี", payCredit, { body: pc({ memberId: f.id.mB }), shopAccess: A }, 409, "member_other_shop"],
    ["payCredit กะร้านบี", payCredit, { body: pc({ shiftId: f.id.shB }), shopAccess: A }, 409, "shift_other_shop"],
    ["shift.manage กะร้านบี", manage, { body: { op: "during", shopId: f.id.shopA, shiftId: f.id.shB, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), type: 1, amount: "1", comment: "" }, shopAccess: A }, 409, "shift_other_shop"],
    ["discardPending guard ร้านบี", discardPending, { body: { shopId: f.id.shopA, receiptUUID: guardB, offlineRef: "T261110-AB12-09", body: { a: 1 }, reason: "x", deviceAt: "2026-11-10T10:00:00+07:00" }, shopAccess: A }, 409, "receipt_uuid_other_shop"],
  ];
  const snap = await dump();
  for (const [label, make, args, code, error] of tries) {
    const r = await call(make, NOW, args);
    assert.deepEqual([r.status, r.body && r.body.error], [code, error], `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.billId, undefined, `${label} ไม่คืน billId`);
    assert.equal(r.body.bill, undefined, `${label} ไม่คืนเนื้อบิล`);
  }
  assert.deepEqual(await dump(), snap, "ฐานต้องเหมือนก่อนยิงทุกตัว");
});

test("middleware requireShopAccess บนฐานจริง: คนนอกร้าน 403 · ทีมงานผ่านเป็น byAdmin · ต่อ handler แล้วเขียนรอยทีมงาน", async () => {
  const f = await fresh();
  const mw = makeRequireShopAccess({ now: NOW.now, log: () => {} });
  const run = async (uid, shopId) => {
    const req = { body: { shopId }, auth: { uid } };
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    await mw(req, res, () => { passed = true; });
    return { passed, req, res };
  };
  const outsider = await run(`u-b${f.id.n}`, f.id.shopA);
  assert.deepEqual([outsider.passed, outsider.res.statusCode, outsider.res.body.error], [false, 403, "not_shop_member"]);
  const ghost = await run(f.id.owner, `ghost${f.id.n}`);
  assert.deepEqual([ghost.passed, ghost.res.statusCode, ghost.res.body.error], [false, 404, "shop_not_found"]);
  const adm = await run("u-admin-e2e", f.id.shopA);
  assert.equal(adm.passed, true);
  assert.deepEqual(adm.req.shopAccess, { shopId: f.id.shopA, uid: "u-admin-e2e", role: "owner", rights: [], byAdmin: true });
  const staff = await run(f.id.staff, f.id.shopA);
  assert.deepEqual(staff.req.shopAccess, { shopId: f.id.shopA, uid: f.id.staff, role: "staff", rights: ["116", "124"] });
  const r = await call(create, NOW, { body: saleBody(f), shopAccess: adm.req.shopAccess });
  assert.equal(r.body.byAdmin, true);
  assert.equal((await get("bill", r.body.billId)).adminUid, "u-admin-e2e");
});

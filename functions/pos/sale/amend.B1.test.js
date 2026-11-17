// เทสบั๊ก server-money B1 (DEV-0011) · แก้บิลค้างครึ่งทาง = ใบใหม่ออกแล้ว ใบเดิมไม่ถูกยกเลิก
//   เดิมชื่อ amend.B1.repro.js (แดงกับโค้ดก่อนแก้: B1-1 ออกใบใหม่แล้ว void ไม่ได้ · B1-2 ออกใบกำกับระหว่างค้างได้)
//   หลังแก้: amend ① ตรวจใบเดิมด้วย void.billStateForVoid ก่อนออกใบใหม่ · issueTaxInvoice ปัดบิลที่ amend.status pending
//   ด่าน shopchamp-center/gate/check-pos-tests.js เก็บไฟล์นี้ (*.test.js)
//   รัน: cd shopchamp_server/functions && node --test pos/sale/amend.B1.test.js
//   เรียก handler ตัวจริง: sale.amend (ไม่ส่ง voidSale ⇒ ใช้ sale.void ในโปรเซส) · sale.void · sale.issueTaxInvoice
//   ส่วนที่ปลอม: createSale (ออกใบใหม่ · เขียนบิลใบใหม่ลงฐานปลอม) และฐาน Firestore ปลอม · ❌ ไม่แตะ Firestore จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const FV = require("../_shared/fakeFieldValue");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const LATER = new Date("2026-11-10T03:06:00.000Z"); // เกิน 5 นาที (AMEND_PENDING_TTL_MS)
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };
const RID = "3c9e1f20-1111-4000-8000-0000000000aa";
const RID_REOPEN = "3c9e1f20-3333-4000-8000-0000000000cc"; // ปิดหน้าต่างแล้วเปิดใหม่ = uuid ใหม่ (Modal_AmendBill.js useEffect)
const RID_VOID = "3c9e1f20-4444-4000-8000-0000000000dd";

// ── ฐานปลอม (รูปเดียวกับ void.test.js + where/limit ของ issueTaxInvoice.test.js) ──
let DATA = {};
let COMMIT_MS = Date.parse("2026-11-10T03:00:30.000Z");
const OPS = { "==": (a, b) => a === b, ">=": (a, b) => typeof a === typeof b && a >= b, "<=": (a, b) => typeof a === typeof b && a <= b };
function makeDb() {
  let auto = 0;
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const run = (c, filters, n) => Object.entries(DATA[c] || {})
    .filter(([, d]) => filters.every(([f, op, v]) => OPS[op](d[f], v)))
    .slice(0, n === undefined ? Infinity : n)
    .map(([id, d]) => ({ id, exists: true, data: () => d }));
  const ref = (c, id) => ({ c, id, get: async () => snapOf(c, id) });
  const query = (c, filters) => ({
    c, filters,
    where: (f, op, v) => query(c, [...filters, [f, op, v]]),
    limit: (n) => ({ c, filters, n, get: async () => ({ docs: run(c, filters, n) }) }),
  });
  return {
    collection: (c) => ({ doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`), where: (f, op, v) => query(c, []).where(f, op, v) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id} หลังเขียน (Firestore ปัด)`);
          if (r.filters) { const docs = run(r.c, r.filters, r.n); return { docs, empty: docs.length === 0 }; }
          return snapOf(r.c, r.id);
        },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); },
        set: (r, v, o) => { writes.push({ op: "set", c: r.c, id: r.id, v, merge: !!(o && o.merge) }); },
      };
      const out = await fn(tx);
      const commitTime = new Date(++COMMIT_MS);
      for (const w of writes) {
        DATA[w.c] = DATA[w.c] || {};
        if (w.op === "update" && DATA[w.c][w.id] === undefined) throw new Error(`update ${w.c}/${w.id} ที่ไม่มี doc`);
        DATA[w.c][w.id] = FV.applyWrite(DATA[w.c][w.id], w.v, { op: w.op, merge: w.merge, commitTime });
      }
      return out;
    },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {}, FieldValue: FV.FieldValue } };

const { amend } = require("./amend");
const V = require("./void");
const T = require("./issueTaxInvoice");
const { amendReceiptUUID } = require("../_shared/idempotency");

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const INPUT = {
  shopId: "shopA", billId: "b1", requestId: RID, reason: "คืน 1 ขวด", staffId: "u-owner", staffName: "เจ้าของ",
  product: [{ fromIndex: 0, id: "p1", qty: 1, name: "น้ำ", net: 50, totalPrice: 50, totalCost: 30 }],
  payment: [{ id: 1, amount: 50, name: "เงินสด" }], moneyMustPaid: 50,
};

function seed(billExtra = {}) {
  COMMIT_MS = Date.parse("2026-11-10T03:00:30.000Z");
  DATA = {
    shop: { shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", position: ["001"], status: "active" }], vip: [{ type: "premium", expire: ts("2027-01-01T00:00:00.000Z") }], amendBill: true, shift: true } },
    shift: { sh1: { shopId: "shopA", status: true, openTime: ts("2026-11-10T01:00:00.000Z"), duringShift: [] } },
    stock: { p1: { shopId: "shopA", stockCountStatus: true, stock: 10, cost: 30 } },
    taxId: { shopA: { month: 11, receipts: 7 } },
    bill: {
      b1: {
        shopId: "shopA", receiptNumber: "202611000010", billDate: "20261110", dateTime: ts("2026-11-10T02:00:00.000Z"), receiptType: "month",
        moneyMustPaid: 100, product: [{ id: "p1", qty: 2, name: "น้ำ", net: 100, totalPrice: 100, totalCost: 60 }], payment: [{ id: 1, amount: 100, name: "เงินสด" }],
        member: {}, campaign: [], gainPoint: 0, usedPoint: 0, pointDiscount: { value: 0, point: 0 },
        shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), manualDiscount: 0, cashierId: "u-owner",
        ...billExtra,
      },
    },
  };
}

// createSale ปลอม = sale.create สำเร็จ · เขียนใบใหม่ลงฐาน (นับในยอดขาย/ปิดกะเหมือนบิลจริง) · ยิงซ้ำ uuid เดิม = ใบเดิม
function createStub() {
  const calls = [];
  return {
    calls,
    createSale: async (i) => {
      calls.push(i);
      if (!DATA.bill["b-new"]) {
        DATA.bill["b-new"] = {
          shopId: "shopA", receiptNumber: "202611000043", billDate: "20261110", dateTime: ts("2026-11-10T02:00:00.000Z"), receiptType: "month",
          moneyMustPaid: i.body.moneyMustPaid, product: i.body.product, payment: i.body.payment, receiptUUID: i.body.receiptUUID,
          member: {}, campaign: [], pointDiscount: { value: 0, point: 0 }, shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"),
        };
      }
      return { ok: true, billId: "b-new", receiptNumber: "202611000043" };
    },
  };
}

async function hit(handler, body, shopAccess = OWNER) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const callAmend = (deps, input = INPUT) => hit(amend(deps), input);
const activeBills = () => Object.entries(DATA.bill).filter(([, b]) => !b.void).map(([id, b]) => `${id}(${b.receiptNumber}·${b.moneyMustPaid})`);

// ── ชุดควบคุม: บิลรูปปกติ ⇒ harness นี้เดินจบได้จริง (ใบเดิมยกเลิก เหลือบิลใช้งาน 1 ใบ) ──
test("ควบคุม: บิลรูปปกติ แก้จบ 200 · ใบเดิม void · เหลือบิลใช้งาน 1 ใบ", async () => {
  seed();
  const c = createStub();
  const r = await callAmend({ now: () => NOW, createSale: c.createSale });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(activeBills(), ["b-new(202611000043·50)"]);
});

// ── B1 ทางที่ 1: ใบเดิมไม่ผ่าน schema Bill ที่ sale.void ใช้ ⇒ ต้องปัดตั้งแต่ ① ไม่ออกใบใหม่ ──
//   product[].qty เป็นสตริง: amendRules อ่านด้วย toNumber ("บิลเก่ามีตัวเลขเป็นข้อความ" amendRules.js:6) ⇒ ด่านเดิมของ ① ผ่าน
//   แต่ Bill.product[].qty = LegacyNumber (typeof number) ⇒ void.js billStateForVoid → 409 bill_unreadable
//   ก่อนแก้: ออกใบใหม่แล้ว ④ ล้ม bill_unreadable ทุกรอบ = บิลใช้งาน 2 ใบ
test("B1-1: ใบเดิม schema ไม่ผ่าน → 409 bill_unreadable ที่ ① · ไม่ออกใบใหม่ · ไม่ประทับ pending · ยิงซ้ำผลเดิม · บิลใช้งาน 1 ใบ", async () => {
  seed({ product: [{ id: "p1", qty: "2", name: "น้ำ", net: 100, totalPrice: 100, totalCost: 60 }] });
  const c = createStub();
  const deps = { now: () => NOW, createSale: c.createSale };

  const r1 = await callAmend(deps);
  assert.equal(r1.code, 409, JSON.stringify(r1.body));
  assert.equal(r1.body.error, "bill_unreadable"); // code เดียวกับที่ sale.void ตอบ
  assert.equal(c.calls.length, 0, "ห้ามออกใบใหม่ก่อนรู้ว่าใบเดิมยกเลิกได้");
  assert.equal(DATA.bill.b1.amend, undefined, "ไม่ประทับ pending (ไม่ล็อกบิลค้าง)");
  assert.equal(DATA.bill.b1.void, undefined, "ใบเดิมไม่ถูกแตะ");

  // แอปบอก "กดยืนยันอีกครั้ง" → กดซ้ำ requestId เดิม = ปัดเดิม ไม่ออกใบ
  const r2 = await callAmend(deps);
  assert.equal(r2.code, 409);
  assert.equal(r2.body.error, "bill_unreadable");
  assert.equal(c.calls.length, 0);

  // เปิดหน้าต่างใหม่หลัง 5 นาที = requestId ใหม่ → ปัดเหตุเดิม (ไม่ใช่ stalled เพราะไม่มีอะไรค้าง)
  const r3 = await callAmend({ now: () => LATER, createSale: c.createSale }, { ...INPUT, requestId: RID_REOPEN });
  assert.equal(r3.code, 409);
  assert.equal(r3.body.error, "bill_unreadable");
  assert.equal(r3.body.stalled, undefined);
  assert.equal(c.calls.length, 0);

  // ยกเลิกเองผ่าน sale.void ก็ปัดเหตุเดียวกัน (เกณฑ์ตัวเดียวกัน) · ไม่มีการขายซ้อน
  const rv = await hit(V.void({ now: () => LATER, log: () => {} }), { shopId: "shopA", billId: "b1", requestId: RID_VOID, reason: "ยกเลิกเอง", staffId: "u-owner", staffName: "เจ้าของ", shiftId: "sh1" });
  assert.equal(rv.body.error, "bill_unreadable");

  assert.deepEqual(activeBills(), ["b1(202611000010·100)"], "การขายนี้ต้องเหลือบิลใช้งาน 1 ใบ");
});

// ── B1 ทางที่ 2: ขั้น ④ ล้มชั่วคราว (instance ตาย/timeout) แล้วระหว่างค้าง มีคนกดออกใบกำกับภาษีให้ใบเดิม ──
//   ก่อนแก้: issueTaxInvoice ไม่ดู bill.amend ⇒ ออกได้ · แล้ว sale.void ตอบ 409 tax_invoice_issued ทุกรอบ (void.js:76) = บิลใช้งาน 2 ใบ
//   หลังแก้: ออกใบกำกับระหว่างค้าง = 409 amend_in_progress ไม่เขียนอะไร · ยิง amend ซ้ำ requestId เดิมแล้วจบ เหลือบิลใช้งาน 1 ใบ
test("B1-2: ④ ล้มชั่วคราว → ออกใบกำกับระหว่างค้าง = 409 amend_in_progress (ตัวนับไม่ขยับ) → ยิงซ้ำ requestId เดิมจบ · บิลใช้งาน 1 ใบ", async () => {
  seed();
  const c = createStub();
  const r1 = await callAmend({ now: () => NOW, createSale: c.createSale, voidSale: async () => { throw new Error("instance timeout 60s"); } });
  assert.equal(r1.body.error, "amend_reverse_failed");
  assert.equal(DATA.bill.b1.amend.status, "pending");
  assert.equal(DATA.bill.b1.amend.newBillId, "b-new");

  const counterBefore = JSON.stringify(DATA.taxId.shopA);
  const TAX = { shopId: "shopA", billId: "b1", staffId: "u-owner", staffName: "เจ้าของ",
    taxCustomer: { id: "c1", name: "บริษัท ลูกค้า จำกัด", tel: "0000000000", address: "กรุงเทพ", taxNumber: "0105500000000", branch: "สำนักงานใหญ่" } };
  const rt = await hit(T.issueTaxInvoice({ now: () => NOW }), TAX);
  assert.equal(rt.code, 409, JSON.stringify(rt.body));
  assert.equal(rt.body.error, "amend_in_progress");
  assert.equal(DATA.bill.b1.taxNumber, undefined, "ไม่เขียนเลขใบกำกับลงบิลที่กำลังถูกแก้");
  assert.equal(DATA.bill.b1.taxCustomer, undefined);
  assert.equal(JSON.stringify(DATA.taxId.shopA), counterBefore, "ตัวนับใบกำกับไม่ขยับ");

  // ค้างเกิน 5 นาทีก็ยังปัด (pending = ใบใหม่อาจออกไปแล้ว)
  const rtLate = await hit(T.issueTaxInvoice({ now: () => LATER }), TAX);
  assert.equal(rtLate.code, 409);
  assert.equal(rtLate.body.error, "amend_in_progress");

  const r2 = await callAmend({ now: () => NOW, createSale: c.createSale }); // ยิงซ้ำ requestId เดิม · sale.void ตัวจริง
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.newBillId, "b-new");
  assert.equal(r2.body.duplicate, false);
  assert.equal(c.calls.length, 1, "ไม่ออกใบที่สาม (② ถูกข้าม)");
  assert.equal(DATA.bill.b1.void, true);
  assert.equal(DATA.bill.b1.amend.status, "done");
  assert.equal(DATA.bill.b1.amendedBy, "b-new");

  assert.deepEqual(activeBills(), ["b-new(202611000043·50)"], "การขายนี้ต้องเหลือบิลใช้งาน 1 ใบ");

  // แก้จบแล้ว ใบเดิมออกใบกำกับไม่ได้ (ยกเลิกแล้ว) · ใบใหม่ออกได้ตามปกติ
  const rtOld = await hit(T.issueTaxInvoice({ now: () => NOW }), TAX);
  assert.equal(rtOld.code, 409);
  assert.equal(rtOld.body.error, "bill_void");
  const rtNew = await hit(T.issueTaxInvoice({ now: () => NOW }), { ...TAX, billId: "b-new" });
  assert.equal(rtNew.code, 200, JSON.stringify(rtNew.body));
});

// ── amend ① กับ sale.void ตัดสินบิลเดียวกันได้ผลเดียวกัน (status + code) · ตัวตัดสินเดียว ไม่ใช่สำเนา logic ──
test("amend ① ปัดด้วย code ของ sale.void เสมอ และไม่เรียก createSale", async () => {
  const { billStateForVoid } = V;
  // ตรวจว่า code ที่ amend ตอบ = code ที่ billStateForVoid ตอบให้บิลเดียวกัน (ตัวตัดสินเดียว ไม่ใช่สำเนา logic)
  seed({ product: [{ id: "p1", qty: "2", name: "น้ำ", net: 100, totalPrice: 100, totalCost: 60 }] });
  const expected = billStateForVoid(DATA.bill.b1, RID);
  assert.equal(expected.ok, false);
  const c = createStub();
  const r = await callAmend({ now: () => NOW, createSale: c.createSale });
  assert.equal(r.code, expected.status);
  assert.equal(r.body.error, expected.error);
  assert.equal(c.calls.length, 0);
});

// ── pending ที่ถูกทิ้ง: amend ประทับ pending แล้วตายก่อนออกใบใหม่ (ไม่มี newBillId · ไม่มี receiptGuard) ──
//   < 5 นาที = การแก้ยังมีชีวิต (busy) ⇒ ใบกำกับปัด · เกิน 5 นาที = sale.amend ถือว่าว่าง ⇒ ใบกำกับต้องออกได้ (ไม่ใช่ทางตันใหม่)
//   ออกใบกำกับแล้ว คำขอแก้เดิม (resume) และคำขอใหม่ ถูกปัด bill_locked {lock:tax_invoice} ก่อนออกใบใหม่
const TAX_B1 = { shopId: "shopA", billId: "b1", staffId: "u-owner", staffName: "เจ้าของ",
  taxCustomer: { id: "c1", name: "บริษัท ลูกค้า จำกัด", tel: "0000000000", address: "กรุงเทพ", taxNumber: "0105500000000", branch: "สำนักงานใหญ่" } };
const createFails = () => { const calls = []; return { calls, createSale: async (i) => { calls.push(i); throw new Error("instance died before create"); } }; };

test("B1-3: pending ถูกทิ้ง (ไม่มีใบใหม่) · <5 นาที ใบกำกับปัด · เกิน 5 นาที ใบกำกับออกได้ · คำขอแก้เดิม/ใหม่ถูกปัด bill_locked ไม่ออกใบใหม่", async () => {
  seed();
  const dead = createFails();
  const r1 = await callAmend({ now: () => NOW, createSale: dead.createSale });
  assert.equal(r1.code, 500);
  assert.equal(r1.body.error, "amend_create_failed");
  assert.equal(DATA.bill.b1.amend.status, "pending");
  assert.equal(DATA.bill.b1.amend.newBillId, undefined);
  assert.equal((DATA.receiptGuard || {})[`amend:b1:${RID}`], undefined, "ไม่มี guard ของใบใหม่");

  const rtBusy = await hit(T.issueTaxInvoice({ now: () => NOW }), TAX_B1);
  assert.equal(rtBusy.code, 409, JSON.stringify(rtBusy.body));
  assert.equal(rtBusy.body.error, "amend_in_progress");
  assert.equal(DATA.bill.b1.taxNumber, undefined);

  const rtLate = await hit(T.issueTaxInvoice({ now: () => LATER }), TAX_B1);
  assert.equal(rtLate.code, 200, `pending ที่ถูกทิ้งต้องออกใบกำกับได้: ${JSON.stringify(rtLate.body)}`);
  assert.equal(typeof DATA.bill.b1.taxNumber, "string");

  const c = createStub();
  const rResume = await callAmend({ now: () => LATER, createSale: c.createSale }); // requestId เดิม (resume · ไม่มี newBillId)
  assert.equal(rResume.code, 409, JSON.stringify(rResume.body));
  assert.equal(rResume.body.error, "bill_locked");
  assert.equal(rResume.body.lock, "tax_invoice");
  const rNew = await callAmend({ now: () => LATER, createSale: c.createSale }, { ...INPUT, requestId: RID_REOPEN });
  assert.equal(rNew.code, 409, JSON.stringify(rNew.body));
  assert.equal(rNew.body.error, "bill_locked");
  assert.equal(rNew.body.lock, "tax_invoice");
  assert.equal(c.calls.length, 0, "ไม่ออกใบใหม่ให้บิลที่ออกใบกำกับแล้ว");

  assert.deepEqual(activeBills(), ["b1(202611000010·100)"], "การขายนี้ต้องเหลือบิลใช้งาน 1 ใบ");
});

// ── pending ค้างเกิน 5 นาที ไม่มี newBillId แต่มี receiptGuard ของใบใหม่ (sale.create commit แล้ว คำตอบหาย ก่อน ③) = stalled ⇒ ใบกำกับปัด ──
test("B1-4: pending เกิน 5 นาที ไม่มี newBillId แต่มี receiptGuard ของใบใหม่ = stalled · ใบกำกับปัด 409 amend_in_progress · ตัวนับไม่ขยับ", async () => {
  seed();
  const dead = createFails();
  const r1 = await callAmend({ now: () => NOW, createSale: dead.createSale });
  assert.equal(r1.body.error, "amend_create_failed");
  assert.equal(DATA.bill.b1.amend.newBillId, undefined);
  DATA.receiptGuard = { [amendReceiptUUID("b1", RID)]: { shopId: "shopA", billId: "b-new" } };

  const counterBefore = JSON.stringify(DATA.taxId.shopA);
  const rt = await hit(T.issueTaxInvoice({ now: () => LATER }), TAX_B1);
  assert.equal(rt.code, 409, JSON.stringify(rt.body));
  assert.equal(rt.body.error, "amend_in_progress");
  assert.equal(DATA.bill.b1.taxNumber, undefined);
  assert.equal(JSON.stringify(DATA.taxId.shopA), counterBefore, "ตัวนับใบกำกับไม่ขยับ");

  // ด่านเดียวกับ sale.amend: คำขอใหม่ก็ถูกปัด stalled (ไม่รับช่วง)
  const rNew = await callAmend({ now: () => LATER, createSale: createStub().createSale }, { ...INPUT, requestId: RID_REOPEN });
  assert.equal(rNew.code, 409);
  assert.equal(rNew.body.error, "amend_in_progress");
  assert.equal(rNew.body.stalled, true);
});

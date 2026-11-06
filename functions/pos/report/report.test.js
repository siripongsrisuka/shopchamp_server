// เทส pos/report/* (ก้อน 9e · DEV-0001) · รัน: node --test functions/pos/report/report.test.js
//   ครอบช่องที่ case ในสัญญา (shopchamp-center/api/report.*.yaml) ครอบไม่ได้:
//   ① รูปคำค้นที่ส่งถึง Firestore จริง (field · ตัวเทียบ · orderBy · select · limit) — ฐานปลอมของ harness ไม่ดู orderBy/select
//   ② ข้อมูลตัวอย่างในสัญญาเป็นรูปที่แอปเก่าเขียนจริง: ผ่าน AnyBill / AnyShiftHistory ของ @shopchamp/schema
//   ③ ฐานล้ม = 500 internal_error ไม่หลุด error ดิบ
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
//   ⚠️ ต้องใช้ @shopchamp/schema ที่ export requests/report และ @shopchamp/logic ที่ export report (แม่ vendor รุ่นใหม่ก่อน)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), valueOf: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };
const ms = (v) => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : v);

let DATA = {};
let QUERIES = [];
let FAIL = false;
function query(coll, st) {
  const api = {
    where: (f, op, v) => query(coll, { ...st, where: [...st.where, [f, op, v]] }),
    orderBy: (f, dir) => query(coll, { ...st, orderBy: [...st.orderBy, [f, dir]] }),
    select: (...fields) => query(coll, { ...st, select: fields }),
    limit: (n) => query(coll, { ...st, limit: n }),
    get: async () => {
      if (FAIL) throw new Error("ฐานล้ม");
      QUERIES.push({ coll, ...st });
      const cmp = (a, op, b) => {
        const x = ms(a), y = ms(b);
        return op === "==" ? x === y : op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : op === "<=" ? x <= y : false;
      };
      let docs = Object.entries(DATA[coll] || {}).filter(([, d]) => st.where.every(([f, op, v]) => cmp(d[f], op, v)));
      for (const [f, dir] of st.orderBy.slice().reverse()) docs.sort(([ia, a], [ib, b]) => ((ms(a[f]) - ms(b[f])) || (ia < ib ? -1 : 1)) * (dir === "desc" ? -1 : 1));
      if (st.limit) docs = docs.slice(0, st.limit);
      return { docs: docs.map(([id, d]) => ({ id, data: () => d })) };
    },
  };
  return api;
}
const db = {
  collection: (c) => ({
    doc: (id) => ({ get: async () => { if (FAIL) throw new Error("ฐานล้ม"); const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; } }),
    where: (f, op, v) => query(c, { where: [[f, op, v]], orderBy: [], select: null, limit: null }),
  }),
};
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db, admin: {} } };

const { AnyBill, AnyShiftHistory } = require("@shopchamp/schema");
const { billList, LIST_FIELDS } = require("./billList");
const { salesTotals } = require("./salesTotals");
const { taxInvoices, TAX_FIELDS } = require("./taxInvoices");
const { duplicateNumbers } = require("./duplicateNumbers");
const { shiftHistory } = require("./shiftHistory");

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const NOW = () => new Date("2026-11-12T03:00:00.000Z");
const shop = { shopId: "shopA", name: "ร้านทดสอบ", cutOff: ts("2010-12-31T20:00:00.000Z"), vip: [{ type: "premium", expire: ts("2027-01-31T17:00:00.000Z") }], humanResource: [{ id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active" }] };
const bill = (x) => ({
  shopId: "shopA", receiptNumber: "202611000001", billDate: "20261110", dateTime: ts("2026-11-10T03:00:00.000Z"), receiptType: "month",
  moneyMustPaid: 100, product: [{ id: "p1", qty: 1, name: "น้ำดื่ม", net: 100, totalPrice: 100, totalCost: 60 }], payment: [{ id: 1, amount: 100, name: "เงินสด" }],
  manualDiscount: 0, productDiscount: 0, pointDiscount: { value: 0, point: 0 }, member: {}, campaign: [], shiftId: "sh1", ...x,
});
const legacyBill = { shopId: "shopA", dateTime: ts("2026-11-10T05:30:00.000Z"), orderId: "o-1", product: [{ id: "p1", qty: 1, price: 30 }], paymentType: "เงินสด", cashReceived: 30, cashChange: 0, credit: 0, promptpay: "", discount: 5, totalPrice: 30, totalCost: 10, customerId: "", customerName: "" };
const shCur = {
  id: "sh1", shopId: "shopA", posId: "pos-1", openTime: ts("2026-11-10T01:00:00.000Z"), closeTime: ts("2026-11-10T13:00:00.000Z"), openCash: "500", openId: "u-owner", openName: "เจ้าของ",
  closeId: "u-owner", closeName: "เจ้าของ", closeCash: "1500", openBy: "u-owner", openComment: "", openDiff: "", openWithDraw: "", closeBy: "u-owner", closeComment: "", receiptNumber: "202611000001", closeWithDraw: "", closeDiff: 0, currentCash: 1500, duringShift: [], lastShiftDate: "20261110", shiftCount: 1, status: false,
  thisPayment: [{ id: 1, name: "เงินสด", amount: 1000, qty: 10 }], thisProduct: [], thisCategory: [], thisCampaign: [], thisSelectedQty: 10, thisVoidQty: 1, saleRate: 100,
  thisTotalNet: 1000, thisTotalPrice: 1000, thisRounding: 0, thisTotalCash: 1000, thisTotalChange: 0, totalManualDiscount: 0, totalPointDiscount: 0, totalProductDiscount: 0, thisVat: 0, lateSales: 20, lateBillQty: 1,
};
const shOld = {
  id: "sh1", shopId: "shopA", posId: "pos-1", openDate: "20261111", openTime: { _seconds: 1794358800, _nanoseconds: 0 }, openCash: "500", openBy: "u-owner", openComment: "", openDiff: "",
  openWithDraw: "", duringShift: [], currentCash: 0, closeBy: "u-owner", closeCash: "", closeComment: "", closeTime: ts("2026-11-11T19:00:00.000Z"), closeWithDraw: "", closeDiff: -5,
};

async function call(factory, body, deps) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await factory(deps || { now: NOW })({ body, shopAccess: OWNER }, res); // ตรึงนาฬิกา (ด่านแพ็กเกจ 62 วันอ่าน now)
  return res;
}
function reset(data) { DATA = data; QUERIES = []; FAIL = false; }

test("② ตัวอย่างบิลและประวัติกะที่ใช้ทดสอบเป็นรูปที่แอปเก่าเขียน (AnyBill · AnyShiftHistory)", () => {
  assert.ok(AnyBill.safeParse(bill({})).success, "บิลรุ่นปัจจุบัน");
  assert.ok(AnyBill.safeParse(legacyBill).success, "บิลรุ่นแรก");
  assert.ok(AnyBill.safeParse(bill({ void: true, voidStaff: "เจ้าของ", reason: "x", taxNumber: "202611000001", vatAmount: 7 })).success);
  const a = AnyShiftHistory.safeParse(shCur);
  assert.ok(a.success, JSON.stringify(a.error && a.error.issues.slice(0, 3)));
  const b = AnyShiftHistory.safeParse(shOld);
  assert.ok(b.success, JSON.stringify(b.error && b.error.issues.slice(0, 3)));
});

test("① billList: ค้น bill ด้วย shopId + ช่วง dateTime ตาม cutOff · orderBy dateTime desc · select · limit pageSize+51 · เรียงจริงล่าสุดก่อน", async () => {
  reset({ shop: { shopA: shop }, bill: { a: bill({}), b: bill({ dateTime: ts("2026-11-10T05:00:00.000Z") }), c: legacyBill } });
  const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 10 });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.rows.map((x) => x.id), ["c", "b", "a"]);
  const q = QUERIES.find((x) => x.coll === "bill");
  assert.deepEqual(q.where.map(([f, op]) => `${f}${op}`), ["shopId==", "dateTime>", "dateTime<="]);
  assert.equal(q.where[1][2].toISOString(), "2026-11-09T20:00:00.000Z");
  assert.equal(q.where[2][2].toISOString(), "2026-11-10T20:00:00.000Z");
  assert.deepEqual(q.orderBy, [["dateTime", "desc"]]);
  assert.deepEqual(q.select, [...LIST_FIELDS]);
  assert.equal(q.limit, 61);
  assert.ok(LIST_FIELDS.includes("shopId"), "ต้อง select shopId ไว้ตรวจว่าเป็นของร้าน");
});

test("① salesTotals: ค้นทั้งเอกสาร (ไม่ select) · ช่วงตาม cutOff", async () => {
  reset({ shop: { shopA: shop }, bill: { a: bill({}), c: legacyBill } });
  const r = await call(salesTotals, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" });
  assert.equal(r.code, 200);
  assert.equal(r.body.totalSale, 125);
  const q = QUERIES.find((x) => x.coll === "bill");
  assert.equal(q.select, null);
  assert.equal(q.limit, null);
});

test("① taxInvoices: ค้น taxNumber ช่วงขึ้นต้น YYYYMM ถึง YYYYMM\\uf8ff · select TAX_FIELDS", async () => {
  reset({ shop: { shopA: shop }, bill: { a: bill({ taxNumber: "202611000001", vatAmount: 6.54 }) } });
  const r = await call(taxInvoices, { shopId: "shopA", month: "202611" }, { now: NOW });
  assert.equal(r.code, 200);
  const q = QUERIES.find((x) => x.coll === "bill");
  assert.deepEqual(q.where, [["shopId", "==", "shopA"], ["taxNumber", ">=", "202611"], ["taxNumber", "<=", "202611"]]);
  assert.deepEqual(q.select, [...TAX_FIELDS]);
  // เลขเดือนอื่นที่ขึ้นต้นใกล้กันไม่หลุดเข้ามา: "202612..." > "202611"
  assert.ok("202612000001" > "202611");
  assert.ok("202611999999" < "202611");
});

test("① duplicateNumbers: ค้น 2 ชุด (receiptNumber · taxNumber) และนับบิลที่อยู่ทั้ง 2 ชุดครั้งเดียว", async () => {
  reset({ shop: { shopA: shop }, bill: { a: bill({ taxNumber: "202611000001" }), b: bill({ taxNumber: "202611000001" }) } });
  const r = await call(duplicateNumbers, { shopId: "shopA", month: "202611" });
  assert.equal(r.code, 200);
  assert.deepEqual(QUERIES.filter((x) => x.coll === "bill").map((x) => x.where[1][0]).sort(), ["receiptNumber", "taxNumber"]);
  assert.equal(r.body.scanned, 2);
  assert.equal(r.body.receipt.groups[0].count, 2);
  assert.equal(r.body.tax.groups[0].count, 2);
});

test("① shiftHistory: ค้นด้วย closeTime (ทุกรุ่นเป็น Timestamp) ไม่ใช่ openTime (บางใบเป็น map) · อ่านรุ่นแรกได้", async () => {
  reset({ shop: { shopA: shop }, shiftHistory: { h1: shCur, h2: shOld } });
  const r = await call(shiftHistory, { shopId: "shopA", fromDay: "20261110", toDay: "20261111" });
  assert.equal(r.code, 200);
  const q = QUERIES.find((x) => x.coll === "shiftHistory");
  assert.deepEqual(q.where.map(([f, op]) => `${f}${op}`), ["shopId==", "closeTime>", "closeTime<="]);
  assert.deepEqual(q.orderBy, [["closeTime", "desc"]]);
  assert.deepEqual(r.body.rows.map((x) => x.id), ["h2", "h1"]);
  assert.equal(r.body.totals.totalNetWithLate, 1020);
  // รุ่นแรก openBy closeBy เป็น id ⇒ handler ส่ง shop.humanResource ให้สูตรแปลงเป็นชื่อ
  const h2 = r.body.rows.find((x) => x.id === "h2");
  assert.equal(h2.openName, "เจ้าของ");
  assert.equal(h2.closeName, "เจ้าของ");
});

test("ด่านแพ็กเกจ: ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วัน → 403 premium_required ก่อนค้นบิล · ไม่ถึงขอบผ่าน", async () => {
  const free = { ...shop, vip: [] };
  for (const f of [billList, salesTotals, shiftHistory]) {
    reset({ shop: { shopA: free } });
    const no = await call(f, { shopId: "shopA", fromDay: "20260910", toDay: "20260911" });
    assert.equal(no.code, 403, f.name);
    assert.equal(no.body.error, "premium_required");
    assert.equal(QUERIES.length, 0, `${f.name} ไม่ควรค้นเมื่อติดด่าน`);
    reset({ shop: { shopA: free } });
    const yes = await call(f, { shopId: "shopA", fromDay: "20260911", toDay: "20260911" });
    assert.equal(yes.code, 200, f.name);
  }
});

test("③ ฐานล้ม = 500 internal_error ทุก route · ไม่หลุดข้อความ error ดิบ", async () => {
  const cases = [
    [billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" }],
    [salesTotals, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" }],
    [taxInvoices, { shopId: "shopA", month: "202611" }],
    [duplicateNumbers, { shopId: "shopA", month: "202611" }],
    [shiftHistory, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" }],
  ];
  for (const [f, body] of cases) {
    reset({ shop: { shopA: shop } });
    FAIL = true;
    const r = await call(f, body, { now: NOW });
    assert.equal(r.code, 500);
    assert.equal(r.body.error, "internal_error");
    assert.ok(!JSON.stringify(r.body).includes("ฐานล้ม"));
  }
});

test("billList: cursor เวลาเดียวกันหลายใบ เดินครบทุกใบ ไม่ซ้ำ ไม่หาย (ข้าม 3 หน้า)", async () => {
  const same = ts("2026-11-10T07:00:00.000Z");
  reset({ shop: { shopA: shop }, bill: { x1: bill({ dateTime: same }), x2: bill({ dateTime: same }), x3: bill({ dateTime: same }), y: bill({}) } });
  const seen = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 1, ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200);
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["x3", "x2", "x1", "y"]);
});

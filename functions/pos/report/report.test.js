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
let READS = 0; // DEV-0010: จำนวน doc ที่อ่าน (doc.get = 1 · query = จำนวน doc ที่คืน ขั้นต่ำ 1 แบบที่ Firestore คิด)
function query(coll, st) {
  const api = {
    where: (f, op, v) => query(coll, { ...st, where: [...st.where, [f, op, v]] }),
    orderBy: (f, dir) => query(coll, { ...st, orderBy: [...st.orderBy, [f, dir]] }),
    select: (...fields) => query(coll, { ...st, select: fields }),
    limit: (n) => query(coll, { ...st, limit: n }),
    startAfter: (...vals) => query(coll, { ...st, startAfter: vals }),
    get: async () => {
      if (FAIL) throw new Error("ฐานล้ม");
      QUERIES.push({ coll, ...st });
      const cmp = (a, op, b) => {
        const x = ms(a), y = ms(b);
        return op === "==" ? x === y : op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : op === "<=" ? x <= y : false;
      };
      const at = (d, f) => f.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), d); // member.id (DEV-0002)
      let docs = Object.entries(DATA[coll] || {}).filter(([, d]) => st.where.every(([f, op, v]) => cmp(at(d, f), op, v)));
      for (const [f, dir] of st.orderBy.slice().reverse()) docs.sort(([ia, a], [ib, b]) => ((ms(at(a, f)) - ms(at(b, f))) || (ia < ib ? -1 : 1)) * (dir === "desc" ? -1 : 1));
      if (st.startAfter) {
        // DEV-0010: startAfter ตาม orderBy แบบ Firestore (__name__ = doc id) · ค่าเกิน orderBy = error แบบ SDK
        if (st.startAfter.length > st.orderBy.length) throw new Error("Too many cursor values");
        const key = (id, d, f) => (f === "__name__" ? id : ms(at(d, f)));
        docs = docs.filter(([id, d]) => {
          for (let i = 0; i < st.startAfter.length; i++) {
            const [f, dir] = st.orderBy[i];
            const a = key(id, d, f), b = f === "__name__" ? st.startAfter[i] : ms(st.startAfter[i]);
            if (a === b) continue;
            return dir === "desc" ? a < b : a > b;
          }
          return false;
        });
      }
      if (st.limit) docs = docs.slice(0, st.limit);
      READS += Math.max(docs.length, 1);
      return { docs: docs.map(([id, d]) => ({ id, data: () => d })) };
    },
  };
  return api;
}
const db = {
  collection: (c) => ({
    doc: (id) => ({ get: async () => { if (FAIL) throw new Error("ฐานล้ม"); READS += 1; const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; } }),
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
const { breakdown } = require("./breakdown");
const { memberBills } = require("./memberBills");

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
function reset(data) { DATA = data; QUERIES = []; FAIL = false; READS = 0; }

test("② ตัวอย่างบิลและประวัติกะที่ใช้ทดสอบเป็นรูปที่แอปเก่าเขียน (AnyBill · AnyShiftHistory)", () => {
  assert.ok(AnyBill.safeParse(bill({})).success, "บิลรุ่นปัจจุบัน");
  assert.ok(AnyBill.safeParse(legacyBill).success, "บิลรุ่นแรก");
  assert.ok(AnyBill.safeParse(bill({ void: true, voidStaff: "เจ้าของ", reason: "x", taxNumber: "202611000001", vatAmount: 7 })).success);
  const a = AnyShiftHistory.safeParse(shCur);
  assert.ok(a.success, JSON.stringify(a.error && a.error.issues.slice(0, 3)));
  const b = AnyShiftHistory.safeParse(shOld);
  assert.ok(b.success, JSON.stringify(b.error && b.error.issues.slice(0, 3)));
});

test("① billList: ค้น bill ด้วย shopId + ช่วง dateTime ตาม cutOff · orderBy dateTime desc, __name__ desc · select · limit pageSize+1 · เรียงจริงล่าสุดก่อน", async () => {
  reset({ shop: { shopA: shop }, bill: { a: bill({}), b: bill({ dateTime: ts("2026-11-10T05:00:00.000Z") }), c: legacyBill } });
  const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 10 });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.rows.map((x) => x.id), ["c", "b", "a"]);
  const q = QUERIES.find((x) => x.coll === "bill");
  assert.deepEqual(q.where.map(([f, op]) => `${f}${op}`), ["shopId==", "dateTime>", "dateTime<="]);
  assert.equal(q.where[1][2].toISOString(), "2026-11-09T20:00:00.000Z");
  assert.equal(q.where[2][2].toISOString(), "2026-11-10T20:00:00.000Z");
  assert.deepEqual(q.orderBy, [["dateTime", "desc"], ["__name__", "desc"]]);
  assert.equal(q.startAfter, undefined, "หน้าแรกไม่มี startAfter");
  assert.deepEqual(q.select, [...LIST_FIELDS]);
  assert.equal(q.limit, 11);
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
    [breakdown, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", dimension: "item" }],
    [memberBills, { shopId: "shopA", memberId: "m-1" }],
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

// ───────── DEV-0002 ─────────
test("DEV-0002 breakdown: ค้นทั้งเอกสาร (ไม่ select) · ช่วงตาม cutOff · มิติ item ส่วนลดกระจาย", async () => {
  reset({ shop: { shopA: shop }, bill: { b1: bill({ moneyMustPaid: 90, manualDiscount: 10 }) } });
  const r = await call(breakdown, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", dimension: "item" });
  assert.equal(r.code, 200);
  const q = QUERIES[0];
  assert.equal(q.coll, "bill");
  assert.equal(q.select, null);
  assert.deepEqual(q.where.map(([f, op]) => [f, op]), [["shopId", "=="], ["dateTime", ">"], ["dateTime", "<="]]);
  assert.equal(q.where[1][2].toISOString(), "2026-11-09T20:00:00.000Z");
  assert.deepEqual(r.body.rows.map((x) => [x.id, x.netAfterBillDiscount, x.billDiscountShare]), [["p1", 90, 10]]);
  assert.equal(r.body.dimension, "item");
});

test("DEV-0002 billList detail: ไม่ select (เอกสารเต็ม) · แถวมี detail + bill เวลาเป็น ISO · ไม่ส่ง detail = select เดิม ไม่มี detail/bill", async () => {
  reset({ shop: { shopA: shop }, bill: { b1: bill({ member: { id: "m-1", name: "สมใจ" } }) } });
  const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", detail: true });
  assert.equal(r.code, 200);
  assert.equal(QUERIES[0].select, null);
  assert.equal(r.body.rows[0].detail.memberId, "m-1");
  assert.equal(r.body.rows[0].bill.dateTime, "2026-11-10T03:00:00.000Z");
  assert.equal(r.body.rows[0].bill.moneyMustPaid, 100);
  reset({ shop: { shopA: shop }, bill: { b1: bill({}) } });
  const n = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" });
  assert.deepEqual(QUERIES[0].select, LIST_FIELDS);
  assert.equal("detail" in n.body.rows[0], false);
  assert.equal("bill" in n.body.rows[0], false);
});

test("DEV-0002 shiftHistory dayBy open: ค้นด้วย openTime · ไม่ส่ง = closeTime เหมือนเดิม", async () => {
  reset({ shop: { shopA: shop }, shiftHistory: { h1: shCur } });
  const o = await call(shiftHistory, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", dayBy: "open" });
  assert.equal(o.code, 200);
  assert.deepEqual(QUERIES[0].where.map(([f]) => f), ["shopId", "openTime", "openTime"]);
  assert.deepEqual(QUERIES[0].orderBy, [["openTime", "desc"]]);
  assert.equal(o.body.rows[0].cashRemain, 1500);
  reset({ shop: { shopA: shop }, shiftHistory: { h1: shCur } });
  await call(shiftHistory, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" });
  assert.deepEqual(QUERIES[0].where.map(([f]) => f), ["shopId", "closeTime", "closeTime"]);
});

test("DEV-0002 memberBills: ค้น member.id + orderBy dateTime desc + limit · ร้านอื่นทิ้ง · ใบยกเลิกทิ้ง · cursor เดินครบไม่ซ้ำ", async () => {
  const B = {};
  for (let i = 0; i < 5; i++) B[`m${i}`] = bill({ member: { id: "m-1" }, dateTime: ts(new Date(Date.parse("2026-11-10T03:00:00.000Z") + i * 60000).toISOString()), void: i === 2 });
  B.other = bill({ shopId: "shopB", member: { id: "m-1" }, dateTime: ts("2026-11-10T09:00:00.000Z") });
  reset({ shop: { shopA: shop }, bill: B });
  const seen = [];
  let cursor;
  for (let i = 0; i < 6; i++) {
    const r = await call(memberBills, { shopId: "shopA", memberId: "m-1", pageSize: 1, ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200);
    if (i === 0) {
      assert.deepEqual(QUERIES[0].where.map(([f, op]) => [f, op]), [["member.id", "=="]]);
      assert.deepEqual(QUERIES[0].orderBy, [["dateTime", "desc"], ["__name__", "desc"]]);
      assert.equal(QUERIES[0].limit, 2);
    }
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["m4", "m3", "m1", "m0"]);
});

test("DEV-0002/DEV-0010 memberBills: หน้าที่อ่านมาเป็นใบยกเลิกทั้งหมด → หน้าว่างแต่มี nextCursor ให้เดินต่อ (ไม่ตัดจบเงียบ) · เดินจนสุดได้ใบปกติครบ", async () => {
  const B = {};
  for (let i = 0; i < 6; i++) B[`v${String(i).padStart(2, "0")}`] = bill({ member: { id: "m-1" }, void: true, dateTime: ts(new Date(Date.parse("2026-11-10T06:00:00.000Z") + i * 1000).toISOString()) });
  B.ok1 = bill({ member: { id: "m-1" }, dateTime: ts("2026-11-10T03:00:00.000Z") });
  reset({ shop: { shopA: shop }, bill: B });
  const r1 = await call(memberBills, { shopId: "shopA", memberId: "m-1", pageSize: 2 });
  assert.deepEqual(r1.body.rows, []);
  assert.ok(r1.body.nextCursor);
  const seen = [];
  let cursor = r1.body.nextCursor;
  for (let i = 0; i < 10 && cursor; i++) {
    const r = await call(memberBills, { shopId: "shopA", memberId: "m-1", pageSize: 2, cursor });
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
  }
  assert.deepEqual(seen, ["ok1"]);
});

// ───────── DEV-0010 · แบ่งหน้าอ่านต่อจากใบสุดท้าย ไม่อ่านเผื่อ ─────────
const at = (base, sec) => ts(new Date(Date.parse(base) + sec * 1000).toISOString());

test("DEV-0010 billList: หน้าถัดไปส่ง startAfter(เวลา, id) ของแถวสุดท้าย · ยังคง dateTime <= at · รูป cursor เดิม {at, id}", async () => {
  const B = {};
  for (let i = 0; i < 5; i++) B[`b${i}`] = bill({ dateTime: at("2026-11-10T03:00:00.000Z", i * 60) });
  reset({ shop: { shopA: shop }, bill: B });
  const r1 = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 2 });
  assert.deepEqual(r1.body.rows.map((x) => x.id), ["b4", "b3"]);
  assert.deepEqual(Object.keys(r1.body.nextCursor).sort(), ["at", "id"]);
  assert.deepEqual(r1.body.nextCursor, { at: "2026-11-10T03:03:00.000Z", id: "b3" });
  reset({ shop: { shopA: shop }, bill: B });
  const r2 = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 2, cursor: r1.body.nextCursor });
  const q = QUERIES.find((x) => x.coll === "bill");
  assert.equal(q.startAfter[0].toISOString(), "2026-11-10T03:03:00.000Z");
  assert.equal(q.startAfter[1], "b3");
  assert.equal(q.where[2][2].toISOString(), "2026-11-10T03:03:00.000Z");
  assert.deepEqual(r2.body.rows.map((x) => x.id), ["b2", "b1"]);
});

test("DEV-0010 billList: บิลเวลาเท่ากัน 60 ใบข้ามรอยต่อหน้า (pageSize 2) → เดินครบ ไม่หาย ไม่ซ้ำ · ชนเกินที่ของเดิมเผื่อ (50) ก็ไม่ข้าม", async () => {
  const same = ts("2026-11-10T07:00:00.000Z");
  const B = { y: bill({}) };
  const tied = [];
  for (let i = 0; i < 60; i++) { const id = `t${String(i).padStart(2, "0")}`; B[id] = bill({ dateTime: same }); tied.unshift(id); }
  B.z = bill({ dateTime: ts("2026-11-10T08:00:00.000Z") });
  const seen = [];
  let cursor;
  for (let i = 0; i < 40; i++) {
    reset({ shop: { shopA: shop }, bill: B });
    const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200);
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["z", ...tied, "y"]);
});

test("DEV-0010 billList: ค่าอ่านต่อหน้า = shop 1 + pageSize+1 (ไม่อ่านเผื่อ) · หน้าสุดท้าย = เท่าที่เหลือ", async () => {
  const B = {};
  for (let i = 0; i < 120; i++) B[`b${String(i).padStart(3, "0")}`] = bill({ dateTime: at("2026-11-10T01:00:00.000Z", i * 30) });
  reset({ shop: { shopA: shop }, bill: B });
  const r1 = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 10 });
  assert.equal(r1.body.rows.length, 10);
  assert.equal(READS, 1 + 11, "shop 1 + bill 11 (เดิม 61)");
  let cursor = r1.body.nextCursor;
  let pages = 1;
  let total = 10;
  while (cursor) {
    reset({ shop: { shopA: shop }, bill: B });
    const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 10, cursor });
    assert.ok(READS <= 12, `หน้า ${pages + 1} อ่าน ${READS}`);
    total += r.body.rows.length;
    cursor = r.body.nextCursor;
    pages += 1;
  }
  assert.equal(total, 120);
  assert.equal(pages, 12);
});

test("DEV-0010 billList: ร้าน S5 (2 key) → ค่าอ่านต่อ key = pageSize+1 · รวมแล้วเรียงถูก ไม่หาย", async () => {
  const s5 = { ...shop, shopId: "legacyA" };
  const B = {};
  for (let i = 0; i < 6; i++) B[`n${i}`] = bill({ shopId: i % 2 ? "shopA" : "legacyA", dateTime: at("2026-11-10T03:00:00.000Z", i * 60) });
  const seen = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    reset({ shop: { shopA: s5 }, bill: B });
    const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", pageSize: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    for (const q of QUERIES.filter((x) => x.coll === "bill" && x.where[0][0] === "shopId" && x.where.length === 3)) assert.equal(q.limit, 3);
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["n5", "n4", "n3", "n2", "n1", "n0"]);
});

test("DEV-0010 billList: เลขใบของลิงก์แก้บิล 2 ทาง · select เฉพาะ amend.ofReceiptNumber / amend.newReceiptNumber · ไม่มีลิงก์ = null", async () => {
  reset({ shop: { shopA: shop }, bill: {
    old: bill({ receiptNumber: "202611000001", amendedBy: "nw", amend: { status: "done", requestId: "r1", newBillId: "nw", newReceiptNumber: "202611000002", staffUid: "u-x" } }),
    nw: bill({ receiptNumber: "202611000002", dateTime: ts("2026-11-10T04:00:00.000Z"), amendOf: "old", amend: { status: "done", requestId: "r1", ofBillId: "old", ofReceiptNumber: "202611000001" } }),
    pend: bill({ dateTime: ts("2026-11-10T02:00:00.000Z"), amend: { status: "pending", requestId: "r2", newReceiptNumber: "202611000009" } }),
    plain: bill({ dateTime: ts("2026-11-10T01:00:00.000Z") }),
  } });
  const r = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110" });
  const by = Object.fromEntries(r.body.rows.map((x) => [x.id, x]));
  assert.equal(by.nw.amendOfNumber, "202611000001");
  assert.equal(by.nw.amendedByNumber, null);
  assert.equal(by.old.amendedByNumber, "202611000002");
  assert.equal(by.old.amendOfNumber, null);
  assert.equal(by.pend.amendedByNumber, null, "ยังไม่มี amendedBy = ยังไม่ขึ้นลิงก์ (เท่า amendLinksOf ของแอป)");
  assert.equal(by.plain.amendOfNumber, null);
  assert.equal("amend" in by.old, false, "ไม่ส่งก้อน amend ทั้งก้อน");
  assert.ok(LIST_FIELDS.includes("amend.ofReceiptNumber") && LIST_FIELDS.includes("amend.newReceiptNumber") && !LIST_FIELDS.includes("amend"));
  reset({ shop: { shopA: shop }, bill: { nw: bill({ amendOf: "old", amend: { status: "done", requestId: "r1", ofReceiptNumber: "202611000001" } }) } });
  const d = await call(billList, { shopId: "shopA", fromDay: "20261110", toDay: "20261110", detail: true });
  assert.equal(d.body.rows[0].amendOfNumber, "202611000001", "detail:true ก็มี");
});

test("DEV-0010 memberBills: ค่าอ่านต่อหน้า = shop 1 + pageSize+1 · startAfter(เวลา, id) ของใบสุดท้ายที่อ่าน · เวลาเท่ากันข้ามหน้าไม่หาย", async () => {
  const same = ts("2026-11-10T07:00:00.000Z");
  const B = {};
  for (let i = 0; i < 5; i++) B[`s${i}`] = bill({ member: { id: "m-1" }, dateTime: same, void: i === 1 });
  B.early = bill({ member: { id: "m-1" }, dateTime: ts("2026-11-10T03:00:00.000Z") });
  const seen = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    reset({ shop: { shopA: shop }, bill: B });
    const r = await call(memberBills, { shopId: "shopA", memberId: "m-1", pageSize: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(r.code, 200);
    assert.ok(READS <= 1 + 3, `อ่าน ${READS}`);
    const q = QUERIES.find((x) => x.coll === "bill");
    if (cursor) assert.deepEqual([q.startAfter[0].toISOString(), q.startAfter[1]], [cursor.at, cursor.id]);
    else assert.equal(q.startAfter, undefined);
    seen.push(...r.body.rows.map((x) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["s4", "s3", "s2", "s0", "early"]);
});

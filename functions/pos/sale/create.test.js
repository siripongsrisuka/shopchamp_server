// เทส sale/create.js · รัน: node --test functions/pos/sale/create.test.js
//   harness ของสัญญาวัดได้แค่คำตอบ (เขียน = no-op · seed ไม่มี stock) ⇒ ของที่เขียนลงฐานและเลขบิลข้ามวัน/ข้ามเดือนพิสูจน์ที่นี่
//   ที่มา: ผลตรวจซ้ำ lanes/dev/source/chunk4-verify/sale.create.md (W1 W2 W3 · mutant M1 M3 M4 M5 M6 M7 M8 M10 M12 · floorRun)
//   ฐานปลอมในไฟล์นี้: บันทึกทุกการเขียน · set {merge} ตามจริง · query where (== >= <=) · ปัดการอ่านหลังเขียนใน transaction เดียว
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };

let DATA = {};
let LOG = [];
const OPS = {
  "==": (a, b) => a === b,
  ">=": (a, b) => typeof a === typeof b && a >= b,
  "<=": (a, b) => typeof a === typeof b && a <= b,
};
function makeDb() {
  let auto = 0;
  const ref = (c, id) => ({ c, id });
  const query = (c, filters) => ({
    c, filters,
    where: (f, op, v) => {
      if (!OPS[op]) throw new Error(`op ${op} ไม่รองรับในฐานปลอม`);
      return query(c, [...filters, [f, op, v]]);
    },
  });
  return {
    collection: (c) => ({
      doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`),
      where: (f, op, v) => query(c, []).where(f, op, v),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id || "query"} หลังเขียน (Firestore ปัด)`);
          if (r.filters) {
            const docs = Object.entries(DATA[r.c] || {})
              .filter(([, d]) => r.filters.every(([f, op, v]) => OPS[op](d[f], v)))
              .map(([id, d]) => ({ id, exists: true, data: () => d }));
            return { docs, empty: docs.length === 0 };
          }
          const d = (DATA[r.c] || {})[r.id];
          return { exists: d !== undefined, id: r.id, data: () => d };
        },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); },
        set: (r, v, o) => { writes.push({ op: o && o.merge ? "merge" : "set", c: r.c, id: r.id, v }); },
      };
      const out = await fn(tx);
      for (const w of writes) {
        DATA[w.c] = DATA[w.c] || {};
        if (w.op === "update" && DATA[w.c][w.id] === undefined) throw new Error(`update ${w.c}/${w.id} ที่ไม่มี doc`);
        DATA[w.c][w.id] = w.op === "set" ? { ...w.v } : { ...DATA[w.c][w.id], ...w.v };
      }
      LOG.push(...writes);
      return out;
    },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
const C = require("./create");

async function call(body, { now = NOW, shopAccess = OWNER } = {}) {
  const handler = C.create({ now: () => now });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const warn = console.warn;
  console.warn = () => {};
  try { await handler({ body, shopAccess }, res); } finally { console.warn = warn; }
  return res;
}
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
let seq = 0;
const uuid = () => `shopA6f1c2d3e-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const body = (x) => ({
  shopId: "shopA", receiptUUID: uuid(),
  product: [{ id: "p1", qty: 2, name: "น้ำดื่ม", net: 20, totalPrice: 20, totalCost: 12 }],
  payment: [{ id: 1, amount: 20, name: "เงินสด" }], moneyMustPaid: 20,
  shiftId: "sh1", shiftOpenTime: "2026-11-10T01:00:00.000Z", ...x,
});
function seed(x = {}) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านทดสอบ", receiptPattern: "month", ...(x.shop || {}) } },
    billId: { shopA: { month: 11, receipts: 41 } },
    shift: {
      sh1: { shopId: "shopA", status: true, openTime: ts("2026-11-10T01:00:00.000Z"), duringShift: [] },
    },
    stock: {
      p1: { shopId: "shopA", stockCountStatus: true, stock: 10 },
      "p-x": { shopId: "shopB", stockCountStatus: true, stock: 5 },
    },
    member: { m1: { shopId: "shopA", name: "ลูกค้าเอ", point: 30, bought: [], creditArray: [] } },
    bill: {},
    receiptGuard: {},
    ...(x.data || {}),
  };
  LOG = [];
}
const onlyBill = () => {
  const bills = Object.values(DATA.bill);
  assert.equal(bills.length, 1, "ต้องมีบิลใบเดียว");
  return bills[0];
};

// ── W1 franchiseId มาจากร้าน ไม่ใช่จากเครื่อง (แอปเก่า main3 CheckoutScreen.js:143 · :688) ──
test("W1 · ไม่ส่ง franchiseId ⇒ บิลได้ shop.franchiseId", async () => {
  seed({ shop: { franchiseId: "F-A" } });
  const r = await call(body());
  assert.equal(r.code, 200);
  assert.equal(onlyBill().franchiseId, "F-A");
});
test("W1 · ส่ง franchiseId ของแฟรนไชส์อื่น ⇒ บิลยังเป็น shop.franchiseId", async () => {
  seed({ shop: { franchiseId: "F-A" } });
  const r = await call(body({ franchiseId: "F-OTHER" }));
  assert.equal(r.code, 200);
  assert.equal(onlyBill().franchiseId, "F-A");
});
test("W1 · ร้านไม่อยู่ในแฟรนไชส์ ⇒ franchiseId '' แบบแอปเก่า แม้เครื่องส่งค่ามา", async () => {
  seed();
  await call(body({ franchiseId: "F-OTHER" }));
  assert.equal(onlyBill().franchiseId, "");
});

// ── W2 usedPoint ที่ใช้คิดจริงต้องอยู่บนบิล (void คืนแต้มจาก bill.usedPoint) ──
test("W2 · ส่งแค่ pointDiscount ⇒ บิลมี usedPoint = แต้มที่หัก", async () => {
  seed();
  const r = await call(body({ member: { id: "m1", name: "ลูกค้าเอ" }, pointDiscount: { value: 10, point: 10 }, moneyMustPaid: 10, payment: [{ id: 1, amount: 10, name: "เงินสด" }] }));
  assert.equal(r.code, 200);
  assert.equal(DATA.member.m1.point, 20);
  assert.equal(onlyBill().usedPoint, 10);
});
test("W2 · usedPoint ต่ำกว่าแต้มของรางวัลที่แลก ⇒ หักตามรางวัล และบิลเขียนค่านั้น", async () => {
  seed();
  const r = await call(body({ member: { id: "m1", name: "ลูกค้าเอ" }, usedPoint: 0, pointDiscount: { value: 10, point: 10 }, moneyMustPaid: 10, payment: [{ id: 1, amount: 10, name: "เงินสด" }] }));
  assert.equal(r.code, 200);
  assert.equal(DATA.member.m1.point, 20);
  assert.equal(onlyBill().usedPoint, 10);
});

// ── W3 gainPoint บนบิล = แต้มที่ server ให้จริง (void หัก bill.gainPoint) ──
test("W3 · เงินเซ็น ร้านไม่เปิด creditPoint ⇒ ไม่ได้แต้ม และบิล gainPoint 0", async () => {
  seed();
  const r = await call(body({ member: { id: "m1", name: "ลูกค้าเอ" }, gainPoint: 5, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }] }));
  assert.equal(r.code, 200);
  assert.equal(DATA.member.m1.point, 30);
  assert.equal(onlyBill().gainPoint, 0);
});
test("W3 · ร้านเปิด creditPoint ⇒ ได้แต้มตามเครื่อง และบิลเขียนค่าเดียวกัน", async () => {
  seed({ shop: { creditPoint: true } });
  await call(body({ member: { id: "m1", name: "ลูกค้าเอ" }, gainPoint: 5, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }] }));
  assert.equal(DATA.member.m1.point, 35);
  assert.equal(onlyBill().gainPoint, 5);
});
test("W3 · ไม่มีสมาชิก ⇒ บิล gainPoint 0 usedPoint 0 แบบแอปเก่า", async () => {
  seed();
  await call(body({ gainPoint: 5 }));
  const b = onlyBill();
  assert.equal(b.gainPoint, 0);
  assert.equal(b.usedPoint, 0);
});

// ── M3 เลขบิลใช้นาฬิกา server ไม่ใช่วันขาย (#19 · S-14) ──
test("M3 · ร้านรายวัน บิลออฟไลน์ขายเมื่อวาน ⇒ หัวเลขวันนี้ เริ่ม 1 · billDate เมื่อวาน", async () => {
  seed({ shop: { receiptPattern: "day" }, data: { billDayId: { shopA: { date: 10, receipts: 5 } } } });
  const now = new Date("2026-11-11T03:00:00.000Z");
  const r = await call(body({ offline: true, soldAt: "2026-11-10T05:00:00.000Z" }), { now });
  assert.equal(r.code, 200);
  assert.equal(r.body.receiptNumber.slice(0, 8), "20261111");
  assert.equal(Number(r.body.receiptNumber.slice(8)), 1);
  assert.equal(r.body.billDate, "20261110");
  assert.equal(DATA.billDayId.shopA.date, 11);
});
test("M3 · ร้านรายเดือน ขาย 31 ต.ค. ซิงก์ 2 พ.ย. ตัวนับรูปแอปเก่า ⇒ 202611000001", async () => {
  seed({ data: { billId: { shopA: { month: 10, receipts: 7 } } } });
  const now = new Date("2026-11-02T03:00:00.000Z");
  const r = await call(body({ offline: true, soldAt: "2026-10-31T10:00:00.000Z" }), { now });
  assert.equal(r.code, 200);
  assert.equal(r.body.receiptNumber, "202611000001");
  assert.equal(r.body.billDate, "20261031");
});

// ── M7 M1 ตัดสต็อก · ไม่แตะสต็อกร้านอื่น ──
test("M7 · ตัดสต็อกจริง ทศนิยม 4 ตำแหน่ง + latestSaleDate", async () => {
  seed();
  await call(body({ product: [{ id: "p1", qty: 1.2345, name: "หมู", net: 20, totalPrice: 20, totalCost: 12 }] }));
  assert.equal(DATA.stock.p1.stock, 8.7655);
  assert.equal(DATA.stock.p1.latestSaleDate.getTime(), NOW.getTime());
});
test("M1 · สต็อกของร้านอื่น ⇒ ไม่ตัด ไม่เขียน แต่ยังขายได้", async () => {
  seed();
  const r = await call(body({ product: [{ id: "p-x", qty: 1, name: "ของร้านอื่น", net: 20, totalPrice: 20, totalCost: 1 }] }));
  assert.equal(r.code, 200);
  assert.equal(DATA.stock["p-x"].stock, 5);
  assert.ok(!LOG.some((w) => w.c === "stock"), "ต้องไม่เขียน stock เลย");
});

// ── M5 เขียน receiptGuard · ยิงซ้ำได้บิลใบเดิม ──
test("M5 · เขียน guard {usedBy billId shopId createdAt} · ยิงซ้ำ ⇒ duplicate ไม่มีบิลที่ 2", async () => {
  seed();
  const b = body();
  const r1 = await call(b);
  const g = DATA.receiptGuard[b.receiptUUID];
  assert.ok(g, "ต้องมี guard");
  assert.equal(g.usedBy, r1.body.receiptNumber);
  assert.equal(g.billId, r1.body.billId);
  assert.equal(g.shopId, "shopA");
  assert.equal(g.createdAt.getTime(), NOW.getTime());
  const r2 = await call(b);
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.billId, r1.body.billId);
  onlyBill();
  assert.equal(DATA.billId.shopA.receipts, 42);
});

// ── M6 bill.shopId = field shop.shopId (ร้านเก่า ≠ doc id) ──
test("M6 · ร้านที่ field shopId ≠ doc id ⇒ bill.shopId = field", async () => {
  seed({ shop: { shopId: "legacyA" } });
  DATA.shift.sh1.shopId = "legacyA";
  const r = await call(body({ receiptUUID: "legacyA6f1c2d3e-0000-4000-8000-000000000999" }));
  assert.equal(r.code, 200);
  assert.equal(onlyBill().shopId, "legacyA");
});

// ── M8 บิลออฟไลน์: dateTime = soldAt ──
test("M8 · บิลออฟไลน์ ⇒ dateTime = soldAt ไม่ใช่เวลาซิงก์", async () => {
  seed();
  await call(body({ offline: true, soldAt: "2026-11-09T05:00:00.000Z" }));
  const b = onlyBill();
  assert.equal(b.dateTime.getTime(), new Date("2026-11-09T05:00:00.000Z").getTime());
  assert.equal(b.syncedAt.getTime(), NOW.getTime());
});

// ── M10 ตัวนับเขียนแบบ merge (field อื่นของ doc ตัวนับไม่หาย) ──
test("M10 · ตัวนับ merge · field เดิมยังอยู่", async () => {
  seed({ data: { billId: { shopA: { month: 11, receipts: 41, keep: "x" } } } });
  await call(body());
  assert.equal(DATA.billId.shopA.keep, "x");
  assert.equal(DATA.billId.shopA.receipts, 42);
});

// ── M12 แถวเงินเซ็นของบิลออฟไลน์มี soldAt ──
test("M12 · บิลออฟไลน์เงินเซ็น ⇒ แถว creditArray มี soldAt", async () => {
  seed();
  const soldAt = "2026-11-09T05:00:00.000Z";
  await call(body({ offline: true, soldAt, member: { id: "m1", name: "ลูกค้าเอ" }, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }] }));
  const arr = DATA.member.m1.creditArray;
  assert.equal(arr.length, 1);
  assert.equal(arr[0].soldAt.getTime(), new Date(soldAt).getTime());
  assert.equal(arr[0].totalCredit, 20);
});

// ── M4 บิลมาช้าเข้ารอบที่ปิดแล้ว ⇒ บวก lateSales lateBillQty ──
test("M4 · รอบปิดแล้ว (late) ⇒ shiftHistory lateSales += ยอด · lateBillQty += 1", async () => {
  seed({ data: { shiftHistory: { h1: { shopId: "shopA", id: "sh1", openTime: ts("2026-11-09T01:00:00.000Z"), lateSales: 100 } } } });
  const r = await call(body({ shiftOpenTime: "2026-11-09T01:00:00.000Z" }));
  assert.equal(r.body.shift.status, "late");
  assert.equal(DATA.shiftHistory.h1.lateSales, 120);
  assert.equal(DATA.shiftHistory.h1.lateBillQty, 1);
  assert.equal(onlyBill().shiftHistoryId, "h1");
});

// ── ตัวนับเสีย ⇒ floorRun จากบิลของรอบนี้ ไม่ปัดการขาย ──
test("floorRun · receipts อ่านไม่ได้ ⇒ ต่อจากเลขสูงสุดของเดือนนี้", async () => {
  seed({ data: { billId: { shopA: { month: 11, receipts: "abc" } } } });
  DATA.bill = {
    old1: { shopId: "shopA", receiptNumber: "202611000060" },
    old2: { shopId: "shopA", receiptNumber: "202610000099" },
    old3: { shopId: "shopB", receiptNumber: "202611000500" },
  };
  const r = await call(body());
  assert.equal(r.code, 200);
  assert.equal(r.body.receiptNumber, "202611000061");
});

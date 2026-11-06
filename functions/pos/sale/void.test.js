// เทส sale/void.js · รัน: node --test functions/pos/sale/void.test.js
//   harness ของสัญญาวัดได้แค่คำตอบ (เขียน = no-op · seed ไม่มี stock/member) ⇒ ของที่เขียนลงฐานพิสูจน์ที่นี่
//   ฐานปลอมในไฟล์นี้: บันทึกทุกการเขียน · ปัดการอ่านหลังเขียนใน transaction เดียว (กติกา Firestore) · commit แล้วค่าเปลี่ยนจริง
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };
const RID = "3c9e1f20-1111-4000-8000-0000000000aa";
const RID2 = "3c9e1f20-2222-4000-8000-0000000000bb";

let DATA = {};
let LOG = [];
function makeDb() {
  let auto = 0;
  const ref = (c, id) => ({ c, id, get: async () => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; } });
  return {
    collection: (c) => ({ doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id} หลังเขียน (Firestore ปัด)`);
          const d = (DATA[r.c] || {})[r.id];
          return { exists: d !== undefined, id: r.id, data: () => d };
        },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); },
      };
      const out = await fn(tx);
      for (const w of writes) {
        DATA[w.c] = DATA[w.c] || {};
        DATA[w.c][w.id] = w.op === "set" ? { ...w.v } : { ...DATA[w.c][w.id], ...w.v };
      }
      LOG.push(...writes);
      return out;
    },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
const V = require("./void");

const handler = V.void({ now: () => NOW, log: () => {} });
async function call(body, shopAccess) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };
const body = (x) => ({ shopId: "shopA", billId: "b1", requestId: RID, reason: "ลูกค้าเปลี่ยนใจ", staffId: "u-owner", staffName: "เจ้าของ", ...x });

function bill(x) {
  return {
    shopId: "shopA", receiptNumber: "202611000010", billDate: "20261110", dateTime: ts("2026-11-10T02:00:00.000Z"),
    receiptType: "month", moneyMustPaid: 1234.5, payment: [{ id: 1, amount: 1234.5, name: "เงินสด" }],
    product: [{ id: "p-meat", qty: 0.85, net: 102, totalPrice: 102, totalCost: 68 }],
    member: {}, gainPoint: 0, usedPoint: 0, shiftId: "sh1", ...x,
  };
}
function seed(x) {
  DATA = {
    shop: { shopA: { shopId: "shopA", humanResource: [] } },
    shift: {
      sh1: { shopId: "shopA", status: true, openTime: ts("2026-11-10T01:00:00.000Z"), duringShift: [] },
      shClosed: { shopId: "shopA", status: false, openTime: ts("2026-11-09T01:00:00.000Z"), duringShift: [] },
      shB: { shopId: "shopB", status: true, openTime: ts("2026-11-10T01:00:00.000Z"), duringShift: [] },
    },
    stock: {
      "p-meat": { shopId: "shopA", stockCountStatus: true, stock: 10, cost: 80 },
      "p-x": { shopId: "shopB", stockCountStatus: true, stock: 5, cost: 1 },
      "box": { shopId: "shopA", stockCountStatus: true, stock: 100, cost: 120, linkId: "L1", linkMultiply: 12 },
      "piece": { shopId: "shopA", stockCountStatus: true, stock: 100, cost: 10, linkId: "L1", linkMultiply: 1 },
    },
    bill: { b1: bill() },
    member: {},
    ...x,
  };
  LOG = [];
}
const writesTo = (c) => LOG.filter((w) => w.c === c);

test("สินค้าชั่ง 0.85 คืนสต็อกตรงค่า · บิลได้ field เดิม + field ใหม่ · แจ้งเตือนรูปแอปเก่า", async () => {
  seed();
  const r = await call(body({ shiftId: "sh1" }), OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, billId: "b1", alreadyVoid: false, voidShift: { status: "open" }, refundCash: 0 });
  assert.equal(DATA.stock["p-meat"].stock, 10.85);
  assert.equal(DATA.stock["p-meat"].cost, logicCost(10, 80, 68, 10.85));
  assert.ok(DATA.stock["p-meat"].updateTime instanceof Date);
  const b = DATA.bill.b1;
  assert.equal(b.void, true); assert.equal(b.voidStaff, "เจ้าของ"); assert.equal(b.reason, "ลูกค้าเปลี่ยนใจ");
  assert.equal(b.voidRequestId, RID); assert.equal(b.voidStaffId, "u-owner"); assert.equal(b.voidAt.getTime(), NOW.getTime());
  assert.equal(b.voidShiftId, "sh1"); assert.equal(b.voidShiftOpenTime.toMillis(), Date.parse("2026-11-10T01:00:00.000Z"));
  assert.equal(b.receiptNumber, "202611000010"); // ของเดิมไม่ถูกแตะ
  assert.equal("byAdmin" in b, false);
  const n = writesTo("notification");
  assert.equal(n.length, 1);
  assert.deepEqual(Object.keys(n[0].v).sort(), ["categoryId", "heading", "notificationContent", "shopId", "timestamp"]);
  assert.equal(n[0].v.heading, "ยกเลิกใบเสร็จ"); assert.equal(n[0].v.categoryId, 1); assert.equal(n[0].v.shopId, "shopA");
  assert.equal(n[0].v.notificationContent, "เหตุผล ลูกค้าเปลี่ยนใจ  \nยอดเงิน 1,234.50 บาท \nโดย เจ้าของ \nเลขที่ใบเสร็จ 202611000010 ");
});
function logicCost(oldStock, prevCost, value, total) {
  return require("@shopchamp/logic").roundStock((oldStock * prevCost + value) / total);
}

test("กะปิดแล้ว / ไม่ส่งกะ = voidShift none ไม่มี voidShiftId · กะร้านอื่น = 409 ไม่เขียนอะไร", async () => {
  seed();
  let r = await call(body({ shiftId: "shClosed" }), OWNER);
  assert.equal(r.body.voidShift.status, "none"); assert.equal("voidShiftId" in DATA.bill.b1, false);
  seed();
  r = await call(body(), OWNER);
  assert.equal(r.body.voidShift.status, "none");
  seed();
  r = await call(body({ shiftId: "shB" }), OWNER);
  assert.equal(r.code, 409); assert.equal(r.body.error, "shift_other_shop"); assert.equal(LOG.length, 0);
});

test("กลุ่มผูกจาก stockSnapshot: คืนทุกตัวในกลุ่ม (รวมตัวที่ไม่อยู่ในแถวบิล) · อ่านครบก่อนเขียน", async () => {
  seed({ bill: { b1: bill({ product: [{ id: "box", qty: 2, totalCost: 240, stockSnapshot: { stockCountStatus: true, linkMultiply: 12, linkIds: ["box", "piece"] } }] }) } });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200);
  assert.equal(DATA.stock.box.stock, 124); assert.equal(DATA.stock.piece.stock, 124);
});

test("stock ของร้านอื่น / ไม่มีแล้ว = ไม่เขียน แต่ยกเลิกบิลได้", async () => {
  seed({ bill: { b1: bill({ product: [{ id: "p-x", qty: 1, totalCost: 1, stockCountStatus: true }, { id: "gone", qty: 1, totalCost: 1, stockCountStatus: true }] }) } });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200);
  assert.equal(writesTo("stock").length, 0);
  assert.equal(DATA.stock["p-x"].stock, 5);
  assert.equal(DATA.bill.b1.void, true);
});

test("สมาชิก: หักแต้มที่ได้ คืนแต้มที่แลก ต่ำสุด 0 · ถอดแถวหนี้ของบิล · คืนเงินที่ชำระแล้วเป็น refundCash", async () => {
  seed({
    bill: { b1: bill({ member: { id: "m1" }, gainPoint: 10, usedPoint: 5, moneyMustPaid: 100, payment: [{ id: 3, amount: 100 }] }) },
    member: { m1: { shopId: "shopA", point: 3, bought: [{ yearMonth: "202611", time: 2, buy: 300 }], creditArray: [{ billId: "b1", totalCredit: 100, remainCredit: 40 }, { billId: "zz", totalCredit: 5, remainCredit: 5 }] } },
  });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200); assert.equal(r.body.refundCash, 60);
  const m = DATA.member.m1;
  assert.equal(m.point, 0);
  assert.deepEqual(m.bought, [{ yearMonth: "202611", time: 1, buy: 200 }]);
  assert.deepEqual(m.creditArray.map((x) => x.billId), ["zz"]);
});

test("สมาชิกของร้านอื่น = ไม่เขียนสมาชิก", async () => {
  seed({ bill: { b1: bill({ member: { id: "m9" }, gainPoint: 10 }) }, member: { m9: { shopId: "shopB", point: 50 } } });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200); assert.equal(writesTo("member").length, 0); assert.equal(DATA.member.m9.point, 50);
});

test("#6: 2 คำขอยกเลิกบิลเดียวกัน คืนสต็อกครั้งเดียว · คำขอเดิมยิงซ้ำ = alreadyVoid ไม่เขียน", async () => {
  seed();
  const a = await call(body(), OWNER);
  const b = await call(body({ requestId: RID2 }), OWNER);
  const again = await call(body(), OWNER);
  assert.equal(a.code, 200);
  assert.equal(b.code, 409); assert.equal(b.body.error, "already_void");
  assert.deepEqual(again.body, { ok: true, billId: "b1", alreadyVoid: true, voidShift: { status: "none" } });
  assert.equal(DATA.stock["p-meat"].stock, 10.85);
  assert.equal(writesTo("stock").length, 1); assert.equal(writesTo("notification").length, 1);
});

test("ทีมงาน: byAdmin + adminUid ทุกเอกสารที่เขียน · คำตอบมี byAdmin", async () => {
  seed({ bill: { b1: bill({ member: { id: "m1" } }) }, member: { m1: { shopId: "shopA", point: 1 } } });
  const r = await call(body({ staffId: "u-company", staffName: "ทีมงาน" }), ADMIN);
  assert.equal(r.body.byAdmin, true);
  assert.ok(LOG.length >= 4);
  for (const w of LOG) { assert.equal(w.v.byAdmin, true, w.c); assert.equal(w.v.adminUid, "u-company", w.c); }
});

test("ปัดแล้วไม่เขียนอะไร: บิลรุ่นแรก · อ่านไม่ออก · ถูกแก้ไข · ร้านอื่น · ไม่มีสิทธิ์", async () => {
  const cases = [
    [{ bill: { b1: { shopId: "shopA", dateTime: ts("2023-05-01T05:00:00Z"), orderId: "o", product: [{ id: "p-meat", qty: 1 }], paymentType: "เงินสด", cashReceived: 1, cashChange: 0, credit: 0, promptpay: "", discount: 0, totalPrice: 1, totalCost: 1, customerId: "", customerName: "" } } }, OWNER, 409, "legacy_bill_view_only"],
    [{ bill: { b1: { shopId: "shopA", receiptNumber: 1 } } }, OWNER, 409, "bill_unreadable"],
    [{ bill: { b1: bill({ void: true, amendedBy: "b2", voidRequestId: RID }) } }, OWNER, 409, "already_void"],
    [{ bill: { b1: bill({ shopId: "shopB" }) } }, OWNER, 409, "bill_other_shop"],
    [{}, { ...OWNER, role: "staff", rights: ["100"] }, 403, "right_required"],
  ];
  for (const [s, acc, code, error] of cases) {
    seed(s);
    const r = await call(body(), acc);
    assert.equal(r.code, code, error); assert.equal(r.body.error, error); assert.equal(LOG.length, 0, error);
  }
});

test("ตัวช่วยล้วน: billStateForVoid แยก replay ออกจาก already_void", () => {
  assert.equal(V.billStateForVoid(bill({ void: true, voidRequestId: RID }), RID).kind, "replay");
  assert.equal(V.billStateForVoid(bill({ void: true }), RID).error, "already_void");
  assert.equal(V.billStateForVoid(bill(), RID).kind, "void");
});

// ── เพิ่มจากการตรวจซ้ำ (lanes/dev/source/chunk4-verify/sale.void.md) ────────────────
async function callAmend(b, shopAccess) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(x) { this.body = x; return this; } };
  await handler({ body: b, shopAccess, amendVoid: true }, res);
  return res;
}
const STAFF_143 = { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["143"] };

test("W1: sale.amend เรียกยกเลิกด้วย amendVoid · พนักงานมีแค่ 143 · บิลมี amend pending ของคำขอนี้ = ข้ามด่าน 116 → 200", async () => {
  seed({ bill: { b1: bill({ amend: { status: "pending", requestId: RID, newBillId: "b2" } }) } });
  const r = await callAmend(body({ staffId: "u-staff", staffName: "พนักงานบี" }), STAFF_143);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.alreadyVoid, false);
  assert.equal(DATA.bill.b1.void, true);
  assert.equal(DATA.stock["p-meat"].stock, 10.85);
});

test("W1 กันรั่ว: amendVoid ข้าม 116 ได้เฉพาะบิลที่ amend pending ของ requestId เดียวกัน · ไม่ใช่ = 403 ไม่เขียน", async () => {
  const cases = [
    ["ไม่มี amend", bill()],
    ["amend ของคำขออื่น", bill({ amend: { status: "pending", requestId: RID2 } })],
    ["amend จบแล้ว", bill({ amend: { status: "done", requestId: RID } })],
  ];
  for (const [why, b] of cases) {
    seed({ bill: { b1: b } });
    const r = await callAmend(body({ staffId: "u-staff", staffName: "พนักงานบี" }), STAFF_143);
    assert.equal(r.code, 403, why); assert.equal(r.body.error, "right_required", why); assert.equal(LOG.length, 0, why);
  }
  // ไม่มี amendVoid (คำขอ HTTP ปกติ) = ด่าน 116 เดิม แม้บิลมี amend pending
  seed({ bill: { b1: bill({ amend: { status: "pending", requestId: RID } }) } });
  const r = await call(body(), STAFF_143);
  assert.equal(r.code, 403); assert.equal(LOG.length, 0);
});

test("M3: ยิงซ้ำ requestId เดิม ตอบ taxNumber + voidShift เดิม (ไม่เขียนซ้ำ)", async () => {
  seed({ bill: { b1: bill({ taxNumber: "TX-0001" }) } });
  const first = await call(body({ shiftId: "sh1" }), OWNER);
  assert.equal(first.code, 200);
  const n = LOG.length;
  const again = await call(body({ shiftId: "sh1" }), OWNER);
  assert.equal(again.code, 200);
  assert.equal(again.body.alreadyVoid, true);
  assert.equal(again.body.taxNumber, "TX-0001");
  assert.deepEqual(again.body.voidShift, { status: "open" });
  assert.equal(LOG.length, n);
  seed();
  await call(body(), OWNER);
  const again2 = await call(body(), OWNER);
  assert.deepEqual(again2.body.voidShift, { status: "none" });
  assert.equal("taxNumber" in again2.body, false);
});

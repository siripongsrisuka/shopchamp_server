// เทสข้างไฟล์ของ pos/sale/amend + amendRules (ก้อน 4 · DEV-0001)
// ส่วนที่ harness วัดไม่ได้ (harness เขียน = no-op): ลำดับการเขียน · ยิงซ้ำเดินต่อ · ล้มกลางทาง · รับช่วงคำขอค้าง
// ฐานปลอมในไฟล์นี้เขียนจริงลง object ⇒ ขั้นถัดไปอ่านเห็นของที่ขั้นก่อนเขียน
// รัน: node --test functions/pos/sale/amend.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ── ฐานปลอมที่เขียนได้ (ใส่แทน functions/firebase ก่อนโหลด handler) ──
let DB = {};
let LOG = [];
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime() }; };
function setPath(obj, dotted, value) {
  const segs = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]] = cur[segs[i]] && typeof cur[segs[i]] === "object" ? cur[segs[i]] : {};
  cur[segs[segs.length - 1]] = value;
}
function ref(coll, id) {
  return {
    coll, id,
    get: async () => { const d = (DB[coll] || {})[id]; return { exists: d !== undefined, id, data: () => d }; },
  };
}
const fakeDb = {
  collection: (c) => ({ doc: (id) => ref(c, id) }),
  runTransaction: async (fn) => {
    const writes = [];
    let wrote = false;
    const txn = {
      get: async (r) => { if (wrote) throw new Error("อ่านหลังเขียนใน txn"); return r.get(); },
      update: (r, data) => { wrote = true; writes.push(["update", r, data]); },
      set: (r, data, opt) => { wrote = true; writes.push(["set", r, data, opt]); },
    };
    const out = await fn(txn);
    for (const [kind, r, data, opt] of writes) {
      DB[r.coll] = DB[r.coll] || {};
      if (kind === "update") {
        if (!DB[r.coll][r.id]) throw new Error("update เอกสารที่ไม่มี");
        for (const [k, v] of Object.entries(data)) setPath(DB[r.coll][r.id], k, v);
      } else {
        DB[r.coll][r.id] = opt && opt.merge ? { ...(DB[r.coll][r.id] || {}), ...data } : data;
      }
      LOG.push(`${kind} ${r.coll}/${r.id} ${Object.keys(data).join(",")}`);
    }
    return out;
  },
};
const fbAbs = require.resolve(path.join(__dirname, "../../firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {}, bucket: {} } };

const { amend } = require("./amend");
const { amendLocks, checkAmendShape, refundDueOf } = require("./amendRules");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const RID = "3c9e1f20-1111-4000-8000-0000000000aa";
const OTHER = "3c9e1f20-2222-4000-8000-0000000000bb";

function seed() {
  return {
    shop: { shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", position: ["001"], status: "active" }], vip: [{ type: "premium", expire: ts("2027-01-01T00:00:00.000Z") }], amendBill: true } },
    shift: { sh1: { shopId: "shopA", status: true, openTime: ts("2026-11-10T01:00:00.000Z") } },
    bill: {
      b1: {
        shopId: "shopA", receiptNumber: "202611000010", billDate: "20261110", dateTime: ts("2026-11-10T02:00:00.000Z"),
        moneyMustPaid: 100, product: [{ id: "p1", qty: 2, name: "น้ำ", net: 100, totalPrice: 100 }], payment: [{ id: 1, amount: 100, name: "เงินสด" }],
        member: {}, campaign: [], gainPoint: 0, usedPoint: 0, pointDiscount: { value: 0, point: 0 },
        shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), manualDiscount: "0", cashierId: "u-owner",
      },
    },
  };
}
const INPUT = {
  shopId: "shopA", billId: "b1", requestId: RID, reason: "คืน 1 ขวด", staffId: "u-owner", staffName: "เจ้าของ",
  product: [{ fromIndex: 0, id: "p1", qty: 1, name: "น้ำ", net: 50, totalPrice: 50, totalCost: 30 }], payment: [{ id: 1, amount: 50, name: "เงินสด" }], moneyMustPaid: 50,
};
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };

function stubs({ createOk = true, voidOk = true } = {}) {
  const calls = { create: [], void: [] };
  return {
    calls,
    deps: {
      now: () => NOW,
      createSale: async (i) => { calls.create.push(i); LOG.push("createSale"); return createOk ? { ok: true, billId: "b-new", receiptNumber: "202611000043" } : { ok: false, error: "counter_failed", status: 500 }; },
      voidSale: async (i) => {
        calls.void.push(i);
        LOG.push(`voidSale amendedBy=${DB.bill.b1.amendedBy || "-"}`);
        if (!voidOk) return { ok: false, error: "internal_error", status: 500 };
        DB.bill.b1.void = true;
        return { ok: true, billId: "b1", alreadyVoid: false };
      },
    },
  };
}
async function call(deps, input = INPUT, access = OWNER) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await amend(deps)({ body: input, shopAccess: access }, res);
  return res;
}
const reset = (mut) => { DB = seed(); LOG = []; if (mut) mut(DB); };

// ── amendRules ──
test("amendLocks: บิลสะอาด = ว่าง (ชุดควบคุมฝั่งควรผ่าน)", () => {
  assert.deepEqual(amendLocks(seed().bill.b1), []);
  assert.deepEqual(amendLocks({ ...seed().bill.b1, member: { id: "" }, taxNumber: "", gainPoint: "0", pointToItem: [], lucky: [] }), []);
});
test("amendLocks: ทุกคลาสที่ล็อก", () => {
  const b = seed().bill.b1;
  assert.deepEqual(amendLocks({ ...b, taxNumber: "202611000003" }), ["tax_invoice"]);
  for (const extra of [{ member: { id: "m1" } }, { payment: [{ id: 3, amount: 100 }] }, { payment: [{ id: "035", amount: "100" }] }, { gainPoint: 2 }, { usedPoint: "5" }, { pointDiscount: { value: 10, point: 1 } }, { pointToItem: [{ id: "x" }] }]) {
    assert.deepEqual(amendLocks({ ...b, ...extra }), ["member"], JSON.stringify(extra));
  }
  assert.deepEqual(amendLocks({ ...b, campaign: [{ id: "c" }] }), ["promotion"]);
  assert.deepEqual(amendLocks({ ...b, lucky: ["1"] }), ["promotion"]);
});
test("checkAmendShape: ลำดับด่าน · ตัวเลขข้อความของบิลเก่า · ช่องจ่ายสลับลำดับ = ไม่เปลี่ยน", () => {
  const b = { ...seed().bill.b1, moneyMustPaid: "100", product: [{ id: "p1", qty: "2" }, { id: "p2", qty: 1 }], payment: [{ id: 1, amount: "60" }, { id: 2, amount: 40 }] };
  const same = { product: [{ fromIndex: 1, id: "p2", qty: 1 }, { fromIndex: 0, id: "p1", qty: 2 }], payment: [{ id: 2, amount: 40 }, { id: 1, amount: 60 }], moneyMustPaid: 100 };
  assert.equal(checkAmendShape(b, same), "nothing_changed");
  assert.equal(checkAmendShape(b, { ...same, product: [{ fromIndex: 0, id: "p1", qty: 2 }] }), null); // ตัดแถว = เปลี่ยน
  assert.equal(checkAmendShape(b, { ...same, product: [{ fromIndex: 0, id: "p2", qty: 1 }] }), "line_mismatch");
  assert.equal(checkAmendShape(b, { ...same, product: [{ fromIndex: 0, id: "p1", qty: 2.0001 }] }), "qty_increase");
  assert.equal(checkAmendShape(b, { ...same, moneyMustPaid: 100.01, payment: [{ id: 1, amount: 100.01 }] }), "net_increase");
  assert.equal(checkAmendShape(b, { ...same, payment: [{ id: 1, amount: 99 }] }), "payment_mismatch");
  assert.equal(checkAmendShape(b, { ...same, payment: [{ id: 1, amount: 120, change: 20 }] }), null); // เงินทอนหักออก · ช่องเปลี่ยน
  // B-4: จำนวนเท่าเดิมทุกแถว ยอดลด = net_decrease · ±0.005 ยังนับเท่าเดิม · ลดจำนวนแล้วยอดลด = ผ่าน
  assert.equal(checkAmendShape(b, { ...same, moneyMustPaid: 90, payment: [{ id: 1, amount: 90 }] }), "net_decrease");
  assert.equal(checkAmendShape(b, { ...same, moneyMustPaid: 99.99, payment: [{ id: 1, amount: 99.99 }] }), "net_decrease");
  assert.equal(checkAmendShape(b, { ...same, moneyMustPaid: 99.996, payment: [{ id: 1, amount: 99.996 }] }), null);
  assert.equal(checkAmendShape(b, { ...same, product: [{ fromIndex: 1, id: "p2", qty: 1 }, { fromIndex: 0, id: "p1", qty: 1 }], moneyMustPaid: 90, payment: [{ id: 1, amount: 90 }] }), null);
  assert.equal(checkAmendShape(b, { ...same, product: [{ fromIndex: 0, id: "p1", qty: 2 }], moneyMustPaid: 60, payment: [{ id: 1, amount: 60 }] }), null); // ตัดแถว = ไม่ใช่จำนวนเท่าเดิม
  assert.equal(refundDueOf({ moneyMustPaid: "180" }, 90), 90);
  assert.equal(refundDueOf({ moneyMustPaid: 100 }, 100), 0);
});

// ── handler: ลำดับและการเขียน ──
test("สำเร็จ: เขียนตามลำดับ ①→create→③→void→⑤ · amendedBy เขียนหลังยกเลิกเท่านั้น", async () => {
  reset();
  const s = stubs();
  const r = await call(s.deps);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(LOG, [
    "update bill/b1 amend",
    "createSale",
    "update bill/b1 amend.newBillId,amend.newReceiptNumber",
    "set bill/b-new amendOf,amend",
    "voidSale amendedBy=-",
    "update bill/b1 amendedBy,amend.status,amend.newBillId,amend.newReceiptNumber,amend.refundDue,amend.doneAt",
    "set notification/undefined heading,shopId,notificationContent,categoryId,timestamp", // B-5 · ใน txn ⑤ เดียวกัน
  ]);
  const noti = DB.notification[undefined];
  assert.equal(noti.categoryId, 8); assert.equal(noti.heading, "แก้ไขใบเสร็จ"); assert.equal(noti.shopId, "shopA");
  assert.equal(noti.timestamp.getTime(), NOW.getTime());
  assert.match(noti.notificationContent, /ใบเดิม 202611000010 → ใบใหม่ /);
  assert.match(noti.notificationContent, /คืนลูกค้า 50\.00 บาท/);
  const b1 = DB.bill.b1;
  assert.equal(b1.amend.status, "done");
  assert.equal(b1.amend.requestId, RID);
  assert.equal(b1.amend.refundDue, 50);
  assert.equal(b1.amendedBy, "b-new");
  assert.equal(DB.bill["b-new"].amendOf, "b1");
  assert.equal(DB.bill["b-new"].amend.ofReceiptNumber, "202611000010");
  // ใบใหม่: ไม่มี fromIndex · ถือกะเดิม · manualDiscount ข้อความเก่าแปลงเป็นเลข
  const cb = s.calls.create[0];
  assert.equal(cb.body.product[0].fromIndex, undefined);
  assert.equal(cb.body.shiftOpenTime, "2026-11-10T01:00:00.000Z");
  assert.equal(cb.body.manualDiscount, 0);
  assert.equal(cb.carry.dateTime.toISOString(), "2026-11-10T02:00:00.000Z");
  assert.equal(require("@shopchamp/schema").SaleCreateRequest.safeParse(cb.body).success, true, "body ใบใหม่ต้องผ่าน SaleCreateRequest");
  const vb = s.calls.void[0];
  assert.equal(vb.amendVoid, true);
  assert.equal(vb.body.requestId, RID);
  assert.equal(vb.body.reason, "แก้ไข → 202611000043 · คืน 1 ขวด");
  assert.equal(require("@shopchamp/schema").SaleVoidRequest.safeParse(vb.body).success, true);
  // ยิงซ้ำหลังจบ = duplicate ไม่เรียกซ้ำ
  const again = await call(s.deps);
  assert.equal(again.code, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.refundDue, 50);
  assert.equal(s.calls.create.length, 1);
  assert.equal(s.calls.void.length, 1);
});

test("ทีมงาน: ทุกเอกสารที่เขียนมี byAdmin + adminUid", async () => {
  reset();
  const r = await call(stubs().deps, { ...INPUT, staffId: "u-co" }, { ...OWNER, uid: "u-co", byAdmin: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.byAdmin, true);
  assert.equal(DB.bill.b1.amend.byAdmin, true);
  assert.equal(DB.bill.b1.amend.adminUid, "u-co");
  assert.equal(DB.bill["b-new"].adminUid, "u-co");
});

test("ออกใบใหม่ล้ม → 500 amend_create_failed · ค้าง pending · ไม่ยกเลิกใบเดิม · ยิงซ้ำเดินต่อจนจบ", async () => {
  reset();
  const bad = stubs({ createOk: false });
  const r = await call(bad.deps);
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "amend_create_failed");
  assert.equal(bad.calls.void.length, 0);
  assert.equal(DB.bill.b1.amend.status, "pending");
  assert.equal(DB.bill.b1.void, undefined);
  // ยิงซ้ำด้วย body ที่เปลี่ยนเนื้อ = ใช้ changes ที่ประทับไว้
  const good = stubs();
  const r2 = await call(good.deps, { ...INPUT, moneyMustPaid: 10, payment: [{ id: 1, amount: 10, name: "เงินสด" }] });
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  assert.equal(good.calls.create[0].body.moneyMustPaid, 50);
  assert.equal(r2.body.refundDue, 50);
});

test("ยกเลิกล้มหลังออกใบใหม่ → 500 amend_reverse_failed · ยิงซ้ำ = ไม่ออกใบใหม่ซ้ำ · ยกเลิกต่อ", async () => {
  reset();
  const bad = stubs({ voidOk: false });
  const r = await call(bad.deps);
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "amend_reverse_failed");
  assert.equal(r.body.newBillId, "b-new");
  assert.equal(DB.bill.b1.amend.newBillId, "b-new");
  const good = stubs();
  const r2 = await call(good.deps);
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  assert.equal(good.calls.create.length, 0);
  assert.equal(good.calls.void.length, 1);
  assert.equal(DB.bill.b1.amend.status, "done");
});

test("ยกเลิกสำเร็จแต่ปิดงานยังไม่ถึง: บิลเดิม void แล้ว ยิงซ้ำ = เดินต่อ ไม่ตอบ bill_void", async () => {
  reset((d) => { Object.assign(d.bill.b1, { void: true, amend: { status: "pending", requestId: RID, at: NOW, changes: { ...INPUT }, newBillId: "b-new", newReceiptNumber: "202611000043" } }); });
  const s = stubs();
  const r = await call(s.deps);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(s.calls.create.length, 0);
});

test("คำขออื่นค้างเกิน 5 นาที: ยังไม่ออกใบใหม่ = รับช่วงได้ · ออกใบใหม่แล้ว = 409 ไม่ออกใบที่ 2", async () => {
  const stale = { status: "pending", requestId: OTHER, at: ts("2026-11-10T02:50:00.000Z"), changes: { ...INPUT } };
  reset((d) => { d.bill.b1.amend = { ...stale }; });
  const r = await call(stubs().deps);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(DB.bill.b1.amend.requestId, RID);
  reset((d) => { d.bill.b1.amend = { ...stale, newBillId: "b-x" }; });
  const s = stubs();
  const r2 = await call(s.deps);
  assert.equal(r2.code, 409);
  assert.equal(r2.body.error, "amend_in_progress");
  assert.equal(s.calls.create.length, 0);
});

test("กะ: บิลไม่มี shiftOpenTime ใช้ dateTime > openTime · กะร้านอื่น 409 · ไม่มี doc กะ 409 shift_unknown", async () => {
  reset((d) => { delete d.bill.b1.shiftOpenTime; });
  assert.equal((await call(stubs().deps)).code, 200);
  reset((d) => { delete d.bill.b1.shiftOpenTime; d.bill.b1.dateTime = ts("2026-11-10T01:00:00.000Z"); });
  assert.equal((await call(stubs().deps)).body.error, "shift_closed");
  reset((d) => { d.shift.sh1.shopId = "shopB"; });
  assert.equal((await call(stubs().deps)).body.error, "shift_other_shop");
  reset((d) => { d.bill.b1.shiftId = "gone"; });
  assert.equal((await call(stubs().deps)).body.error, "shift_unknown");
});

test("ด่านที่ปัดต้องไม่เขียนอะไรเลย", async () => {
  reset((d) => { d.bill.b1.taxNumber = "T1"; });
  const r = await call(stubs().deps);
  assert.equal(r.body.lock, "tax_invoice");
  assert.deepEqual(LOG, []);
  assert.equal(DB.bill.b1.amend, undefined);
});

// ── ช่องที่ case ในสัญญาไม่จับ (ตรวจซ้ำ `lanes/dev/source/chunk4-verify/sale.amend.md`) ──
const { Bill } = require("@shopchamp/schema");
const AmendShape = Bill.shape.amend;

test("รูปที่เขียนต้องผ่าน schema Bill: amend บนบิลเดิม (pending และ done) · amend บนใบใหม่มี status (ข้อ 1-2)", async () => {
  reset();
  const bad = stubs({ createOk: false });
  await call(bad.deps);
  assert.equal(AmendShape.safeParse(DB.bill.b1.amend).success, true, JSON.stringify(DB.bill.b1.amend));
  assert.equal(Bill.safeParse(DB.bill.b1).success, true, "บิลเดิมที่ค้าง pending ต้องยังยกเลิกได้ผ่าน sale.void");
  const s = stubs();
  assert.equal((await call(s.deps)).code, 200);
  assert.equal(typeof DB.bill.b1.amend.staff, "string");
  assert.equal(DB.bill.b1.amend.staffId, "u-owner");
  assert.equal(AmendShape.safeParse(DB.bill.b1.amend).success, true, JSON.stringify(DB.bill.b1.amend));
  assert.equal(Bill.safeParse(DB.bill.b1).success, true);
  const na = DB.bill["b-new"].amend;
  assert.equal(AmendShape.safeParse(na).success, true, JSON.stringify(na));
  assert.equal(na.ofBillId, "b1");
});

test("แก้ใบใหม่ซ้ำเป็นทอด: ลิงก์ย้อน ofBillId ofReceiptNumber ของใบที่ 2 ไม่หาย · ล็อกของคำขอใหม่ใช้ได้ (ข้อ 3)", async () => {
  reset();
  assert.equal((await call(stubs().deps)).code, 200);
  // ใบใหม่ในฐาน = ผลของ sale.create (จำลอง) + ที่ ③ เขียน
  Object.assign(DB.bill["b-new"], { ...seed().bill.b1, receiptNumber: "202611000043", moneyMustPaid: 50, product: [{ id: "p1", qty: 1, name: "น้ำ", net: 50, totalPrice: 50 }], payment: [{ id: 1, amount: 50, name: "เงินสด" }] });
  const calls = { create: 0, void: [] };
  const deps = {
    now: () => NOW,
    createSale: async () => { calls.create++; return { ok: true, billId: "b-new2", receiptNumber: "202611000044" }; },
    voidSale: async (i) => { calls.void.push(i); DB.bill[i.body.billId].void = true; return { ok: true, billId: i.body.billId, alreadyVoid: false }; },
  };
  const r = await call(deps, { ...INPUT, billId: "b-new", requestId: OTHER, product: [{ fromIndex: 0, id: "p1", qty: 1, name: "น้ำ", net: 50, totalPrice: 50, totalCost: 30 }], payment: [{ id: 2, amount: 50, name: "พร้อมเพย์" }], moneyMustPaid: 50 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(calls.create, 1);
  const a = DB.bill["b-new"].amend;
  assert.equal(a.ofBillId, "b1");
  assert.equal(a.ofReceiptNumber, "202611000010");
  assert.equal(a.status, "done");
  assert.equal(a.requestId, OTHER);
  assert.equal(a.newBillId, "b-new2");
  assert.equal(DB.bill["b-new"].amendOf, "b1");
  assert.equal(DB.bill["b-new2"].amend.ofBillId, "b-new");
});

test("คำขออื่นค้างเกิน 5 นาที ที่ออกใบใหม่แล้วแต่ยังไม่ผูก (มี receiptGuard) = 409 stalled ไม่ออกใบที่ 2 (ข้อ 4)", async () => {
  reset((d) => {
    d.bill.b1.amend = { status: "pending", requestId: OTHER, at: ts("2026-11-10T02:50:00.000Z"), changes: { ...INPUT } };
    d.receiptGuard = { [`amend:b1:${OTHER}`]: { billId: "orphan", usedBy: "202611000042", shopId: "shopA" } };
  });
  const s = stubs();
  const r = await call(s.deps);
  assert.equal(r.code, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "amend_in_progress");
  assert.equal(s.calls.create.length, 0);
  assert.equal(DB.bill.b1.amend.requestId, OTHER);
});

test("ยิงซ้ำ requestId เดิมพร้อมกัน: ตัวที่ช้ากว่าเจอ already_void หลังอีกตัวทำจบ = 200 duplicate ไม่ใช่ 500 (ข้อ 5)", async () => {
  reset();
  const deps = {
    now: () => NOW,
    createSale: async () => ({ ok: true, billId: "b-new", receiptNumber: "202611000043", duplicate: true }),
    voidSale: async () => {
      // อีกเครื่องทำจบรวม ⑤ ไปแล้วระหว่างทาง
      Object.assign(DB.bill.b1, { void: true, voidRequestId: RID, amendedBy: "b-new" });
      Object.assign(DB.bill.b1.amend, { status: "done", newBillId: "b-new", newReceiptNumber: "202611000043", refundDue: 50 });
      return { ok: false, error: "already_void", status: 409 };
    },
  };
  const r = await call(deps);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.newBillId, "b-new");
  // ชุดควบคุม: already_void จากคนอื่น (ไม่ใช่คำขอนี้) ยังเป็น 500
  reset();
  const other = { ...deps, voidSale: async () => { DB.bill.b1.void = true; return { ok: false, error: "already_void", status: 409 }; } };
  assert.equal((await call(other)).code, 500);
});

test("ยิงซ้ำหลังออกใบใหม่ล้ม: ยกเลิกใบเดิมด้วยพนักงานที่ประทับไว้ ไม่ใช่ของคำขอใหม่", async () => {
  reset();
  await call(stubs({ createOk: false }).deps);
  const s = stubs();
  assert.equal((await call(s.deps, { ...INPUT, staffId: "u-x", staffName: "คนอื่น" })).code, 200);
  assert.equal(s.calls.void[0].body.staffId, "u-owner");
  assert.equal(s.calls.void[0].body.staffName, "เจ้าของ");
});

test("create.applyAmendCarry: ใบใหม่ถือ dateTime billDate soldAt ของใบเดิม · ไม่มี carry = ไม่แตะ (ข้อ 6)", () => {
  const { applyAmendCarry } = require("./create");
  const b = { dateTime: NOW, billDate: "20261110" };
  applyAmendCarry(b, undefined);
  assert.deepEqual(b, { dateTime: NOW, billDate: "20261110" });
  const old = new Date("2026-11-09T16:30:00.000Z"); // 23:30 เวลาไทย วันที่ 9
  const c = { dateTime: NOW, billDate: "20261110" };
  applyAmendCarry(c, { dateTime: old, billDate: "20261109", soldAt: old });
  assert.equal(c.dateTime.getTime(), old.getTime());
  assert.equal(c.billDate, "20261109");
  assert.equal(c.soldAt.getTime(), old.getTime());
  const d = { dateTime: NOW, billDate: "20261110" };
  applyAmendCarry(d, { dateTime: old });
  assert.equal(d.billDate, "20261109", "ไม่มี billDate ใน carry = คิดจาก dateTime เดิม");
  const e = { dateTime: NOW, billDate: "20261110" };
  applyAmendCarry(e, { dateTime: "x", billDate: 5 });
  assert.deepEqual(e, { dateTime: NOW, billDate: "20261110" }, "carry รูปเพี้ยน = ไม่แตะ");
});

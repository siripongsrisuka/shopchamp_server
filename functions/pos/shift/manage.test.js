// เทสข้างไฟล์ pos/shift/manage.js — ส่วนที่ case ในสัญญาวัดยาก (harness บันทึกการเขียนแต่ไม่ลงฐาน · ไม่เห็นลำดับอ่าน/เขียน)
//   รูปเอกสารที่เขียน · อ่านครบก่อนเขียนใน transaction · ไม่เขียนเมื่อถูกปัด/ซ้ำ
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime() }; };

// Firestore ปลอมที่บันทึกลำดับ get/set/update ใน transaction
function fakeDb(seed) {
  const log = [];
  const snap = (coll, id) => { const d = (seed[coll] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  // where รองรับ == >= > array-contains · เวลาเทียบเป็น ms (Timestamp ปลอมคนละ object แต่เวลาเดียวกัน = เท่ากัน)
  const msOf = (v) => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : undefined);
  const match = (dv, op, v) => {
    const a = msOf(dv), b = msOf(v);
    if (a !== undefined && b !== undefined) { dv = a; v = b; }
    if (op === "==") return dv === v;
    if (op === ">=") return dv !== undefined && dv >= v;
    if (op === ">") return dv !== undefined && dv > v;
    if (op === "array-contains") return Array.isArray(dv) && dv.includes(v);
    throw new Error("fake where op " + op);
  };
  const query = (coll, filters) => ({
    where: (f, op, v) => query(coll, [...filters, [f, op, v]]),
    get: async () => {
      const docs = Object.entries(seed[coll] || {}).filter(([, d]) => filters.every(([f, op, v]) => match(d[f], op, v))).map(([id, d]) => ({ id, exists: true, data: () => d }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
    _q: coll,
  });
  let auto = 0;
  const db = {
    collection: (coll) => ({ doc: (id) => ({ _coll: coll, id: id === undefined ? `__auto_${++auto}` : id, get: async () => snap(coll, id) }), where: (f, op, v) => query(coll, [[f, op, v]]) }),
    runTransaction: async (fn) => fn({
      get: async (ref) => { log.push(["get", ref._coll || ref._q]); return ref.get(); },
      set: (ref, data) => log.push(["set", ref._coll, ref.id, data]),
      update: (ref, data) => log.push(["update", ref._coll, ref.id, data]),
    }),
  };
  return { db, log };
}

function load(db) {
  const fb = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  require.cache[fb] = { id: fb, filename: fb, loaded: true, exports: { db, admin: {} } };
  const p = require.resolve("./manage");
  delete require.cache[p];
  return require("./manage");
}

async function call(seed, body, access, nowIso) {
  const { db, log } = fakeDb(seed);
  const { manage } = load(db);
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await manage({ now: () => new Date(nowIso || "2026-11-10T03:00:00.000Z") })({ body, shopAccess: access }, res);
  return { res, log };
}

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };
const shop = () => ({ shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", name: "เจ้าของ", status: "active" }] } });
const openShift = () => ({
  shopId: "shopA", posId: "pos-1", status: true, openTime: ts("2026-11-10T01:00:00.000Z"), openCash: "500",
  duringShift: [{ type: 1, amount: "50", comment: "", staff: "เจ้าของ", staffId: "u-owner", timestamp: ts("2026-11-10T01:30:00.000Z"), entryId: "d0" }],
  lastShiftDate: "20261110", shiftCount: 1, openId: "u-owner", openName: "เจ้าของ",
});
const bills = () => ({
  b1: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), dateTime: ts("2026-11-10T02:00:00.000Z"), moneyMustPaid: 100, product: [{ id: "p1", qty: 1, net: 100, totalPrice: 100 }], payment: [{ id: 1, amount: 100, change: 0 }] },
  // บิลรอบก่อน (ป้ายคนละรอบ) ไม่เข้ารอบนี้
  b0: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts("2026-11-09T01:00:00.000Z"), dateTime: ts("2026-11-09T02:00:00.000Z"), moneyMustPaid: 999, product: [], payment: [{ id: 1, amount: 999 }] },
  // ร้านอื่นที่ shiftId ชนกัน = ไม่นับ
  bx: { shopId: "shopB", shiftId: "sh1", dateTime: ts("2026-11-10T02:00:00.000Z"), moneyMustPaid: 7, product: [], payment: [{ id: 1, amount: 7 }] },
});

test("open: เขียน shift รูปเดิม + openRequestId · เวลา server · ไม่มีรอยทีมงานเมื่อเจ้าของเปิด", async () => {
  const s = { ...openShift(), status: false, lastShiftDate: "20261109", shiftCount: 4 };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s } }, { op: "open", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", requestId: "r1", openCash: "300" }, OWNER);
  assert.equal(res.code, 200);
  const w = log.filter((l) => l[0] !== "get");
  assert.equal(w.length, 2); // shift + แจ้งเตือน (A-9)
  assert.deepEqual(w[0].slice(0, 3), ["update", "shift", "sh1"]);
  assert.deepEqual(w[1].slice(0, 3), ["set", "notification", "sh1_open_r1"]);
  assert.deepEqual({ ...w[1][3], timestamp: w[1][3].timestamp.toISOString() }, { heading: "เปิดกะที่ 1", notificationContent: "ยอดเงิน 300.00 บาท\nโดย เจ้าของ", shopId: "shopA", categoryId: 2, timestamp: "2026-11-10T03:00:00.000Z" });
  const p = w[0][3];
  assert.equal(p.status, true);
  assert.equal(p.openTime.toISOString(), "2026-11-10T03:00:00.000Z");
  assert.deepEqual({ openCash: p.openCash, openId: p.openId, openName: p.openName, lastShiftDate: p.lastShiftDate, shiftCount: p.shiftCount, openRequestId: p.openRequestId }, { openCash: "300", openId: "u-owner", openName: "เจ้าของ", lastShiftDate: "20261110", shiftCount: 1, openRequestId: "r1" });
  assert.deepEqual(p.duringShift, []);
  assert.equal("byAdmin" in p, false);
});

test("open: ข้ามเที่ยงคืนเวลาไทย (17:30Z = 00:30 วันถัดไป) ได้กะที่ 1 ของวันใหม่", async () => {
  const s = { ...openShift(), status: false, lastShiftDate: "20261110", shiftCount: 3 };
  const { res } = await call({ shop: shop(), shift: { sh1: s } }, { op: "open", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "r1", openCash: "0" }, OWNER, "2026-11-10T17:30:00.000Z");
  assert.equal(res.body.lastShiftDate, "20261111");
  assert.equal(res.body.shiftCount, 1);
});

test("open โดยทีมงาน: shift ติด byAdmin adminUid", async () => {
  const s = { ...openShift(), status: false };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s } }, { op: "open", shopId: "shopA", shiftId: "sh1", staffId: "u-company", staffName: "ทีมงาน", requestId: "r1", openCash: "0" }, ADMIN);
  assert.equal(res.body.byAdmin, true);
  const p = log.find((l) => l[0] === "update")[3];
  assert.equal(p.byAdmin, true);
  assert.equal(p.adminUid, "u-company");
});

test("during: ต่อท้ายรายการเดิม ไม่ทับ · entryId = requestId · timestamp เวลา server", async () => {
  const { res, log } = await call({ shop: shop(), shift: { sh1: openShift() } }, { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", requestId: "d1", type: 2, amount: "20", comment: "ซื้อน้ำแข็ง" }, OWNER);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.warnings, []);
  const p = log.find((l) => l[0] === "update")[3];
  assert.equal(p.duringShift.length, 2);
  assert.equal(p.duringShift[0].entryId, "d0");
  const e = p.duringShift[1];
  assert.deepEqual({ type: e.type, amount: e.amount, comment: e.comment, staff: e.staff, staffId: e.staffId, entryId: e.entryId }, { type: 2, amount: "20", comment: "ซื้อน้ำแข็ง", staff: "เจ้าของ", staffId: "u-owner", entryId: "d1" });
  assert.equal(e.timestamp.toISOString(), "2026-11-10T03:00:00.000Z");
});

test("during: นำออกไม่เกินเงินคาดที่รวมยอดขายเงินสด = ไม่เตือน · เกิน = เตือน (เงินคาด 500+50+100 = 650)", async () => {
  const base = { shop: shop(), shift: { sh1: openShift() }, bill: bills() };
  const body = (amount) => ({ op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "d1", type: 2, amount, comment: "" });
  assert.deepEqual((await call(base, body("650"), OWNER)).res.body.warnings, []);
  assert.deepEqual((await call(base, body("650.01"), OWNER)).res.body.warnings, ["CASH_OUT_OVER"]);
});

test("close: อ่านครบก่อนเขียน · ประวัติ doc id ตายตัว · รูปเดิม + field ใหม่ · shift ปิด", async () => {
  const { res, log } = await call({ shop: shop(), shift: { sh1: openShift() }, bill: bills() }, { op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", requestId: "c1", closeCash: "640", closeWithDraw: "100", expectedCash: 650 }, OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual({ e: res.body.expectedCash, d: res.body.closeDiff, r: res.body.cashRemain }, { e: 650, d: -10, r: 540 });
  assert.equal(res.body.summary.billQty, 1);
  const firstWrite = log.findIndex((l) => l[0] !== "get");
  assert.ok(log.slice(firstWrite).every((l) => l[0] !== "get"), "มี get หลังเขียน");
  const set = log.find((l) => l[0] === "set");
  assert.deepEqual(set.slice(1, 3), ["shiftHistory", "sh1_1794272400000"]);
  const h = set[3];
  assert.equal(h.shopId, "shopA");
  assert.equal(h.id, "sh1");
  assert.equal(h.openCash, "500");
  assert.equal(h.closeCash, "640");
  assert.equal(h.closeWithDraw, "100");
  assert.equal(h.closeDiff, -10);
  assert.equal(h.currentCash, 650);
  assert.equal(h.thisTotalCash, 100);
  assert.equal(h.closeRequestId, "c1");
  assert.equal(h.closeTime.toISOString(), "2026-11-10T03:00:00.000Z");
  assert.equal(h.duringShift.length, 1);
  const up = log.find((l) => l[0] === "update");
  assert.deepEqual(up.slice(1), ["shift", "sh1", { status: false, duringShift: [] }]);
});

test("ถูกปัดหรือซ้ำ = ไม่เขียนอะไรเลย", async () => {
  const cases = [
    [{ shop: shop(), shift: { sh1: openShift() } }, { op: "open", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "r9", openCash: "0" }, 409],
    [{ shop: shop(), shift: { sh1: openShift() } }, { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "d0", type: 1, amount: "50", comment: "" }, 200],
    [{ shop: shop(), shift: { sh1: openShift() }, bill: bills() }, { op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "c1", closeCash: "650", closeWithDraw: "0", expectedCash: 600 }, 409],
    [{ shop: shop(), shift: { sh1: openShift() }, shiftHistory: { sh1_1794272400000: { shopId: "shopA", closeRequestId: "c-other" } } }, { op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "c1", closeCash: "550", closeWithDraw: "0", expectedCash: 550 }, 409],
  ];
  for (const [seed, body, code] of cases) {
    const { res, log } = await call(seed, body, OWNER);
    assert.equal(res.code, code, JSON.stringify(res.body));
    assert.deepEqual(log.filter((l) => l[0] !== "get"), [], body.op + " " + body.requestId);
  }
});

test("ประวัติที่มี closeRequestId ตรงแต่เป็นของร้านอื่น ไม่นับเป็น duplicate", async () => {
  const s = { ...openShift(), status: false };
  const { res } = await call({ shop: shop(), shift: { sh1: s }, shiftHistory: { sh1_1794272400000: { shopId: "shopB", closeRequestId: "c1" } } }, { op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "c1", closeCash: "650", closeWithDraw: "0", expectedCash: 650 }, OWNER);
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "shift_not_open");
});

// ── เพิ่มหลังตรวจซ้ำ (lanes/dev/source/chunk4-verify/shift.manage.md) · ส่วนที่ case ในสัญญาไม่ครอบ ──
const closeBody = (extra) => ({ op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", requestId: "c1", closeCash: "650", closeWithDraw: "0", expectedCash: 650, ...extra });

test("#17 close: รับชำระหนี้เงินสดในรอบนับเข้าเงินคาด (500+50+100+40 = 690) · ร้านอื่น/รอบก่อนไม่นับ", async () => {
  const paidHistory = {
    p1: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), paymentId: 1, paid: 40, timestamp: ts("2026-11-10T02:00:00.000Z") },
    p0: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts("2026-11-09T01:00:00.000Z"), paymentId: 1, paid: 999, timestamp: ts("2026-11-09T02:00:00.000Z") },
    px: { shopId: "shopB", shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), paymentId: 1, paid: 7, timestamp: ts("2026-11-10T02:00:00.000Z") },
  };
  const seed = { shop: shop(), shift: { sh1: openShift() }, bill: bills(), paidHistory };
  const okRes = await call(seed, closeBody({ closeCash: "690", expectedCash: 690 }), OWNER);
  assert.equal(okRes.res.code, 200, JSON.stringify(okRes.res.body));
  assert.equal(okRes.res.body.expectedCash, 690);
  assert.equal(okRes.log.find((l) => l[0] === "set")[3].currentCash, 690);
  const stale = await call(seed, closeBody({ expectedCash: 650 }), OWNER);
  assert.equal(stale.res.code, 409);
  assert.equal(stale.res.body.expectedCash, 690);
});

test("ทีมงานบันทึกเงินเข้าออก: รายการติด byAdmin adminUid · เจ้าของบันทึก = ไม่ติด", async () => {
  const body = { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-company", staffName: "ทีมงาน", requestId: "d1", type: 1, amount: "20", comment: "" };
  const a = await call({ shop: shop(), shift: { sh1: openShift() } }, body, ADMIN);
  const e = a.log.find((l) => l[0] === "update")[3].duringShift[1];
  assert.deepEqual({ b: e.byAdmin, u: e.adminUid }, { b: true, u: "u-company" });
  const o = await call({ shop: shop(), shift: { sh1: openShift() } }, { ...body, staffId: "u-owner" }, OWNER);
  const e2 = o.log.find((l) => l[0] === "update")[3].duringShift[1];
  assert.equal("byAdmin" in e2, false);
});

test("ทีมงานปิดกะ: ประวัติติด byAdmin adminUid ของคนปิด", async () => {
  const { res, log } = await call({ shop: shop(), shift: { sh1: openShift() }, bill: bills() }, closeBody({ staffId: "u-company" }), ADMIN);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const h = log.find((l) => l[0] === "set")[3];
  assert.deepEqual({ b: h.byAdmin, u: h.adminUid }, { b: true, u: "u-company" });
});

test("W2 ทีมงานเปิด แล้วเจ้าของปิด: ประวัติไม่ติดรอยทีมงานว่าเป็นคนปิด · รอยคนเปิดแยกไว้ที่ openByAdmin", async () => {
  const s = { ...openShift(), byAdmin: true, adminUid: "u-company" };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s }, bill: bills() }, closeBody(), OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const h = log.find((l) => l[0] === "set")[3];
  assert.equal(h.byAdmin, false);
  assert.equal(h.adminUid, null);
  assert.deepEqual({ b: h.openByAdmin, u: h.openAdminUid }, { b: true, u: "u-company" });
});

test("W1 ปิดซ้ำ requestId เดิมหลังมีคนเปิดรอบใหม่ = duplicate ของรอบเดิม · ไม่ปิดรอบใหม่", async () => {
  // รอบ 1 (เปิด 01:00Z) ปิดแล้วด้วย c1 · รอบ 2 เปิด 03:00Z ยอด 650 ยังไม่มีบิล
  const s = { ...openShift(), openTime: ts("2026-11-10T03:00:00.000Z"), openCash: "650", duringShift: [], openRequestId: "r2" };
  const hist = { sh1_1794272400000: { id: "sh1", shopId: "shopA", closeRequestId: "c1", currentCash: 650, closeDiff: 0 } };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s }, shiftHistory: hist }, closeBody(), OWNER, "2026-11-10T04:00:00.000Z");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.shiftHistoryId, "sh1_1794272400000");
  assert.deepEqual(log.filter((l) => l[0] !== "get"), []);
});

test("W1 requestId เดิมแต่เป็นประวัติของจุดขายอื่นหรือร้านอื่น = ไม่นับ duplicate", async () => {
  const hist = {
    sh2_1794272400000: { id: "sh2", shopId: "shopA", closeRequestId: "c1" },
    sh1_1700000000000: { id: "sh1", shopId: "shopB", closeRequestId: "c1" },
  };
  const { res } = await call({ shop: shop(), shift: { sh1: openShift() }, bill: bills(), shiftHistory: hist }, closeBody(), OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.duplicate, false);
});

test("#9 ประวัติ id = doc id ของ shift เสมอ แม้ doc shift มี field id ไม่ตรง", async () => {
  const s = { ...openShift(), id: "old-id" };
  const { log } = await call({ shop: shop(), shift: { sh1: s }, bill: bills() }, closeBody(), OWNER);
  assert.equal(log.find((l) => l[0] === "set")[3].id, "sh1");
});

test("#5 ส่ง during ซ้ำหลังปิดกะ (รายการอยู่ในประวัติรอบนั้นแล้ว) = duplicate ไม่ใช่ 409", async () => {
  const s = { ...openShift(), status: false, duringShift: [] };
  const hist = { sh1_1794272400000: { id: "sh1", shopId: "shopA", closeRequestId: "c1", duringShift: [{ type: 1, amount: "50", entryId: "d0" }] } };
  const body = { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "d0", type: 1, amount: "50", comment: "" };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s }, shiftHistory: hist }, body, OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.duplicate, true);
  assert.deepEqual(log.filter((l) => l[0] !== "get"), []);
  const other = await call({ shop: shop(), shift: { sh1: s }, shiftHistory: hist }, { ...body, requestId: "d-new" }, OWNER);
  assert.equal(other.res.code, 409);
  assert.equal(other.res.body.error, "shift_not_open");
});

// ── ก้อน 4 รอบ 2 (Pack เคาะ 2026-11-06 · chunk4-case-additions.md) ──
const sets = (log, coll) => log.filter((l) => l[0] === "set" && l[1] === coll);

test("A-8 close: บิลไม่มีป้ายที่ขายก่อน openTime (รอบก่อน shiftId เดียวกัน) ไม่นับ · หลัง openTime นับ · บิลมีป้ายรอบนี้แต่นาฬิกาเครื่องช้านับ", async () => {
  const bill = {
    b1: bills().b1,
    old: { shopId: "shopA", shiftId: "sh1", dateTime: ts("2026-11-09T05:00:00.000Z"), moneyMustPaid: 999, product: [], payment: [{ id: 1, amount: 999 }] },
    legacy: { shopId: "shopA", shiftId: "sh1", dateTime: ts("2026-11-10T02:10:00.000Z"), moneyMustPaid: 20, product: [], payment: [{ id: 1, amount: 20 }] },
    // ป้ายรอบนี้ แต่ dateTime (= soldAt เครื่อง) ช้ากว่า openTime ของ server · ต้องได้จาก query ป้าย
    skew: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), dateTime: ts("2026-11-10T00:55:00.000Z"), moneyMustPaid: 5, product: [], payment: [{ id: 1, amount: 5 }] },
  };
  const { res } = await call({ shop: shop(), shift: { sh1: openShift() }, bill }, closeBody({ closeCash: "675", expectedCash: 675 }), OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.expectedCash, 675); // 500 + 50 + 100 + 20 + 5 · ไม่มี 999
  assert.equal(res.body.summary.billQty, 3);
});

test("A-8 roundDocs: 2 query (ป้าย · เวลา) รวมด้วย doc id ไม่ซ้ำ · paidHistory ใช้ timestamp", async () => {
  const asked = [];
  const mk = (coll, f = []) => ({ where: (a, op, v) => mk(coll, [...f, `${a}${op}`]), _f: f, _c: coll });
  const { db } = fakeDb({});
  const M = load({ ...db, collection: (c) => ({ where: (a, op) => mk(c, [`${a}${op}`]) }) });
  const docs = await M.roundDocs(async (q) => { asked.push(`${q._c}:${q._f.join("&")}`); return { docs: [{ id: "x" }, { id: q._f[1].startsWith("shiftOpenTime") ? "y" : "x" }] }; }, "paidHistory", "sh1", ts("2026-11-10T01:00:00.000Z"));
  assert.deepEqual(asked.sort(), ["paidHistory:shiftId==&shiftOpenTime==", "paidHistory:shiftId==&timestamp>="]);
  assert.deepEqual(docs.map((d) => d.id).sort(), ["x", "y"]);
});

test("A-9 แจ้งเตือนหมวด 2: during และ close รูปข้อความเดิม · ทีมงานติดรอย · ซ้ำไม่เขียน", async () => {
  const d = await call({ shop: shop(), shift: { sh1: openShift() } }, { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-company", staffName: "ทีมงาน", requestId: "d1", type: 2, amount: "20", comment: "ซื้อน้ำแข็ง" }, ADMIN);
  const n = sets(d.log, "notification");
  assert.equal(n.length, 1);
  assert.equal(n[0][2], "sh1_during_d1");
  assert.deepEqual({ h: n[0][3].heading, c: n[0][3].notificationContent, k: n[0][3].categoryId, b: n[0][3].byAdmin, u: n[0][3].adminUid },
    { h: "จัดการเงินระหว่างกะ (กะที่1)", c: "นำเงินออก\nจำนวนเงิน : 20 บาท\nเหตุผล: ซื้อน้ำแข็ง\nโดย ทีมงาน", k: 2, b: true, u: "u-company" });
  const c = await call({ shop: shop(), shift: { sh1: openShift() }, bill: bills() }, closeBody({ closeCash: "640", closeWithDraw: "100", expectedCash: 650 }), OWNER);
  const cn = sets(c.log, "notification");
  assert.equal(cn.length, 1);
  assert.equal(cn[0][3].heading, "ปิดกะที่ 1");
  assert.equal(cn[0][3].notificationContent, [
    "โดย เจ้าของ", "รายได้รวม : 100.00", "เงินสด : 100.00", "เงินสดเริ่มต้นเปิดกะ 500.00", "ยอดชำระเงินสด 100.00", "เงินสดรวมที่คาดไว้ 650.00",
    "เงินสดที่นับได้จริง 640.00", "ยอดเงินขาด/เกิน -10.00", "เงินสดที่ถอนออก 100.00", "ยอดเงินสดคงเหลือในเครื่อง 540.00",
    "ระหว่างกะ", "1. นำเงินเข้า 50.00 บาท", " โดย เจ้าของ, เหตุผล :  ", "เวลา 10/11/2026 08:30:00 น.",
  ].join("\n"));
  assert.equal("byAdmin" in cn[0][3], false);
});

test("B-11 open: พนักงาน inActive → 409 staff_inactive ไม่เขียน · active ผ่าน · inActive บันทึกเงินเข้าออก/ปิดกะได้", async () => {
  const sh = () => ({ shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", status: "active", position: ["001"] }, { id: "u-off", name: "ปิดแล้ว", status: "inActive" }] } });
  const closed = { ...openShift(), status: false, lastShiftDate: "20261109" };
  const open = (staffId) => ({ op: "open", shopId: "shopA", shiftId: "sh1", staffId, staffName: "", requestId: "r1", openCash: "0" });
  const off = await call({ shop: sh(), shift: { sh1: closed } }, open("u-off"), OWNER);
  assert.equal(off.res.code, 409);
  assert.equal(off.res.body.error, "staff_inactive");
  assert.deepEqual(off.log.filter((l) => l[0] !== "get"), []);
  assert.equal((await call({ shop: sh(), shift: { sh1: closed } }, open("u-owner"), OWNER)).res.code, 200);
  const dur = await call({ shop: sh(), shift: { sh1: openShift() } }, { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-off", staffName: "", requestId: "d9", type: 1, amount: "5", comment: "" }, OWNER);
  assert.equal(dur.res.code, 200, JSON.stringify(dur.res.body));
  const cl = await call({ shop: sh(), shift: { sh1: openShift() }, bill: bills() }, closeBody({ staffId: "u-off" }), OWNER);
  assert.equal(cl.res.code, 200, JSON.stringify(cl.res.body));
});

test("B-12 close เขียน entryIds · during ซ้ำช้าหลังเปิดรอบใหม่ = duplicate ไม่ต่อท้ายรอบใหม่ · ประวัติจุดขายอื่น/ร้านอื่นไม่นับ", async () => {
  const c = await call({ shop: shop(), shift: { sh1: openShift() }, bill: bills() }, closeBody(), OWNER);
  assert.deepEqual(sets(c.log, "shiftHistory")[0][3].entryIds, ["d0"]);
  const round2 = { ...openShift(), openTime: ts("2026-11-10T03:00:00.000Z"), duringShift: [], openRequestId: "r2" };
  const body = { op: "during", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "", requestId: "d0", type: 1, amount: "50", comment: "" };
  const hist = { sh1_1794272400000: { id: "sh1", shopId: "shopA", entryIds: ["d0"] } };
  const late = await call({ shop: shop(), shift: { sh1: round2 }, shiftHistory: hist }, body, OWNER, "2026-11-10T04:00:00.000Z");
  assert.equal(late.res.code, 200);
  assert.equal(late.res.body.duplicate, true);
  assert.deepEqual(late.log.filter((l) => l[0] !== "get"), []);
  for (const other of [{ sh2_1794272400000: { shopId: "shopA", entryIds: ["d0"] } }, { sh1_1794272400000: { shopId: "shopB", entryIds: ["d0"] } }]) {
    const r = await call({ shop: shop(), shift: { sh1: round2 }, shiftHistory: other }, body, OWNER, "2026-11-10T04:00:00.000Z");
    assert.equal(r.res.body.duplicate, false, JSON.stringify(other));
  }
});

test("C-2 close doc กะรุ่นก่อน มี.ค. 2025: ช่อง initialShift ที่ขาดเติมค่าเดิม · ช่องที่มีอยู่ไม่ถูกทับ", async () => {
  const { receiptNumber, posId, ...rest } = openShift(); // eslint-disable-line no-unused-vars
  const s = { ...rest, openComment: "มีค่าเดิม" };
  const { res, log } = await call({ shop: shop(), shift: { sh1: s }, bill: bills() }, closeBody(), OWNER);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const h = sets(log, "shiftHistory")[0][3];
  assert.deepEqual({ r: h.receiptNumber, p: h.posId, cb: h.closeBy, oc: h.openComment, od: h.openDiff, ow: h.openWithDraw, ob: h.openBy, cc: h.closeComment },
    { r: "", p: "", cb: "", oc: "มีค่าเดิม", od: "", ow: "", ob: "", cc: "" });
  assert.equal(h.openCash, "500");
});

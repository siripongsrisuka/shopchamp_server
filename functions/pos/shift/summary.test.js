// เทสข้างไฟล์ pos/shift/summary.js (DEV-0011 ข้อ ⑤) · รัน: node --test pos/shift/summary.test.js
//   พิสูจน์: เงินคาดของ summary = เงินคาดที่ close ใช้ (ฐานเดียวกัน · รวมเงินเซ็นที่รับเป็นเงินสด) · อ่านอย่างเดียว · จำนวน read
//            · ด่านร้าน (403 ข้ามร้าน · 409 กะร้านอื่น · 404 · 409 กะปิด · 401)
// ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime() }; };
const msOf = (v) => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : undefined);
const match = (dv, op, v) => {
  const a = msOf(dv), b = msOf(v);
  if (a !== undefined && b !== undefined) { dv = a; v = b; }
  if (op === "==") return dv === v;
  if (op === ">=") return dv !== undefined && dv >= v;
  if (op === "array-contains") return Array.isArray(dv) && dv.includes(v);
  throw new Error("fake where op " + op);
};

// ฐานปลอม · นับ read แบบ Firestore คิดเงิน (doc get = 1 · query = จำนวน doc ที่คืน ขั้นต่ำ 1) · เขียน = โยน
function fakeDb(seed) {
  const stat = { docGets: [], queries: [], reads: 0, writes: 0 };
  const snap = (c, id) => { const d = (seed[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const query = (c, filters) => ({
    where: (f, op, v) => query(c, [...filters, [f, op, v]]),
    limit: () => query(c, filters),
    get: async () => {
      const docs = Object.entries(seed[c] || {}).filter(([, d]) => filters.every(([f, op, v]) => match(d[f], op, v))).map(([id, d]) => ({ id, exists: true, data: () => d }));
      stat.queries.push({ c, filters: filters.map(([f, op]) => `${f}${op}`), n: docs.length });
      stat.reads += Math.max(1, docs.length);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const writeTrap = () => { stat.writes++; throw new Error("summary ห้ามเขียน"); };
  const db = {
    collection: (c) => ({
      doc: (id) => ({ _coll: c, id, get: async () => { stat.docGets.push(`${c}/${id}`); stat.reads++; return snap(c, id); }, set: writeTrap, update: writeTrap }),
      where: (f, op, v) => query(c, [[f, op, v]]),
    }),
    runTransaction: async (fn) => fn({
      get: async (ref) => ref.get(),
      set: () => { stat.writes++; },
      update: () => { stat.writes++; },
    }),
  };
  return { db, stat };
}

function load(db) {
  const fb = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  require.cache[fb] = { id: fb, filename: fb, loaded: true, exports: { db, admin: {} } };
  for (const m of ["./summary", "./manage"]) delete require.cache[require.resolve(m)];
  return { summary: require("./summary").summary, manage: require("./manage").manage };
}
const resOf = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const NOW = () => new Date("2026-11-17T05:00:00.000Z");

async function callSummary(seed, body, access) {
  const { db, stat } = fakeDb(seed);
  const { summary } = load(db);
  const res = resOf();
  await summary({ now: NOW })({ body, ...(access ? { shopAccess: access } : {}) }, res);
  return { res, stat };
}
async function callClose(seed, body, access) {
  const { db, stat } = fakeDb(seed);
  const { manage } = load(db);
  const res = resOf();
  await manage({ now: NOW })({ body, shopAccess: access }, res);
  return { res, stat };
}

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const CASHIER = { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100", "108"] };
const shop = () => ({
  shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", name: "เจ้าของ", status: "active" }, { id: "u-cash", name: "แคชเชียร์", status: "active", rights: ["100", "108"] }] },
  shopB: { shopId: "shopB", humanResource: [{ id: "u-b", name: "ร้านบี", status: "active" }] },
});
const OPEN_AT = "2026-11-17T01:00:00.000Z";
// ฉากของใบ: เปิดกะ 1,000 · ขายเงินสด 500 · รับชำระเงินเซ็นเป็นเงินสด 300 ในกะนี้ ⇒ server คาด 1,800
const openShift = () => ({ shopId: "shopA", posId: "p1", status: true, openTime: ts(OPEN_AT), openCash: "1000", duringShift: [], lastShiftDate: "20261117", shiftCount: 1 });
const bills = () => ({
  b1: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts(OPEN_AT), dateTime: ts("2026-11-17T02:00:00.000Z"), moneyMustPaid: 500, product: [{ id: "p1", qty: 1, net: 500, totalPrice: 500 }], payment: [{ id: 1, amount: 500, change: 0 }] },
  // ร้านอื่นที่ shiftId ชนกัน = ไม่นับ
  bx: { shopId: "shopB", shiftId: "sh1", shiftOpenTime: ts(OPEN_AT), dateTime: ts("2026-11-17T02:00:00.000Z"), moneyMustPaid: 7, product: [], payment: [{ id: 1, amount: 7 }] },
});
const paid = () => ({
  c1: { shopId: "shopA", shiftId: "sh1", shiftOpenTime: ts(OPEN_AT), paymentId: 1, paid: 300, timestamp: ts("2026-11-17T03:00:00.000Z") },
});
const seedApp = () => ({ shop: shop(), shift: { sh1: openShift() }, bill: bills(), paidHistory: paid() });
const BODY = { shopId: "shopA", shiftId: "sh1" };
const closeBody = (expectedCash) => ({ op: "close", shopId: "shopA", shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", requestId: "c-1", closeCash: "1800", closeWithDraw: "0", expectedCash });

test("summary: เงินคาดรวมเงินเซ็นที่รับเป็นเงินสด (1000+500+300 = 1800) · เท่ากับที่ close ใช้ปิด · close ด้วยยอดนี้ไม่เจอ 409", async () => {
  const s = await callSummary(seedApp(), BODY, OWNER);
  assert.equal(s.res.code, 200, JSON.stringify(s.res.body));
  assert.equal(s.res.body.ok, true);
  assert.equal(s.res.body.expectedCash, 1800);
  assert.equal(s.res.body.summary.expectedCash, 1800);
  assert.equal(s.res.body.summary.cashSales, 500);
  assert.equal(s.res.body.summary.creditCash, 300);
  assert.equal(s.res.body.summary.openCash, 1000);
  assert.equal(s.res.body.openTime, OPEN_AT);
  assert.equal(s.res.body.shiftId, "sh1");
  assert.equal("outside" in s.res.body.summary, false);

  const c = await callClose(seedApp(), closeBody(s.res.body.expectedCash), OWNER);
  assert.equal(c.res.code, 200, JSON.stringify(c.res.body));
  assert.equal(c.res.body.expectedCash, s.res.body.expectedCash);
  assert.equal(c.res.body.closeDiff, 0);

  // สูตรเดิมของจอ (ไม่มีเงินเซ็น) = 1,500 ⇒ server ปัด และยอดที่ตอบกลับ = ยอดเดียวกับ summary
  const stale = await callClose(seedApp(), closeBody(1500), OWNER);
  assert.equal(stale.res.code, 409);
  assert.equal(stale.res.body.expectedCash, s.res.body.expectedCash);
});

test("summary: เงินเข้าออกระหว่างกะ ตรงกับ close เสมอ (สูตรเดียว · ฉากสุ่มหลายชุด)", async () => {
  const sets = [
    [{ type: 1, amount: "200", entryId: "e1" }, { type: 2, amount: "50", entryId: "e2" }],
    [{ type: 2, amount: "0.35", entryId: "e1" }, { type: 2, amount: "0.35", entryId: "e1" }], // entryId ซ้ำนับครั้งเดียว (SC-46)
    [{ type: "เติมเงิน", amount: "10" }, { type: "ถอนเงิน", amount: "3.5" }], // แถวรุ่นเก่า
  ];
  for (const during of sets) {
    const seed = () => ({ ...seedApp(), shift: { sh1: { ...openShift(), duringShift: during } } });
    const s = await callSummary(seed(), BODY, OWNER);
    assert.equal(s.res.code, 200);
    const c = await callClose(seed(), closeBody(s.res.body.expectedCash), OWNER);
    assert.equal(c.res.code, 200, `${JSON.stringify(during)} → ${JSON.stringify(c.res.body)}`);
    assert.equal(c.res.body.expectedCash, s.res.body.expectedCash);
  }
});

test("summary: อ่านอย่างเดียว · ไม่เขียน · ไม่ใช้ transaction · read = shop 1 + shift 1 + bill 2 query + paidHistory 2 query", async () => {
  const { res, stat } = await callSummary(seedApp(), BODY, OWNER);
  assert.equal(res.code, 200);
  assert.equal(stat.writes, 0);
  assert.deepEqual(stat.docGets.sort(), ["shift/sh1", "shop/shopA"]);
  assert.deepEqual(stat.queries.map((q) => `${q.c}:${q.filters.join("&")}`).sort(), [
    "bill:shiftId==&dateTime>=", "bill:shiftId==&shiftOpenTime==",
    "paidHistory:shiftId==&shiftOpenTime==", "paidHistory:shiftId==&timestamp>=",
  ]);
  // บิล 2 ใบ (1 ใบร้านอื่นตัดทิ้งหลังอ่าน) ติดทั้ง 2 query = 4 · ใบรับชำระ 1 ใบ ติด 2 query = 2 · doc 2 ⇒ 8
  assert.equal(stat.reads, 8);
});

test("summary: แคชเชียร์ทั่วไป (ไม่มีเลขสิทธิ์กะ) อ่านได้แบบ shift.get", async () => {
  const { res } = await callSummary(seedApp(), BODY, CASHIER);
  assert.equal(res.code, 200);
  assert.equal(res.body.expectedCash, 1800);
});

test("🔒 summary: ข้ามร้าน → 403 wrong_shop ก่อนอ่านฐาน · กะของร้านอื่น → 409 ไม่อ่านบิล · ไม่มีกะ 404 · ไม่มี token 401", async () => {
  const cross = await callSummary(seedApp(), { shopId: "shopB", shiftId: "sh1" }, OWNER);
  assert.equal(cross.res.code, 403);
  assert.equal(cross.res.body.error, "wrong_shop");
  assert.equal(cross.stat.reads, 0);
  assert.equal("expectedCash" in cross.res.body, false);

  const seedB = { ...seedApp(), shift: { shB: { ...openShift(), shopId: "shopB" } } };
  const other = await callSummary(seedB, { shopId: "shopA", shiftId: "shB" }, OWNER);
  assert.equal(other.res.code, 409);
  assert.equal(other.res.body.error, "shift_other_shop");
  assert.equal(other.stat.queries.length, 0);
  assert.equal("expectedCash" in other.res.body, false);

  const none = await callSummary(seedApp(), { shopId: "shopA", shiftId: "nope" }, OWNER);
  assert.equal(none.res.code, 404);
  assert.equal(none.res.body.error, "shift_not_found");

  const noAuth = await callSummary(seedApp(), BODY, null);
  assert.equal(noAuth.res.code, 401);
  assert.equal(noAuth.stat.reads, 0);
});

test("summary: คนนอกร้าน (shopAccess ปลอมเป็น staff) → 403 not_shop_member ไม่คืนยอด", async () => {
  const { res, stat } = await callSummary(seedApp(), BODY, { shopId: "shopA", uid: "u-other", role: "staff", rights: [] });
  assert.equal(res.code, 403);
  assert.equal(res.body.error, "not_shop_member");
  assert.equal(stat.queries.length, 0);
});

test("summary: กะปิดอยู่ → 409 shift_not_open · openTime อ่านไม่ได้ → 409 shift_open_time_bad · ไม่อ่านบิล", async () => {
  const closed = await callSummary({ ...seedApp(), shift: { sh1: { ...openShift(), status: false } } }, BODY, OWNER);
  assert.equal(closed.res.code, 409);
  assert.equal(closed.res.body.error, "shift_not_open");
  assert.equal(closed.stat.queries.length, 0);
  const bad = await callSummary({ ...seedApp(), shift: { sh1: { ...openShift(), openTime: "" } } }, BODY, OWNER);
  assert.equal(bad.res.code, 409);
  assert.equal(bad.res.body.error, "shift_open_time_bad");
  assert.equal(bad.stat.queries.length, 0);
});

test("summary: ไม่ส่ง shiftId → 400", async () => {
  const { res } = await callSummary(seedApp(), { shopId: "shopA" }, OWNER);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, "invalid_request");
});

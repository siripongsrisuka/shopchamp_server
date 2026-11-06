// เทส member/payCredit.js · รัน: node --test functions/pos/member/payCredit.test.js
//   harness ของสัญญาวัดได้แค่คำตอบ (เขียน = no-op) ⇒ ของที่เขียนลงฐาน · ลำดับด่าน · ส่งซ้ำไม่ตัดหนี้ซ้ำ พิสูจน์ที่นี่
//   ที่มาของแต่ละเทส: lanes/dev/source/chunk4-verify/member.payCredit.md (W1–W3 · G1–G4)
//   ฐานปลอม: บันทึกทุกการเขียน · ปัดการอ่านหลังเขียนใน transaction เดียว · commit แล้วค่าเปลี่ยนจริง
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const logic = require("@shopchamp/logic");

const NOW = new Date("2026-11-10T18:00:00.000Z"); // วันไทย 20261111
const UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

let DATA = {};
let LOG = [];
function makeDb() {
  let auto = 0;
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  // อ่านนอก transaction (auth.resolveShopRef พิสูจน์ field ของร้าน S5): doc.get · where(==).limit().get
  const ref = (c, id) => ({ c, id, get: async () => snapOf(c, id) });
  const where = (c, f, v) => ({
    limit: (n) => ({ get: async () => ({ docs: Object.keys(DATA[c] || {}).filter((id) => DATA[c][id][f] === v).slice(0, n).map((id) => snapOf(c, id)) }) }),
  });
  return {
    collection: (c) => ({ doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`), where: (f, op, v) => where(c, f, v) }),
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
const P = require("./payCredit");

const handler = P.payCredit({ now: () => NOW });
async function call(body, shopAccess) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };
const STAFF = (rights) => ({ shopId: "shopA", uid: "u-staff", role: "staff", rights });
const body = (x) => ({ shopId: "shopA", memberId: "m1", amount: 100, paymentId: 1, shiftId: "sh1", staffId: "u-owner", staffName: "เจ้าของ", payUUID: UUID, ...x });

function seed(mut) {
  DATA = {
    shop: { shopA: { shopId: "shopA", humanResource: [
      { id: "u-owner", position: ["001"], status: "active" },
      { id: "u-staff", position: ["002"], status: "active", rights: ["124"] },
    ], shopchampPayment: [{ id: 1, name: "เงินสด" }, { id: "c-uuid-1", name: "โอนเข้าบัญชี" }] } },
    member: { m1: { shopId: "shopA", name: "ลูกค้าเอ", credit: 0, creditArray: [{ billId: "b1", receiptNumber: "202611000005", totalCredit: 300, remainCredit: 300 }] } },
    shift: { sh1: { shopId: "shopA", status: true, openTime: "OPEN-T" } },
    paidHistory: {},
  };
  if (mut) mut(DATA);
  LOG = [];
}
const writesTo = (c) => LOG.filter((w) => w.c === c);

// ── W1 สิทธิ์ '124' ─────────────────────────────────────────────────────────────
test("W1 พนักงานไม่มีสิทธิ์ 124 → 403 right_required · ไม่เขียนอะไร", async () => {
  seed();
  const r = await call(body({ staffId: "u-staff" }), STAFF([]));
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "right_required");
  assert.equal(LOG.length, 0);
  assert.equal(DATA.member.m1.creditArray[0].remainCredit, 300);
});

test("W1 พนักงานมีสิทธิ์ 124 → 200 · เจ้าของ/ทีมงานผ่านโดยไม่ต้องมี rights", async () => {
  seed();
  assert.equal((await call(body({ staffId: "u-staff" }), STAFF(["124"]))).code, 200);
  seed();
  assert.equal((await call(body(), OWNER)).code, 200);
  seed();
  assert.equal((await call(body({ staffId: "u-company" }), ADMIN)).code, 200);
});

// ── W2 paymentId สตริงตัวเลข ────────────────────────────────────────────────────
for (const pid of ["3", "03", " 3", "3 ", "01"]) {
  test(`W2 paymentId ${JSON.stringify(pid)} → 400 invalid_request · ไม่เขียน`, async () => {
    seed();
    const r = await call(body({ paymentId: pid }), OWNER);
    assert.equal(r.code, 400);
    assert.equal(r.body.error, "invalid_request");
    assert.equal(LOG.length, 0);
  });
}

test("W2 paymentId \"1\" เขียนเป็นเลข 1 ⇒ กะนับเป็นเงินสด", async () => {
  seed();
  const r = await call(body({ paymentId: "1" }), OWNER);
  assert.equal(r.code, 200);
  const ph = DATA.paidHistory[UUID];
  assert.equal(ph.paymentId, 1);
  assert.equal(logic.isCashChannel(ph.paymentId), true);
  assert.equal(ph.paymentName, "เงินสด");
});

test("W2 ช่องที่ร้านเพิ่มเอง (uuid สตริง) เขียนตามเดิม", async () => {
  seed();
  const r = await call(body({ paymentId: "c-uuid-1" }), OWNER);
  assert.equal(r.code, 200);
  assert.equal(DATA.paidHistory[UUID].paymentId, "c-uuid-1");
  assert.equal(DATA.paidHistory[UUID].paymentName, "โอนเข้าบัญชี");
});

// ── W3 remainCredit สตริงมีคอมมา ───────────────────────────────────────────────
test("W3 remainCredit \"1,000\" จ่าย 100 → cutBills มีบิลนั้น 100 ทั้งคำตอบและ paidHistory", async () => {
  seed((d) => { d.member.m1.creditArray = [{ billId: "b1", totalCredit: 1000, remainCredit: "1,000" }]; });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.existCredit, 900);
  assert.deepEqual(r.body.cutBills, [{ billId: "b1", amount: 100 }]);
  assert.deepEqual(DATA.paidHistory[UUID].cutBills, [{ billId: "b1", amount: 100 }]);
});

// ── G1 ของที่เขียนลงฐาน ────────────────────────────────────────────────────────
test("G1 เขียน member · paidHistory · notification ครบรูป (shopId = field ของร้าน)", async () => {
  seed((d) => {
    d.shop.shopA.shopId = "SF-A";
    d.member.m1.shopId = "SF-A";
    d.member.m1.credit = 50;
    d.member.m1.creditArray.push("junk");
  });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cutBills, [{ billId: "b1", receiptNumber: "202611000005", amount: 50 }]);

  const mu = writesTo("member");
  assert.equal(mu.length, 1);
  assert.equal(mu[0].op, "update");
  assert.deepEqual(Object.keys(mu[0].v).sort(), ["credit", "creditArray"]);
  assert.equal(DATA.member.m1.credit, 0);
  assert.deepEqual(DATA.member.m1.creditArray, [{ billId: "b1", receiptNumber: "202611000005", totalCredit: 300, remainCredit: 250 }]);

  const ph = writesTo("paidHistory");
  assert.equal(ph.length, 1);
  assert.equal(ph[0].id, UUID);
  assert.deepEqual(ph[0].v, {
    shopId: "SF-A", paid: 100, existCredit: 250, memberId: "m1", timestamp: NOW, billDate: "20261111",
    receiptUUID: UUID, shiftId: "sh1", shiftOpenTime: "OPEN-T", staffId: "u-owner", staffName: "เจ้าของ",
    paymentId: 1, paymentName: "เงินสด", cutBills: [{ billId: "b1", receiptNumber: "202611000005", amount: 50 }],
  });
  assert.equal(typeof ph[0].v.paid, "number");

  const no = writesTo("notification");
  assert.equal(no.length, 1);
  assert.equal(no[0].v.heading, "ลูกค้าชำระเงินเซ็น");
  assert.equal(no[0].v.shopId, "SF-A");
  assert.equal(no[0].v.categoryId, 4);
  assert.deepEqual(no[0].v.timestamp, NOW);
  assert.equal(no[0].v.byAdmin, undefined);
  assert.equal(LOG.length, 3);
});

test("G1 ทีมงาน: paidHistory และ notification ติด byAdmin+adminUid · member ไม่ติด", async () => {
  seed();
  const r = await call(body({ staffId: "u-company" }), ADMIN);
  assert.equal(r.code, 200);
  assert.equal(r.body.byAdmin, true);
  const [ph] = writesTo("paidHistory");
  const [no] = writesTo("notification");
  const [mu] = writesTo("member");
  assert.equal(ph.v.byAdmin, true);
  assert.equal(ph.v.adminUid, "u-company");
  assert.equal(no.v.byAdmin, true);
  assert.equal(no.v.adminUid, "u-company");
  assert.equal(mu.v.byAdmin, undefined);
  assert.equal(mu.v.adminUid, undefined);
});

// ── G2 ส่งซ้ำไม่ตัดหนี้ซ้ำ ──────────────────────────────────────────────────────
test("G2 ส่งซ้ำ 2 รอบ: รอบ 2 ได้ duplicate · ไม่เขียนอะไรเพิ่ม · หนี้ตัดครั้งเดียว", async () => {
  seed();
  const a = await call(body(), OWNER);
  assert.equal(a.code, 200);
  assert.equal(a.body.duplicate, false);
  const n = LOG.length;
  const b = await call(body(), OWNER);
  assert.equal(b.code, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(LOG.length, n);
  assert.equal(DATA.member.m1.creditArray[0].remainCredit, 200);
});

// ── G3 เช็ก payUUID ซ้ำก่อนเช็กกะ ───────────────────────────────────────────────
test("G3 payUUID เดิม + กะปิดแล้ว → 200 duplicate (ไม่ใช่ 409 shift_not_open)", async () => {
  seed((d) => {
    d.shift.sh1.status = false;
    d.paidHistory[UUID] = { shopId: "shopA", memberId: "m1", paid: 100 };
  });
  const r = await call(body(), OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(LOG.length, 0);
});

// ── G4 ทีมงานใส่ staffId ของคนอื่น ──────────────────────────────────────────────
test("G4 ทีมงานใส่ staffId ที่ไม่อยู่ในร้านและไม่ใช่ uid ตัวเอง → 409 staff_not_in_shop", async () => {
  seed();
  const r = await call(body({ staffId: "u-someone" }), ADMIN);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "staff_not_in_shop");
  assert.equal(LOG.length, 0);
});

// ── ตัวช่วย pure ──────────────────────────────────────────────────────────────
test("paymentIdOf", () => {
  assert.deepEqual(P.paymentIdOf(1), { ok: true, id: 1 });
  assert.deepEqual(P.paymentIdOf("1"), { ok: true, id: 1 });
  assert.deepEqual(P.paymentIdOf("12"), { ok: true, id: 12 });
  assert.deepEqual(P.paymentIdOf("abc-1"), { ok: true, id: "abc-1" });
  assert.deepEqual(P.paymentIdOf("3"), { ok: false });
  assert.deepEqual(P.paymentIdOf("03"), { ok: false });
  assert.deepEqual(P.paymentIdOf(" 1"), { ok: false });
});

// ── chunk4 รอบ 2: B-11 (Pack เคาะ) · B-13 (agent เลือก) ─────────────────────────
test("B-11 staffId อยู่ในร้านแต่ inActive → 409 staff_inactive · ไม่เขียน · active → 200", async () => {
  seed((d) => { d.shop.shopA.humanResource[1].status = "inActive"; });
  const r = await call(body({ staffId: "u-staff", staffName: "พนักงาน" }), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "staff_inactive");
  assert.equal(LOG.length, 0);
  seed();
  assert.equal((await call(body({ staffId: "u-staff", staffName: "พนักงาน" }), OWNER)).code, 200);
  seed();
  assert.equal((await call(body({ staffId: "u-ghost" }), OWNER)).body.error, "staff_not_in_shop"); // ไม่อยู่ในร้านยังเป็นรหัสเดิม
});

test("B-13 payUUID เดิมคนละสมาชิก/คนละยอด → 409 pay_uuid_mismatch ไม่เขียน · ตรงกัน (ยอดเป็นข้อความ) → duplicate", async () => {
  for (const [prev, code, err] of [
    [{ memberId: "m9", paid: 100 }, 409, "pay_uuid_mismatch"],
    [{ memberId: "m1", paid: 50 }, 409, "pay_uuid_mismatch"],
    [{ memberId: "m1", paid: "100.00" }, 200, undefined],
    [{ memberId: "m1", paid: 100 }, 200, undefined],
  ]) {
    seed((d) => { d.paidHistory[UUID] = { shopId: "shopA", ...prev }; });
    const r = await call(body(), OWNER);
    assert.equal(r.code, code, JSON.stringify(prev));
    if (err) assert.equal(r.body.error, err);
    else assert.equal(r.body.duplicate, true);
    assert.equal(LOG.length, 0);
  }
  assert.equal(P.sameRequest({ memberId: "m1", paid: "1,000" }, { memberId: "m1", amount: 1000 }), true);
  assert.equal(P.sameRequest({ memberId: "m1", paid: 100.01 }, { memberId: "m1", amount: 100 }), false);
});

// ── ก้อน 5 ข้อ ①: ร้านไม่ใช้ระบบกะ รับชำระได้แบบแอปเก่า (main3 src/Modal/Modal_CreditMember.js:40-112 ไม่ดูกะ) ──
test("ข้อ ① · ร้านไม่มี shop.shift + กะประจำจุดปิด ⇒ 200 · paidHistory shiftId sh1 shiftOpenTime null · ไม่แตะ shift", async () => {
  seed((d) => { d.shift.sh1 = { shopId: "shopA", status: false, openTime: "" }; });
  const r = await call(body({}), OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const [ph] = writesTo("paidHistory");
  assert.equal(ph.v.shiftId, "sh1");
  assert.equal(ph.v.shiftOpenTime, null);
  assert.equal(writesTo("shift").length, 0);
});

test("ข้อ ① · ร้านไม่ใช้กะ ไม่ส่ง shiftId ⇒ 200 · paidHistory.shiftId null", async () => {
  seed((d) => { d.shop.shopA.shift = false; });
  const { shiftId, ...b0 } = body({});
  const r = await call(b0, OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const [ph] = writesTo("paidHistory");
  assert.equal(ph.v.shiftId, null);
  assert.equal(ph.v.shiftOpenTime, null);
});

test("ข้อ ① คู่ควบคุม · ร้านใช้กะ กะปิด ⇒ 409 shift_not_open · ไม่เขียน", async () => {
  seed((d) => { d.shop.shopA.shift = true; d.shift.sh1.status = false; });
  const r = await call(body({}), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "shift_not_open");
  assert.equal(LOG.length, 0);
});

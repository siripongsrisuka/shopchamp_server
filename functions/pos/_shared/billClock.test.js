// เทส billClock.js · รัน: node --test functions/pos/_shared/
//
// ⚖️ คู่เทียบกับสูตรแอปเดิม (lanes/dev/source/compare/old-logic/docNumber.js · คัดลอกคำต่อคำจากแอป):
//   สูตรเดิมอ่าน `new Date()` และ getter ของเครื่อง ⇒ รันใต้ TZ=Asia/Bangkok (= เครื่องร้าน) โดยตรึงนาฬิกา
//   ของใหม่รันใต้ TZ=UTC (= server) ⇒ ถ้าของใหม่แอบใช้โซนเครื่อง เลขจะเพี้ยนที่เวลาใกล้เที่ยงคืนไทย
//   ชุดควบคุม: สูตรเดิมรันใต้ UTC ต้องได้ผลต่างจากของใหม่ที่เวลาชุดเดียวกัน (พิสูจน์ว่าเวลาที่เลือกจับความต่างโซนได้จริง)
// ไฟล์เทียบอยู่นอก repo นี้ (บ้าน ~/shopchamp-workspace) · ไม่พบ = ตก (ไม่ข้ามเงียบ) · clone เดี่ยวตั้ง SHOPCHAMP_NO_WORKSPACE=1
"use strict";
process.env.TZ = "UTC";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("./billClock");

const OLD = path.resolve(__dirname, "../../../../lanes/dev/source/compare/old-logic/docNumber.js");
const RealDate = Date;

function withClock(ms, tz, fn) {
  const prevTz = process.env.TZ;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(ms); else super(...a); }
    static now() { return ms; }
  }
  process.env.TZ = tz;
  global.Date = FakeDate;
  try { return fn(); } finally { global.Date = RealDate; process.env.TZ = prevTz; }
}
function fakeTx(stored) {
  const tx = { doc: stored ? { ...stored } : null, set(_r, d) { tx.doc = { ...d }; }, update(_r, d) { tx.doc = { ...(tx.doc || {}), ...d }; } };
  return tx;
}
const docOf = (s) => ({ exists: s !== null && s !== undefined, data: () => s });
function runOld(old, receiptType, stored, ms, tz) {
  const tx = fakeTx(stored);
  const r = withClock(ms, tz, () => old.checkoutCounter({ transaction: tx, billIdDoc: docOf(stored), billIdRef: "ref", receiptType }));
  return { receiptNumber: r.trueReceiptNumber, after: tx.doc };
}

// เวลาทดสอบ: ขอบเที่ยงคืนไทย ขอบเดือน ขอบปี + สุ่มแบบกำหนด seed
function instants() {
  const fixed = [
    "2026-11-10T03:00:00.000Z", // 10:00 ไทย
    "2026-11-30T16:59:59.999Z", // 23:59:59 ไทย 30 พ.ย.
    "2026-11-30T17:00:00.000Z", // 00:00 ไทย 1 ธ.ค. (UTC ยัง 30 พ.ย.)
    "2026-11-30T23:30:00.000Z", // 06:30 ไทย 1 ธ.ค.
    "2026-12-31T17:30:00.000Z", // 00:30 ไทย 1 ม.ค. 2027
    "2027-02-28T18:00:00.000Z", // 01:00 ไทย 1 มี.ค.
    "2028-02-28T17:10:00.000Z", // 00:10 ไทย 29 ก.พ. (ปีอธิกสุรทิน)
  ].map((s) => RealDate.parse(s));
  let s = 20261106 >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const from = RealDate.parse("2025-01-01T00:00:00Z"), to = RealDate.parse("2028-12-31T00:00:00Z");
  for (let i = 0; i < 300; i++) fixed.push(Math.floor(from + rnd() * (to - from)));
  return fixed;
}
// doc ตัวนับที่แอปเก่าเขียน (ยังไม่มี serverKey) ให้ครบ 3 กรณี: ไม่มี doc · รอบเดียวกัน · รอบอื่น
function storedCases(type, ms) {
  const bkk = new RealDate(ms + 7 * 3600e3);
  const field = type === "month" ? "month" : "date";
  const cur = type === "month" ? bkk.getUTCMonth() + 1 : bkk.getUTCDate();
  const other = (cur % (type === "month" ? 12 : 28)) + 1;
  return [null, { [field]: cur, receipts: 41 }, { [field]: other, receipts: 41 }, { [field]: cur, receipts: 999999 }];
}

test("คู่เทียบสูตรเดิม: เลขบิลและค่าที่เขียนกลับตรงกันทุกไบต์ (server UTC · ร้าน Asia/Bangkok)", (t) => {
  if (!fs.existsSync(OLD)) {
    if (process.env.SHOPCHAMP_NO_WORKSPACE === "1") return t.skip("ไม่มีไฟล์สูตรเดิม (clone เดี่ยว)");
    assert.fail(`ไม่พบสูตรเดิมที่ ${OLD}`);
  }
  const old = require(OLD);
  let n = 0;
  for (const ms of instants()) {
    for (const [pattern, type] of [["month", "month"], [undefined, "month"], ["day", "day"]]) {
      for (const stored of storedCases(type, ms)) {
        const o = runOld(old, type, stored, ms, "Asia/Bangkok");
        const r = C.nextBillNumber({ receiptPattern: pattern, stored, now: new RealDate(ms) });
        const at = new RealDate(ms).toISOString();
        assert.equal(r.ok, true, at);
        assert.equal(r.receiptNumber, o.receiptNumber, `${at} ${type} ${JSON.stringify(stored)}`);
        const f = type === "month" ? "month" : "date";
        assert.equal(r.write[f], o.after[f], `${at} field`);
        assert.equal(r.write.receipts, o.after.receipts, `${at} receipts`);
        assert.equal(r.collection, type === "month" ? "billId" : "billDayId");
        n++;
      }
    }
  }
  assert.ok(n > 3000, `เทียบ ${n} คู่`);
});

test("ชุดควบคุม: สูตรเดิมใต้โซน UTC ได้เลขต่างจากของใหม่ที่ขอบเที่ยงคืนไทย (เวลาที่เลือกจับความต่างโซนได้)", (t) => {
  if (!fs.existsSync(OLD)) return t.skip("ไม่มีไฟล์สูตรเดิม");
  const old = require(OLD);
  const ms = RealDate.parse("2026-11-30T17:00:00.000Z");
  const wrong = runOld(old, "month", null, ms, "UTC");
  const ours = C.nextBillNumber({ receiptPattern: "month", stored: null, now: new RealDate(ms) });
  assert.equal(wrong.receiptNumber, "202611000001");
  assert.equal(ours.receiptNumber, "202612000001");
});

test("ตัวอย่างตามสัญญา sale.create: 41 → 202611000042 · รายวัน 5 → 20261110000006", () => {
  const now = new Date("2026-11-10T03:00:00.000Z");
  assert.equal(C.nextBillNumber({ receiptPattern: "month", stored: { month: 11, receipts: 41 }, now }).receiptNumber, "202611000042");
  const d = C.nextBillNumber({ receiptPattern: "day", stored: { date: 10, receipts: 5 }, now });
  assert.equal(d.receiptNumber, "20261110000006");
  assert.equal(d.collection, "billDayId");
  assert.deepEqual(d.write, { date: 10, receipts: 6, serverKey: 20261110, serverRun: 6 });
});

test("โซนบังคับ: ไม่รับโซนจากผู้เรียก (ส่ง tz มาก็ไม่มีผล)", () => {
  const now = new Date("2026-11-30T17:00:00.000Z");
  const r = C.nextBillNumber({ receiptPattern: "month", stored: null, now, tz: "UTC" });
  assert.equal(r.receiptNumber, "202612000001");
});

test("ปัด: now ไม่ใช่ Date / Date เพี้ยน = now-invalid · counter เสีย = counter-broken (ไม่ออกเลข)", () => {
  for (const now of [undefined, 1794279600000, "2026-11-10T03:00:00Z", new Date("x")]) {
    const r = C.nextBillNumber({ receiptPattern: "month", stored: null, now });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "now-invalid");
  }
  const broken = C.nextBillNumber({ receiptPattern: "month", stored: { month: 11, receipts: "abc" }, now: new Date("2026-11-10T03:00:00Z") });
  assert.deepEqual(broken, { ok: false, reason: "counter-broken" });
  const healed = C.nextBillNumber({ receiptPattern: "month", stored: { month: 11, receipts: "abc" }, now: new Date("2026-11-10T03:00:00Z"), floorRun: 41 });
  assert.equal(healed.receiptNumber, "202611000042");
});

test("billDateOf: วันปฏิทินไทยของเวลาขาย (ไม่ใช่วันธุรกิจ · ไม่ใช่วันของ UTC)", () => {
  assert.equal(C.billDateOf(new Date("2026-11-06T04:00:00.000Z")), "20261106");
  assert.equal(C.billDateOf(new Date("2026-11-30T16:59:59.999Z")), "20261130");
  assert.equal(C.billDateOf(new Date("2026-11-30T17:00:00.000Z")), "20261201");
  assert.equal(C.billDateOf({ toMillis: () => RealDate.parse("2026-11-10T03:00:00Z") }), "20261110");
  assert.equal(C.billDateOf({ seconds: 1794279600, nanoseconds: 0 }), "20261110");
  for (const bad of [undefined, null, "x", {}, NaN]) assert.equal(C.billDateOf(bad), null);
});

test("receiptTypeOf / billReceiptTypeOf / counterCollectionOf ตามแอปเดิม", () => {
  assert.equal(C.receiptTypeOf("month"), "month");
  assert.equal(C.receiptTypeOf(undefined), "month");
  assert.equal(C.receiptTypeOf("day"), "day");
  assert.equal(C.receiptTypeOf("date"), "day"); // ค่าอื่นทุกค่า = รายวัน (CheckoutScreen.js:544-546)
  assert.equal(C.billReceiptTypeOf(undefined), "month");
  assert.equal(C.billReceiptTypeOf("day"), "day");
  assert.equal(C.counterCollectionOf(undefined), "billId");
  assert.equal(C.counterCollectionOf("day"), "billDayId");
});

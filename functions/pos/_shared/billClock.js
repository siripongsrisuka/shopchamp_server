// pos/_shared/billClock.js — นาฬิกาของเลขบิลและวันของบิลฝั่ง server (ก้อน 4 · DEV-0001)
//
// ยกท่าจากพี่น้อง (`claude/_shared/billClock.js` บังคับ tz) · สูตรจริงอยู่ที่ @shopchamp/logic docNumber (แหล่งเดียว)
//   ไฟล์นี้แค่ ① บังคับโซน Asia/Bangkok ทุกครั้ง (ไม่รับโซนจากผู้เรียก · server รัน UTC)
//            ② เลือก collection ตัวนับตาม shop.receiptPattern แบบแอปเดิม
//            ③ วันของบิล (billDate) = วันปฏิทินไทยของเวลาขาย (ไม่ใช่วันธุรกิจ · ความหมายเดิม)
//
// 2 เข็มนาฬิกา (สัญญา sale.create · offline-pattern-from-sibling.md §4.3):
//   เลขบิล = เวลา server เสมอ (#19 · S-14 คงเดิม: ขายวันที่ 6 ซิงก์วันที่ 10 ได้หัวเลขวันที่ 10)
//   billDate = soldAt (บิลออฟไลน์หลัง clamp) หรือ now (บิลปกติ)
//   ❌ ห้ามส่ง soldAt เข้า nextBillNumber — ป้อนวันย้อนหลัง = ตัวนับรีเซ็ตเป็น 1 = เลขซ้ำทั้งร้าน
//
// เทียบสูตรเก่า: billClock.test.js รันสูตรแอปเดิม (lanes/dev/source/compare/old-logic/docNumber.js) ใต้ TZ=Asia/Bangkok
//   แล้วเทียบกับไฟล์นี้ที่รันใต้ TZ=UTC ⇒ เลขเท่ากันทุกไบต์ทั้งรายเดือนและรายวัน
"use strict";

const logic = require("@shopchamp/logic");

const SHOP_TZ = "Asia/Bangkok"; // ร้าน Shopchamp อยู่ไทยทั้งหมด · ไม่มี field โซนในฐาน

/** รูปแบบเลขของร้าน: 'month' และไม่ส่ง = รายเดือน · ค่าอื่นทุกค่า = รายวัน (แอปเดิม CheckoutScreen.js:544-546) */
function receiptTypeOf(receiptPattern) {
  return receiptPattern === undefined || receiptPattern === null || receiptPattern === "month" ? "month" : "day";
}

/** ค่า bill.receiptType ที่เขียนลงบิล = shop.receiptPattern ถ้ามี ไม่งั้น 'month' (สัญญา sale.create) */
function billReceiptTypeOf(receiptPattern) {
  return typeof receiptPattern === "string" && receiptPattern ? receiptPattern : "month";
}

/** collection ตัวนับ: รายเดือน billId · รายวัน billDayId (doc id = shop doc id · doc เดิมที่แอปเก่าใช้) */
function counterCollectionOf(receiptPattern) {
  return receiptTypeOf(receiptPattern) === "month" ? "billId" : "billDayId";
}

/** วันปฏิทินไทยเป็นเลข YYYYMMDD · null เมื่ออ่านเวลาไม่ได้ · รับ Date ms Timestamp ISO-มีโซน */
function thaiYmd(instant) {
  const ms = logic.toMillis(instant);
  if (ms === null) return null;
  const p = logic.periodOf("day", ms, SHOP_TZ);
  return p.ok ? p.key : null;
}

/** billDate 'YYYYMMDD' (รูปเดียวกับที่แอปเก่าเขียน · เว็บค้นด้วยค่านี้) · null เมื่ออ่านเวลาไม่ได้ */
function billDateOf(instant) {
  const k = thaiYmd(instant);
  return k === null ? null : String(k);
}

/**
 * nextBillNumber — เลขบิลถัดไปจาก doc ตัวนับที่อ่านใน transaction · โซนบังคับ Asia/Bangkok
 * @param {object} p
 * @param {string} [p.receiptPattern] shop.receiptPattern
 * @param {object|null} p.stored `doc.data()` ของ billId/billDayId (ไม่มี doc = null)
 * @param {Date} p.now เวลา server (จาก readNow) · ❌ ไม่ใช่ soldAt
 * @param {number} [p.floorRun] ลำดับสูงสุดจากบิลของรอบนี้ (ส่งเมื่อได้ counter-broken)
 * @returns ผลของ logic.nextCounter + `collection` · ok:true → {receiptNumber, write, collection, ...}
 *   ผู้เรียกเขียน `write` ลง `<collection>/{shopDocId}` ด้วย merge:true ใน transaction เดียวกับบิล
 *   ok:false reason 'counter-broken' = หา floorRun แล้วเรียกใหม่ · 'now-invalid' | 'counter-invalid' = 500 counter_failed
 */
function nextBillNumber({ receiptPattern, stored, now, floorRun } = {}) {
  if (!(now instanceof Date)) return { ok: false, reason: "now-invalid" };
  const type = receiptTypeOf(receiptPattern);
  const r = logic.nextCounter({ receiptPattern: type, stored, now, tz: SHOP_TZ, floorRun });
  return r.ok ? { ...r, collection: counterCollectionOf(receiptPattern) } : r;
}

module.exports = { SHOP_TZ, receiptTypeOf, billReceiptTypeOf, counterCollectionOf, thaiYmd, billDateOf, nextBillNumber };

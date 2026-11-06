// pos/_shared/premium.js — แพ็กเกจของร้าน (shop.vip) ตัดสินที่ server (ก้อน 4 · DEV-0001)
//
// กติกาเดิมของแอป (`shopchamp_app/src/redux/shopSlice.js:47-51`):
//   newVip.forEach(({type, expire}) => { if (enableTypes.hasOwnProperty(type) && NumberYMD(formatTime(expire)) >= currentDate) enableTypes[type] = true })
//   ⇒ ① ใช้ได้เมื่อ "วันที่" ของ expire ≥ วันนี้ (ทั้งวันหมดอายุยังใช้ได้ · เทียบระดับวัน ไม่ใช่เวลา)
//     ② ถ้ามีหลายแถวชนิดเดียวกัน แถวไหนยังไม่หมดก็พอ (forEach + ตั้ง true อย่างเดียว)
//     ③ วันที่คิดตามนาฬิกาเครื่อง (ร้านอยู่ไทย) ⇒ server คิดบนผนังนาฬิกาไทยเสมอ (ไม่ใช้โซนของ server ที่เป็น UTC)
//   expire อ่านไม่ได้ = ไม่นับแถวนั้น (แอปเดิมได้ NaN แล้วเทียบเป็น false เหมือนกัน)
//
// ⚠️ หัวไฟล์สัญญา sale.amend เขียนว่า `expire > now` (เทียบเวลา) · ไฟล์นี้ใช้กติกาวันของแอปเดิมตามที่ใบสั่ง
//    ต่างกันเฉพาะวันหมดอายุ (แอปเดิมยังใช้ได้ทั้งวัน) · case ที่รอเซ็นไม่มีตัวไหนอยู่ที่ขอบนี้
"use strict";

const { thaiYmd } = require("./billClock");

/**
 * vipActive(shop, type, now, {firstOnly}) → boolean
 * @param {object} shop doc ร้านที่อ่านจากฐาน (ไม่ใช่ค่าจากแอป)
 * @param {string} type 'premium' | 'staff' | 'member' | 'warehouse' | 'delivery'
 * @param {Date} now เวลา server
 * @param {boolean} [opt.firstOnly] true = ดูแถวแรกของชนิดนี้แถวเดียว (กติกาแพ็กเกจพนักงานของ LoadingScreen.js:72 ใช้ `vip.find`)
 */
function vipActive(shop, type, now, { firstOnly } = {}) {
  const vip = shop && Array.isArray(shop.vip) ? shop.vip : [];
  const today = now instanceof Date ? thaiYmd(now) : null; // now ต้องเป็นเวลา server (Date จาก readNow) ไม่รับข้อความ
  if (today === null) return false; // นาฬิกาเพี้ยน = ไม่ให้สิทธิ์ (fail-closed)
  const rows = vip.filter((v) => v && typeof v === "object" && v.type === type);
  const pick = firstOnly === true ? rows.slice(0, 1) : rows;
  return pick.some((v) => {
    const day = thaiYmd(v.expire);
    return day !== null && day >= today;
  });
}

/** isPremiumActive(shop, now) — แพ็กเกจพรีเมี่ยมยังไม่หมด (ใช้กับ sale.amend → 403 premium_required) */
function isPremiumActive(shop, now) {
  return vipActive(shop, "premium", now);
}

/** isStaffPackageActive(shop, now) — แพ็กเกจพนักงาน (แถวแรกของชนิด staff ตามแอปเดิม) */
function isStaffPackageActive(shop, now) {
  return vipActive(shop, "staff", now, { firstOnly: true });
}

module.exports = { vipActive, isPremiumActive, isStaffPackageActive };

// pos/promotion/_common.js — ด่านร่วมของ promotion.save · promotion.delete · promotion.setStatus (ก้อน 9b · DEV-0001)
//
// ด่านเดิมของแอป (ตรวจที่จอเท่านั้น):
//   เข้าจอโปรผ่าน `ตั้งค่า` (สิทธิ์ '101' · `main3:src/screens/HomeScreen.js:55`) → `ShopSettingScreen.js:25` ตั้งค่าขั้นสูง → `AdvanceScreen` เมนูพรีเมี่ยม (`main3:src/screens/AdvanceScreen.js:29,62`)
//   ⇒ server ตรวจเอง 2 ชั้น: สิทธิ์ '101' (เจ้าของ/ทีมงานผ่านเสมอ) · แพ็กเกจพรีเมี่ยมยังไม่หมด (`_shared/premium.js` กติกาวันของแอปเดิม)
//   ลำดับ: สิทธิ์ก่อนอ่านฐาน · พรีเมี่ยมหลังอ่าน shop ใน transaction (ค่าจากฐาน ไม่เชื่อแอป)
"use strict";

const { deny } = require("../_shared/respond");
const { hasRight } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { thaiYmd } = require("../_shared/billClock");
const { refuse } = require("../member/_gate");

const SETTING_RIGHT = "101"; // ตั้งค่า (main3 src/screens/StaffScreen.js:47)
const OTHER_SHOP_MSG = "โปรโมชันนี้เป็นของร้านอื่น";

/** rightDeny(access) — ไม่มีสิทธิ์ '101' = deny 403 · มี = null */
function rightDeny(access) {
  return hasRight(access, SETTING_RIGHT) ? null : deny(403, "right_required", undefined, { right: SETTING_RIGHT });
}

/** requirePremium(shop, now) — หมดพรีเมี่ยม = throw Refusal 403 premium_required */
function requirePremium(shop, now) {
  if (!isPremiumActive(shop, now)) refuse(deny(403, "premium_required"));
}

/** ms ของเวลาในฐาน (Timestamp/Date/ข้อความ ISO) · อ่านไม่ได้ = null */
function msOf(t) {
  if (t instanceof Date) return t.getTime();
  if (t && typeof t.toMillis === "function") return t.toMillis();
  if (t && typeof t.toDate === "function") return t.toDate().getTime();
  if (typeof t === "string") { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : null; }
  return null;
}

/**
 * dayWorks(d) — วันนี้ขายลดได้จริงไหม · แอปเก่าลดเมื่อ `allDay || period.includes(hour)` (`main3:src/redux/promotionSlice.js:76-92`)
 *   ⇒ status true และ (allDay ไม่ใช่ false · หรือมีชั่วโมงใน period) · allDay false + period ว่าง = ไม่มีชั่วโมงทำงาน (K06 · ผลตรวจ 9b ข2)
 *   doc เก่าที่ไม่มี allDay/period = ถือว่าทำงาน (ไม่ปัดสิ่งที่พิสูจน์ไม่ได้)
 */
function dayWorks(d) {
  if (!d || d.status !== true) return false;
  if (d.allDay !== false) return true;
  return !Array.isArray(d.period) || d.period.length > 0;
}

/**
 * statusOnProblem(doc) — เปิดโปรที่มีอยู่แล้ว (setStatus true) ด้วยกติกา K06 เท่าที่ doc รุ่นนั้นมีข้อมูล
 *   มี workingDays แต่ไม่มีวันไหนขายลดได้ (dayWorks) = 'promotion_no_working_day' · expireType limit และวันสิ้นสุดก่อนวันเริ่ม (วันไทย) = 'promotion_date_range'
 *   doc รุ่นแรกที่ไม่มี workingDays = ไม่ตรวจส่วนนั้น (แอปเดิมถือว่าทุกวัน · DI-48)
 */
function statusOnProblem(doc) {
  const days = doc && Array.isArray(doc.workingDays) ? doc.workingDays : null;
  if (days && !days.some(dayWorks)) return "promotion_no_working_day";
  if (doc && doc.expireType === "limit") {
    const s = thaiYmd(doc.startDate), e = thaiYmd(doc.endDate);
    if (s !== null && e !== null && s > e) return "promotion_date_range";
  }
  return null;
}

module.exports = { SETTING_RIGHT, OTHER_SHOP_MSG, rightDeny, requirePremium, msOf, statusOnProblem, dayWorks };

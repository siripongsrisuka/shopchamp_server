// pos/shopStaff/common.js — ของร่วมของโดเมนร้านและพนักงาน (ก้อน 9c · DEV-0001)
//   shop.update · staff.manage · staff.checkIn · expense.manage · expenseReport.manage · profile.manage
// ทุกตัวในไฟล์นี้ pure (ไม่แตะฐาน)
"use strict";

const { deny } = require("../_shared/respond");
const { memberStatusOf } = require("../_shared/auth");
const { SHOP_TZ } = require("../_shared/billClock");

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

/**
 * callerStillActive(shop, access, now) — ด่านซ้ำใน transaction: ผู้เรียกยัง active ในร้านตอนเขียนจริงไหม
 *   (middleware ตัดสินจากการอ่านก่อนหน้า · ร้านถอดสิทธิ์ระหว่างนั้นได้ · harness ส่ง req.shopAccess มาเอง)
 *   ทีมงาน (byAdmin) ผ่านทุกร้าน (Pack เคาะ 2026-11-06 ข้อ 3-2) · คนอื่นใช้กติกาเดียวกับ requireShopAccess (แพ็กเกจพนักงานด้วย)
 * @returns {null | deny 403 not_shop_member {reason}}
 */
function callerStillActive(shop, access, now) {
  if (access && access.byAdmin === true) return null;
  const m = memberStatusOf(shop, access && access.uid, now);
  if (m.status === "active") return null;
  return deny(403, "not_shop_member", undefined, { reason: m.status });
}

/** sameValue(a, b) — เทียบค่าลึกแบบ JSON (คีย์ไม่สนลำดับ · Timestamp/Date เทียบเวลา) */
function canon(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return { __t: v.getTime() };
  if (typeof v.toMillis === "function") return { __t: v.toMillis() };
  if (typeof v.toDate === "function") return { __t: v.toDate().getTime() };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  const out = {};
  for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) out[k] = c; }
  return out;
}
function sameValue(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** toIsoDeep(v) — ค่าที่คืนให้แอป: Timestamp/Date → ISO · อย่างอื่นคงเดิม */
function toIsoDeep(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v.toDate === "function") { const d = v.toDate(); return d instanceof Date ? d.toISOString() : null; }
  if (Array.isArray(v)) return v.map(toIsoDeep);
  const out = {};
  for (const k of Object.keys(v)) out[k] = toIsoDeep(v[k]);
  return out;
}

/** thaiReceiptTime(now) — รูปเวลาเดียวกับ `stringDateTimeReceipt` ของแอปเก่า (`app:Utility/dateTime.js:49-60`) บนนาฬิกาไทย: `27/06/2021 00:25:26` */
function thaiReceiptTime(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** displayName(profile, fallback) — ชื่อจาก profile ในฐาน (ไม่เชื่อชื่อจากแอป) */
function displayName(profile, fallback) {
  return isObj(profile) && typeof profile.name === "string" ? profile.name : fallback || "";
}

module.exports = { isObj, Refusal, refuse, callerStillActive, sameValue, toIsoDeep, thaiReceiptTime, displayName };

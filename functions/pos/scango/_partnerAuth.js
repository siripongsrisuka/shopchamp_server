// pos/scango/_partnerAuth.js — ยามของเส้นที่เซิร์ฟเวอร์ ScanGo เรียกเข้า Shopchamp (route auth 'partner' · แบบ shopchamp-scango-design.md §เส้นเชื่อม)
//
// ผู้เรียก = เซิร์ฟเวอร์ ScanGo ไม่ใช่คนในร้าน ⇒ ไม่มี ID token ของบ้านนี้ ⇒ ยาม = กุญแจร่วมระหว่าง 2 เซิร์ฟเวอร์
//   ① env `SCANGO_SHOPCHAMP_KEY` ไม่ตั้ง = 503 partner_not_configured ทุกคำขอ (fail-closed · ไม่มี default ฝังซอร์ส)
//   ② รับกุญแจจาก header `x-scango-platform-key` เท่านั้น (ไม่อ่าน body/query)
//   ③ เทียบด้วย crypto.timingSafeEqual (ยาวไม่เท่า = ปัดก่อน · timingSafeEqual โยนถ้ายาวไม่เท่า)
//   ไม่มี/ผิด = 401 no_auth (รหัสเดียวกับด่านตัวตนของ route อื่น)
// ⚠️ ยามนี้พิสูจน์แค่ว่า "ผู้เรียกคือ ScanGo" · ร้านมาจาก body.externalId (= shopId) ที่ handler ตรวจเอง
"use strict";

const crypto = require("crypto");
const { fail } = require("../_shared/respond");

const HEADER = "x-scango-platform-key";
const ENV_KEY = "SCANGO_SHOPCHAMP_KEY";

function safeEqual(a, b) {
  const A = Buffer.from(String(a), "utf8");
  const B = Buffer.from(String(b), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function headerOf(req, name) {
  if (req && typeof req.header === "function") return req.header(name);
  const h = (req && req.headers) || {};
  return h[name] || h[String(name).toLowerCase()];
}

/** checkPartnerKey(req, env?) → null (ผ่าน) | {status, error, message} · env ไม่ส่ง = process.env */
function checkPartnerKey(req, env) {
  const configured = (env || process.env)[ENV_KEY];
  if (typeof configured !== "string" || configured === "") {
    return { status: 503, error: "partner_not_configured", message: "ระบบเชื่อมต่อ ScanGo ยังไม่ถูกตั้งค่าบนเซิร์ฟเวอร์นี้" };
  }
  const presented = headerOf(req, HEADER);
  if (typeof presented !== "string" || presented === "" || !safeEqual(presented, configured)) {
    return { status: 401, error: "no_auth", message: "กุญแจเชื่อมต่อไม่ถูกต้อง" };
  }
  return null;
}

/** requirePartnerKey(env?) → express middleware (app.js ใช้แทน checkIfAuthenticated กับแถว auth 'partner') */
function requirePartnerKey(env) {
  return function partnerKeyGate(req, res, next) {
    const e = checkPartnerKey(req, env);
    if (e) return fail(res, e.status, e.error, e.message);
    return next();
  };
}

module.exports = { HEADER, ENV_KEY, checkPartnerKey, requirePartnerKey, safeEqual };

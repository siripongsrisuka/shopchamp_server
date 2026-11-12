// pos/scango/_loginCode.js — ของร่วมของรหัสเข้าเว็บร้าน ScanGo จากแอปร้าน (ใช้ครั้งเดียว · 2 นาที) · ไม่ใช่ handler · ไม่ถูก route
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/settingsLogin.js` (start · redeem)
//   รหัส = `<id20>.<hex64>` · doc `scangoSettingsLogin/{id20}` = {secretHash, shopId, personId, status:'pending'|'claimed', createdAt, expiresAt, claimedAt?}
//   เก็บแค่ sha256(secret) · เทียบ timingSafeEqual · expiresAt อ่านไม่ออก = หมดอายุ · ลำดับตรวจตอนแลกตามต้นแบบ
//   ตัวสุ่ม/hash ใช้ชุดเดียวกับลิงก์เข้าเว็บเจ้าของร้านของบ้านนี้ (`../webLogin/core.js`) — ❌ ไม่มีสูตรที่ 2
// รูปเก็บเดียวกับต้นแบบทุกช่อง (Pack เคาะ B2 2026-11-12: ไม่ผนึก HMAC ตามแบบพี่น้อง · เดิมรอบ 4 ผนึกด้วยกุญแจ GATEWAY_CRED_ENC_KEY)
//   ⚠️ ความเสี่ยงที่รับไว้ (รายงาน Pack แล้วตอนเคาะ): rules ที่ live ของ shopcham-24b0b ยังให้คนที่ login เขียน doc ได้ (ดูหัว webLogin/core.js)
//      ⇒ กันได้ด้วย firestore.rules ปิด collection นี้ (server เขียนผ่าน admin SDK เท่านั้น) — ไม่ใช่งานของไฟล์นี้
// ❌ ไม่ log รหัส / secret / secretHash / seal
"use strict";

const crypto = require("crypto");
const WL = require("../webLogin/core");

const COLLECTION = "scangoSettingsLogin";
const TTL_MS = 2 * 60 * 1000; // 120 วิ (ต้นแบบ CODE_TTL_MS)
const CODE_RE = /^([A-Za-z0-9]{20})\.([0-9a-f]{64})$/;

/** ข้อความไทยของรหัสปฏิเสธ (รหัส = ชุดที่ connector ฝั่ง ScanGo แปล: LOGIN_CODES ของ connector แอปพี่น้อง) */
const MSG = Object.freeze({
  owner_only: "เฉพาะเจ้าของร้านเท่านั้นที่เข้าเว็บตั้งค่าร้าน ScanGo ได้",
  code_invalid: "รหัสเข้าเว็บไม่ถูกต้อง",
  code_not_found: "ไม่พบรหัสเข้าเว็บนี้ ลองเปิดจากแอปใหม่",
  code_expired: "รหัสหมดอายุแล้ว (2 นาที) ลองเปิดจากแอปใหม่",
  already_used: "รหัสนี้ถูกใช้ไปแล้ว ลองเปิดจากแอปใหม่",
});

/** parseCode(raw) → {id, secret} | null (รูปผิด = null · ผู้เรียกตอบ 400 code_invalid โดยไม่แตะฐาน) */
function parseCode(raw) {
  const m = CODE_RE.exec(typeof raw === "string" ? raw.trim() : "");
  return m ? { id: m[1], secret: m[2] } : null;
}

/** newCode() → {id, secret} (CSPRNG ชุดเดียวกับ webLogin) */
const newCode = () => ({ id: WL.randomSessionId(), secret: WL.newSecret() });

/** บรรทัด log 1 บรรทัด/เหตุการณ์ {message:'scango.settingsLogin', event, result, shopId, uid6} · ❌ ไม่มีรหัส */
function auditOf(deps) {
  const custom = deps && typeof deps.audit === "function" ? deps.audit : null;
  return function audit(event, result, shopId, uid) {
    const line = { message: "scango.settingsLogin", event, result, shopId: shopId || "", uid6: WL.short6(uid) };
    try {
      if (custom) custom(line);
      else console.log(JSON.stringify({ severity: result === "ok" ? "INFO" : "WARNING", ...line }));
    } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
  };
}

module.exports = {
  COLLECTION, TTL_MS, CODE_RE, MSG,
  parseCode, newCode, auditOf,
  sha256Hex: WL.sha256Hex, secretMatches: WL.secretMatches, msOf: WL.msOf, isExpired: WL.isExpired, SID_RE: WL.SID_RE, HEX64_RE: WL.HEX64_RE,
};

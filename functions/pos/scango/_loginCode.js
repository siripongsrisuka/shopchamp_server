// pos/scango/_loginCode.js — ของร่วมของรหัสเข้าเว็บร้าน ScanGo จากแอปร้าน (ใช้ครั้งเดียว · 2 นาที) · ไม่ใช่ handler · ไม่ถูก route
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/settingsLogin.js` (start · redeem)
//   รหัส = `<id20>.<hex64>` · doc `scangoSettingsLogin/{id20}` = {secretHash, shopId, personId, status:'pending'|'claimed', createdAt, expiresAt, claimedAt?}
//   เก็บแค่ sha256(secret) · เทียบ timingSafeEqual · expiresAt อ่านไม่ออก = หมดอายุ · ลำดับตรวจตอนแลกตามต้นแบบ
//   ตัวสุ่ม/hash ใช้ชุดเดียวกับลิงก์เข้าเว็บเจ้าของร้านของบ้านนี้ (`../webLogin/core.js`) — ❌ ไม่มีสูตรที่ 2
// ต่างจากต้นแบบ 1 ข้อ (บังคับโดยฐานของบ้านนี้): **ผนึก doc ด้วย HMAC** เหมือน `../webLogin/core.js`
//   เหตุ: rules ที่ live ของ shopcham-24b0b ยังให้ทุกคนที่ login เขียน doc ได้ (ดูหัว webLogin/core.js) ⇒ ถ้าไม่ผนึก
//   คนที่ login ได้สร้าง doc เองชี้ร้านคนอื่น + uid เจ้าของจริง แล้วแลกเป็นสิทธิ์เจ้าของบนเว็บ ScanGo ได้
//   seal = HMAC-SHA256(K, "sgl1|" + id + "|" + shopId + "|" + personId + "|" + secretHash + "|" + expiresAtMs)
//   K    = HKDF-SHA256(GATEWAY_CRED_ENC_KEY 32 ไบต์ · salt ว่าง · info "shopchamp-scango-login-seal-v1") — แยกกุญแจจากผนึกของ webLogin
//   ไม่มีกุญแจ = 503 scango_login_not_configured (fail-closed)
// ❌ ไม่ log รหัส / secret / secretHash / seal
"use strict";

const crypto = require("crypto");
const SB = require("../gateway/secretBox");
const WL = require("../webLogin/core");

const COLLECTION = "scangoSettingsLogin";
const TTL_MS = 2 * 60 * 1000; // 120 วิ (ต้นแบบ CODE_TTL_MS)
const CODE_RE = /^([A-Za-z0-9]{20})\.([0-9a-f]{64})$/;
const SEAL_INFO = "shopchamp-scango-login-seal-v1";
const SEAL_PREFIX = "sgl1";

/** ข้อความไทยของรหัสปฏิเสธ (รหัส = ชุดที่ connector ฝั่ง ScanGo แปล: LOGIN_CODES ของ connector แอปพี่น้อง) */
const MSG = Object.freeze({
  owner_only: "เฉพาะเจ้าของร้านเท่านั้นที่เข้าเว็บตั้งค่าร้าน ScanGo ได้",
  code_invalid: "รหัสเข้าเว็บไม่ถูกต้อง",
  code_not_found: "ไม่พบรหัสเข้าเว็บนี้ ลองเปิดจากแอปใหม่",
  code_expired: "รหัสหมดอายุแล้ว (2 นาที) ลองเปิดจากแอปใหม่",
  already_used: "รหัสนี้ถูกใช้ไปแล้ว ลองเปิดจากแอปใหม่",
  scango_login_not_configured: "ระบบเข้าเว็บร้าน ScanGo ยังไม่พร้อม",
});

/** parseCode(raw) → {id, secret} | null (รูปผิด = null · ผู้เรียกตอบ 400 code_invalid โดยไม่แตะฐาน) */
function parseCode(raw) {
  const m = CODE_RE.exec(typeof raw === "string" ? raw.trim() : "");
  return m ? { id: m[1], secret: m[2] } : null;
}

/** readSealKey(deps) → {key} | {error:{code}} · deps.sealKey (base64 · เทส/harness) → deps.env / process.env GATEWAY_CRED_ENC_KEY */
function readSealKey(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const env = d.env && typeof d.env === "object" ? d.env : undefined;
  const k = SB.readKey({ deps: typeof d.sealKey === "string" ? { credKey: d.sealKey } : {}, env });
  if (k.error) return { error: { code: k.error.code } };
  return { key: Buffer.from(crypto.hkdfSync("sha256", k.key, Buffer.alloc(0), SEAL_INFO, 32)) };
}

/** sealOf(key, {id, shopId, personId, secretHash, expiresAtMs}) → hex */
function sealOf(key, { id, shopId, personId, secretHash, expiresAtMs }) {
  const msg = [SEAL_PREFIX, id, shopId, personId, secretHash, String(expiresAtMs)].join("|");
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

/** sealMatches(key, id, doc) — id มาจาก path ของ doc (ย้ายผนึกข้าม doc ไม่ได้) · ช่องผิดรูป = false · ไม่โยน */
function sealMatches(key, id, doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  if (typeof d.seal !== "string" || !WL.HEX64_RE.test(d.seal)) return false;
  if (typeof d.shopId !== "string" || d.shopId === "" || typeof d.personId !== "string" || d.personId === "") return false;
  if (typeof d.secretHash !== "string" || !WL.HEX64_RE.test(d.secretHash)) return false;
  const expiresAtMs = WL.msOf(d.expiresAt);
  if (expiresAtMs === null) return false;
  const want = sealOf(key, { id, shopId: d.shopId, personId: d.personId, secretHash: d.secretHash, expiresAtMs });
  return crypto.timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(d.seal, "hex"));
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
  COLLECTION, TTL_MS, CODE_RE, SEAL_INFO, SEAL_PREFIX, MSG,
  parseCode, readSealKey, sealOf, sealMatches, newCode, auditOf,
  sha256Hex: WL.sha256Hex, secretMatches: WL.secretMatches, msOf: WL.msOf, isExpired: WL.isExpired, SID_RE: WL.SID_RE, HEX64_RE: WL.HEX64_RE,
};

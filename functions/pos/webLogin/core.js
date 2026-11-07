// pos/webLogin/core.js — ตัวช่วยแบบ pure ของลิงก์ login ใช้ครั้งเดียว (DEV-0001 · owner-web-login-design.md §2.2-§2.4)
//
// ผนึก doc (เหตุ: rules ที่ live เปิดให้ทุกคนที่ login เขียนทุก doc ⇒ server เชื่อ field ใน doc ไม่ได้ถ้าไม่ผนึก)
//   seal = HMAC-SHA256(K, "wl1|" + sessionId + "|" + startedBy + "|" + secretHash + "|" + expiresAtMs)  (hex)
//   K    = HKDF-SHA256(ikm = GATEWAY_CRED_ENC_KEY 32 ไบต์, salt = ว่าง, info = "shopchamp-weblogin-seal-v1", 32 ไบต์)
//          (§11 ข้อ 1 · Pack เคาะใช้ secret ที่ผูก pos แล้ว แยกกุญแจด้วย HKDF)
//   status ไม่อยู่ในผนึก (เปลี่ยนตามรอบ) · ความเสี่ยงที่เหลือ = คนที่รู้ secret อยู่แล้วแก้ status กลับเป็น approved ได้ภายในอายุ 2 นาที (§2.4)
// ❌ ไม่ log secret / secretHash / seal / กุญแจ
"use strict";

const crypto = require("crypto");
const SB = require("../gateway/secretBox");

const COLLECTION = "webLogin";
const TTL_MS = 2 * 60 * 1000;
const SEAL_INFO = "shopchamp-weblogin-seal-v1";
const SEAL_PREFIX = "wl1";
const SID_RE = /^[A-Za-z0-9]{20}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SID_LEN = 20;
// ไบต์ ≥ 248 (= 62 × 4) ทิ้ง ⇒ ทุกตัวอักษรออกเท่ากัน (ไม่เอียง)
const SID_CUTOFF = 256 - (256 % SID_ALPHABET.length);
const UA_MAX = 120;

/** randomSessionId(randomBytes?) → 20 ตัว [A-Za-z0-9] · rejection sampling (randomBytes ส่งมาได้เพื่อพิสูจน์การทิ้งไบต์) */
function randomSessionId(randomBytes = crypto.randomBytes) {
  let out = "";
  while (out.length < SID_LEN) {
    const buf = randomBytes(32);
    for (let i = 0; i < buf.length && out.length < SID_LEN; i++) {
      if (buf[i] < SID_CUTOFF) out += SID_ALPHABET[buf[i] % SID_ALPHABET.length];
    }
  }
  return out;
}

/** newSecret() → 32 ไบต์ CSPRNG เป็น hex ตัวเล็ก 64 ตัว */
const newSecret = () => crypto.randomBytes(32).toString("hex");

const sha256Hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/** secretMatches(secret, secretHash) — เทียบ sha256 ด้วย timingSafeEqual · รูปผิดฝั่งใดก็ได้ = false (ไม่โยน) */
function secretMatches(secret, secretHash) {
  if (typeof secret !== "string" || !HEX64_RE.test(secret)) return false;
  if (typeof secretHash !== "string" || !HEX64_RE.test(secretHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256Hex(secret), "hex"), Buffer.from(secretHash, "hex"));
}

/**
 * readSealKey(deps) → {key:Buffer(32)} | {error:{code}}
 *   ฐานกุญแจ: deps.sealKey (base64 32 ไบต์ · harness/เทส) → deps.env / process.env GATEWAY_CRED_ENC_KEY
 *   ไม่มี/ผิดรูป = error (handler ตอบ 503 weblogin_not_configured · fail-closed)
 */
function readSealKey(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const env = d.env && typeof d.env === "object" ? d.env : undefined;
  const k = SB.readKey({ deps: typeof d.sealKey === "string" ? { credKey: d.sealKey } : {}, env });
  if (k.error) return { error: { code: k.error.code } };
  return { key: Buffer.from(crypto.hkdfSync("sha256", k.key, Buffer.alloc(0), SEAL_INFO, 32)) };
}

/** sealOf(key, {sessionId, startedBy, secretHash, expiresAtMs}) → hex */
function sealOf(key, { sessionId, startedBy, secretHash, expiresAtMs }) {
  const msg = [SEAL_PREFIX, sessionId, startedBy, secretHash, String(expiresAtMs)].join("|");
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

/** msOf(t) — Date / Timestamp → ms · อย่างอื่น (ไม่มี · ตัวเลข · สตริง) = null (fail-closed) */
function msOf(t) {
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (t && typeof t === "object" && typeof t.toMillis === "function") {
    const ms = t.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * sealMatches(key, sessionId, doc) — ผนึกตรงกับ field ที่ผนึก · ทุก field ต้องรูปถูก · ไม่โยน
 *   ใช้ sessionId จาก path ของ doc (ไม่ใช่ field ใน doc) ⇒ ย้ายผนึกข้าม doc ไม่ได้
 */
function sealMatches(key, sessionId, doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  if (typeof d.seal !== "string" || !HEX64_RE.test(d.seal)) return false;
  if (typeof d.startedBy !== "string" || d.startedBy === "") return false;
  if (typeof d.secretHash !== "string" || !HEX64_RE.test(d.secretHash)) return false;
  const expiresAtMs = msOf(d.expiresAt);
  if (expiresAtMs === null) return false;
  const want = sealOf(key, { sessionId, startedBy: d.startedBy, secretHash: d.secretHash, expiresAtMs });
  return crypto.timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(d.seal, "hex"));
}

/** isExpired(nowMs, expiresAtMs) — ไม่มีวันหมด/อ่านไม่ออก = หมดแล้ว · ขอบพอดี (now === expiresAt) ยังใช้ได้ */
function isExpired(nowMs, expiresAtMs) {
  if (!Number.isFinite(expiresAtMs)) return true;
  return nowMs > expiresAtMs;
}

/** uaOf(req) — user-agent ตัด 120 ตัว · ไม่มี = undefined (ไม่เขียน field) */
function uaOf(req) {
  const ua = req && req.headers ? req.headers["user-agent"] : undefined;
  return typeof ua === "string" && ua !== "" ? ua.slice(0, UA_MAX) : undefined;
}

const short6 = (v) => (typeof v === "string" && v !== "" ? v.slice(0, 6) : "");

module.exports = {
  COLLECTION, TTL_MS, SEAL_INFO, SID_RE, HEX64_RE, SID_ALPHABET, SID_CUTOFF, UA_MAX,
  randomSessionId, newSecret, sha256Hex, secretMatches, readSealKey, sealOf, sealMatches, msOf, isExpired, uaOf, short6,
};

// pos/scango/v1/partnerSign.js — ยามลายเซ็น HMAC ของ ScanGo Order API v1 §2 (route auth 'partnerSigned' · DEV-0009)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/v1/partnerSign.js` (ตัวรับ) · ตัวส่ง = scango_server
//   origin/main `functions/_shared/partnerSign.js` › headersFor (providers/partnerApi/client.js ใช้กับทุกเจ้า)
// header: `X-ScanGo-Partner` = `shopchamp` (PROVIDER_ID ของ connector shopchamp ฝั่ง ScanGo) · `X-ScanGo-Timestamp` = unix ms ·
//         `X-ScanGo-Signature` = `v1=<hex64 ตัวเล็ก>` = HMAC-SHA256(secret, timestamp + "." + rawBody)
// 🔒 fail-closed: env กุญแจว่าง = 503 partner_not_configured (ไม่ใช่ 401 — กันกุญแจว่างเทียบว่างแล้วผ่าน) ·
//    header ขาด/รูปผิด/partner ไม่ใช่ shopchamp = 401 signature_invalid · |now − ts| > 300000 ms = 401 signature_expired · เทียบ timingSafeEqual
// 🔑 rawBody = ไบต์ตรงตามที่ส่ง: บน Cloud Functions = req.rawBody ที่ framework เก็บให้ · นอกนั้น app.js ให้ express.json เก็บไบต์ใส่ req.rawBody
//    ไม่มีทั้งคู่ (เทสเรียกตรง) = JSON.stringify(req.body) · ❌ ไม่ re-serialize เมื่อมีไบต์จริง
// กุญแจ = `SCANGO_SHOPCHAMP_KEY` ตัวเดียวกับ _partnerAuth.js (= SHOPCHAMP_PLATFORM_KEY ฝั่ง ScanGo · connector ใช้ค่าเดียวกันทั้ง header key และ HMAC)
// ต่างจากต้นแบบ: ชื่อ partner/env ของบ้านนี้ · ขาส่ง (headersFor) อยู่ที่ ./eventOut.js (ร้านกดรับในแอป · DEV-0009 2026-11-14) · คำตอบผ่าน respond.fail (มี code ซ้ำ error ตามสัญญา §2)
"use strict";

const crypto = require("crypto");
const { fail } = require("../../_shared/respond");

const PARTNER_ID = "shopchamp";
const ENV_KEY = "SCANGO_SHOPCHAMP_KEY";
const SKEW_MS = 300000;
const H_PARTNER = "x-scango-partner";
const H_TIMESTAMP = "x-scango-timestamp";
const H_SIGNATURE = "x-scango-signature";

const str = (v) => (v == null ? "" : String(v).trim());

/** rawBody ของคำขอ — Buffer/string · ไม่มี = serialize body (เทส) */
function rawBodyOf(req) {
  const rb = req && req.rawBody;
  if (Buffer.isBuffer(rb)) return rb.toString("utf8");
  if (typeof rb === "string") return rb;
  return req && req.body !== undefined ? JSON.stringify(req.body) : "";
}

function headerOf(req, name) {
  if (req && typeof req.header === "function") return req.header(name);
  const h = (req && req.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : undefined;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a), "utf8");
  const B = Buffer.from(String(b), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** `v1=<hex>` ของ (timestamp, rawBody) — ใช้ตรวจ และให้เทสเซ็นคำขอ */
function sign({ timestamp, rawBody, secret }) {
  if (!secret) throw new Error(`${ENV_KEY} ว่าง — เซ็นลายเซ็นไม่ได้`);
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody == null ? "" : rawBody);
  return "v1=" + crypto.createHmac("sha256", secret).update(`${String(timestamp)}.${body}`, "utf8").digest("hex");
}

/**
 * verify(req, {now, env}) → null (ผ่าน) | {status, code, message}
 *   env ไม่ส่ง = process.env (อ่านตอนคำขอ)
 */
function verify(req, { now = new Date(), env } = {}) {
  const key = (env || process.env)[ENV_KEY];
  if (typeof key !== "string" || key === "") return { status: 503, code: "partner_not_configured", message: "ระบบเชื่อมต่อ ScanGo ยังไม่ถูกตั้งค่าบนเซิร์ฟเวอร์นี้" };
  const bad = (code, message) => ({ status: 401, code, message });
  const partner = str(headerOf(req, H_PARTNER));
  const tsRaw = str(headerOf(req, H_TIMESTAMP));
  const sig = str(headerOf(req, H_SIGNATURE));
  if (partner !== PARTNER_ID) return bad("signature_invalid", "X-ScanGo-Partner ไม่ใช่พาร์ทเนอร์นี้");
  if (!/^\d{1,16}$/.test(tsRaw)) return bad("signature_invalid", "X-ScanGo-Timestamp ต้องเป็น unix ms");
  if (!/^v1=[0-9a-f]{64}$/.test(sig)) return bad("signature_invalid", "X-ScanGo-Signature ต้องเป็น v1=<hex64>");
  if (Math.abs(now.getTime() - Number(tsRaw)) > SKEW_MS) return bad("signature_expired", "X-ScanGo-Timestamp ห่างจากเวลาเซิร์ฟเวอร์เกิน 5 นาที");
  const expect = sign({ timestamp: tsRaw, rawBody: rawBodyOf(req), secret: key });
  if (!safeEqual(sig, expect)) return bad("signature_invalid", "ลายเซ็นไม่ตรง");
  return null;
}

/** requirePartnerSignature({env, now}?) → express middleware (app.js ใช้กับแถว auth 'partnerSigned') */
function requirePartnerSignature(opts) {
  const o = opts || {};
  return function partnerSignatureGate(req, res, next) {
    const e = verify(req, { env: o.env, now: typeof o.now === "function" ? o.now() : new Date() });
    if (e) return fail(res, e.status, e.code, e.message, { code: e.code });
    return next();
  };
}

module.exports = { PARTNER_ID, ENV_KEY, SKEW_MS, H_PARTNER, H_TIMESTAMP, H_SIGNATURE, sign, verify, requirePartnerSignature, rawBodyOf, safeEqual };

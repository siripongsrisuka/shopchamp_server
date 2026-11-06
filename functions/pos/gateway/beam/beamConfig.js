// pos/gateway/beam/beamConfig.js — ค่าตั้ง Beam จาก env (สภาพแวดล้อม + ตัวตน partner ของบริษัท) · ก้อน 7 · DEV-0001
//
// ยกจากพี่น้อง (เนื้อเดิม) · เปลี่ยน: อ่าน env ผ่านตัวที่ฉีดได้ (`_setEnv` / อาร์กิวเมนต์ `env`) ค่าตั้งต้น = process.env
// เส้น Bolt ใช้กุญแจรายร้าน (merchantId + Partner API Key ต่อ merchant · เก็บเข้ารหัสที่ beamMerchantCreds.js)
//   ⇒ env ไม่มี "Partner API Key ตัวเดียวของบริษัท" · partner mode = มี BEAM_PARTNER_ID (ไม่ใช่ความลับ) · กุญแจมาต่อคำขอ
//   ❌ ไม่มีค่าตั้งต้นของ BEAM_PARTNER_ID ในโค้ด — playground/production คนละบัญชี · ไม่ตั้ง = fail-closed beam_config_missing
//
// env (ทุกตัวไม่บังคับ):
//   BEAM_ENV               = "playground" | "production"   (ค่าตั้งต้น playground · ค่าอื่นทั้งหมด = playground)
//   BEAM_MERCHANT_ID       = บัญชีบริษัท (ทาง ② ของ beamClient · เส้นเงินไม่ใช้)
//   BEAM_MERCHANT_API_KEY  = ความลับ — ❌ ไม่ log ไม่คืนออก HTTP
//   BEAM_PARTNER_ID        = ตัวตน partner ของ Shopchamp ใน Bridge · บังคับสำหรับเส้น Bolt รายร้าน
//   BEAM_WEBHOOK_HMAC_KEY  = ความลับ (ไม่บังคับ) — กุญแจ webhook ระดับบริษัท
"use strict";

let ENV_OVERRIDE = null;

/** เทสตั้ง env ปลอมทั้งก้อน (แทน process.env ทั้งหมด ไม่ผสม) */
function _setEnv(obj) {
  ENV_OVERRIDE = obj && typeof obj === "object" ? obj : null;
}
function _resetEnv() {
  ENV_OVERRIDE = null;
}

const envOf = (env) => env || ENV_OVERRIDE || process.env;

function readEnv(name, env) {
  const v = envOf(env)[name];
  if (typeof v !== "string") return "";
  return v.trim();
}

const isNonEmpty = (v) => typeof v === "string" && v.length > 0;

function normalizeEnv(raw) {
  const v = (raw || "").toLowerCase();
  return v === "production" ? "production" : "playground";
}

/** "merchant" | "partner" | "missing" · มีคู่บัญชีบริษัทครบ = merchant ก่อน */
function getBeamApiMode(env) {
  if (isNonEmpty(readEnv("BEAM_MERCHANT_ID", env)) && isNonEmpty(readEnv("BEAM_MERCHANT_API_KEY", env))) return "merchant";
  if (isNonEmpty(readEnv("BEAM_PARTNER_ID", env))) return "partner";
  return "missing";
}

/** "playground" | "production" (ป้ายเท่านั้น ไม่มี URL) */
function getBeamBaseUrlLabel(env) {
  return normalizeEnv(readEnv("BEAM_ENV", env));
}

/** ค่าเต็ม (มีความลับ) — ฝั่ง server เท่านั้น ❌ ห้าม serialize ออก HTTP */
function getBeamConfig(env) {
  return {
    environment: getBeamBaseUrlLabel(env),
    apiMode: getBeamApiMode(env),
    merchantId: readEnv("BEAM_MERCHANT_ID", env),
    merchantApiKey: readEnv("BEAM_MERCHANT_API_KEY", env),
    partnerId: readEnv("BEAM_PARTNER_ID", env),
    webhookHmacKey: readEnv("BEAM_WEBHOOK_HMAC_KEY", env),
  };
}

/** สรุปว่ามี/ไม่มี (boolean + ป้าย) — ไม่มีค่าลับ คืนให้ผู้ดูแลได้ */
function getBeamPresence(env) {
  const environment = getBeamBaseUrlLabel(env);
  const apiMode = getBeamApiMode(env);
  const hasMerchantId = isNonEmpty(readEnv("BEAM_MERCHANT_ID", env));
  const hasMerchantApiKey = isNonEmpty(readEnv("BEAM_MERCHANT_API_KEY", env));
  const hasPartnerId = isNonEmpty(readEnv("BEAM_PARTNER_ID", env));
  const hasWebhookHmacKey = isNonEmpty(readEnv("BEAM_WEBHOOK_HMAC_KEY", env));
  const missing = [];
  if (apiMode === "missing") {
    if (!hasMerchantId) missing.push("BEAM_MERCHANT_ID");
    if (!hasMerchantApiKey) missing.push("BEAM_MERCHANT_API_KEY");
  }
  // partner mode: กุญแจรายร้านอยู่ใน Firestore (beamMerchantCreds) ไม่ใช่ env ⇒ ไม่มีช่องขาดฝั่ง env
  return {
    ok: apiMode !== "missing",
    environment,
    apiMode,
    hasMerchantId,
    hasMerchantApiKey,
    hasPartnerId,
    hasWebhookHmacKey,
    baseUrlLabel: environment,
    missing,
  };
}

module.exports = {
  getBeamConfig,
  getBeamPresence,
  getBeamApiMode,
  getBeamBaseUrlLabel,
  _setEnv,
  _resetEnv,
};

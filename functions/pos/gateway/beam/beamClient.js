// pos/gateway/beam/beamClient.js — ตัวยิง HTTP ไป Beam ฝั่ง server · ก้อน 7 · DEV-0001
//
// ยกจากพี่น้อง · เปลี่ยน: ยิงผ่าน http ที่ฉีดได้ (`_setHttp(fn)` / `_resetHttp()` · ค่าตั้งต้น axios) ⇒ เทสไม่ออกเน็ต
//   + `opts.env` ส่งต่อให้ beamConfig (ไม่ส่ง = env ของ beamConfig / process.env)
// ❌ แอป/หน้าเว็บห้ามยิง Beam ตรง — กุญแจอยู่ฝั่ง server เท่านั้น
//
// ตัวตนที่ยิง (Basic auth) ตัดสินจาก "ผู้เรียกส่งกุญแจรายร้านมาไหม":
//   ① รายร้าน (เส้น Bolt ใช้ทางนี้ทางเดียว): opts.merchantId + opts.apiKey (ถอดจาก beamMerchantCreds แล้ว)
//      → Basic base64(merchantId:apiKey) + header X-Beam-Partner-ID = BEAM_PARTNER_ID
//      (docs.beamcheckout.com/get-started/authentication › Partner API Key)
//      ขาดช่องไหน = ปัดก่อนยิง · ❌ ไม่ถอยไป BEAM_MERCHANT_* เงียบ ๆ (ถอย = เงินร้านไหลเข้าบัญชีบริษัท)
//   ② บัญชีบริษัท (BEAM_MERCHANT_ID/KEY) — ใช้เมื่อไม่ส่งกุญแจรายร้านเลย · เส้นเงินไม่ใช้
//
// POST/PATCH/DELETE ใส่ x-beam-idempotency-key (ผู้เรียกไม่ส่ง = สุ่ม UUID ต่อครั้ง)
// error ทุกทางผ่านตัวกรอง: ❌ ไม่คัด err.config (มี Authorization) · ไม่มี URL · ไม่ log ความลับ
"use strict";

const crypto = require("crypto");
const { getBeamConfig } = require("./beamConfig");

const BASE_URLS = {
  playground: "https://playground.api.beamcheckout.com",
  production: "https://api.beamcheckout.com",
};

const DEFAULT_TIMEOUT_MS = 15000;
const METHODS_NEEDING_IDEMPOTENCY = new Set(["POST", "PATCH", "DELETE"]);

// ── http ที่ฉีดได้ (รูปเดียวกับ axios(opts) → {status, data, headers}) ──
let HTTP = null;
function _setHttp(fn) {
  if (typeof fn !== "function") throw new TypeError("beamClient._setHttp ต้องรับฟังก์ชัน");
  HTTP = fn;
}
function _resetHttp() {
  HTTP = null;
}
const httpOf = () => HTTP || require("axios"); // โหลด axios ตอนยิงจริงเท่านั้น

const getBaseUrl = (env) => BASE_URLS[env] || BASE_URLS.playground;

/** header ตัวตน · คืน null เมื่อไม่มีกุญแจ (ผู้เรียกต้องปัด) · ค่าลับอยู่ในหน่วยความจำของคำขอนี้เท่านั้น */
function buildAuthHeaders(cfg, perShop) {
  if (perShop) {
    const basic = Buffer.from(`${perShop.merchantId}:${perShop.apiKey}`).toString("base64");
    return { Authorization: `Basic ${basic}`, "X-Beam-Partner-ID": cfg.partnerId };
  }
  if (cfg.apiMode === "merchant") {
    const basic = Buffer.from(`${cfg.merchantId}:${cfg.merchantApiKey}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return null;
}

/**
 * ทาง ①: อ่าน merchantId + apiKey ของร้าน → {merchantId, apiKey} | {error}
 * ห้ามมี ':' / ช่องว่าง (Basic แยก username/password ด้วย ':' ตัวแรก) · ❌ ไม่ใส่ค่าที่ส่งมาลง error
 */
function readPartnerCreds(opts) {
  const m = typeof opts.merchantId === "string" ? opts.merchantId.trim() : "";
  if (!m) return { error: { code: "beam_merchant_missing", message: "Beam partner mode ต้องระบุ merchantId ของร้านต่อคำขอ" } };
  if (/[:\s]/.test(m)) return { error: { code: "beam_merchant_invalid", message: "merchantId มีอักขระที่ใช้ไม่ได้ (':' หรือช่องว่าง)" } };
  const k = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (!k) return { error: { code: "beam_api_key_missing", message: "Beam partner mode ต้องระบุ apiKey ของร้านต่อคำขอ" } };
  if (/[:\s]/.test(k)) return { error: { code: "beam_api_key_invalid", message: "apiKey มีอักขระที่ใช้ไม่ได้ (':' หรือช่องว่าง)" } };
  return { merchantId: m, apiKey: k };
}

/** มี key ใดใน 2 ช่องนี้ (แม้ค่าว่าง) = ตั้งใจยิงรายร้าน ⇒ ต้องครบ ไม่ครบ = ปัด (ไม่ถอยไปทาง ②) */
const wantsPerShop = (opts) => !!opts && (opts.merchantId !== undefined || opts.apiKey !== undefined);

function generateIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function pickBeamRequestId(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  return headers["x-beam-request-id"] || headers["x-request-id"] || undefined;
}

// กันชั้นสอง: ข้อความจาก Beam ที่หน้าตาเหมือน header ตัวตน/token = ทิ้ง
const SECRET_LIKE = /authorization|basic\s+[A-Za-z0-9+/=]{8,}|bearer\s+[A-Za-z0-9._-]{8,}/i;

function safeProviderMessage(v) {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (SECRET_LIKE.test(trimmed)) return undefined;
  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

function safeProviderCode(v) {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

// Beam ซ้อนรายละเอียดไว้ใน body.error = { errorCode:"<ENUM>", errorMessage } (docs.beamcheckout.com/get-started/error)
//   ชั้นบน `code` เป็นตัวเลข ⇒ ถ้าไม่อ่านชั้นในจะไม่รู้ว่าปัดเพราะอะไร · เพิ่มช่องใหม่เท่านั้น ไม่แตะช่องเดิม
function nestedProviderDetail(data) {
  const inner = data && typeof data === "object" && data.error && typeof data.error === "object" ? data.error : null;
  if (!inner) return {};
  const out = {};
  const detailCode = safeProviderCode(inner.errorCode);
  const detailMessage = safeProviderMessage(inner.errorMessage);
  if (detailCode) out.providerDetailCode = detailCode;
  if (detailMessage) out.providerDetailMessage = detailMessage;
  return out;
}

/** error จากคำตอบไม่ใช่ 2xx → {code, message, status, providerStatus, providerErrorCode?, providerMessage?, providerDetail*?} */
function buildProviderError(status, data) {
  let code = `beam_http_${status}`;
  let message = `Beam returned status ${status}`;
  let providerErrorCode;
  let providerMessage;
  if (data && typeof data === "object") {
    providerErrorCode = safeProviderCode(data.code) || safeProviderCode(data.error) || safeProviderCode(data.errorCode);
    providerMessage = safeProviderMessage(data.message);
    if (providerErrorCode) code = providerErrorCode;
    if (providerMessage) message = providerMessage;
  }
  const err = { code, message, status, providerStatus: status };
  if (providerErrorCode) err.providerErrorCode = providerErrorCode;
  if (providerMessage) err.providerMessage = providerMessage;
  Object.assign(err, nestedProviderDetail(data));
  return err;
}

/** error ที่ http โยนมา → รูปปลอดภัย · ❌ ไม่คัด err.config / err.request / URL */
function normalizeAxiosError(err) {
  if (err && err.response) return buildProviderError(err.response.status, err.response.data);
  if (err && err.code === "ECONNABORTED") return { code: "beam_timeout", message: "Beam request timed out" };
  if (err && typeof err.code === "string") return { code: "beam_network_error", message: `Network error (${err.code})` };
  return { code: "beam_unknown_error", message: "Unknown Beam client error" };
}

/** บอกโหมดตัวตน (ไม่มีค่าลับ) */
function describeAuth(env) {
  const cfg = getBeamConfig(env);
  return { apiMode: cfg.apiMode, environment: cfg.environment, willAuthenticate: cfg.apiMode !== "missing" };
}

/** เลือกตัวตน → {cfg, authHeaders} | {error} (ยังไม่แตะเน็ต) */
function resolveAuth(opts) {
  const cfg = getBeamConfig(opts && opts.env);
  let perShop = null;
  if (wantsPerShop(opts)) {
    const pc = readPartnerCreds(opts);
    if (pc.error) return { error: pc.error };
    if (!cfg.partnerId) {
      return { error: { code: "beam_config_missing", message: "ยังไม่ได้ตั้ง BEAM_PARTNER_ID (ตัวตน partner ของ Shopchamp ใน Bridge)" } };
    }
    perShop = pc;
  }
  const authHeaders = buildAuthHeaders(cfg, perShop);
  if (!authHeaders) return { error: { code: "beam_config_missing", message: "Beam credentials not configured" } };
  return { cfg, authHeaders };
}

/**
 * request({method, path, body?, headers?, timeoutMs?, merchantId?, apiKey?, env?})
 *   → {ok:true, status, data, beamRequestId?} | {ok:false, status?, error:{code, message, status?...}, beamRequestId?}
 *   ไม่ throw · 4xx/5xx แปลงเป็นซองปลอดภัย (validateStatus เปิดหมด) · เน็ต/หมดเวลา = จับแล้วแปลง
 */
async function request(opts) {
  const auth = resolveAuth(opts);
  if (auth.error) return { ok: false, error: auth.error };
  const { cfg, authHeaders } = auth;

  const method = String((opts && opts.method) || "GET").toUpperCase();
  const path = (opts && opts.path) || "/";
  const url = `${getBaseUrl(cfg.environment)}${path}`;

  const headers = { Accept: "application/json", ...authHeaders, ...((opts && opts.headers) || {}) };
  const hasBody = opts && opts.body !== undefined && opts.body !== null;
  if (hasBody) headers["Content-Type"] = "application/json";
  if (METHODS_NEEDING_IDEMPOTENCY.has(method) && !headers["x-beam-idempotency-key"]) {
    headers["x-beam-idempotency-key"] = generateIdempotencyKey();
  }

  const httpOpts = {
    method,
    url,
    headers,
    timeout: (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
  };
  if (hasBody) httpOpts.data = opts.body;

  try {
    const resp = await httpOf()(httpOpts);
    const beamRequestId = pickBeamRequestId(resp && resp.headers);
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, status: resp.status, data: resp.data, beamRequestId };
    }
    return { ok: false, status: resp.status, error: buildProviderError(resp.status, resp.data), beamRequestId };
  } catch (err) {
    // log แค่รหัสสั้น — err เต็มมี err.config.headers.Authorization
    console.warn("beamClient: request failed", (err && (err.code || err.name)) || "unknown");
    return { ok: false, error: normalizeAxiosError(err) };
  }
}

module.exports = {
  request,
  describeAuth,
  normalizeAxiosError,
  _baseUrls: BASE_URLS,
  _setHttp,
  _resetHttp,
};

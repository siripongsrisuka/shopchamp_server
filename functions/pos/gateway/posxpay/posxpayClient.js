// pos/gateway/posxpay/posxpayClient.js — ตัวยิง HTTP ของ POSxPay (ก้อน 7 · DEV-0001 · ยกจากพี่น้อง)
//
// บางที่สุด: ผู้เรียกส่ง token (Bearer) มาทุกคำขอ · ไฟล์นี้ไม่เก็บ ไม่ log token
// base URL: env `POSXPAY_BASE_URL` (ไม่บังคับ) → ค่าตั้งต้น production (POSxPay ไม่มี UAT host · ของเดิมก็ยิงตัวนี้)
// error ทุกรูปถูกย่อเป็น {code, message, status?} · ❌ ไม่ส่ง err.config ต่อเด็ดขาด (ก้อนนั้นถือ header Authorization = token)
"use strict";

const DEFAULT_BASE_URL = "https://apipayment.posxpay.com";
const DEFAULT_TIMEOUT_MS = 15000;

// ── env · http ที่ฉีดได้ (เทสไม่ออกเน็ตเด็ดขาด) ──────────────────────────────────
let ENV_OVERRIDE = null;
function _setEnv(obj) {
  ENV_OVERRIDE = obj && typeof obj === "object" ? obj : null;
}
function _resetEnv() {
  ENV_OVERRIDE = null;
}
function envOf(env) {
  if (env && typeof env === "object") return env;
  return ENV_OVERRIDE || process.env;
}

// http(config) → {status, data} หรือ throw แบบ axios (err.response / err.code) · config = รูป axios.request
const defaultHttp = (config) => require("axios").request(config);
let HTTP = defaultHttp;
function _setHttp(fn) {
  HTTP = typeof fn === "function" ? fn : defaultHttp;
}
function _resetHttp() {
  HTTP = defaultHttp;
}

function getBaseUrl(env) {
  const v = envOf(env).POSXPAY_BASE_URL;
  return typeof v === "string" && v.trim() ? v.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

/** ย่อ error ทุกรูปให้ปลอดความลับ — ส่งต่อแค่ status + ข้อความสั้นจาก body */
function normalizeError(err) {
  if (err && err.response) {
    const status = err.response.status;
    const data = err.response.data || {};
    // รูป validator ของ POSxPay: `{code:400, errors:[{path,msg,value}]}` ไม่มี message
    //   พี่น้องเคยได้แค่ "HTTP 400" แล้วไล่ผิดทาง ⇒ เอา path+msg มาด้วย · ❌ ไม่เอา value (อาจเป็นค่าที่ร้านกรอก)
    const validatorMsg =
      data && Array.isArray(data.errors) && data.errors.length
        ? data.errors.map((e) => `${e && e.path ? e.path + ": " : ""}${(e && e.msg) || "invalid"}`).join(" · ")
        : "";
    const message =
      (data && (data.message || data.error || data.status)) ||
      (validatorMsg && `PosXPay HTTP ${status} · ${validatorMsg}`) ||
      `PosXPay HTTP ${status}`;
    return { ok: false, error: { code: "posxpay_http_" + status, message: String(message).slice(0, 300), status } };
  }
  if (err && (err.code === "ECONNABORTED" || /timeout/i.test(err.message || ""))) {
    return { ok: false, error: { code: "posxpay_timeout", message: "PosXPay request timed out" } };
  }
  return { ok: false, error: { code: "posxpay_network_error", message: "PosXPay network error" } };
}

/**
 * ยิง POSxPay 1 ครั้ง
 * @param {{method:'GET'|'POST', path:string, token:string, body?:object, env?:object}} opts
 * @returns {Promise<{ok:true,status:number,data:object}|{ok:false,error:{code,message,status?}}>}
 */
async function request({ method, path, token, body, env }) {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, error: { code: "config_missing", message: "PosXPay token is required" } };
  }
  const config = {
    method,
    url: getBaseUrl(env) + path,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBodyLength: Infinity,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  };
  if (body !== undefined) config.data = body;

  try {
    const res = await HTTP(config);
    return { ok: true, status: res.status, data: (res && res.data) || {} };
  } catch (err) {
    return normalizeError(err);
  }
}

module.exports = { request, getBaseUrl, normalizeError, envOf, DEFAULT_BASE_URL, _setHttp, _resetHttp, _setEnv, _resetEnv };

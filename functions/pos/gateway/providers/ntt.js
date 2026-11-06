// pos/gateway/providers/ntt — NTT DATA (NDPS) Host-to-Host · โชว์ QR ให้ลูกค้าสแกน (C scan B)
//
// ยกมาจากบ้านพี่น้อง (ยิงด้วยเงินจริงมาแล้ว) · 1 เจ้า 1 ไฟล์ · ประกาศตัวเองผ่าน `spec`
// สเปก NDPS = ndps-h2h-v1.14 (เลขบรรทัด :NNN ในคอมเมนต์อ้างเล่มนั้น)
//
// กับดักที่พิสูจน์ด้วยของจริงแล้ว (อย่าแก้ให้ "ง่ายขึ้น" โดยไม่อ่านก่อน)
//  1) ThaiQR ตอบ "SUCCESS" · ShopeePay ตอบ "TRADE_SUCCESS" ⇒ แมปเป็นกลุ่มสถานะ · ไม่รู้จัก = 'error' ห้ามตก 'waiting'
//  2) time_end ยาวไม่เท่ากัน (12 / 14 หลัก) ⇒ ห้าม parse ด้วยความยาวตายตัว
//  3) company_id ต้องเอาจาก response ของ auth เสมอ (ไม่ใช่ "001" ตามตัวอย่างสเปก)
//  4) token ตายเที่ยงคืน + ตายเมื่อยิงถี่ ~100-200 ครั้ง ⇒ re-auth เมื่อเจอ invalid TOKEN · retry ครั้งเดียว
//  5) re-auth แล้วยังเจอ invalid TOKEN = กระเป๋านี้ไม่ได้เปิดให้ TID ⇒ 'channel_not_enabled'
//  6) กระเป๋าไหนเปิด ดูได้จาก `walletOpenFrom` ตัวเดียว · `lastKnownAvailable` = ค่าที่รู้ล่าสุด ไม่ใช่ความจริง
//
// ความลับ: config.password ที่รับเข้ามา = รหัสผ่านจริง (plaintext · handler ถอดจาก secretBox แล้ว)
//  ⇒ ไฟล์นี้ hash เอง ตอนยิง (sha256 → base64) · plaintext ไม่ออกจากไฟล์นี้ ไม่ลง log ไม่อยู่ใน error
//  ❌ ไม่มี console.* · log มีที่เดียวใน checkChannels และผ่าน rawForLog เสมอ
//
// ทุกการยิงเน็ตผ่าน http ที่เปลี่ยนได้ (`_setHttp`) · env ผ่าน `_setEnv` · logger ผ่าน `_setLogger` — เทสไม่ออกเน็ต
"use strict";

const crypto = require("crypto");

// ── ของที่เปลี่ยนได้ตอนเทส ───────────────────────────────────────────────────────
// http(url, body, {timeout, headers}) → {data} หรือ throw แบบ axios (มี err.response / err.code)
const defaultHttp = (url, body, opts) => require("axios").post(url, body, opts);
let http = defaultHttp;
let envOverride = null;
let logger = null;

function _setHttp(fn) {
  if (typeof fn !== "function") throw new TypeError("_setHttp ต้องรับฟังก์ชัน");
  http = fn;
}
function _resetHttp() {
  http = defaultHttp;
}
function _setEnv(obj) {
  envOverride = obj && typeof obj === "object" ? obj : null;
}
function _resetEnv() {
  envOverride = null;
}
function _setLogger(l) {
  logger = l || null;
}
function _resetLogger() {
  logger = null;
}
const env = () => envOverride || process.env;
// โหลด logger ตอนใช้ (ไม่ดึง SDK ตอนโหลดไฟล์)
const log = () => logger || require("firebase-functions/logger");

// ── endpoint · env ──────────────────────────────────────────────────────────────
const DEFAULT_HOST = "https://payment.ghl.co.th";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_TEST_THROTTLE_MS = 60000; // ปุ่มทดสอบ จำผลต่อบัญชี 1 นาที
const DEFAULT_CHANNEL_CHECK_COOLDOWN_MS = 300000; // ตรวจกระเป๋า 5 นาที (1 ครั้ง = 9 requests)

// UAT ต่างกันทั้ง path ไม่ใช่แค่ host (สเปก :189-190, :709-710, :800-801)
const PATHS = {
  production: {
    auth: "/PAYMENT_AUTHENTICATION/api/WebServices/Check_User_Pass_v2",
    qr: "/PAYMENTSERVICES/ALL_QRCODE.ASPX",
    query: "/PAYMENTSERVICES/ALL_ORDERQUERY.ASPX",
  },
  uat: {
    auth: "/PAYMENT_AUTHENTICATION_UAT/api/WebServices/Check_User_Pass_v2",
    qr: "/PAYMENTSERVICES_UAT/ALL_QRCODE.ASPX",
    query: "/PAYMENTSERVICES_UAT/ALL_ORDERQUERY.ASPX",
  },
};

// default = production โดยเจตนา (credential ถูกเปิดไว้ที่ production เท่านั้น · ค่าแปลก = production)
function envName() {
  const v = String(env().NTT_ENV || "production").trim().toLowerCase();
  return v === "uat" ? "uat" : "production";
}
function baseHost() {
  const v = env().NTT_BASE_URL;
  const s = typeof v === "string" && v.trim() ? v.trim() : DEFAULT_HOST;
  return s.replace(/\/+$/, "");
}
function endpoint(kind) {
  return baseHost() + PATHS[envName()][kind];
}
function timeoutMs() {
  const n = Number(env().NTT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}
// 0 = ปิดการจำ (debug เท่านั้น)
function testThrottleMs() {
  const n = Number(env().NTT_TEST_THROTTLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TEST_THROTTLE_MS;
}
// 0 = ปิด cooldown (ห้ามใช้ใน production — ปุ่มเดียวเขี่ย token ของเส้นขายได้)
function channelCheckCooldownMs() {
  const n = Number(env().NTT_CHANNEL_CHECK_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CHANNEL_CHECK_COOLDOWN_MS;
}

// ── spec 3 ชั้น: ตัวเจ้า · บัญชีที่ร้านตั้ง (connection) · ปุ่มตอนขาย (channels) ─────────────
// NDPS ใช้ TID + รหัสผ่านชุดเดียวครอบทุกกระเป๋า ⇒ 1 บัญชี → 9 ปุ่มขาย ต่างกันแค่ tran_type
// lastKnownAvailable = ค่าที่วัดล่าสุด (2026-08-13) ใช้เป็นค่าตั้งต้นเท่านั้น · ความจริงรายร้าน = checkChannels()
const spec = {
  // `ntt-h2h` ไม่ใช่ `ntt` — NTT มีอีกผลิตภัณฑ์คือเครื่อง EDC (ntt-edc)
  id: "ntt-h2h",
  labelKey: "screens.paymentGateway.provider.ntt-h2h.name",
  labelFallback: "NTT DATA (ผ่านระบบออนไลน์)",
  runtime: "server",
  connection: {
    fields: [
      {
        key: "terminalId",
        labelKey: "screens.paymentGateway.field.ntt-h2h.terminalId",
        labelFallback: "รหัสร้าน (TID)",
        required: true,
      },
      // รหัสผ่านนี้ถอนเงินได้ ⇒ secret (เข้ารหัสด้วย secretBox) · ไฟล์นี้ hash เองตอนยิง ไม่มี store
      {
        key: "password",
        labelKey: "screens.paymentGateway.field.ntt-h2h.password",
        labelFallback: "รหัสผ่าน",
        required: true,
        secret: true,
      },
    ],
    // note ต้องเอ่ยทุกช่องที่บังคับกรอก (ทะเบียนตรวจ)
    test: {
      kind: "auth",
      note:
        "ยิง Check_User_Pass_v2 (ขอ token อย่างเดียว — ไม่มีรายการเงินเกิดขึ้นเลย) · " +
        "ครอบครบ 2/2 ช่อง: terminalId + password (NDPS ตรวจ 2 ค่านี้พร้อมกันในคำขอเดียว ผิดช่องใดช่องหนึ่ง = ตกทั้งคู่) · " +
        "ไม่ครอบ: ไม่มี — แต่ผ่านแล้วไม่ได้แปลว่าขายได้ทุกกระเป๋า (แต่ละ tran_type ต้องให้ NTT เปิดให้ TID นี้แยกต่างหาก)",
    },
  },
  // ตาราง tran_type สเปก :137-166
  channels: [
    { channelId: "nttThaiQr", nameKey: "screens.paymentGateway.channel.nttThaiQr", nameFallback: "ไทยคิวอาร์ (NTT)", tranType: "T", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttShopeePay", nameKey: "screens.paymentGateway.channel.nttShopeePay", nameFallback: "ShopeePay (NTT)", tranType: "G", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttAlipayPlus", nameKey: "screens.paymentGateway.channel.nttAlipayPlus", nameFallback: "Alipay+ (NTT)", tranType: "X", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttTrueMoney", nameKey: "screens.paymentGateway.channel.nttTrueMoney", nameFallback: "ทรูมันนี่ วอลเล็ท (NTT)", tranType: "4", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttRabbitLinePay", nameKey: "screens.paymentGateway.channel.nttRabbitLinePay", nameFallback: "แรบบิท ไลน์เพย์ (NTT)", tranType: "L", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttMaxMe", nameKey: "screens.paymentGateway.channel.nttMaxMe", nameFallback: "MAX ME (NTT)", tranType: "9", qrKind: "text", lastKnownAvailable: true },
    { channelId: "nttBblQr", nameKey: "screens.paymentGateway.channel.nttBblQr", nameFallback: "คิวอาร์ ธ.กรุงเทพ", tranType: "5", qrKind: "text", lastKnownAvailable: false },
    { channelId: "nttWechat", nameKey: "screens.paymentGateway.channel.nttWechat", nameFallback: "WeChat Pay (NTT)", tranType: "I", qrKind: "text", lastKnownAvailable: false },
    { channelId: "nttAtome", nameKey: "screens.paymentGateway.channel.nttAtome", nameFallback: "Atome (NTT)", tranType: "B", qrKind: "text", lastKnownAvailable: false },
  ],
};

// ── helpers ─────────────────────────────────────────────────────────────────────

// สูตรรหัสผ่านตามสเปก :331-360 — base64( sha256_raw( utf8(password) ) )
// ไบต์เดียวกับที่บ้านพี่น้องเก็บไว้ (sha256 ของ String(ค่าที่กรอก) ไม่ trim) ⇒ NDPS เห็นค่าเดิมเป๊ะ
function hashPassword(plain) {
  if (typeof plain !== "string" || plain === "") {
    throw new TypeError("hashPassword ต้องรับ string ที่ไม่ว่าง");
  }
  return crypto.createHash("sha256").update(plain, "utf8").digest("base64");
}

// out_trade_no สเปก :719-727 = TID 8 หลัก + สุ่ม 12 หลัก (ตัวเลข 20 ตัว · NTT ใช้กระทบยอด)
// คนละเลขกับ referenceId ของเรา
function makeOutTradeNo(tid) {
  const digits = String(tid == null ? "" : tid).replace(/\D/g, "");
  if (!digits) throw new TypeError("makeOutTradeNo ต้องรับ terminalId ที่มีตัวเลข");
  const tid8 = digits.slice(0, 8).padStart(8, "0");
  let rand = "";
  while (rand.length < 12) rand += String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  return tid8 + rand.slice(0, 12);
}

// ตาราง trade_state สเปก :417-432 · กลุ่ม void (คืนเงิน) ยุบเข้า 'closed' · ค่าดิบยังอยู่ใน raw
const TRADE_STATE_MAP = new Map([
  ["USERPAYING", "waiting"],
  ["WAIT_BUYER_PAY", "waiting"],
  ["NOTPAY", "waiting"],
  ["SUCCESS", "paid"],
  ["TRADE_SUCCESS", "paid"],
  ["TRADE_FINISHED", "paid"],
  ["PAYMENT", "paid"],
  ["REVOKED", "closed"],
  ["REFUND", "closed"],
  ["CLOSED", "closed"],
  ["TRADE_CLOSED", "closed"],
  ["PAYERROR", "error"],
  ["NOT_FOUND", "error"],
  ["ERROR", "error"],
]);

// ไม่รู้จัก / ว่าง / ไม่ใช่ string = 'error' เสมอ
function mapTradeState(s) {
  if (typeof s !== "string") return "error";
  const key = s.trim().toUpperCase();
  if (!key) return "error";
  return TRADE_STATE_MAP.get(key) || "error";
}

// time_end รับ 8/12/14 หลัก · คืนเวลาไทยแบบไม่มี Z (NTT ไม่บอก timezone) · นอกนั้น null
function parseTimeEnd(v) {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length !== 8 && d.length !== 12 && d.length !== 14) return null;
  const y = d.slice(0, 4);
  const mo = d.slice(4, 6);
  const da = d.slice(6, 8);
  const hh = d.length >= 12 ? d.slice(8, 10) : "00";
  const mi = d.length >= 12 ? d.slice(10, 12) : "00";
  const ss = d.length >= 14 ? d.slice(12, 14) : "00";
  if (+y < 2000 || +y > 2999) return null;
  if (+mo < 1 || +mo > 12) return null;
  if (+da < 1 || +da > 31) return null;
  if (+hh > 23 || +mi > 59 || +ss > 59) return null;
  return `${y}-${mo}-${da}T${hh}:${mi}:${ss}`;
}

// ── HTTP + การอ่าน response ──────────────────────────────────────────────────────
function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message: String(message).slice(0, 300) }, extra || {}) };
}

// แปลง error เป็นก้อนที่ไม่มีความลับ · ❌ ห้าม copy err.config / err.request (ถือ header tokenid)
function normalizeError(err) {
  if (err && err.response) {
    const status = err.response.status;
    const data = err.response.data || {};
    const message =
      (data && typeof data === "object" && (data.message || data.msg || data.error)) || `NTT HTTP ${status}`;
    return fail(`ntt_http_${status}`, message, { status });
  }
  if (err && (err.code === "ECONNABORTED" || /timeout/i.test((err && err.message) || ""))) {
    return fail("ntt_timeout", "NTT request timed out");
  }
  return fail("ntt_network_error", "NTT network error");
}

// ASPX บางเส้นตอบ text/plain ⇒ ลอง parse ก่อน
function coerceBody(data) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

// response 3 รูป: auth = array · qr/query = {STATUS:[{...}]} · อ่านแบบเผื่อช่องเกิน
function unwrapStatus(body) {
  const data = coerceBody(body);
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.STATUS)) return data.STATUS[0] || null;
  if (Array.isArray(data)) return data[0] || null;
  return data;
}

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

// สเปก :299-311 — {result:false, message:"invalid TOKEN"}
function isInvalidToken(obj) {
  if (!obj || typeof obj !== "object") return false;
  const msg = obj.message || obj.msg || "";
  return !truthy(obj.result) && /invalid\s*token/i.test(String(msg));
}

// "TID นี้ไม่มีสิทธิ์ในกระเป๋านี้" = รูปเปลือย (มีแค่ result/message) + ข้อความ invalid TOKEN พร้อมกัน
// กระเป๋าที่เปิดตอบ record เต็มเสมอ · เปลือยแบบ "json wrong format" = เปิด (พิสูจน์ด้วย QR ฿1 จริง)
// รูปที่ไม่เคยเห็น = ถือว่าเปิด (ผิดทางนี้ดังตอนขาย · ผิดอีกทาง = กระเป๋าถูกซ่อนเงียบ)
function isNotProvisioned(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (Object.keys(obj).some((k) => k !== "result" && k !== "message")) return false;
  return isInvalidToken(obj);
}

// เกณฑ์เดียวว่ากระเป๋าเปิดให้ TID ไหม · null = อ่านไม่ออก = ไม่รู้ (ห้ามแปลว่าปิด · ห้ามจำ)
function walletOpenFrom(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (Object.keys(obj).length === 0) return null;
  return !isNotProvisioned(obj);
}

async function post(url, body, headers) {
  try {
    const res = await http(url, body, {
      timeout: timeoutMs(),
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    });
    return { ok: true, data: res && res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

// ── config + token ──────────────────────────────────────────────────────────────
// token cache ต่อ TID ในหน่วยความจำ · ไม่มี TTL (ความจริงมาจาก response เท่านั้น) · value = {token, companyId}
const tokenCache = new Map();
// ผลปุ่มทดสอบต่อบัญชี · value = {at, result}
const connTestCache = new Map();
// ผลตรวจกระเป๋าต่อ (บัญชี × กระเป๋า) · value = {at, open, checkedAt}
const channelCheckCache = new Map();

// key บัญชี = TID + digest ของ hash (ไม่ใช้ค่า hash ตรง ๆ) · เปลี่ยนรหัสผ่าน = บัญชีใหม่
function connTestKey({ terminalId, passwordHash }) {
  const d = crypto.createHash("sha256").update(passwordHash, "utf8").digest("hex").slice(0, 16);
  return `${terminalId}:${d}`;
}
function markThrottled(result, throttled) {
  if (!result || result.ok !== true) return result;
  return { ok: true, data: { ...result.data, throttled } };
}

// เทสเท่านั้น
function __resetTokenCache() {
  tokenCache.clear();
}
function __resetConnectionTestCache() {
  connTestCache.clear();
  channelCheckCache.clear();
}

// config.password = รหัสผ่านจริง (plaintext) ⇒ hash ตรงนี้ครั้งเดียว ตอนใช้
// ไม่ trim รหัสผ่าน (ช่องว่างต้น/ท้ายเป็นส่วนของรหัสได้ · บ้านพี่น้องก็ไม่ trim ก่อน hash)
// ❌ ไม่มีทางลัด "ถ้าหน้าตาเหมือน hash แล้วไม่ hash ซ้ำ" — config ต้องเป็น plaintext เสมอ
function readConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const terminalId = typeof c.terminalId === "string" ? c.terminalId.trim() : "";
  const plain = typeof c.password === "string" ? c.password : "";
  if (!terminalId) return { error: fail("config_missing", "ยังไม่ได้ตั้ง Terminal ID (TID) ของ NTT") };
  if (!plain.trim()) return { error: fail("config_missing", "ยังไม่ได้ตั้งรหัสผ่านของ NTT") };
  return { terminalId, passwordHash: hashPassword(plain), _plain: plain };
}

function readChannel(channel) {
  if (!channel || typeof channel !== "object" || typeof channel.tranType !== "string" || !channel.tranType) {
    return { error: fail("bad_channel", "ไม่รู้จักช่องทางชำระเงินที่ส่งมา (ต้องเป็นแถวจาก spec.channels)") };
  }
  return { tranType: channel.tranType };
}

// auth สเปก :186-232 — username = TID · terminal_id = TID · password = sha256b64
async function authenticate({ terminalId, passwordHash }) {
  const res = await post(endpoint("auth"), {
    username: terminalId,
    password: passwordHash,
    terminal_id: terminalId,
  });
  if (!res.ok) return res;

  const obj = unwrapStatus(res.data);
  if (!obj) return fail("bad_response", "NTT ตอบรูปแบบที่อ่านไม่ออกตอนขอ token");

  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  if (!token) {
    const msg = obj.msg || obj.message || "NTT ปฏิเสธ TID/รหัสผ่าน";
    return fail("auth_failed", msg);
  }
  const companyId = obj.company_id != null ? String(obj.company_id) : "";
  if (!companyId) return fail("bad_response", "NTT ไม่ได้คืน company_id ตอน auth");

  tokenCache.set(terminalId, { token, companyId });
  return { ok: true, data: { token, companyId } };
}

async function getSession(creds, { forceRefresh } = {}) {
  if (!forceRefresh) {
    const hit = tokenCache.get(creds.terminalId);
    if (hit) return { ok: true, data: hit, fromCache: true };
  }
  tokenCache.delete(creds.terminalId);
  const r = await authenticate(creds);
  if (!r.ok) return r;
  return { ok: true, data: r.data, fromCache: false };
}

// ── testConnection — ปุ่ม "ทดสอบการเชื่อมต่อ" (auth ล้วน · ไม่มีเงินเคลื่อน) ─────────────────
// เบรกอยู่ที่นี่ (ไม่ใช่ที่ route) เพราะกดรัว = เขี่ย token ของเส้นขาย TID เดียวกัน
// จำผลต่อบัญชี (TID + รหัสผ่าน) ทั้งผลผ่านและผลล้ม ไว้ testThrottleMs()
async function testConnection(input) {
  const { config } = input || {};
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  const key = connTestKey(cfg);
  const ttl = testThrottleMs();
  const hit = connTestCache.get(key);
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) return markThrottled(hit.result, true);

  const r = await authenticate(cfg);
  const result = r.ok
    ? {
        ok: true,
        data: {
          verifiedFields: ["terminalId", "password"],
          companyId: r.data.companyId,
          note: "เชื่อมต่อ NDPS ได้จริง (Check_User_Pass_v2 ผ่าน) — ตรวจครบ 2/2 ช่อง · ไม่มีรายการเงินเกิดขึ้นจากการทดสอบนี้",
        },
      }
    : r;
  connTestCache.set(key, { at: Date.now(), result });
  return markThrottled(result, false);
}

// ── checkChannels — วันนี้ TID เปิดกระเป๋าไหนบ้าง ───────────────────────────────────────
// ยิง ALL_ORDERQUERY ด้วย out_trade_no ที่ไม่มีจริง ต่างแค่ tran_type → อ่านด้วย walletOpenFrom
// ต้องใช้ token สดก่อนเสมอ (invalid TOKEN แปลได้ 2 อย่าง) · ยิงทีละตัว ไม่ขนาน
// จำผลต่อ (บัญชี × กระเป๋า) ไว้ cooldown · ผลที่ "ไม่รู้" ไม่จำ · ❌ ห้ามใช้ ALL_QRCODE (= เงินจริง)
// คืน results[].open: true เปิด · false ปิด · null ถามไม่สำเร็จ (ห้ามแปลว่าปิด)

// ค่าดิบสำหรับ log: ตัด key ลับทั้งช่อง · mask ค่า config ที่ถูก echo กลับ · ยาว ≤500
const LOG_SECRET_KEY = /token|password|secret|credential/i;
function rawForLog(value, cfg) {
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (LOG_SECRET_KEY.test(k)) continue;
        out[k] = scrub(val);
      }
      return out;
    }
    return v;
  };
  let s;
  try {
    s = JSON.stringify(scrub(value === undefined ? null : value));
  } catch (_) {
    return "(stringify ไม่ได้)";
  }
  for (const secret of [cfg && cfg.terminalId, cfg && cfg.passwordHash, cfg && cfg._plain]) {
    if (typeof secret === "string" && secret.length >= 4 && s.includes(secret)) s = s.split(secret).join("«ปกปิด»");
  }
  return s.slice(0, 500);
}

async function checkChannels(input) {
  const { config } = input || {};
  // ไม่ส่ง channels = ตรวจครบทุกกระเป๋าใน spec
  const channels = input && input.channels !== undefined ? input.channels : spec.channels;

  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  if (!Array.isArray(channels) || channels.length === 0) {
    return fail("bad_input", "checkChannels ต้องส่ง channels อย่างน้อย 1 ช่องทาง (แถวจาก spec.channels)");
  }
  for (const c of channels) {
    if (!c || typeof c.channelId !== "string" || !c.channelId || typeof c.tranType !== "string" || !c.tranType) {
      return fail("bad_channel", "channels[] ต้องเป็นแถวจาก spec.channels (มี channelId + tranType)");
    }
  }

  const acct = connTestKey(cfg);
  const cooldown = channelCheckCooldownMs();
  const now = Date.now();

  const results = [];
  const pending = [];
  for (const c of channels) {
    const hit = channelCheckCache.get(`${acct}|${c.channelId}`);
    if (hit && cooldown > 0 && now - hit.at < cooldown) {
      results.push({ channelId: c.channelId, open: hit.open, checkedAt: hit.checkedAt, cached: true });
    } else {
      pending.push(c);
    }
  }
  if (!pending.length) return { ok: true, data: { results } };

  // token สดใบเดียวทั้งรอบ · ล้มตรงนี้ = ล้มทั้งรอบ ไม่มีผลลวง
  const session = await getSession(cfg, { forceRefresh: true });
  if (!session.ok) return session;

  for (const c of pending) {
    const checkedAt = new Date().toISOString();
    const res = await post(
      endpoint("query"),
      {
        tran_type: c.tranType,
        out_trade_no: makeOutTradeNo(cfg.terminalId), // เลขที่ไม่มีจริง ไม่แตะรายการของใคร
        terminal_id: cfg.terminalId,
        company_id: session.data.companyId,
      },
      { tokenid: session.data.token },
    );

    let row;
    let rawSrc;
    if (!res.ok) {
      row = { channelId: c.channelId, open: null, checkedAt, cached: false, reason: res.error.code };
      rawSrc = res.error;
    } else {
      const open = walletOpenFrom(unwrapStatus(res.data));
      rawSrc = res.data;
      if (open === null) {
        row = { channelId: c.channelId, open: null, checkedAt, cached: false, reason: "bad_response" };
      } else {
        channelCheckCache.set(`${acct}|${c.channelId}`, { at: Date.now(), open, checkedAt });
        row = { channelId: c.channelId, open, checkedAt, cached: false };
      }
    }

    // หลักฐานดิบรายกระเป๋าที่ถามจริง (ตอบคำถาม "กระเป๋าโดนปิด NTT ตอบว่าอะไร") · ผ่าน rawForLog เท่านั้น
    log().info("function:pos/gateway/providers/ntt/checkChannels:wallet", {
      channelId: row.channelId,
      open: row.open,
      ...(row.reason ? { reason: row.reason } : {}),
      raw: rawForLog(rawSrc, cfg),
    });
    results.push(row);
  }

  const byId = new Map(results.map((r) => [r.channelId, r]));
  return { ok: true, data: { results: channels.map((c) => byId.get(c.channelId)).filter(Boolean) } };
}

// เส้นที่ใช้ token: invalid TOKEN ครั้งแรก → re-auth แล้วยิงซ้ำครั้งเดียว · ซ้ำอีก = channel_not_enabled
async function callWithToken(creds, kind, buildBody) {
  let session = await getSession(creds);
  if (!session.ok) return session;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await post(endpoint(kind), buildBody(session.data), { tokenid: session.data.token });
    if (!res.ok) return res;

    const obj = unwrapStatus(res.data);
    if (!obj) return fail("bad_response", "NTT ตอบรูปแบบที่อ่านไม่ออก");

    if (isInvalidToken(obj)) {
      if (attempt === 0) {
        const next = await getSession(creds, { forceRefresh: true });
        if (!next.ok) return next;
        session = next;
        continue;
      }
      return fail(
        "channel_not_enabled",
        "NTT ปัดด้วยข้อความ invalid TOKEN ทั้งที่ token เพิ่งขอใหม่ — แปลว่าช่องทางนี้ยังไม่ได้เปิดให้ TID นี้",
      );
    }
    return { ok: true, data: obj, companyId: session.data.companyId };
  }
  /* istanbul ignore next */
  return fail("channel_not_enabled", "NTT ปัดด้วย invalid TOKEN ซ้ำ");
}

function upstreamMessage(obj, fallback) {
  const m = obj && (obj.message || obj.msg);
  return m ? String(m) : fallback;
}

// ── createQR — ALL_QRCODE (สเปก :700-760) ───────────────────────────────────────────────
// input: channel (แถวจาก spec.channels) · config {terminalId, password(plaintext)} · amount (บาท)
//        channelOpen? = ผลตรวจสดรายร้าน (ชนะ lastKnownAvailable) · ไม่ใช่ boolean = ใช้ lastKnownAvailable (fail-closed)
// referenceId ไม่ส่งให้ NTT (ใช้ผูกฝั่งเราเท่านั้น)
async function createQR(input) {
  const { channel, config, amount, channelOpen } = input || {};

  const ch = readChannel(channel);
  if (ch.error) return ch.error;

  const open = typeof channelOpen === "boolean" ? channelOpen : channel.lastKnownAvailable !== false;
  if (!open) {
    return fail(
      "channel_not_enabled",
      typeof channelOpen === "boolean"
        ? `ช่องทาง ${channel.channelId || ch.tranType} ตรวจล่าสุดแล้วว่ายังไม่เปิดให้ TID นี้ (ตรวจใหม่ด้วยปุ่มตรวจกระเป๋า)`
        : `ช่องทาง ${channel.channelId || ch.tranType} ยังไม่ได้เปิดให้ TID นี้ (ค่าที่รู้ล่าสุด — ตรวจใหม่ด้วยปุ่มตรวจกระเป๋า)`,
    );
  }

  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return fail("bad_amount", `ยอดเงินไม่ถูกต้อง: ${amount}`);
  const totalFee = n.toFixed(2);

  // สเปก :726 — tran_type 5 ต้องส่ง out_trade_no ว่าง แล้วรับเลขจาก NTT
  const ours = ch.tranType === "5" ? "" : makeOutTradeNo(cfg.terminalId);

  const res = await callWithToken(cfg, "qr", (session) => ({
    tran_type: ch.tranType,
    out_trade_no: ours,
    terminal_id: cfg.terminalId,
    company_id: session.companyId,
    total_fee: totalFee,
  }));
  if (!res.ok) return res;

  const obj = res.data;
  if (!truthy(obj.result)) {
    return fail("ntt_error", upstreamMessage(obj, "NTT ปฏิเสธการสร้าง QR"));
  }

  const qrPayload = typeof obj.code_url === "string" ? obj.code_url.trim() : "";
  if (!qrPayload) return fail("bad_response", "NTT ตอบว่าสำเร็จแต่ไม่มี code_url");

  // out_trade_no ที่ NTT คืนชนะของเรา — เป็นกุญแจกระทบยอด และเป็นตัวเดียวที่ notify ส่งกลับมา
  const providerRef = obj.out_trade_no != null && String(obj.out_trade_no).trim() ? String(obj.out_trade_no).trim() : ours;
  if (!providerRef) return fail("bad_response", "ไม่ได้ out_trade_no ทั้งจากเราและจาก NTT");

  const chargeId = obj.prepay_id != null && String(obj.prepay_id).trim() ? String(obj.prepay_id).trim() : null;

  return { ok: true, data: { providerRef, chargeId, qrPayload, qrKind: "text" } };
}

// ── inquiry — ALL_ORDERQUERY (สเปก :788-900) ───────────────────────────────────────────
// ไม่ปัดตาม lastKnownAvailable — บิลที่สร้างไปแล้วต้องตามสถานะได้เสมอ
// expectedAmount ไม่ใช้ที่นี่ (เหมือนพี่น้อง) · handler เทียบยอดเองผ่าน settle.confirmPaid
async function inquiry(input) {
  const { channel, config, providerRef } = input || {};

  const ch = readChannel(channel);
  if (ch.error) return ch.error;

  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  const ref = typeof providerRef === "string" ? providerRef.trim() : "";
  if (!ref) return fail("bad_input", "inquiry ต้องมี providerRef (out_trade_no)");

  const res = await callWithToken(cfg, "query", (session) => ({
    tran_type: ch.tranType,
    out_trade_no: ref,
    terminal_id: cfg.terminalId,
    company_id: session.companyId,
  }));
  if (!res.ok) return res;

  const obj = res.data;
  const hasState = typeof obj.trade_state === "string" && obj.trade_state.trim() !== "";
  // มี trade_state = อ่านได้ (ThaiQR ก่อนจ่ายตอบ NOT_FOUND)
  if (!hasState) {
    if (!truthy(obj.result)) return fail("ntt_error", upstreamMessage(obj, "NTT ปฏิเสธคำขอเช็คสถานะ"));
    return fail("bad_response", "NTT ตอบสำเร็จแต่ไม่มี trade_state");
  }

  const amt = Number(obj.amount);
  const state = mapTradeState(obj.trade_state);
  // ช่อง amount ของ NTT = ยอดที่เราขอ ไม่ใช่ยอดที่จ่ายแล้ว ⇒ รายงานเฉพาะตอน paid (ไม่งั้นด่านเทียบยอดเป็นวงกลม)
  return {
    ok: true,
    data: {
      state,
      amountPaid: state === "paid" && Number.isFinite(amt) ? amt : null,
      paidAt: parseTimeEnd(obj.time_end),
      raw: obj,
    },
  };
}

// ── webhook helper — แกะ notify ของ NDPS (สเปก §3 Notification · pure ไม่แตะฐาน ไม่แตะเน็ต) ────────
// รูปที่ NDPS ส่ง = JSON {ref, buyer, paidby, terminal_id, transaction_id, tran_amount, tran_date,
//   tran_time, transaction_status:"SALE"|"VOID", out_trade_no, ...} · รับ string JSON / form-encoded ไว้ด้วยเผื่อ
// 🔴 NTT notify ไม่มีลายเซ็นเลยสักชั้น ⇒ ใครเดา URL ได้ก็ POST ว่า "จ่ายแล้ว" ได้
//    ⇒ ทุกช่องในนี้เป็นแค่ "สัญญาณให้ไปถาม" · handler ต้องหา pgWebhook ด้วย providerRef
//      แล้วถาม NTT ใหม่ด้วย inquiry และเทียบยอดถึงสตางค์ทุกครั้ง ❌ ห้ามใช้ state/amount ข้างล่างตัดสิน
// คืน {ok:true, outTradeNo, providerRef, state?, amount?, raw} | {ok:false, error:{code, message}}
function parseNotify(body) {
  let b = body;
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    const s = b.trim();
    let parsed = null;
    if (s.startsWith("{")) {
      try {
        parsed = JSON.parse(s);
      } catch (_) {
        parsed = null;
      }
    } else if (s.includes("=")) {
      parsed = Object.fromEntries(new URLSearchParams(s));
    }
    b = parsed;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return fail("notify_bad_body", "notify ของ NTT อ่านไม่ออก");
  }

  const v = b.out_trade_no !== undefined ? b.out_trade_no : b.outTradeNo;
  const outTradeNo = v === undefined || v === null ? "" : String(v).trim();
  if (!outTradeNo) return fail("notify_missing_out_trade_no", "notify ของ NTT ไม่มี out_trade_no");

  const out = { ok: true, outTradeNo, providerRef: outTradeNo, raw: b };
  // ค่าบอกใบ้เท่านั้น (ไม่ผ่านการยืนยัน)
  const st = typeof b.transaction_status === "string" ? b.transaction_status.trim().toUpperCase() : "";
  if (st === "SALE") out.state = "paid";
  else if (st === "VOID") out.state = "closed";
  const amt = Number(b.tran_amount);
  if (b.tran_amount !== undefined && b.tran_amount !== null && b.tran_amount !== "" && Number.isFinite(amt)) out.amount = amt;
  return out;
}

module.exports = {
  spec,
  createQR,
  inquiry,
  testConnection,
  checkChannels,
  // webhook
  parseNotify,
  // helpers (เทส + จอตั้งค่า)
  hashPassword,
  makeOutTradeNo,
  mapTradeState,
  parseTimeEnd,
  walletOpenFrom,
  // ของเปลี่ยนได้ตอนเทส
  _setHttp,
  _resetHttp,
  _setEnv,
  _resetEnv,
  _setLogger,
  _resetLogger,
  __resetTokenCache,
  __resetConnectionTestCache,
};

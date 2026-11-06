// pos/gateway/providers/kbank-qr.js — ธนาคารกสิกรไทย ThaiQR ผ่านเครื่องกลาง mTLS ของพี่น้อง (ก้อน 7 · DEV-0001)
//
// KBank บังคับ mTLS ⇒ เราไม่คุยกับธนาคารตรง · เส้นทาง = functions ──HTTPS+กุญแจตัวกลาง──► เครื่องกลาง ──mTLS+OAuth──► KBank
//   (Pack เลือก 4-2 วันที่ 2026-11-06: ใช้เครื่องกลางของพี่น้องร่วมกัน · ดู .claude/rules/separate-home.md ข้อยกเว้น)
// ❌ ไม่มี URL/กุญแจในโค้ด — อ่านจาก env เท่านั้น: KBANK_PROXY_URL · KBANK_PROXY_KEY · KBANK_PROXY_KEY_HEADER (ชื่อ header กุญแจ)
//   ขาดตัวใดตัวหนึ่ง = fail-closed `kbank_proxy_not_configured` ทุกฟังก์ชันที่ออกเน็ต และไม่ยิงสักครั้ง
//
// "ยิงไม่ผ่าน" มี 3 ชั้นที่ความหมายต่างกัน: ① ไปไม่ถึงเครื่องกลาง ② เครื่องกลางไปไม่ถึงธนาคาร ③ ธนาคารปฏิเสธค่าที่ร้านกรอก
//   ⇒ ① ② ห้ามแปลว่า "รหัสร้านผิด" · แยกด้วยโครงคำตอบ (มีก้อน data ไหม) ไม่ใช่ข้อความ
//
// กับดักของเครื่องกลางที่พี่น้องเจอจริง:
//  1) เส้น createQR แปลงยอด 0/ว่าง เป็น ฿1 เงียบ ๆ แล้วสร้างรายการจริง ⇒ ปัดยอด ≤ 0 ก่อนแตะเน็ต · ปุ่มทดสอบห้ามแตะ createQR
//  2) เส้น testToken = เขียวหลอก (ไม่แตะ merchantId · token cache ~28 นาที) ⇒ ปุ่มทดสอบ = ถาม inquiry ด้วยเลขรายการที่ไม่มีจริง
//  3) path ขึ้นต้น `/uat` เป็นชื่อหลอก — คือเส้นรับเงินจริง (ตั้งใน KBANK_PROXY_URL ทั้งก้อน)
"use strict";

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 20000; // เครื่องกลางตั้ง timeout ขาไปธนาคาร 15s ⇒ ของเราต้องยาวกว่า
const DEFAULT_TEST_THROTTLE_MS = 60000; // ปุ่มทดสอบ — จำผลต่อ merchantId 1 นาที (เครื่องกลางมีเครื่องเดียว)
const REF3_TAG = "SHOPCHAMP"; // ป้ายบอกที่มาในรายงานธนาคาร

// ── env · http ที่ฉีดได้ (เทสไม่ออกเน็ตเด็ดขาด) ──────────────────────────────────
let ENV_OVERRIDE = null;
function _setEnv(obj) {
  ENV_OVERRIDE = obj && typeof obj === "object" ? obj : null;
}
function _resetEnv() {
  ENV_OVERRIDE = null;
}
function envOf(input) {
  if (input && input.env && typeof input.env === "object") return input.env;
  return ENV_OVERRIDE || process.env;
}

// http(url, body, {timeout, headers}) → {status, data} หรือ throw แบบ axios (err.response / err.code)
const defaultHttp = (url, body, opts) => require("axios").post(url, body, opts);
let HTTP = defaultHttp;
function _setHttp(fn) {
  HTTP = typeof fn === "function" ? fn : defaultHttp;
}
function _resetHttp() {
  HTTP = defaultHttp;
}

const str = (v) => (v == null ? "" : String(v).trim());

function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message: String(message).slice(0, 300) }, extra || {}) };
}

/** ค่าตัวกลางจาก env · ขาดตัวใด = error (ไม่บอกค่า บอกแค่ชื่อ env) */
function proxyConfig(env) {
  const url = str(env.KBANK_PROXY_URL).replace(/\/+$/, "");
  const key = str(env.KBANK_PROXY_KEY);
  const header = str(env.KBANK_PROXY_KEY_HEADER);
  const missing = [];
  if (!url) missing.push("KBANK_PROXY_URL");
  if (!key) missing.push("KBANK_PROXY_KEY");
  if (!header) missing.push("KBANK_PROXY_KEY_HEADER");
  if (missing.length) {
    return {
      error: fail(
        "kbank_proxy_not_configured",
        `ระบบยังไม่ได้ตั้งค่าตัวกลางกสิกร (${missing.join(", ")}) — ติดต่อทีมงาน Shopchamp`,
      ),
    };
  }
  return { url, key, header };
}

function timeoutMs(env) {
  const n = Number(env.KBANK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** ตั้ง 0 = ปิดการจำผลปุ่มทดสอบ */
function testThrottleMs(env) {
  const n = Number(env.KBANK_TEST_THROTTLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TEST_THROTTLE_MS;
}

// รหัสที่วัดจริง 2026-08-14 (พี่น้องยิง inquiry 3 นัด ต่างกันแค่ merchantId):
//   statusCode เป็น "10" เท่ากันทุกนัด ⇒ ใช้ตัดสินไม่ได้ · ตัวชี้ขาดคือ errorCode (เทียบแบบไม่สนตัวพิมพ์)
//   และเครื่องกลางคืน 200 + success:true แม้ธนาคารปฏิเสธ ⇒ ต้องอ่านลึกถึง data.errorCode
const TEST_PASS_ERROR_CODES = ["INVALID_ORIGPARTNERTXNUID"]; // รู้จักร้าน แค่ไม่มีเลขรายการ = ผ่าน
const TEST_BAD_MERCHANT_ERROR_CODES = ["INVALID_MERCHANT"]; // ไม่รู้จักร้าน = รหัสร้านผิด (ตัวเดียวที่ฟันธงได้)

/** รหัสใหม่ที่แปลว่า "รู้จักร้าน ไม่มีรายการ" เติมทาง env ได้ · ทับ INVALID_MERCHANT ไม่ได้ */
function notFoundCodes(env) {
  const raw = env.KBANK_QR_TEST_NOTFOUND_CODES;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

// ── spec 3 ชั้น (ทะเบียน providers/index.js บังคับโครง) ──────────────────────────
const spec = {
  id: "kbank-qr", // ไม่ใช่ `kbank` เฉย ๆ — KBank มีหลายผลิตภัณฑ์คนละรูป
  labelKey: "screens.paymentGateway.provider.kbank-qr.name",
  labelFallback: "ธนาคารกสิกรไทย (ไทยคิวอาร์)",
  runtime: "server", // เซิร์ฟเวอร์เรายิงเอง (ผ่านตัวกลาง)
  connection: {
    fields: [
      {
        // ช่องเดียว — ความลับจริง (cert mTLS · OAuth) อยู่บนเครื่องกลาง ไม่ใช่ของร้าน
        // ไม่ติด secret: merchantId เป็นเลขระบุตัวร้าน ถอนเงินไม่ได้
        key: "merchantId",
        labelKey: "screens.paymentGateway.field.kbank-qr.merchantId",
        labelFallback: "รหัสร้าน (Merchant ID)",
        required: true,
      },
    ],
    test: {
      kind: "query-nonexistent",
      note:
        "ถามสถานะของเลขรายการที่ไม่มีอยู่จริง ผ่านตัวกลาง (อ่านอย่างเดียว — ไม่สร้างรายการเงิน ไม่แตะยอดใด ๆ) · " +
        "ครอบ 1/1 ช่องบังคับ: merchantId — คำถามถูกส่งไปถึงธนาคารพร้อมเลขร้านที่กรอกจริง แล้วธนาคารเป็นคนตอบว่ารู้จักหรือไม่ · " +
        "ไม่ครอบ: ไม่พิสูจน์ว่าร้านเปิดรับ ThaiQR อยู่จริง · ไม่พิสูจน์ว่าสร้าง QR ได้ · ไม่พิสูจน์วงเงิน/ค่าธรรมเนียม · " +
        "เมื่อตัวกลางหรือธนาคารล่ม ระบบจะตอบว่ายังทดสอบไม่ได้ ไม่ใช่ 'เลขร้านผิด'",
    },
  },
  // ThaiQR แถวเดียว · ไม่มี QR Credit
  channels: [
    {
      channelId: "kbankThaiQr",
      nameKey: "screens.paymentGateway.channel.kbankThaiQr",
      nameFallback: "ไทยคิวอาร์ (กสิกร)", // ต้องไม่ซ้ำกับไทยคิวอาร์ของ NTT
      qrType: "3", // ค่าของธนาคาร: '3' = ThaiQR ระบุยอดตายตัว (ไม่ใช่ 'thai_qr_payment' ของเครื่อง EDC)
      qrKind: "text", // เครื่องกลางคืน qrCode เป็นข้อความ จอ render เอง
      lastKnownAvailable: true,
    },
  ],
};

// ── helpers ───────────────────────────────────────────────────────────────────
function readConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const merchantId = str(c.merchantId);
  if (!merchantId) return { error: fail("config_missing", "ยังไม่ได้ตั้งรหัสร้าน (Merchant ID) ของกสิกร") };
  return { merchantId };
}

/** รับเฉพาะแถวจาก spec.channels ของเจ้านี้ (มี qrType) */
function readChannel(channel) {
  if (!channel || typeof channel !== "object" || !str(channel.qrType)) {
    return { error: fail("bad_channel", "ไม่รู้จักช่องทางชำระเงินที่ส่งมา (ต้องเป็นแถวจาก spec.channels ของ kbank-qr)") };
  }
  return { qrType: str(channel.qrType) };
}

function proxyErrText(body) {
  if (!body || typeof body !== "object") return typeof body === "string" ? body.slice(0, 200) : "";
  const e = body.error;
  if (typeof e === "string") return e.slice(0, 200);
  if (e && typeof e === "object") {
    const m = e.errorDesc || e.message || e.error_description || e.error;
    if (m) return String(m).slice(0, 200);
    try {
      return JSON.stringify(e).slice(0, 200);
    } catch (_) {
      return "";
    }
  }
  return "";
}

/**
 * error ของ http → ก้อนที่ไม่มีความลับ แยกชั้นชัด
 * ❌ ห้าม copy err.config / err.request (ถือ header กุญแจ)
 * 403 = กุญแจตัวกลางไม่ตรง · ≥500 = เครื่องกลาง/ธนาคารล้ม · ไม่มี response = ไปไม่ถึง
 */
function normalizeError(err, secret) {
  const scrub = (s) => (secret ? String(s).split(secret).join("***") : String(s));
  if (err && err.response) {
    const status = err.response.status;
    const detail = scrub(proxyErrText(err.response.data));
    if (status === 403) {
      return fail("kbank_proxy_unauthorized", "ตัวกลางปฏิเสธคำขอ (กุญแจตัวกลางไม่ตรง) — เป็นเรื่องฝั่งระบบ ไม่ใช่รหัสร้านที่กรอก", { status });
    }
    // ประโยค "ยังตรวจรหัสร้านไม่ได้" ต้องอยู่เสมอ แล้วค่อยต่อรายละเอียดจริง
    if (status >= 500) {
      return fail("kbank_upstream_error", `ตัวกลาง/ธนาคารตอบผิดพลาด (HTTP ${status}) — ยังตรวจรหัสร้านไม่ได้${detail ? " · " + detail : ""}`, { status });
    }
    return fail(`kbank_proxy_http_${status}`, `ตัวกลางตอบ HTTP ${status} — ยังตรวจรหัสร้านไม่ได้${detail ? " · " + detail : ""}`, { status });
  }
  if (err && (err.code === "ECONNABORTED" || /timeout/i.test((err && err.message) || ""))) {
    return fail("kbank_proxy_timeout", "ติดต่อตัวกลางไม่ทันเวลา — ยังตรวจรหัสร้านไม่ได้");
  }
  return fail("kbank_proxy_unreachable", "ติดต่อตัวกลางไม่ได้ (เครื่องอาจดับ/เน็ตมีปัญหา) — ยังตรวจรหัสร้านไม่ได้");
}

/**
 * ยิงตัวกลางแล้วคลี่ซองนอกออก เหลือคำตอบธนาคาร
 * ซอง: สำเร็จ 200 {success:true, data} · ล้ม 500 {success:false, error} (ไม่มี data)
 * ตัวแยกชั้น = มีก้อน data ไหม (มี = ธนาคารเป็นคนตอบ)
 */
async function postProxy(env, pathName, body) {
  const pc = proxyConfig(env);
  if (pc.error) return pc.error; // ไม่ตั้งค่า = ไม่ยิงเลย
  let res;
  try {
    res = await HTTP(`${pc.url}/${pathName}`, body, {
      timeout: timeoutMs(env),
      headers: { "Content-Type": "application/json", [pc.header]: pc.key },
    });
  } catch (err) {
    return normalizeError(err, pc.key);
  }
  const envelope = res && res.data;
  if (!envelope || typeof envelope !== "object") return fail("kbank_bad_response", "ตัวกลางตอบรูปแบบที่อ่านไม่ออก");
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object") {
    const detail = proxyErrText(envelope).split(pc.key).join("***");
    return fail("kbank_upstream_error", `ตัวกลางตอบว่าไม่สำเร็จ — ยังตรวจรหัสร้านไม่ได้${detail ? " · " + detail : ""}`);
  }
  return { ok: true, data: envelope.data };
}

// ── testConnection (query-nonexistent) ─────────────────────────────────────────
const connTestCache = new Map(); // ต่อ merchantId · in-memory เท่าอายุ instance

function __resetConnectionTestCache() {
  connTestCache.clear();
}

function markThrottled(result, throttled) {
  if (!result || result.ok !== true) return result;
  return { ok: true, data: { ...result.data, throttled } };
}

// เลขรายการจริงที่ตัวกลางสร้าง = ตัวอักษรล้วนต่อด้วยตัวเลขล้วน ⇒ ใส่ขีดกลางจะชนของจริงไม่ได้ · สุ่มใหม่ทุกครั้ง
function makeProbeRef() {
  return `${REF3_TAG}-CONNTEST-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

/** เกณฑ์ตัดสินคำตอบปุ่มทดสอบ · bad-merchant เช็คก่อนและ env ทับไม่ได้ · ไม่รู้จัก = unknown (ห้ามว่ารหัสร้านผิด) */
function classifyTestResponse(v, env) {
  const statusCode = str(v && v.statusCode);
  const errorCode = str(v && v.errorCode).toUpperCase();
  if (errorCode && TEST_BAD_MERCHANT_ERROR_CODES.includes(errorCode)) return "bad-merchant";
  if (statusCode === "00") return "pass";
  if (errorCode && (TEST_PASS_ERROR_CODES.includes(errorCode) || notFoundCodes(env || envOf()).includes(errorCode))) return "pass";
  return "unknown";
}

/**
 * ปุ่มทดสอบ — เบรกอยู่ที่นี่ (ทุกทางเข้าผ่าน) เพื่อกันกดรัวไปเบียดเครื่องกลางที่เก็บเงินร้านอื่นอยู่
 * จำทั้งผลผ่านและผลล้มต่อ merchantId ตาม testThrottleMs
 */
async function testConnection(input) {
  const { config } = input || {};
  const env = envOf(input);
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const pc = proxyConfig(env);
  if (pc.error) return pc.error; // ไม่จำผลนี้ — ตั้ง env แล้วกดใหม่ต้องยิงจริง

  const ttl = testThrottleMs(env);
  const hit = connTestCache.get(cfg.merchantId);
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) return markThrottled(hit.result, true);

  // เส้น inquiry เท่านั้น (อ่านอย่างเดียว) · ❌ ห้ามเปลี่ยนไป createQR (ยอด 0 → ฿1)
  const r = await postProxy(env, "inquiry", { merchantId: cfg.merchantId, origPartnerTxnUid: makeProbeRef() });

  let result;
  if (!r.ok) {
    result = r; // ①② ยังไปไม่ถึงคำตัดสินธนาคาร
  } else {
    const statusCode = str(r.data.statusCode);
    const errorCodeRaw = str(r.data.errorCode); // แสดงรูปดิบ
    const verdict = classifyTestResponse({ statusCode, errorCode: errorCodeRaw }, env);
    if (verdict === "pass") {
      result = {
        ok: true,
        data: {
          verifiedFields: [spec.connection.fields[0].key],
          note:
            "ถามสถานะรายการที่ไม่มีอยู่จริงผ่านตัวกลางแล้วธนาคารตอบว่ารู้จักร้านนี้ = รหัสร้านนี้ใช้ถามธนาคารได้จริง · " +
            "ไม่มีรายการเงินเกิดขึ้นจากการทดสอบนี้ · ยังไม่ได้พิสูจน์ว่าสร้าง QR รับเงินได้ (คนละเส้น)",
        },
      };
    } else if (verdict === "bad-merchant") {
      // ไม่เอา errorDesc ของธนาคารเป็นประโยคหลัก (ข้อความ dev) — แนบรหัสท้ายพอ
      result = fail(
        "kbank_merchant_rejected",
        `ธนาคารไม่รู้จักรหัสร้านนี้ — รหัสร้าน (Merchant ID) ไม่ถูกต้อง ตรวจเลขที่กรอกอีกครั้ง (errorCode=${errorCodeRaw})`,
      );
    } else {
      // รหัสที่ไม่มีเอกสาร = ยังยืนยันไม่ได้ · ไม่นับผ่าน และไม่ฟันว่าเลขผิด
      result = fail(
        "kbank_test_inconclusive",
        `ยังยืนยันรหัสร้านไม่ได้ — ธนาคารตอบด้วยรหัสที่ระบบยังไม่รู้จัก (statusCode=${statusCode || "-"} · errorCode=${errorCodeRaw || "-"}) ยังสรุปไม่ได้ว่าเลขที่กรอกใช้ได้หรือไม่`,
      );
    }
  }
  connTestCache.set(cfg.merchantId, { at: Date.now(), result });
  return markThrottled(result, false);
}

// ── createQR (สร้างรายการเงินจริง) ───────────────────────────────────────────────
/**
 * ref1 = referenceId (= doc id ของ pgWebhook) · ธนาคาร echo กลับใน callback เป็น reference1
 * ref2 = shopId (ไม่ส่ง = ตัวกลางเติมค่าตั้งต้นของมันเองลงรายงานธนาคาร) · ref3 = ป้ายที่มา · ❌ ไม่มี ref4
 * partnerTxnUid = ทั้งกุญแจตามสถานะและเลขรายการ ⇒ providerRef = chargeId ค่าเดียวกัน
 */
async function createQR(input) {
  const { channel, config, amount, referenceId, shopId } = input || {};
  const env = envOf(input);
  const ch = readChannel(channel);
  if (ch.error) return ch.error;
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  // ด่านสำคัญสุด: ตัวกลางแปลงยอด 0/ว่าง เป็น ฿1 แล้วสร้างรายการจริง ⇒ ปัดก่อนแตะเน็ต
  const n = Number(amount);
  if (amount === null || amount === "" || !Number.isFinite(n) || n <= 0) {
    return fail("bad_amount", `ยอดเงินไม่ถูกต้อง: ${amount} (ตัวกลางจะแปลงยอด 0 เป็น ฿1 แล้วสร้างรายการจริง)`);
  }
  const ref1 = str(referenceId);
  if (!ref1) return fail("bad_input", "createQR ต้องมี referenceId (ธนาคาร echo ค่านี้กลับมาใน callback)");

  const body = { qrType: ch.qrType, merchantId: cfg.merchantId, amount: n, ref1, ref3: REF3_TAG };
  if (str(shopId)) body.ref2 = str(shopId);

  const r = await postProxy(env, "createQR", body);
  if (!r.ok) return r;
  const d = r.data;
  const statusCode = str(d.statusCode);
  if (statusCode !== "00") {
    return fail("kbank_error", str(d.errorDesc) || `ธนาคารปฏิเสธการสร้าง QR (statusCode=${statusCode || "-"}${str(d.errorCode) ? " errorCode=" + str(d.errorCode) : ""})`);
  }
  const providerRef = str(d.partnerTxnUid);
  const qrPayload = str(d.qrCode);
  if (!providerRef) return fail("bad_response", "ธนาคารตอบว่าสำเร็จแต่ไม่มี partnerTxnUid (ไม่มีเลขไว้ตามสถานะ)");
  if (!qrPayload) return fail("bad_response", "ธนาคารตอบว่าสำเร็จแต่ไม่มี qrCode");
  return { ok: true, data: { providerRef, chargeId: providerRef, qrPayload, qrKind: "text" } };
}

// ── inquiry ──────────────────────────────────────────────────────────────────
// ตารางสถานะโตจากของที่เห็นจริงทีละค่าเท่านั้น · ไม่รู้จัก = 'error' (ไม่ใช่ waiting)
const TXN_STATUS_MAP = new Map([
  ["PAID", "paid"], // ค่าที่เส้นเดิมใช้เก็บเงินอยู่
  ["REQUESTED", "waiting"], // เห็นบน production 2026-08-14 ตอนยังไม่มีใครจ่าย
  ["EXPIRED", "closed"], // เห็นบน production 2026-08-14 · อายุ QR ~10 นาที
]);

// เติมค่าที่เห็นใหม่ทาง env ได้ (ไม่ต้อง deploy) · ❌ ไม่มี KBANK_QR_STATUS_PAID โดยเจตนา · ทับแถวที่พิสูจน์แล้วไม่ได้
const ENV_STATUS_VARS = [
  ["KBANK_QR_STATUS_WAITING", "waiting"],
  ["KBANK_QR_STATUS_CLOSED", "closed"],
];

function envStatusMap(env) {
  const m = new Map();
  for (const [name, state] of ENV_STATUS_VARS) {
    const raw = env[name];
    if (typeof raw !== "string" || !raw.trim()) continue;
    for (const code of raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)) {
      if (TXN_STATUS_MAP.has(code)) continue;
      if (!m.has(code)) m.set(code, state);
    }
  }
  return m;
}

/** ค่าดิบ txnStatus → 'waiting'|'paid'|'closed'|'error' */
function mapTxnStatus(s, env) {
  if (typeof s !== "string") return "error";
  const key = s.trim().toUpperCase();
  if (!key) return "error";
  return TXN_STATUS_MAP.get(key) || envStatusMap(env || envOf()).get(key) || "error";
}

/**
 * ⚠️ amountPaid ของเจ้านี้ = txnAmount (ยอดของรายการ) มีค่าแม้ยัง waiting
 *   ⇒ ผู้เรียกเทียบยอดเฉพาะเมื่อ state='paid' (settle.confirmPaid ทำแบบนั้นอยู่แล้ว)
 */
async function inquiry(input) {
  const { channel, config, providerRef } = input || {};
  const env = envOf(input);
  const ch = readChannel(channel);
  if (ch.error) return ch.error;
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const ref = str(providerRef);
  if (!ref) return fail("bad_input", "inquiry ต้องมี providerRef (partnerTxnUid)");

  const r = await postProxy(env, "inquiry", { merchantId: cfg.merchantId, origPartnerTxnUid: ref });
  if (!r.ok) return r;
  const d = r.data;
  const statusCode = str(d.statusCode);
  if (statusCode !== "00") {
    return fail("kbank_error", str(d.errorDesc) || `ธนาคารปฏิเสธคำขอเช็คสถานะ (statusCode=${statusCode || "-"}${str(d.errorCode) ? " errorCode=" + str(d.errorCode) : ""})`);
  }
  const amt = Number(d.txnAmount);
  return {
    ok: true,
    data: {
      state: mapTxnStatus(d.txnStatus, env),
      amountPaid: d.txnAmount != null && d.txnAmount !== "" && Number.isFinite(amt) ? amt : null,
      raw: d,
    },
  };
}

// ── cancelQR ─────────────────────────────────────────────────────────────────
// POST cancel {merchantId, origPartnerTxnUid} · สำเร็จ = statusCode '00' · ปฏิเสธ (รวมจ่ายแล้ว/หมดอายุ) = ok:false ห้าม mark
async function cancelQR(input) {
  const { channel, config, providerRef } = input || {};
  const env = envOf(input);
  const ch = readChannel(channel);
  if (ch.error) return ch.error;
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const ref = str(providerRef);
  if (!ref) return fail("bad_input", "cancelQR ต้องมี providerRef (partnerTxnUid)");

  const r = await postProxy(env, "cancel", { merchantId: cfg.merchantId, origPartnerTxnUid: ref });
  if (!r.ok) return r;
  const d = r.data;
  const statusCode = str(d.statusCode);
  if (statusCode !== "00") {
    return fail("kbank_error", str(d.errorDesc) || `ธนาคารปฏิเสธการยกเลิก QR (statusCode=${statusCode || "-"}${str(d.errorCode) ? " errorCode=" + str(d.errorCode) : ""})`);
  }
  return { ok: true, data: { canceled: true, raw: d } };
}

// ── webhook helper (บริสุทธิ์ · ไม่แตะ db/เน็ต) ────────────────────────────────────
/**
 * อ่าน callback ที่เครื่องกลางส่งต่อมา → ตัวชี้บิล
 * 🔴 callback ของ KBank ไม่มีลายเซ็น และผ่านมือตัวกลาง ⇒ ทุกช่องเป็นแค่ "สัญญาณให้ไปถาม"
 *    handler ต้องถามธนาคารซ้ำด้วย inquiry (ใช้ providerRef จาก doc ไม่ใช่จาก payload) แล้วเทียบยอดก่อน mark เสมอ
 * referenceId = reference1 (= ref1 ที่เราส่งตอน createQR = doc id ของ pgWebhook) · มี "/" = ปัด (doc id ต้องเป็น segment เดียว)
 * providerRef/amount/state = จาก partnerTxnUid/txnAmount/txnStatus ไว้ log เท่านั้น ❌ ห้ามใช้ตัดสิน
 */
function parseCallback(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: { code: "bad_callback", message: "callback ไม่ใช่ object" } };
  }
  const v = body.reference1;
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (!s || s.includes("/")) {
    return { ok: false, error: { code: "no_reference1", message: "callback ไม่มี reference1 ที่ใช้ได้" } };
  }
  const out = { ok: true, referenceId: s, raw: body };
  const pr = str(body.partnerTxnUid);
  if (pr) out.providerRef = pr;
  const amt = Number(body.txnAmount);
  if (body.txnAmount != null && body.txnAmount !== "" && Number.isFinite(amt)) out.amount = amt;
  if (typeof body.txnStatus === "string" && body.txnStatus.trim()) out.state = mapTxnStatus(body.txnStatus);
  return out;
}

const I18N_KEYS = [spec.labelKey, ...spec.connection.fields.map((f) => f.labelKey), ...spec.channels.map((c) => c.nameKey)];

module.exports = {
  spec,
  createQR,
  inquiry,
  cancelQR, // ทะเบียน derive canCancel จากฟังก์ชันนี้
  testConnection,
  parseCallback,
  I18N_KEYS,
  // เทสเรียก
  mapTxnStatus,
  classifyTestResponse,
  __resetConnectionTestCache,
  _setHttp,
  _resetHttp,
  _setEnv,
  _resetEnv,
};

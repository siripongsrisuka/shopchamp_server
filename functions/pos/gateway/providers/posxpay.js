// pos/gateway/providers/posxpay.js — POSxPay (กล่องเสียง SoundBox · พร้อมเพย์) (ก้อน 7 · DEV-0001 · ยกจากพี่น้อง)
//
// runtime:'server' — เซิร์ฟเวอร์ยิง POSxPay เอง · POSxPay ดัน QR ขึ้นกล่องเสียงหน้าร้าน และคืน `qrPlainText` ให้แอปวาดเองด้วย
// 🔐 token = Bearer JWT ที่ถอนเงินได้จริง ⇒ `secret: true` (handler เข้ารหัสด้วย secretBox ตอนเก็บ · ถอดเป็นค่าดิบก่อนยื่นมา)
//   ต่างจากพี่น้องที่เก็บค่าดิบ (`store:'plain'`) — บ้านนี้ไม่มี store แล้ว ⇒ config.token ที่ได้ = ค่าดิบ ยิง Bearer ตรง ๆ
// ยิงเน็ตผ่าน `../posxpay/posxpayClient` เท่านั้น (http/env ฉีดได้ · ไม่ส่ง err.config ต่อ = token ไม่หลุดกับ error)
// อ้างอิงเอกสาร: SoundBox (Merchant) v1.2 — หัวข้อ 2 RequestPay · 3 Inquire (ตาราง status 4 ค่า)
// webhook: พี่น้องไม่มีตัวแยก notify ของ POSxPay ⇒ บ้านนี้ยืนยันด้วย inquiry อย่างเดียว (ไม่มี helper webhook)
"use strict";

const crypto = require("crypto");
const client = require("../posxpay/posxpayClient");

/** เส้นสร้างรายการ — `/requestpay` (ดัน QR ขึ้นกล่องเสียง) · ❌ ไม่ใช้ `/requestqr` (ไม่ขึ้นเครื่อง ร้านไม่ได้ยินเสียง) */
const REQUEST_PATH = "/api/v1/payment/requestpay";
/** เส้นถามสถานะ — ต่อท้ายด้วย orderId */
const INQUIRE_PATH = "/api/v1/payment/inquire/";
/** เพดานของผู้ให้บริการ (เอกสาร v1.2: ไม่เกิน 50,000 บาท) */
const MAX_AMOUNT_BAHT = 50000;
/** ปุ่มทดสอบ — จำผลต่อบัญชี 1 นาที */
const DEFAULT_TEST_THROTTLE_MS = 60000;
/** ข้อความในรายการของ POSxPay */
const DESCRIPTION = "Shopchamp";

// env/http ฉีดได้ — ตั้งที่ client ตัวเดียว (provider กับ client เห็นค่าเดียวกัน)
const _setEnv = client._setEnv;
const _resetEnv = client._resetEnv;
const _setHttp = client._setHttp;
const _resetHttp = client._resetHttp;

/** ช่วงจำผลของปุ่มทดสอบ · env `POSXPAY_TEST_THROTTLE_MS` · 0 = ปิดการจำ */
function testThrottleMs(env) {
  const n = Number(client.envOf(env).POSXPAY_TEST_THROTTLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TEST_THROTTLE_MS;
}

// ── spec 3 ชั้น ──────────────────────────────────────────────────────────────────
const spec = {
  id: "posxpay",
  labelKey: "screens.paymentGateway.provider.posxpay.name",
  labelFallback: "POSxPay",
  runtime: "server",
  // ไม่ประกาศ channelChoice ⇒ at-setup (กระเป๋าเดียว ไม่ต้องเลือกตอนขาย)
  connection: {
    fields: [
      {
        // เลขเครื่องกล่องเสียง — ป้ายระบุอุปกรณ์ ไม่ใช่ค่าที่ถอนเงินได้ ⇒ ไม่ลับ
        key: "serial",
        labelKey: "screens.paymentGateway.field.posxpay.serial",
        labelFallback: "เลขเครื่องกล่องเสียง (Serial)",
        required: true,
      },
      {
        // Bearer JWT ของร้าน = ความลับจริง · ❌ ไม่มี store (handler เข้ารหัสเอง)
        key: "token",
        labelKey: "screens.paymentGateway.field.posxpay.token",
        labelFallback: "โทเคนร้านค้า (Token)",
        required: true,
        secret: true,
      },
    ],
    // ปุ่มทดสอบ = ถามสถานะเลขที่ไม่มีจริง · ❌ ห้ามใช้ /requestpay (สร้างเงินจริง + QR เด้งหน้าลูกค้า + เสียงเรียก)
    test: {
      kind: "query-nonexistent",
      note:
        "ถามสถานะของเลขรายการที่ไม่มีอยู่จริง (GET /payment/inquire/<เลขที่แต่งขึ้น>) = อ่านอย่างเดียว ไม่สร้างรายการเงิน ไม่ดัน QR ขึ้นกล่องเสียง ไม่มีเสียงเรียก · " +
        "ครอบ 1/2 ช่องบังคับ: token — ผ่าน = POSxPay ยอมรับโทเคนของร้านนี้จริง · " +
        "❌ ไม่ครอบ serial — เส้นถามสถานะไม่ได้ส่งเลขเครื่องไปด้วย ⇒ กรอกเลขเครื่องผิดก็ยังขึ้นเขียว และจะรู้ตอนขายจริงครั้งแรกเท่านั้น · " +
        "❌ ไม่พิสูจน์ว่ากล่องเสียงเปิด/ต่อเน็ตอยู่ · ไม่พิสูจน์ว่าบัญชีเปิดรับพร้อมเพย์ · ไม่พิสูจน์วงเงิน/ค่าธรรมเนียม · " +
        "POSxPay ล่มหรือเน็ตมีปัญหา = ระบบตอบว่ายังทดสอบไม่ได้ ไม่ใช่ 'โทเคนผิด'",
    },
  },
  // แถวเดียว: พร้อมเพย์ — ค่าเดียวที่พิสูจน์ได้ว่าเก็บเงินอยู่จริง (ตารางกระเป๋าในเอกสาร ≠ บัญชีเราเปิดไว้)
  channels: [
    {
      channelId: "posxpayPromptPay",
      nameKey: "screens.paymentGateway.channel.posxpayPromptPay",
      // ต่อท้าย (POSxPay) เพราะลิสต์กระเป๋าเป็นลิสต์แบนปนทุกเจ้า
      nameFallback: "พร้อมเพย์ (POSxPay)",
      sourceType: "promptpay", // ค่าของผู้ให้บริการ + ลายเซ็นแถว (กันยัด channel เจ้าอื่น)
      qrKind: "text",
      lastKnownAvailable: true,
    },
  ],
};

// ── helpers ──────────────────────────────────────────────────────────────────────
function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message: String(message).slice(0, 300) }, extra || {}) };
}

const str = (v) => (v == null ? "" : String(v).trim());

/** ชื่อช่อง = fields[].key เป๊ะ · token = ค่าดิบ (handler ถอดกล่องแล้ว) */
function readConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const serial = str(c.serial);
  const token = str(c.token);
  if (!serial) return { error: fail("config_missing", "ยังไม่ได้ตั้งเลขเครื่องกล่องเสียง (Serial) ของ POSxPay") };
  if (!token) return { error: fail("config_missing", "ยังไม่ได้ตั้งโทเคนร้านค้า (Token) ของ POSxPay") };
  return { serial, token };
}

/** รับเฉพาะแถวจาก spec.channels ของเจ้านี้ (มี sourceType) */
function readChannel(channel) {
  if (!channel || typeof channel !== "object" || !str(channel.sourceType)) {
    return { error: fail("bad_channel", "ไม่รู้จักช่องทางชำระเงินที่ส่งมา (ต้องเป็นแถวจาก spec.channels ของ posxpay)") };
  }
  return { sourceType: str(channel.sourceType) };
}

/** 🔴 HTTP 200 ไม่ได้แปลว่าสำเร็จ — POSxPay ใส่ `code` ของตัวเองใน body อีกชั้น (200/403/404/500) */
function bodyCode(data) {
  const n = Number(data && data.code);
  return Number.isFinite(n) ? n : null;
}

/** ข้อความสั้นจาก body · ❌ ไม่โยนทั้งก้อนออกไป */
function bodyMessage(data) {
  if (!data || typeof data !== "object") return "";
  const m = data.message || data.error || data.status;
  return m ? String(m).slice(0, 200) : "";
}

/**
 * เลขอ้างอิงที่ส่ง POSxPay — ต้องเป็น Number (validator ปัดสตริง · พี่น้องพิสูจน์บน production แล้ว)
 * Date.now()×1000 + สุ่ม 0-999 = 16 หลัก < MAX_SAFE_INTEGER · 2 คำขอใน ms เดียวกันไม่ชน
 * กันกดซ้ำฝั่งเรา = handler (dedupe 15 นาที) ไม่ใช่เลขนี้
 */
function makeNumericRef() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// ── createQR — `/requestpay` = สร้างรายการเงินจริง + ดันขึ้นกล่องเสียง ─────────────────
/**
 * @param {{channel, config:{serial,token}, amount:number(บาท), referenceId:string, shopId?:string, env?:object}} input
 * @returns {Promise<{ok:true,data:{providerRef,chargeId,qrPayload,qrKind:'text'}}|{ok:false,error:{code,message}}>}
 */
async function createQR(input) {
  const { channel, config, amount, referenceId, shopId, env } = input || {};

  const ch = readChannel(channel);
  if (ch.error) return ch.error;
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  // ปัดยอดที่ยิงไม่ได้ก่อนแตะเน็ตเสมอ — ทุกคำขอที่ผ่าน = QR เด้งขึ้นเครื่องหน้าร้าน + เสียงเรียก
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return fail("bad_amount", `ยอดเงินไม่ถูกต้อง: ${amount} (ต้องมากกว่า 0 บาท)`);
  if (n > MAX_AMOUNT_BAHT) {
    return fail("bad_amount", `ยอดเงินเกินเพดานของ POSxPay (สูงสุด ${MAX_AMOUNT_BAHT.toLocaleString("en-US")} บาทต่อรายการ) — ได้ ${n}`);
  }

  // referenceId ของเราใช้ผูกกลับฝั่งเรา (handler เก็บ orderId เป็น providerRef) · ไม่ส่งไป POSxPay เพราะเขารับแต่ตัวเลข
  const ref = str(referenceId);
  if (!ref) return fail("bad_input", "createQR ต้องมี referenceId");

  const body = {
    referenceId: makeNumericRef(),
    description: DESCRIPTION,
    serial: cfg.serial,
    sourceType: ch.sourceType,
    amount: n,
  };
  // ref1 ไม่บังคับ — ไม่ยัดค่ามั่วเมื่อไม่ได้ส่งมา
  if (str(shopId)) body.ref1 = str(shopId);

  const r = await client.request({ method: "POST", path: REQUEST_PATH, token: cfg.token, body, env });
  if (!r.ok) return r;

  const d = r.data && typeof r.data === "object" ? r.data : {};
  const code = bodyCode(d);
  if (code !== 200) {
    const msg = bodyMessage(d);
    return fail("posxpay_rejected", `POSxPay ปฏิเสธการสร้าง QR (code=${code === null ? "-" : code})${msg ? " · " + msg : ""}`);
  }

  // orderId ของจริงเป็นตัวเลข ⇒ แปลงเป็นสตริงเสมอ
  const providerRef = str(d.orderId);
  const qrPayload = str(d.qrPlainText);
  if (!providerRef) return fail("bad_response", "POSxPay ตอบว่าสำเร็จแต่ไม่มี orderId (ไม่มีเลขไว้ตามสถานะ)");
  if (!qrPayload) return fail("bad_response", "POSxPay ตอบว่าสำเร็จแต่ไม่มี qrPlainText (ไม่มี QR ให้จอแสดง)");

  // เจ้านี้มีเลขเดียว: orderId = ทั้งกุญแจตามสถานะและเลขรายการ
  return { ok: true, data: { providerRef, chargeId: providerRef, qrPayload, qrKind: "text" } };
}

// ── inquiry — `GET /payment/inquire/<orderId>` ───────────────────────────────────────
/**
 * ตารางสถานะจากเอกสาร v1.2 หัวข้อ 3 (ครบ 4 ค่า):
 *   success → paid · pending → waiting (🔴 สถานะปกติ ห้ามเป็น error) · fail/cancel → closed
 *   อย่างอื่นทั้งหมด → error (fail-closed · ห้ามตกเป็น waiting) · ค่าดิบอยู่ใน raw
 */
const STATUS_MAP = new Map([
  ["SUCCESS", "paid"],
  ["PENDING", "waiting"],
  ["FAIL", "closed"],
  ["CANCEL", "closed"],
]);

/** @returns {'waiting'|'paid'|'closed'|'error'} */
function mapStatus(s) {
  if (typeof s !== "string") return "error";
  const key = s.trim().toUpperCase();
  if (!key) return "error";
  return STATUS_MAP.get(key) || "error";
}

/**
 * @param {{channel, config, providerRef:string, expectedAmount?:number, env?:object}} input
 * @returns {Promise<{ok:true,data:{state,amountPaid:number|null,raw:object}}|{ok:false,error}>}
 *   state 'amount_mismatch' = จ่ายแล้วแต่ยอดไม่ตรง expectedAmount (ถึงสตางค์)
 */
async function inquiry(input) {
  const { channel, config, providerRef, expectedAmount, env } = input || {};

  const ch = readChannel(channel);
  if (ch.error) return ch.error;
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const ref = str(providerRef);
  if (!ref) return fail("bad_input", "inquiry ต้องมี providerRef (orderId ที่ POSxPay ออกให้)");

  const r = await client.request({ method: "GET", path: INQUIRE_PATH + encodeURIComponent(ref), token: cfg.token, env });
  if (!r.ok) return r;

  const d = r.data && typeof r.data === "object" ? r.data : {};
  const code = bodyCode(d);
  if (code !== 200) {
    const msg = bodyMessage(d);
    return fail("posxpay_rejected", `POSxPay ปฏิเสธคำขอเช็คสถานะ (code=${code === null ? "-" : code})${msg ? " · " + msg : ""}`);
  }

  let state = mapStatus(d.status);
  // `amount` = ยอดของรายการ ไม่ใช่ยอดที่จ่ายแล้ว ⇒ รายงาน amountPaid เฉพาะตอน paid
  const amt = Number(d.amount);
  const amountPaid = state === "paid" && Number.isFinite(amt) ? amt : null;
  // เทียบยอดถึงสตางค์เมื่อผู้เรียกส่ง expectedAmount มา (handler เทียบซ้ำใน settle อีกชั้น)
  if (state === "paid" && expectedAmount !== undefined && expectedAmount !== null) {
    const exp = Number(expectedAmount);
    if (!Number.isFinite(exp) || amountPaid === null || Math.round(exp * 100) !== Math.round(amountPaid * 100)) {
      state = "amount_mismatch";
    }
  }
  return { ok: true, data: { state, amountPaid, raw: d } };
}

// ── testConnection — query-nonexistent ───────────────────────────────────────────────
/** ผลปุ่มทดสอบต่อบัญชี · in-memory เท่าอายุ instance */
const connTestCache = new Map();

/** เทสเท่านั้น — เคลียร์ผลที่จำไว้ */
function __resetConnectionTestCache() {
  connTestCache.clear();
}

/** key ของแคช = digest ไม่ใช่ค่าดิบ (token ไม่ควรโผล่ใน heap dump) */
function cacheKeyOf(cfg) {
  return crypto.createHash("sha256").update(`${cfg.serial}\u0000${cfg.token}`).digest("base64");
}

function markThrottled(result, throttled) {
  if (!result || result.ok !== true) return result;
  return { ok: true, data: { ...result.data, throttled } };
}

/** เลขที่ถาม = ตัวอักษร+ขีด (orderId จริงเป็นตัวเลขล้วน ⇒ ชนไม่ได้) · สุ่มใหม่ทุกครั้ง */
function makeProbeRef() {
  return `SHOPCHAMP-CONNTEST-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

/**
 * เกณฑ์ตัดสินคำตอบปุ่มทดสอบ (พี่น้องยิง production จริงเป็นคู่เทียบแล้ว):
 *   HTTP/code 401|403 → bad-token (token ผิดตาย 403 ก่อนถึงการหา order)
 *   HTTP 400 + "Order not found" → pass (ผ่านด่านสิทธิ์แล้ว) · 400 ข้อความอื่น = unknown
 *   HTTP/code 404 → pass (ตามเอกสาร) · code 200 → pass
 *   อย่างอื่น (500 · timeout · เน็ตล่ม · code แปลก) → unknown ❌ ห้ามแปลว่าโทเคนผิด
 * @param {{httpStatus:number|null, bodyCode:number|null, bodyMessage?:string}} v
 * @returns {'pass'|'bad-token'|'unknown'}
 */
function classifyTestResponse(v) {
  const http = Number.isFinite(Number(v && v.httpStatus)) && v.httpStatus !== null ? Number(v.httpStatus) : null;
  const code = Number.isFinite(Number(v && v.bodyCode)) && v.bodyCode !== null ? Number(v.bodyCode) : null;
  const msg = str(v && v.bodyMessage);

  if (http === 401 || http === 403 || code === 401 || code === 403) return "bad-token";
  if (http === 400 && /order\s*not\s*found/i.test(msg)) return "pass";
  if (http === 404 || code === 404) return "pass";
  if (code === 200) return "pass";
  return "unknown";
}

/**
 * ปุ่ม "ทดสอบการเชื่อมต่อ" — ไม่เคลื่อนเงิน · เบรกกดรัวอยู่ในตัว provider (ทุกทางเข้าผ่านที่นี่)
 *   จำทั้งผลผ่านและผลล้มต่อบัญชี testThrottleMs()
 * @param {{config:object, shopId?:string, env?:object}} input
 * @returns {Promise<{ok:true,data:{verifiedFields:['token'],note,throttled}}|{ok:false,error}>}
 *   🔴 verifiedFields = token เท่านั้น — เส้น inquire ไม่ส่ง serial ⇒ ใส่ serial = โกหกร้าน
 */
async function testConnection(input) {
  const { config, env } = input || {};
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;

  const ttl = testThrottleMs(env);
  const key = cacheKeyOf(cfg);
  const hit = connTestCache.get(key);
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) return markThrottled(hit.result, true);

  // 🔒 inquire เท่านั้น — ❌ ห้ามเปลี่ยนไป /requestpay
  const r = await client.request({ method: "GET", path: INQUIRE_PATH + makeProbeRef(), token: cfg.token, env });

  const httpStatus = r.ok ? Number(r.status) : Number(r.error && r.error.status);
  const code = r.ok ? bodyCode(r.data) : null;
  // ฝั่ง !ok ข้อความ body ผ่าน normalizeError มาแล้ว ⇒ "Order not found" อยู่ที่ r.error.message
  const bodyMsg = r.ok ? bodyMessage(r.data) : str(r.error && r.error.message);
  const verdict = classifyTestResponse({
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    bodyCode: code,
    bodyMessage: bodyMsg,
  });

  let result;
  if (verdict === "pass") {
    result = {
      ok: true,
      data: {
        verifiedFields: [spec.connection.fields.find((f) => f.secret === true).key], // = 'token'
        note:
          "ถามสถานะรายการที่ไม่มีอยู่จริงแล้ว POSxPay ตอบกลับตามปกติ = โทเคนร้านค้าใช้งานได้จริง · " +
          "ไม่มีรายการเงินเกิดขึ้น ไม่มี QR ขึ้นกล่องเสียง · " +
          "ยังไม่ได้พิสูจน์เลขเครื่องกล่องเสียง (Serial) — จะรู้ว่ากรอกถูกหรือไม่ตอนขายจริงครั้งแรกเท่านั้น",
      },
    };
  } else if (verdict === "bad-token") {
    result = fail(
      "posxpay_token_rejected",
      `POSxPay ไม่รับโทเคนของร้านนี้ — โทเคนร้านค้า (Token) ไม่ถูกต้องหรือหมดอายุ ตรวจค่าที่กรอกอีกครั้ง (HTTP ${
        Number.isFinite(httpStatus) ? httpStatus : "-"
      }${code === null ? "" : " · code=" + code})`,
    );
  } else {
    // ยังยืนยันไม่ได้ — ไม่ฟันว่าโทเคนผิด ไม่นับผ่าน · แสดงรหัสดิบไว้เป็นเบาะแส
    const upstream = r.ok ? "" : str(r.error && r.error.message);
    result = fail(
      "posxpay_test_inconclusive",
      `ยังยืนยันโทเคนไม่ได้ — POSxPay ตอบด้วยผลที่ระบบยังไม่รู้จัก (HTTP ${
        Number.isFinite(httpStatus) ? httpStatus : "-"
      } · code=${code === null ? "-" : code})${upstream ? " · " + upstream : ""} ยังสรุปไม่ได้ว่าค่าที่กรอกใช้ได้หรือไม่`,
    );
  }

  connTestCache.set(key, { at: Date.now(), result });
  return markThrottled(result, false);
}

/** i18n key ทั้งหมดของเจ้านี้ — derive จาก spec */
const I18N_KEYS = [spec.labelKey, ...spec.connection.fields.map((f) => f.labelKey), ...spec.channels.map((c) => c.nameKey)];

module.exports = {
  spec,
  createQR,
  inquiry,
  testConnection,
  I18N_KEYS,
  mapStatus,
  classifyTestResponse,
  __resetConnectionTestCache,
  MAX_AMOUNT_BAHT,
  REQUEST_PATH,
  INQUIRE_PATH,
  _setHttp,
  _resetHttp,
  _setEnv,
  _resetEnv,
};

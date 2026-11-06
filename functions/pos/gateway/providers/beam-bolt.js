// pos/gateway/providers/beam-bolt.js — เจ้า Beam Bolt (เครื่องรับเงินของ Beam ที่ตั้งหน้าร้าน) · ก้อน 7 · DEV-0001
//
// ยกจากพี่น้อง · runtime:'server' = เซิร์ฟเวอร์เรายิง HTTPS หา Beam แล้ว Beam ส่งงานต่อไปที่เครื่อง Bolt ที่จับคู่ไว้ (paired mode)
//   · บัญชี = ของร้าน แต่ทีมงาน Shopchamp กรอกให้ (merchantId + Partner API Key เข้ารหัสที่ beamMerchantCreds/{shopId})
//   · ร้านกรอกช่องเดียว ไม่ใช่ความลับ = boltConnectionId (รหัสจับคู่เครื่อง)
//   · 🔴 ยอดเงินของ Beam = สตางค์จำนวนเต็ม (ทะเบียนส่งบาท ⇒ แปลงในไฟล์นี้)
//   · ไม่มี QR กลับมาให้จอ render — เครื่อง Bolt แสดงเอง ⇒ qrPayload/qrKind = null ตรง ๆ
// ตัดของร้านอาหารออก (checkoutType · autoCheckout · ปิดบิล) — แอป Shopchamp สร้างบิลเองหลังจ่าย
// 🔒 ไม่มี console.* · ผลที่คืนไม่มี API key/Authorization (beamClient กันไว้อีกชั้น)
// ฉีดได้: env ต่อคำขอ `input.env` หรือทั้งโมดูล `_setEnv(obj)` · กุญแจเข้ารหัส `input.credKey` (base64) · http ผ่าน beamClient._setHttp
"use strict";

const crypto = require("crypto");
const { request } = require("../beam/beamClient");
const { getBeamBaseUrlLabel } = require("../beam/beamConfig");
const { getShopBeamCreds } = require("../beam/beamMerchantCreds");
const { PAYMENT_METHOD_FACTORIES, SUPPORTED_PAYMENT_METHODS } = require("../beam/beamPaymentMethods");

// ── ค่าคงที่ (พิสูจน์แล้วที่พี่น้องกับเครื่องจริง) ──
const BOLT_INTENTS_PATH = "/api/v1/bolt-intents";
const BOLT_CONNECTIONS_PATH = "/api/v1/bolt-connections";
const DEFAULT_CURRENCY = "THB";
const DEFAULT_EXPIRY_SEC = 90;
const MIN_AMOUNT_SATANG = 1; // 1 สตางค์ก็เด้งขึ้นจอเครื่องที่ลูกค้ายืนอยู่
const MAX_AMOUNT_SATANG = 100000000;

// ผ่อนชำระต้องมีงวด + ธนาคารรายบิล ซึ่งสัญญา createQR ไม่มีที่ให้ส่ง ⇒ ประกาศแถวไว้ แต่ createQR ปัด (ไม่เลือกธนาคารแทนลูกค้า)
const CHANNELS_NEEDING_PER_BILL_FIELDS = new Set(["CARD_INSTALLMENTS"]);

// ── spec 3 ชั้น ──
const spec = {
  id: "beam-bolt",
  labelKey: "screens.paymentGateway.provider.beam-bolt.name",
  labelFallback: "Beam Bolt",
  runtime: "server",
  // เลือกวิธีจ่ายตอนขาย: Beam บังคับ paymentMethodType ทุก intent ⇒ ไม่มีแถว "ให้เครื่องเลือกเอง" · คนเลือก = คนคิดเงิน
  channelChoice: "at-bill",

  connection: {
    fields: [
      {
        // ไม่ใช่ความลับ (ถอนเงินไม่ได้) — ค่าที่ถอนเงินได้คือกุญแจร้านใน beamMerchantCreds ที่ร้านไม่เคยเห็น
        key: "boltConnectionId",
        labelKey: "screens.paymentGateway.field.beam-bolt.boltConnectionId",
        labelFallback: "รหัสจับคู่เครื่อง Bolt",
        required: true,
      },
    ],
    // ค่าในช่องนี้เป็นของร้านได้ทีละร้าน — กันร้าน A กรอกเลขเครื่องร้าน B แล้วบิลไปเด้งที่เครื่องร้าน B
    //   (GET /bolt-connections/{id} ตอบ 200 กับ id ของ merchant เดียวกันทุกสาขา) ⇒ ทะเบียนเจ้าของอยู่ฝั่งเรา
    ownership: { field: "boltConnectionId", registry: "beamBoltConnections" },
    test: {
      kind: "query-nonexistent",
      note:
        "ยิง GET /bolt-connections/{boltConnectionId} = อ่านอย่างเดียว ไม่สร้างรายการเงินสักบาท · " +
        "ครอบ 1/1 ช่องบังคับ: boltConnectionId — ผ่าน = บัญชี Beam ของร้าน (ที่ทีมงานตั้งให้) ใช้ได้จริง และเครื่องที่ร้านกรอกมีอยู่จริงในบัญชีนั้น · " +
        "แยกได้ 3 ทาง: ยังไม่ได้ตั้งบัญชี = ปัดก่อนยิง (ติดต่อทีมงาน) · 401 = กุญแจที่ทีมงานตั้งใช้ไม่ได้ (ร้านแก้เองไม่ได้) · 404 = กุญแจใช้ได้แต่ไม่มีเครื่องรหัสนี้ (ร้านกรอกผิด/ยังไม่ได้จับคู่) · " +
        "ไม่ครอบ: ไม่พิสูจน์ว่าเครื่องเปิด/ต่อเน็ตอยู่ · ไม่พิสูจน์ว่าบัญชีเปิดวิธีจ่ายไหน · ไม่พิสูจน์ว่ารูดขายได้จริง · " +
        "ผลบอกด้วยว่ายิงเข้าสภาพแวดล้อมไหนจริง (playground/production)",
    },
  },

  // 1 แถว = 1 วิธีจ่าย (ตรง SUPPORTED_PAYMENT_METHODS เป๊ะ · เทสตรึง) · ไม่ประกาศ qrKind (ไม่มี QR ไหลกลับมา)
  // lastKnownAvailable:false ทุกแถว = ยังไม่เคยวัดว่าบัญชีเปิดวิธีไหน (วัดได้ทางเดียวคือสร้างเงินจริง) ⇒ fail-closed
  //   ด่านเปิด/ปิดจริง = สวิตช์ร้านที่ handler ⇒ ❌ อย่าเปลี่ยนเป็น true โดยไม่มีผลวัดจริง
  // nameFallback ต่อท้าย "(Beam)" — ลิสต์ช่องทางเป็นลิสต์แบนปนทุกเจ้า กระเป๋าเดียวกันมีหลายเจ้า
  channels: [
    { channelId: "beamBoltPromptPay", nameKey: "screens.paymentGateway.channel.beamBoltPromptPay", nameFallback: "พร้อมเพย์ (Beam)", paymentMethodType: "QR_PROMPT_PAY", lastKnownAvailable: false },
    { channelId: "beamBoltCard", nameKey: "screens.paymentGateway.channel.beamBoltCard", nameFallback: "บัตรเครดิต/เดบิต (Beam)", paymentMethodType: "CARD", lastKnownAvailable: false },
    { channelId: "beamBoltCardInstallments", nameKey: "screens.paymentGateway.channel.beamBoltCardInstallments", nameFallback: "ผ่อนชำระผ่านบัตร (Beam)", paymentMethodType: "CARD_INSTALLMENTS", lastKnownAvailable: false },
    // ALIPAY คนละตัวกับ ALIPAY_PLUS (Beam แยก 2 วิธี)
    { channelId: "beamBoltAlipay", nameKey: "screens.paymentGateway.channel.beamBoltAlipay", nameFallback: "อาลีเพย์ (Beam)", paymentMethodType: "ALIPAY", lastKnownAvailable: false },
    { channelId: "beamBoltAlipayPlus", nameKey: "screens.paymentGateway.channel.beamBoltAlipayPlus", nameFallback: "Alipay+ (Beam)", paymentMethodType: "ALIPAY_PLUS", lastKnownAvailable: false },
    { channelId: "beamBoltLinePay", nameKey: "screens.paymentGateway.channel.beamBoltLinePay", nameFallback: "ไลน์เพย์ (Beam)", paymentMethodType: "LINE_PAY", lastKnownAvailable: false },
    { channelId: "beamBoltShopeePay", nameKey: "screens.paymentGateway.channel.beamBoltShopeePay", nameFallback: "ShopeePay (Beam)", paymentMethodType: "SHOPEE_PAY", lastKnownAvailable: false },
    { channelId: "beamBoltTrueMoney", nameKey: "screens.paymentGateway.channel.beamBoltTrueMoney", nameFallback: "ทรูมันนี่ วอลเล็ท (Beam)", paymentMethodType: "TRUE_MONEY", lastKnownAvailable: false },
    { channelId: "beamBoltWechat", nameKey: "screens.paymentGateway.channel.beamBoltWechat", nameFallback: "WeChat Pay (Beam)", paymentMethodType: "WECHAT_PAY", lastKnownAvailable: false },
  ],
};

// แถวที่ createQR ปัดแน่นอน = ไม่ฉายไปถึงจอ (ปุ่มหลอก) · ติดจาก Set ที่เดียว ⇒ แถวยังอยู่ครบ 9
for (const c of spec.channels) {
  if (CHANNELS_NEEDING_PER_BILL_FIELDS.has(c.paymentMethodType)) c.sellable = false;
}

// ── helper กลาง ──
function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message: String(message).slice(0, 300) }, extra || {}) };
}

/** ฐานข้อมูล — require ตอนใช้ (เทส stub `../../../firebase` ผ่าน require.cache) */
const dbOf = () => require("../../../firebase").db;

// env ที่ฉีดได้: input.env (ต่อคำขอ) > _setEnv (ทั้งโมดูล · เทส) > ไม่ส่ง = ให้ beamConfig/secretBox อ่าน process.env เอง
let ENV_OVERRIDE = null;
function _setEnv(obj) {
  ENV_OVERRIDE = obj && typeof obj === "object" ? obj : null;
}
function _resetEnv() {
  ENV_OVERRIDE = null;
}
const envOf = (input) => (input && input.env && typeof input.env === "object" ? input.env : ENV_OVERRIDE) || undefined;

const NOT_CONFIGURED_MESSAGE = "ร้านนี้ยังไม่ได้เปิดบัญชีรับเงิน Beam — ติดต่อทีมงาน Shopchamp เพื่อเปิดใช้งาน";

/**
 * กุญแจ Beam ของร้าน — ทุกเส้นที่ยิง Beam ผ่านตรงนี้ก่อน · คืน {creds:{merchantId,apiKey}} | {error}
 *   ไม่มี shopId = bad_input (ห้ามเดาร้าน ห้ามถอยไปบัญชีบริษัท) · ร้านยังไม่มีกุญแจ = beam_merchant_not_configured
 *   ถอดไม่ได้/กุญแจเข้ารหัสหาย = ส่งรหัสของ beamMerchantCreds ตรง ๆ (gateway_cred_*)
 *   กุญแจเข้ารหัส: input.credKey (base64) ชนะ · ไม่ส่ง = env (GATEWAY_CRED_ENC_KEY)
 */
async function shopCredsOf(input) {
  const shopId = input && typeof input.shopId === "string" ? input.shopId.trim() : "";
  if (!shopId) return { error: fail("bad_input", "ผู้เรียกไม่ได้ส่ง shopId — ไม่รู้ว่าจะยิง Beam ด้วยบัญชีร้านไหน") };
  const credKey = input && typeof input.credKey === "string" && input.credKey ? input.credKey : undefined;
  const opts = { deps: credKey ? { credKey } : undefined, env: envOf(input) };
  const r = await getShopBeamCreds(dbOf(), shopId, opts);
  if (!r || r.ok !== true) {
    const code = (r && r.code) || "beam_merchant_not_configured";
    const message = code === "beam_merchant_not_configured" ? NOT_CONFIGURED_MESSAGE : `อ่านกุญแจ Beam ของร้านไม่ได้ (${code}) — แจ้งทีมงาน Shopchamp`;
    return { error: fail(code, message) };
  }
  return { creds: { merchantId: r.merchantId, apiKey: r.apiKey } };
}

/** ยิง Beam ด้วยกุญแจร้าน + env เดียวกับที่ใช้รายงานสภาพแวดล้อม */
function beamRequest(input, opts, creds) {
  const env = envOf(input);
  return request({ ...opts, ...creds, ...(env ? { env } : {}) });
}

/**
 * ธงสภาพแวดล้อม — beamConfig ตีความ "ไม่ใช่ production = playground" ⇒ สะกด BEAM_ENV ผิดตัวเดียว = ยิง playground เงียบ ๆ
 * ไม่เขียนตารางแปลงใหม่: ถาม getBeamBaseUrlLabel แล้วเทียบกับที่คนพิมพ์ ต่างกัน = พิมพ์ผิด
 * @returns {{environment:'playground'|'production', source:'default'|'explicit'|'unrecognized', warning:string|null}}
 */
function environmentInfo(input) {
  const env = envOf(input);
  const environment = getBeamBaseUrlLabel(env);
  const src = env || process.env;
  const raw = typeof src.BEAM_ENV === "string" ? src.BEAM_ENV.trim() : "";
  if (!raw) return { environment, source: "default", warning: `ไม่ได้ตั้ง BEAM_ENV ⇒ ใช้ค่าตั้งต้น "${environment}"` };
  if (raw.toLowerCase() !== environment) {
    return {
      environment,
      source: "unrecognized",
      warning: `BEAM_ENV="${raw}" ไม่ใช่ค่าที่ระบบรู้จัก ⇒ ตกลงมาเป็น "${environment}" (ถ้าตั้งใจยิงของจริง ต้องสะกดว่า production เป๊ะ ๆ)`,
    };
  }
  return { environment, source: "explicit", warning: null };
}

function environmentPhrase(input) {
  const info = environmentInfo(input);
  const head = `ยิงจริงเข้าสภาพแวดล้อม: ${info.environment}`;
  if (info.source === "explicit") return `${head} (ตั้ง BEAM_ENV ไว้ชัดเจน)`;
  return `${head} ⚠️ ${info.warning}`;
}

/** อ่าน config.boltConnectionId ตรงชื่อ field.key · ค่าไปต่อท้าย URL ⇒ ปัดช่องว่าง / ? # ตั้งแต่ต้น */
function readConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const raw = typeof c.boltConnectionId === "string" ? c.boltConnectionId.trim() : "";
  if (!raw) return { error: fail("config_missing", "ยังไม่ได้ตั้งรหัสจับคู่เครื่อง Bolt (boltConnectionId)") };
  if (/[\s/?#]/.test(raw)) {
    return { error: fail("config_invalid", "รหัสจับคู่เครื่อง Bolt มีช่องว่างหรืออักขระที่ใช้ไม่ได้ — คัดลอกมาใหม่จากหน้าจับคู่เครื่อง") };
  }
  return { boltConnectionId: raw };
}

function readChannel(channel) {
  if (!channel || typeof channel !== "object" || typeof channel.paymentMethodType !== "string" || !channel.paymentMethodType) {
    return { error: fail("bad_channel", "ไม่รู้จักช่องทางชำระเงินที่ส่งมา (ต้องเป็นแถวจาก spec.channels)") };
  }
  return { paymentMethodType: channel.paymentMethodType };
}

/** 🔴 บาท → สตางค์ (ผิดทาง = ผิด 100 เท่า) · Math.round เพราะ 19.99*100 = 1998.999… */
function toSatang(amountBaht) {
  const n = Number(amountBaht);
  if (!Number.isFinite(n) || n <= 0) return { error: fail("bad_amount", `ยอดเงินไม่ถูกต้อง: ${amountBaht}`) };
  const satang = Math.round(n * 100);
  if (satang < MIN_AMOUNT_SATANG) return { error: fail("bad_amount", `ยอดเงินต่ำกว่าที่ Beam รับได้ (ต่ำสุด ${MIN_AMOUNT_SATANG} สตางค์): ${amountBaht}`) };
  if (satang > MAX_AMOUNT_SATANG) return { error: fail("bad_amount", `ยอดเงินเกินเพดานที่รับได้: ${amountBaht}`) };
  return { satang };
}

/**
 * ผลล้มของ beamClient → รหัสที่เราตัดสินเอง: ผูกกับ status เสมอ (beamClient เอา code จาก body ของ Beam มาทับได้)
 * รหัสของ Beam เก็บเป็น providerErrorCode · รายละเอียดซ้อน body.error เก็บเป็น providerDetail
 */
function normalizeHttpFailure(result) {
  const err = (result && result.error) || {};
  const status = Number.isFinite(err.status) ? err.status : Number.isFinite(result && result.status) ? result.status : null;
  if (status === null) {
    // ยังไปไม่ถึง Beam (config หาย · timeout · เน็ต) — รหัสของ client เรา
    const code = typeof err.code === "string" && err.code ? err.code : "beam_unknown_error";
    const message = typeof err.message === "string" && err.message ? err.message : "ติดต่อ Beam ไม่สำเร็จ";
    return fail(code, message);
  }
  const extra = { status };
  if (typeof err.code === "string" && err.code && err.code !== `beam_http_${status}`) extra.providerErrorCode = err.code;
  if (!extra.providerErrorCode && typeof err.providerDetailCode === "string") extra.providerErrorCode = err.providerDetailCode;
  if (typeof err.providerDetailMessage === "string") extra.providerDetail = err.providerDetailMessage;
  const message = typeof err.message === "string" && err.message ? err.message : `Beam ตอบกลับด้วยสถานะ ${status}`;
  return fail(`beam_http_${status}`, message, extra);
}

// ── testConnection (query-nonexistent) ──
/**
 * GET /bolt-connections/{id} = อ่านอย่างเดียว
 * ❌ ห้ามใช้: เช็กแค่ env (ขึ้นเขียวกับกุญแจมั่ว) · POST /bolt-intents (สร้างเงินจริง) · DELETE /bolt-connections (ตัดเครื่องจริง)
 * 2xx = กุญแจใช้ได้และมีเครื่องนี้ · 401/403 = กุญแจทีมงาน (ไม่โทษร้าน) · 404 = ร้านกรอกรหัสผิด
 * @param {{config:object, shopId:string, env?:object, credKey?:string}} input
 */
async function testConnection(input) {
  const { config } = input || {};
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;

  const env = environmentPhrase(input);
  const result = await beamRequest(input, { method: "GET", path: `${BOLT_CONNECTIONS_PATH}/${encodeURIComponent(cfg.boltConnectionId)}` }, sc.creds);

  if (!result || result.ok !== true) {
    const e = normalizeHttpFailure(result);
    const status = e.error.status;
    const extra = status === undefined || status === null ? {} : { status };
    if (e.error.providerErrorCode) extra.providerErrorCode = e.error.providerErrorCode;
    if (status === 401 || status === 403) {
      return fail(`beam_http_${status}`, `บัญชี Beam ของร้านใช้ไม่ได้ (Beam ปฏิเสธกุญแจที่ทีมงานตั้งไว้ · ${status}) — ไม่ใช่ค่าที่ร้านกรอกผิด กรุณาแจ้งทีมงาน · ${env}`, extra);
    }
    if (status === 404) {
      return fail("beam_http_404", `บัญชี Beam ของร้านใช้ได้ แต่ไม่พบเครื่อง Bolt รหัสนี้ — ตรวจรหัสจับคู่ (boltConnectionId) อีกครั้ง หรือจับคู่เครื่องใหม่ · ${env}`, extra);
    }
    return fail(e.error.code, `${e.error.message} · ${env}`, extra);
  }

  return {
    ok: true,
    data: {
      // ต้องสะกดตรง fields[].key ไม่งั้นถูกคัดทิ้งเงียบ
      verifiedFields: ["boltConnectionId"],
      environment: environmentInfo(input).environment,
      note:
        `เชื่อมต่อ Beam ได้จริงและพบเครื่อง Bolt รหัสนี้ในบัญชี (อ่านอย่างเดียว ไม่มีรายการเงินเกิดขึ้น) · ${env} · ` +
        `ยังไม่ได้พิสูจน์: เครื่องเปิดอยู่ไหม · บัญชีเปิดวิธีจ่ายไหนบ้าง · รูดขายได้จริงไหม`,
    },
  };
}

// ── pair / unpair — ห่อ Beam ล้วน ไม่แตะฐาน (ทะเบียนเจ้าของ = handler) ──
// Beam ไม่มี error code เฉพาะรหัสผิด/หมดอายุ ⇒ 400/404/409 ตอน pair รวมเป็นข้อความเดียว · ไม่ lock ความยาวรหัส
const PAIRING_CODE_REJECTED_MESSAGE =
  "รหัสจับคู่ไม่ถูกต้องหรือหมดอายุ — ดูรหัสบนจอเครื่อง Bolt (เครื่องแสดงรหัสพร้อมเวลาหมดอายุ) " +
  "ถ้าหมดอายุให้เข้าโหมดจับคู่ที่เครื่องอีกครั้งเพื่อรับรหัสใหม่";
const CREDENTIALS_INVALID_MESSAGE = (status) =>
  `บัญชี Beam ของร้านใช้ไม่ได้ (Beam ปฏิเสธกุญแจที่ทีมงานตั้งไว้ · ${status}) — ไม่ใช่สิ่งที่ร้านแก้เองได้ กรุณาแจ้งทีมงาน`;

function normalizePairingFailure(result, { rejectedStatuses }) {
  const e = normalizeHttpFailure(result);
  const status = e.error.status;
  const extra = status === undefined || status === null ? {} : { status };
  if (e.error.providerErrorCode) extra.providerErrorCode = e.error.providerErrorCode;
  if (status === 401 || status === 403) return fail("beam_credentials_invalid", CREDENTIALS_INVALID_MESSAGE(status), extra);
  if (rejectedStatuses.has(status)) return fail("pairing_code_rejected", PAIRING_CODE_REJECTED_MESSAGE, extra);
  return fail(e.error.code, e.error.message, extra);
}

/**
 * POST /bolt-connections {pairingCode} → 201 {id, deviceId, merchantId, createdAt}
 * @param {{pairingCode:string, shopId:string, env?:object, credKey?:string}} input
 * @returns {Promise<{ok:true,data:{boltConnectionId,deviceId,merchantId,createdAt,environment}}|{ok:false,error}>}
 */
async function pair(input) {
  const raw = input && typeof input.pairingCode === "string" ? input.pairingCode.trim() : "";
  if (!raw) return fail("bad_input", "ต้องระบุรหัสจับคู่ (pairingCode) ที่แสดงบนจอเครื่อง Bolt");
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;
  const result = await beamRequest(input, { method: "POST", path: BOLT_CONNECTIONS_PATH, body: { pairingCode: raw } }, sc.creds);
  if (!result || result.ok !== true) return normalizePairingFailure(result, { rejectedStatuses: new Set([400, 404, 409]) });
  const data = (result && result.data) || {};
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const id = str(data.id) || str(data.boltConnectionId) || "";
  if (!id) return fail("bad_response", "Beam ตอบว่าจับคู่สำเร็จแต่ไม่มีรหัสเชื่อมต่อกลับมา (บันทึกไม่ได้ — ลองใหม่ หรือแจ้งทีมงาน)");
  return {
    ok: true,
    data: { boltConnectionId: id, deviceId: str(data.deviceId), merchantId: str(data.merchantId), createdAt: str(data.createdAt), environment: environmentInfo(input).environment },
  };
}

/**
 * DELETE /bolt-connections/{id} · 202 = ตัดแล้ว · 404 = ถือว่าตัดไปแล้ว (alreadyGone) · 401/403 = ล้ม
 * @param {{boltConnectionId:string, shopId:string, env?:object, credKey?:string}} input
 */
async function unpair(input) {
  const cfg = readConfig(input);
  if (cfg.error) return cfg.error;
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;
  const result = await beamRequest(input, { method: "DELETE", path: `${BOLT_CONNECTIONS_PATH}/${encodeURIComponent(cfg.boltConnectionId)}` }, sc.creds);
  const environment = environmentInfo(input).environment;
  if (result && result.ok === true) return { ok: true, data: { boltConnectionId: cfg.boltConnectionId, alreadyGone: false, environment } };
  const e = normalizePairingFailure(result, { rejectedStatuses: new Set() });
  if (e.error.status === 404) return { ok: true, data: { boltConnectionId: cfg.boltConnectionId, alreadyGone: true, environment } };
  return e;
}

// ── createQR — สร้าง Bolt Intent แล้วโยนให้เครื่อง Bolt (paired mode) ──
/**
 * ชื่อ createQR แต่ไม่มี QR กลับมา (เครื่อง Bolt แสดงเอง) ⇒ qrPayload/qrKind = null · ❌ ห้ามแต่ง payload ปลอม
 * ไม่ปัดด้วย lastKnownAvailable (วัดไม่ได้ตลอดกาลสำหรับ at-bill · ด่านจริง = สวิตช์ร้านที่ handler)
 * @param {{channel, config, amount:number(บาท), referenceId:string, shopId:string, env?:object, credKey?:string}} input
 * @returns {Promise<{ok:true,data:{providerRef,chargeId,qrPayload:null,qrKind:null}}|{ok:false,error}>}
 */
async function createQR(input) {
  const { channel, config, amount, referenceId } = input || {};
  const ch = readChannel(channel);
  if (ch.error) return ch.error;

  // ด่านผ่อนชำระ — ยืนของมันเอง ไม่ผูกกับสวิตช์ร้าน
  if (CHANNELS_NEEDING_PER_BILL_FIELDS.has(ch.paymentMethodType)) {
    return fail(
      "channel_needs_per_bill_fields",
      `ช่องทาง ${channel.channelId || ch.paymentMethodType} ต้องระบุจำนวนงวดและธนาคารผู้ออกบัตรรายบิล ซึ่งยังไม่มีที่ให้ส่งในสัญญา createQR ⇒ ขายผ่านเส้นนี้ยังไม่ได้`,
    );
  }
  const factory = PAYMENT_METHOD_FACTORIES[ch.paymentMethodType];
  if (typeof factory !== "function") return fail("unsupported_payment_method", `Beam ไม่รองรับวิธีจ่าย ${ch.paymentMethodType}`);

  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const amt = toSatang(amount);
  if (amt.error) return amt.error;
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;

  const body = {
    amount: amt.satang,
    boltConnectionId: cfg.boltConnectionId,
    mode: { type: "PAIRING" }, // paired mode ต้องส่งคู่กับ boltConnectionId
    currency: DEFAULT_CURRENCY,
    expiryDurationInSec: DEFAULT_EXPIRY_SEC,
    paymentMethod: factory(),
  };
  // referenceId = เลขใบของเรา ให้กระทบยอดฝั่ง Beam ผูกกลับได้ · ไม่มี = ไม่สร้างเลขสุ่มแทน
  const ref = typeof referenceId === "string" ? referenceId.trim() : "";
  if (ref) body.referenceId = ref;

  const result = await beamRequest(input, { method: "POST", path: BOLT_INTENTS_PATH, body }, sc.creds);
  if (!result || result.ok !== true) return normalizeHttpFailure(result);

  const data = (result && result.data) || {};
  const s = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const providerRef = s(data.id) || s(data.boltIntentId);
  if (!providerRef) return fail("bad_response", "Beam ตอบว่าสำเร็จแต่ไม่มีเลข bolt intent กลับมา (ตามสถานะรายการนี้ต่อไม่ได้)");
  const chargeId = s(data.latestChargeId) || null;
  return { ok: true, data: { providerRef, chargeId, qrPayload: null, qrKind: null } };
}

// ── inquiry — อ่านสถานะ Bolt Intent ──
// 🔴 อ่าน data.result เป็นหลัก (ของเดิมที่พี่น้องไม่อ่าน result = บิลจ่ายแล้วค้าง pending ตลอดกาล)
//    latestChargeStatus เป็นตัวสำรองเฉพาะตอน result ว่าง · ค่าไม่รู้จัก = error (ห้ามตกเป็น waiting เงียบ)
const RESULT_MAP = new Map([
  ["CH_SUCCEEDED", "paid"],
  ["CH_PROCESSING_FAILED", "error"],
  ["CH_INSUFFICIENT_FUNDS", "error"],
  ["CH_AUTHENTICATION_FAILED", "error"],
  ["BI_EXPIRED", "closed"],
  ["BI_CANCELED", "closed"],
]);
const CHARGE_STATUS_MAP = new Map([
  ["SUCCEEDED", "paid"],
  ["FAILED", "error"],
  ["PENDING", "waiting"],
]);

/** @returns {'waiting'|'paid'|'closed'|'error'} */
function mapIntentState(beamResult, latestChargeStatus) {
  const r = typeof beamResult === "string" ? beamResult.trim().toUpperCase() : "";
  if (r) return RESULT_MAP.get(r) || "error";
  const s = typeof latestChargeStatus === "string" ? latestChargeStatus.trim().toUpperCase() : "";
  if (!s) return "waiting"; // ยังไม่มี charge = ยังไม่จ่าย
  return CHARGE_STATUS_MAP.get(s) || "error";
}

// 💰 จ่ายแล้วต้องยอดตรงบิลถึงตอบ paid · amount ของ BoltIntent = สตางค์จำนวนเต็ม · อ่านไม่ออก = ไม่ตรง
const AMOUNT_MISMATCH_STATE = "amount_mismatch";
function beamAmountMatches(beamSatang, expectedBaht) {
  if (expectedBaht === null || expectedBaht === "") return false;
  const exp = Number(expectedBaht);
  if (!Number.isFinite(exp)) return false;
  if (typeof beamSatang !== "number" || !Number.isInteger(beamSatang)) return false;
  return beamSatang === Math.round(exp * 100);
}

/**
 * GET /bolt-intents/{providerRef}
 * @param {{channel, config, providerRef:string, expectedAmount?:number(บาท), shopId:string, env?:object, credKey?:string}} input
 *   expectedAmount ส่งมา + จ่ายแล้ว = เทียบกับ data.amount (สตางค์) ก่อนตอบ paid · ไม่ส่ง = ไม่เทียบ
 * @returns {Promise<{ok:true,data:{state,amountPaid:number|null,expectedAmount?:number,raw}}|{ok:false,error}>}
 * ไม่ปัดตาม lastKnownAvailable — ใบที่ออกไปแล้วต้องตามสถานะได้เสมอ
 */
async function inquiry(input) {
  const { config, providerRef, expectedAmount } = input || {};
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const ref = typeof providerRef === "string" ? providerRef.trim() : "";
  if (!ref) return fail("bad_input", "inquiry ต้องมี providerRef (boltIntentId)");
  if (/[\s/?#]/.test(ref)) return fail("bad_input", "providerRef มีอักขระที่ใช้ไม่ได้");
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;

  const result = await beamRequest(input, { method: "GET", path: `${BOLT_INTENTS_PATH}/${encodeURIComponent(ref)}` }, sc.creds);
  if (!result || result.ok !== true) return normalizeHttpFailure(result);

  const data = result.data;
  if (!data || typeof data !== "object") return fail("bad_response", "Beam ตอบรูปแบบที่อ่านไม่ออกตอนเช็คสถานะ");

  const state = mapIntentState(data.result, data.latestChargeStatus);
  // สตางค์ → บาท · คืนเฉพาะตอนจ่ายสำเร็จ (ก่อนนั้นคือยอดที่ขอ ไม่ใช่ยอดที่จ่าย)
  const amt = Number(data.amount);
  const amountPaid = state === "paid" && typeof data.amount === "number" && Number.isFinite(amt) ? amt / 100 : null;

  if (state === "paid" && expectedAmount !== undefined && !beamAmountMatches(data.amount, expectedAmount)) {
    return { ok: true, data: { state: AMOUNT_MISMATCH_STATE, amountPaid, expectedAmount, raw: data } };
  }
  return { ok: true, data: { state, amountPaid, raw: data } };
}

// ── cancelQR — PATCH /bolt-intents/{id}/cancel (ไม่มี body · พิสูจน์กับเครื่องจริงที่พี่น้องแล้ว) ──
/**
 * สำเร็จ = 2xx (inquiry ต่อไปอ่านเป็น BI_CANCELED = closed) · Beam ปฏิเสธ = ok:false ⇒ ผู้เรียกห้าม mark ฝั่งเรา
 * @param {{channel, config, providerRef:string, shopId:string, env?:object, credKey?:string}} input
 */
async function cancelQR(input) {
  const { config, providerRef } = input || {};
  const cfg = readConfig(config);
  if (cfg.error) return cfg.error;
  const ref = typeof providerRef === "string" ? providerRef.trim() : "";
  if (!ref) return fail("bad_input", "cancelQR ต้องมี providerRef (boltIntentId)");
  if (/[\s/?#]/.test(ref)) return fail("bad_input", "providerRef มีอักขระที่ใช้ไม่ได้");
  const sc = await shopCredsOf(input);
  if (sc.error) return sc.error;

  const result = await beamRequest(input, { method: "PATCH", path: `${BOLT_INTENTS_PATH}/${encodeURIComponent(ref)}/cancel` }, sc.creds);
  if (!result || result.ok !== true) return normalizeHttpFailure(result);
  return { ok: true, data: { canceled: true, raw: (result && result.data) || {} } };
}

// ── ตัวช่วย webhook (pure · ไม่แตะฐาน ไม่ออกเน็ต) ──
// Beam ยิง event ต่อ merchant · ชนิด event มาทาง header X-Beam-Event · ลายเซ็นมาทาง header X-Beam-Signature
// ลายเซ็นพิสูจน์แค่ว่า Beam ส่งมาจริง ไม่ได้พิสูจน์ว่าบิลจ่ายครบ ⇒ handler ต้องถาม inquiry ซ้ำ + เทียบยอดก่อน mark เสมอ
const EVENT_PAID = "bolt_intent.paid";
const EVENT_CHARGE_FAILED = "charge.failed";
const EVENTS_NOT_PAID = new Set(["bolt_intent.canceled", "bolt_intent.expired", EVENT_CHARGE_FAILED]);
const EVENTS_ACCEPTED = new Set([EVENT_PAID, ...EVENTS_NOT_PAID]);

/**
 * X-Beam-Signature = base64(HMAC-SHA256(rawBody, base64decode(hmacKey))) · เทียบแบบ timing-safe
 * rawBody เท่านั้น (Buffer/สตริง · ❌ ไม่ re-serialize req.body) · ขาด/ผิดรูปอะไร = false · ไม่ throw
 * @param {{rawBody:Buffer|string, signatureHeader:string, hmacKey:string}} input  (`header` ใช้แทน signatureHeader ได้)
 * @returns {boolean}
 */
function verifyBeamSignature(input) {
  try {
    const i = input && typeof input === "object" ? input : {};
    const rawBody = i.rawBody;
    const sigRaw = i.signatureHeader !== undefined ? i.signatureHeader : i.header;
    const hmacKey = i.hmacKey;
    if (!(Buffer.isBuffer(rawBody) || (typeof rawBody === "string")) || rawBody.length === 0) return false;
    if (typeof sigRaw !== "string" || !sigRaw.trim()) return false;
    if (typeof hmacKey !== "string" || !hmacKey.trim()) return false;
    const key = Buffer.from(hmacKey.trim(), "base64");
    if (key.length === 0) return false;
    const computed = Buffer.from(crypto.createHmac("sha256", key).update(rawBody).digest("base64"));
    const given = Buffer.from(sigRaw.trim());
    return computed.length === given.length && crypto.timingSafeEqual(computed, given);
  } catch (e) {
    return false;
  }
}

const strOf = (v) => (typeof v === "string" ? v.trim() : "");

/** merchantId ผู้ส่ง: `merchant.merchantId` (bolt_intent.* ของจริง) ก่อน · fallback `merchantId` ชั้นบน (charge.*) — ใช้เลือกกุญแจเท่านั้น */
function pickMerchantId(body) {
  const b = body && typeof body === "object" ? body : {};
  const nested = b.merchant && typeof b.merchant === "object" ? strOf(b.merchant.merchantId) : "";
  return nested || strOf(b.merchantId);
}

/** ตัวชี้กลับหาใบ: bolt_intent.* → `id` · charge.failed → `sourceId` (id ของ intent) = providerRef ที่ createQR คืน */
function pickIntentId(eventType, body) {
  const b = body && typeof body === "object" ? body : {};
  return eventType === EVENT_CHARGE_FAILED ? strOf(b.sourceId) : strOf(b.id);
}

/**
 * แกะ event ของ Beam (ยังไม่เชื่อ status/amount/result ใน payload — ไว้ให้ handler ไปถาม inquiry)
 * @param {object} body         req.body ที่ parse แล้ว
 * @param {string} eventHeader  ค่า header X-Beam-Event (Beam ไม่ใส่ชนิด event ใน body)
 * @returns {{ok:true, providerRef, merchantId, eventType, paid:boolean, raw}
 *         | {ok:false, error:'bad_body'|'no_merchant_id'|'no_event_type'|'unknown_event'|'no_intent_id', eventType?, merchantId?}}
 */
function parseBeamEvent(body, eventHeader) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const merchantId = pickMerchantId(body);
  if (!merchantId) return { ok: false, error: "no_merchant_id" };
  const eventType = strOf(eventHeader).toLowerCase();
  if (!eventType) return { ok: false, error: "no_event_type", merchantId };
  if (!EVENTS_ACCEPTED.has(eventType)) return { ok: false, error: "unknown_event", eventType, merchantId };
  const providerRef = pickIntentId(eventType, body);
  if (!providerRef) return { ok: false, error: "no_intent_id", eventType, merchantId };
  return { ok: true, providerRef, merchantId, eventType, paid: eventType === EVENT_PAID, raw: body };
}

/** i18n key ทั้งหมดของเจ้านี้ — derive จาก spec */
const I18N_KEYS = [spec.labelKey, ...spec.connection.fields.map((f) => f.labelKey), ...spec.channels.map((c) => c.nameKey)];

module.exports = {
  spec,
  createQR,
  inquiry,
  cancelQR, // ทะเบียน derive canCancel จากการมีฟังก์ชันนี้
  testConnection,
  pair, // ทะเบียน derive canPair จาก pair + unpair
  unpair,
  verifyBeamSignature,
  parseBeamEvent,
  I18N_KEYS,
  // helper (เทสยิงตรง)
  mapIntentState,
  toSatang,
  environmentInfo,
  pickMerchantId,
  pickIntentId,
  NOT_CONFIGURED_MESSAGE,
  BOLT_INTENTS_PATH,
  BOLT_CONNECTIONS_PATH,
  EVENT_PAID,
  EVENT_CHARGE_FAILED,
  EVENTS_NOT_PAID,
  SUPPORTED_PAYMENT_METHODS,
  _setEnv,
  _resetEnv,
};

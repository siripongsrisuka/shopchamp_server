// เทส beam/beamClient.js (+ beamConfig.js) · รัน: node --test pos/gateway/beam/beamClient.test.js
//   ① รายร้าน: Basic = merchantId:apiKey ของร้าน + X-Beam-Partner-ID จาก env
//   ② รายร้านแต่ขาดช่องไหน (merchantId · apiKey · BEAM_PARTNER_ID) = ปัดก่อนยิง 0 ครั้ง · ❌ ไม่ถอยไป BEAM_MERCHANT_*
//   ③ ไม่ส่งกุญแจรายร้าน = บัญชีบริษัท · ④ กุญแจไม่โผล่ใน error สักทาง
//   ❌ ไม่ออกเน็ต — http ปลอมผ่าน _setHttp · env ปลอมผ่าน beamConfig._setEnv
"use strict";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const client = require("./beamClient");
const config = require("./beamConfig");
const { request, describeAuth, normalizeAxiosError } = client;

let CALLS = [];
let HANDLER = null;
const fakeHttp = async (opts) => {
  CALLS.push({ method: String(opts.method || "GET").toUpperCase(), url: opts.url, headers: opts.headers || {}, data: opts.data, timeout: opts.timeout });
  if (typeof HANDLER !== "function") throw new Error(`เทสไม่ได้ตั้ง HANDLER แต่มีการยิง ${opts.method} ${opts.url}`);
  const out = await HANDLER(opts);
  if (out && out.__throw) throw out.__throw;
  return { status: out.status, data: out.data, headers: out.headers || {} };
};

const PARTNER_ID = "pnr_TEST_partner";
const MERCHANT_ID = "merchant-COMPANY";
const MERCHANT_KEY = "merchant-secret-not-real";
const SHOP_MERCHANT = "m_shop777";
const SHOP_KEY = "shop-partner-key-not-real";

const asPartner = (extra = {}) => config._setEnv({ BEAM_PARTNER_ID: PARTNER_ID, ...extra });
const asMerchant = (extra = {}) => config._setEnv({ BEAM_MERCHANT_ID: MERCHANT_ID, BEAM_MERCHANT_API_KEY: MERCHANT_KEY, ...extra });
const decodeBasic = (h) => Buffer.from(String(h || "").replace(/^Basic /, ""), "base64").toString("utf8");

beforeEach(() => {
  CALLS = [];
  HANDLER = null;
  client._setHttp(fakeHttp);
  config._setEnv({});
});
after(() => {
  client._resetHttp();
  config._resetEnv();
});

test("① รายร้าน: Basic = merchantId:apiKey ของร้าน + X-Beam-Partner-ID · ค่าไม่หลุดเป็น header อื่น · ค่าตั้งต้น playground", async () => {
  asPartner();
  HANDLER = () => ({ status: 200, data: { id: "bi_1" }, headers: { "x-beam-request-id": "rq1" } });
  const r = await request({ method: "GET", path: "/api/v1/bolt-intents/bi_1", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.equal(r.ok, true);
  assert.equal(r.beamRequestId, "rq1");
  assert.deepEqual(r.data, { id: "bi_1" });
  assert.equal(CALLS.length, 1);
  const h = CALLS[0].headers;
  assert.equal(decodeBasic(h.Authorization), `${SHOP_MERCHANT}:${SHOP_KEY}`);
  assert.equal(h["X-Beam-Partner-ID"], PARTNER_ID);
  assert.ok(!("merchantId" in h) && !("apiKey" in h));
  assert.ok(CALLS[0].url.startsWith("https://playground.api.beamcheckout.com/"));
  assert.ok(!("x-beam-idempotency-key" in h), "GET ไม่ต้องมี idempotency key");
  assert.equal(CALLS[0].timeout, 15000);
});

test("① รายร้านชนะ env บริษัทเสมอ · trim ค่าที่ส่งมา", async () => {
  asMerchant({ BEAM_PARTNER_ID: PARTNER_ID });
  HANDLER = () => ({ status: 200, data: {} });
  await request({ method: "GET", path: "/x", merchantId: `  ${SHOP_MERCHANT}  `, apiKey: ` ${SHOP_KEY} ` });
  assert.equal(decodeBasic(CALLS[0].headers.Authorization), `${SHOP_MERCHANT}:${SHOP_KEY}`);
  assert.equal(CALLS[0].headers["X-Beam-Partner-ID"], PARTNER_ID);
});

test("POST ใส่ idempotency key (สุ่มเมื่อไม่ส่ง · ใช้ของผู้เรียกเมื่อส่ง) + Content-Type + body", async () => {
  asPartner();
  HANDLER = () => ({ status: 201, data: { ok: 1 } });
  await request({ method: "post", path: "/api/v1/bolt-intents", body: { a: 1 }, merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  await request({ method: "POST", path: "/p", body: { a: 2 }, headers: { "x-beam-idempotency-key": "ref-1" }, merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.equal(CALLS[0].method, "POST");
  assert.match(CALLS[0].headers["x-beam-idempotency-key"], /^[0-9a-f-]{32,36}$/);
  assert.equal(CALLS[0].headers["Content-Type"], "application/json");
  assert.deepEqual(CALLS[0].data, { a: 1 });
  assert.equal(CALLS[1].headers["x-beam-idempotency-key"], "ref-1");
});

test("② รายร้านแต่ไม่มี/ว่าง merchantId → beam_merchant_missing · 0 ครั้ง · ไม่ถอยไปบัญชีบริษัท", async () => {
  asMerchant({ BEAM_PARTNER_ID: PARTNER_ID });
  HANDLER = () => ({ status: 200, data: {} });
  for (const m of [null, "", "   ", 123]) {
    const r = await request({ method: "POST", path: "/api/v1/bolt-intents", body: { a: 1 }, merchantId: m, apiKey: SHOP_KEY });
    assert.equal(r.ok, false, `merchantId=${JSON.stringify(m)}`);
    assert.equal(r.error.code, "beam_merchant_missing");
  }
  // ส่งแค่ apiKey (merchantId undefined) ก็ยังนับว่าตั้งใจยิงรายร้าน
  assert.equal((await request({ method: "GET", path: "/x", apiKey: SHOP_KEY })).error.code, "beam_merchant_missing");
  assert.equal(CALLS.length, 0, "ไม่มี merchantId แต่ยังยิงออกไป");
});

test("② รายร้านแต่ไม่มี/ว่าง apiKey → beam_api_key_missing · 0 ครั้ง", async () => {
  asMerchant({ BEAM_PARTNER_ID: PARTNER_ID });
  HANDLER = () => ({ status: 200, data: {} });
  for (const k of [undefined, null, "", "  ", 7]) {
    const r = await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: k });
    assert.equal(r.error.code, "beam_api_key_missing", `apiKey=${JSON.stringify(k)}`);
  }
  assert.equal(CALLS.length, 0);
});

test("② merchantId / apiKey มี ':' หรือช่องว่างกลาง → *_invalid · 0 ครั้ง", async () => {
  asPartner();
  HANDLER = () => ({ status: 200, data: {} });
  for (const m of ["a:b", "a b"]) {
    assert.equal((await request({ method: "GET", path: "/x", merchantId: m, apiKey: SHOP_KEY })).error.code, "beam_merchant_invalid");
  }
  for (const k of ["k:1", "k 1"]) {
    assert.equal((await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: k })).error.code, "beam_api_key_invalid");
  }
  assert.equal(CALLS.length, 0);
});

test("② รายร้านครบ แต่ไม่ตั้ง BEAM_PARTNER_ID → beam_config_missing บอกชื่อ env · 0 ครั้ง · ไม่มีค่าตั้งต้นในโค้ด", async () => {
  asMerchant();
  HANDLER = () => ({ status: 200, data: {} });
  const r = await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.equal(r.error.code, "beam_config_missing");
  assert.match(r.error.message, /BEAM_PARTNER_ID/);
  assert.match(r.error.message, /Shopchamp/);
  assert.equal(CALLS.length, 0);
});

test("③ ไม่ส่งกุญแจรายร้าน = บัญชีบริษัท · ไม่มี X-Beam-Partner-ID แม้ตั้ง BEAM_PARTNER_ID", async () => {
  asMerchant({ BEAM_PARTNER_ID: PARTNER_ID });
  HANDLER = () => ({ status: 200, data: { ok: 1 } });
  const r = await request({ method: "GET", path: "/x" });
  assert.equal(r.ok, true);
  assert.equal(decodeBasic(CALLS[0].headers.Authorization), `${MERCHANT_ID}:${MERCHANT_KEY}`);
  assert.ok(!("X-Beam-Partner-ID" in CALLS[0].headers));
});

test("③ env ว่าง / มีแค่ BEAM_PARTNER_ID แต่ไม่ส่งกุญแจรายร้าน → beam_config_missing · 0 ครั้ง", async () => {
  assert.equal((await request({ method: "GET", path: "/x" })).error.code, "beam_config_missing");
  asPartner();
  assert.equal((await request({ method: "GET", path: "/x" })).error.code, "beam_config_missing");
  assert.equal(CALLS.length, 0);
});

test("BEAM_ENV=production → api.beamcheckout.com · ค่าสะกดผิด = playground · opts.env ชนะ env ของโมดูล", async () => {
  asPartner({ BEAM_ENV: "production" });
  HANDLER = () => ({ status: 200, data: {} });
  await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.ok(CALLS[0].url.startsWith("https://api.beamcheckout.com/"), CALLS[0].url);
  asPartner({ BEAM_ENV: "prodution" });
  await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.ok(CALLS[1].url.startsWith("https://playground.api.beamcheckout.com/"));
  config._setEnv({});
  await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY, env: { BEAM_PARTNER_ID: PARTNER_ID, BEAM_ENV: "production" } });
  assert.ok(CALLS[2].url.startsWith("https://api.beamcheckout.com/"));
  assert.equal(CALLS[2].headers["X-Beam-Partner-ID"], PARTNER_ID);
});

test("ไม่ใช่ 2xx → ซองปลอดภัย · อ่านรหัสซ้อนใน body.error ของ Beam", async () => {
  asPartner();
  HANDLER = () => ({ status: 400, data: { code: 400, message: "Bad request", error: { errorCode: "INVALID_PAYMENT_METHOD", errorMessage: "alipayPlus not enabled" } } });
  const r = await request({ method: "POST", path: "/x", body: {}, merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, "beam_http_400", "code ตัวเลขของ Beam ไม่ใช่รหัสที่ใช้ได้");
  assert.equal(r.error.message, "Bad request");
  assert.equal(r.error.providerDetailCode, "INVALID_PAYMENT_METHOD");
  assert.equal(r.error.providerDetailMessage, "alipayPlus not enabled");
  HANDLER = () => ({ status: 404, data: { code: "NOT_FOUND" } });
  const r2 = await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY });
  assert.equal(r2.error.code, "NOT_FOUND");
  assert.equal(r2.error.providerErrorCode, "NOT_FOUND");
});

test("เน็ตล่ม / หมดเวลา / ไม่รู้จัก → beam_network_error / beam_timeout / beam_unknown_error (ไม่ throw)", async () => {
  asPartner();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    HANDLER = () => ({ __throw: Object.assign(new Error("x"), { code: "ECONNABORTED" }) });
    assert.equal((await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY })).error.code, "beam_timeout");
    HANDLER = () => ({ __throw: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
    assert.equal((await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY })).error.code, "beam_network_error");
    HANDLER = () => ({ __throw: new Error("x") });
    assert.equal((await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY })).error.code, "beam_unknown_error");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(normalizeAxiosError({ response: { status: 502, data: null } }).code, "beam_http_502");
});

test("④ กุญแจไม่โผล่ใน error ทุกทาง (missing · 401 echo · network throw · console.warn)", async () => {
  const texts = [];
  asPartner();
  texts.push(JSON.stringify(await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT })));
  texts.push(JSON.stringify(await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: "bad:key" })));
  const basic = Buffer.from(`${SHOP_MERCHANT}:${SHOP_KEY}`).toString("base64");
  HANDLER = () => ({ status: 401, data: { code: "UNAUTHORIZED", message: `Authorization Basic ${basic}` } });
  texts.push(JSON.stringify(await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY })));
  const err = Object.assign(new Error("boom"), { code: "ECONNRESET", config: { headers: { Authorization: `Basic ${basic}` } } });
  HANDLER = () => ({ __throw: err });
  const origWarn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.map(String).join(" "));
  try {
    texts.push(JSON.stringify(await request({ method: "GET", path: "/x", merchantId: SHOP_MERCHANT, apiKey: SHOP_KEY })));
  } finally {
    console.warn = origWarn;
  }
  texts.push(warned.join("\n"));
  const all = texts.join("\n");
  assert.ok(!all.includes(SHOP_KEY), "apiKey ของร้านหลุด");
  assert.ok(!all.includes("bad:key"), "apiKey ผิดรูปถูกสะท้อนกลับ");
  assert.ok(!all.includes(basic), "Basic blob หลุด");
  assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(all), "Authorization หลุด");
});

test("beamConfig: presence ไม่มีค่าลับ · describeAuth · โหมด · env arg ชนะ _setEnv", () => {
  asMerchant({ BEAM_PARTNER_ID: PARTNER_ID, BEAM_WEBHOOK_HMAC_KEY: "wh-secret-not-real" });
  const p = config.getBeamPresence();
  assert.equal(p.ok, true);
  assert.equal(p.apiMode, "merchant");
  assert.equal(p.hasWebhookHmacKey, true);
  const dump = JSON.stringify(p) + JSON.stringify(describeAuth());
  assert.ok(!dump.includes(MERCHANT_KEY) && !dump.includes("wh-secret-not-real"));
  assert.equal(config.getBeamApiMode({ BEAM_PARTNER_ID: "p" }), "partner");
  assert.deepEqual(config.getBeamPresence({}).missing, ["BEAM_MERCHANT_ID", "BEAM_MERCHANT_API_KEY"]);
  assert.equal(config.getBeamBaseUrlLabel({ BEAM_ENV: " Production " }), "production");
  assert.equal(config.getBeamConfig().webhookHmacKey, "wh-secret-not-real");
  config._resetEnv();
  assert.equal(config.getBeamBaseUrlLabel({}), "playground");
});

test("_setHttp ปัดของที่ไม่ใช่ฟังก์ชัน", () => {
  assert.throws(() => client._setHttp(null), TypeError);
});

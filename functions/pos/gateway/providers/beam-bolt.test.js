// pos/gateway/providers/beam-bolt.test.js — เทสเจ้า Beam Bolt · ยกจากบ้านพี่น้อง ก้อน 7
// รัน: cd shopchamp_server/functions && node --test pos/gateway/providers/beam-bolt.test.js
// 🔴 ห้ามออกเน็ต (ยิงจริง = charge จริงขึ้นจอเครื่องที่ลูกค้ายืน) ⇒ http ปลอมผ่าน beamClient._setHttp · ไม่ตั้ง HANDLER แล้วมีคนยิง = throw
// กุญแจร้าน: ใช้ beamMerchantCreds ตัวจริงกับฐานปลอม + กล่องเข้ารหัสด้วยกุญแจทดสอบ ⇒ พิสูจน์ว่า credKey/env เดินถึงตัวถอดจริง
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

// ── ฐานปลอม (วางก่อน require provider) ──
const DOCS = {}; // "col/id" -> data
const fakeDb = {
  __fake: true,
  collection: (col) => ({
    doc: (id) => ({
      get: async () => {
        const d = DOCS[`${col}/${id}`];
        return { exists: d !== undefined, id, data: () => d };
      },
    }),
  }),
};
const fbPath = require.resolve("../../../firebase");
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db: fakeDb } };

const beamClient = require("../beam/beamClient");
const CREDS = require("../beam/beamMerchantCreds");
const { SUPPORTED_PAYMENT_METHODS, PAYMENT_METHOD_FACTORIES } = require("../beam/beamPaymentMethods");
const BEAM = require("./beam-bolt");

function optional(rel) {
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(rel.replace("./", ""))) return null;
    throw e;
  }
}
const INDEX = optional("./index");
const H2H = optional("./ntt");
const EDC = optional("./ntt-edc");
const needIndex = INDEX ? false : "ยังไม่มี providers/index.js";
const needAll = INDEX && H2H && EDC ? false : "ยังไม่มี index/ntt/ntt-edc";

// ── http ปลอม ──
let CALLS = [];
let HANDLER = null;
beamClient._setHttp(async (opts) => {
  CALLS.push({ method: String(opts.method || "GET").toUpperCase(), url: opts.url, headers: opts.headers || {}, data: opts.data });
  if (typeof HANDLER !== "function") throw new Error(`เทสไม่ได้ตั้ง HANDLER แต่มีการยิง ${opts.method} ${opts.url}`);
  const out = await HANDLER(opts, CALLS.length);
  if (out && out.__throw) throw out.__throw;
  return { status: out.status, data: out.data, headers: out.headers || {} };
});

// ── env + กุญแจทดสอบ (ปลอม · bytes 0..31) ──
const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const PARTNER_ID = "pnr_TEST_partner";
const BASE_ENV = {
  BEAM_PARTNER_ID: PARTNER_ID,
  GATEWAY_CRED_ENC_KEY: TEST_KEY,
  // บัญชีบริษัทค้างใน env โดยเจตนา — ตรึงว่าไม่มีเส้นไหนหยิบไปใช้
  BEAM_MERCHANT_ID: "merchant-test",
  BEAM_MERCHANT_API_KEY: "not-a-real-key",
};
const setEnv = (extra) => BEAM._setEnv({ ...BASE_ENV, ...(extra || {}) });

const SHOP = "shop_T1";
const SHOP_MERCHANT = "m_shopT1";
const SHOP_KEY = "shop-partner-key-not-real";
function seedCreds(shopId, merchantId, apiKey, key) {
  const enc = CREDS._internal.encryptSecret(apiKey, { field: "apiKey", shopId }, { key: key || TEST_KEY });
  assert.ok(enc.box, JSON.stringify(enc));
  DOCS[`beamMerchantCreds/${shopId}`] = { shopId, merchantId, apiKey: enc.box, webhookHmacKey: null };
}
seedCreds(SHOP, SHOP_MERCHANT, SHOP_KEY);

const { spec, mapIntentState, toSatang, environmentInfo, I18N_KEYS } = BEAM;
const withShop = (fn) => (input) => fn({ shopId: SHOP, ...(input || {}) });
const createQR = withShop(BEAM.createQR);
const inquiry = withShop(BEAM.inquiry);
const testConnection = withShop(BEAM.testConnection);

const CONFIG = { boltConnectionId: "bc_TEST123" };
const chPromptPay = spec.channels.find((c) => c.channelId === "beamBoltPromptPay");
const chInstallments = spec.channels.find((c) => c.channelId === "beamBoltCardInstallments");
const I18N = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;

test.beforeEach(() => {
  CALLS = [];
  HANDLER = null;
  setEnv();
});
test.after(() => {
  beamClient._resetHttp();
  BEAM._resetEnv();
});

// ══ ① ทะเบียน ══
test("① ลงทะเบียนผ่านเดี่ยว · ซ้ำ = ปัด", { skip: needIndex }, () => {
  assert.doesNotThrow(() => INDEX.buildRegistry([BEAM]));
  assert.throws(() => INDEX.buildRegistry([BEAM, BEAM]));
});

test("① อยู่ร่วมกับ ntt-h2h + ntt-edc ได้ (ไม่ชน id/channelId)", { skip: needAll }, () => {
  const r = INDEX.buildRegistry([H2H, EDC, BEAM]);
  assert.deepEqual(r.listProviders().map((s) => s.id), ["ntt-h2h", "ntt-edc", "beam-bolt"]);
  for (const row of r.listChannels().filter((c) => c.providerId === "beam-bolt")) assert.equal(row.channelChoice, "at-bill");
});

test("mutant: ถอด testConnection / createQR → ทะเบียนปัด", { skip: needIndex }, () => {
  assert.throws(() => INDEX.buildRegistry([{ spec, createQR: BEAM.createQR, inquiry: BEAM.inquiry }]), /testConnection/);
  assert.throws(() => INDEX.buildRegistry([{ spec, inquiry: BEAM.inquiry, testConnection: BEAM.testConnection }]), /createQR/);
});

test("mutant: ใส่ store ให้ช่องกรอก → ทะเบียนปัด (Shopchamp ห้ามมี store)", { skip: needIndex }, () => {
  const withStore = { ...BEAM, spec: { ...spec, connection: { ...spec.connection, fields: spec.connection.fields.map((f) => ({ ...f, store: "plain" })) } } };
  assert.throws(() => INDEX.buildRegistry([withStore]));
});

test("① at-bill: ทะเบียนไม่ปัดด้วย lastKnownAvailable (ด่านจริง = สวิตช์ร้าน)", { skip: needIndex }, () => {
  const r = INDEX.buildRegistry([BEAM]);
  for (const c of spec.channels) {
    assert.equal(r.resolveSalesChannel(c.channelId).ok, true, c.channelId);
    assert.ok(r.findChannel(c.channelId));
  }
});

// ══ ② spec ══
test("② connection: 1 ช่อง boltConnectionId บังคับ · ไม่ลับ · ไม่มี store/env · ไม่มีช่อง apiKey/webhookHmacKey", () => {
  assert.equal(spec.id, "beam-bolt");
  assert.equal(spec.runtime, "server");
  assert.equal(spec.channelChoice, "at-bill");
  assert.deepEqual(spec.connection.fields.map((f) => f.key), ["boltConnectionId"]);
  const f = spec.connection.fields[0];
  assert.equal(f.required, true);
  assert.ok(!f.secret);
  for (const fld of spec.connection.fields) {
    assert.equal("store" in fld, false, "ห้ามมี store");
    assert.equal(fld.env, undefined);
    if (fld.secret) assert.equal(fld.secret, true);
  }
});

test("② ownership = {boltConnectionId, beamBoltConnections} · ไม่ประกาศ canCancel/canPair/canCheckChannels เอง", () => {
  assert.deepEqual(spec.connection.ownership, { field: "boltConnectionId", registry: "beamBoltConnections" });
  for (const k of ["canCancel", "canPair", "canCheckChannels"]) assert.equal(spec[k], undefined, k);
});

test("② derive: canPair/canCancel = true จากฟังก์ชันจริง · ถอด pair หรือ unpair = ปัด", { skip: needIndex }, () => {
  const r = INDEX.buildRegistry([BEAM]);
  assert.equal(r.canPairOf(BEAM), true);
  assert.equal(r.canCancelOf(BEAM), true);
  assert.equal(r.canCheckChannelsOf(BEAM), false);
  assert.throws(() => INDEX.buildRegistry([{ ...BEAM, unpair: undefined }]), /คู่/);
  assert.throws(() => INDEX.buildRegistry([{ ...BEAM, pair: undefined }]), /คู่/);
  assert.throws(() => INDEX.buildRegistry([{ ...BEAM, spec: { ...spec, connection: { ...spec.connection, ownership: undefined } } }]), /ownership/);
});

test("② test.kind = query-nonexistent · note เอ่ย boltConnectionId · 401/404 · ไม่ครอบ · สภาพแวดล้อม", () => {
  const t = spec.connection.test;
  assert.equal(t.kind, "query-nonexistent");
  assert.ok(t.note.includes("boltConnectionId"));
  assert.ok(t.note.includes("ไม่ครอบ"));
  assert.ok(/401/.test(t.note) && /404/.test(t.note));
  assert.ok(/playground|production/.test(t.note));
});

test("② ช่องทาง = SUPPORTED_PAYMENT_METHODS เป๊ะทั้ง 2 ทิศ · 9 แถว · มี factory ทุกแถว", () => {
  const declared = spec.channels.map((c) => c.paymentMethodType);
  assert.deepEqual([...declared].sort(), [...SUPPORTED_PAYMENT_METHODS].sort());
  assert.equal(new Set(declared).size, declared.length);
  assert.equal(spec.channels.length, 9);
  for (const c of spec.channels) assert.equal(typeof PAYMENT_METHOD_FACTORIES[c.paymentMethodType], "function", c.channelId);
});

test("② ไม่ประกาศ qrKind · lastKnownAvailable:false ทุกแถว · channelId ขึ้นต้น beamBolt · sellable:false เฉพาะผ่อนชำระ", () => {
  for (const c of spec.channels) {
    assert.equal("qrKind" in c, false, c.channelId);
    assert.equal(c.lastKnownAvailable, false, c.channelId);
    assert.ok(/^beamBolt[A-Z]/.test(c.channelId), c.channelId);
  }
  assert.deepEqual(spec.channels.filter((c) => c.sellable === false).map((c) => c.channelId), ["beamBoltCardInstallments"]);
});

test("② listSellableChannels ไม่นับแถวผ่อนชำระ (beam 9→8)", { skip: needIndex }, () => {
  const r = INDEX.buildRegistry([BEAM]);
  assert.ok(r.listChannels().some((c) => c.channelId === "beamBoltCardInstallments"));
  assert.equal(r.listSellableChannels().filter((c) => c.providerId === "beam-bolt").length, 8);
});

test("② channelId/ข้อความสำรองไม่ชนเจ้า NTT", { skip: needAll }, () => {
  const taken = new Set([...H2H.spec.channels, ...EDC.spec.channels].map((c) => c.channelId));
  const others = new Set();
  for (const mod of [H2H, EDC]) {
    others.add(mod.spec.labelFallback);
    for (const c of mod.spec.channels) others.add(c.nameFallback);
  }
  assert.ok(others.size > 10, "ชุดเทียบเล็กผิดปกติ = เขียวฟรี");
  assert.ok(!others.has(spec.labelFallback));
  for (const c of spec.channels) {
    assert.ok(!taken.has(c.channelId), c.channelId);
    assert.ok(!others.has(c.nameFallback), c.nameFallback);
  }
});

// ══ ③ i18n ══
test("③ I18N_KEYS 11 ตัว รูปถูก ไม่มีอักษรไทย · ข้อความสำรองครบ ไม่ใช่ key", () => {
  assert.equal(I18N_KEYS.length, 11);
  assert.equal(new Set(I18N_KEYS).size, 11);
  for (const k of I18N_KEYS) {
    assert.ok(I18N.test(k), k);
    assert.ok(!/[฀-๿]/.test(k), k);
  }
  for (const c of spec.channels) assert.equal(c.nameKey, `screens.paymentGateway.channel.${c.channelId}`);
  for (const v of [spec.labelFallback, ...spec.connection.fields.map((f) => f.labelFallback), ...spec.channels.map((c) => c.nameFallback)]) {
    assert.ok(typeof v === "string" && v.trim() && !I18N.test(v), v);
  }
});

test("ข้อความถึงร้านชี้ทีมงาน Shopchamp", () => {
  assert.ok(BEAM.NOT_CONFIGURED_MESSAGE.includes("ติดต่อทีมงาน Shopchamp"));
});

// ══ ④ testConnection ══
test("④ สำเร็จ: GET /bolt-connections/{id} ครั้งเดียว · ไม่แตะ bolt-intents/DELETE · verifiedFields ตรง key", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123", deviceId: "dev_1" } });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(CALLS.length, 1);
  assert.equal(CALLS[0].method, "GET");
  assert.ok(CALLS[0].url.endsWith("/api/v1/bolt-connections/bc_TEST123"), CALLS[0].url);
  assert.deepEqual(r.data.verifiedFields, ["boltConnectionId"]);
  assert.ok(r.data.note.includes("ยังไม่ได้พิสูจน์"));
});

test("④ 401 → beam_http_401 ชี้ทีมงาน · 404 → beam_http_404 ชี้ boltConnectionId", async () => {
  HANDLER = () => ({ status: 401, data: { message: "Unauthorized" } });
  let r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "beam_http_401");
  assert.ok(/ทีมงาน/.test(r.error.message));
  HANDLER = () => ({ status: 404, data: { message: "not found" } });
  r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "beam_http_404");
  assert.ok(/boltConnectionId/.test(r.error.message));
});

test("mutant: Beam ใส่ code ของตัวเองใน body → รหัสเรายังผูกกับ status · เก็บ providerErrorCode", async () => {
  HANDLER = () => ({ status: 401, data: { code: "invalid_credentials", message: "bad key" } });
  const a = await testConnection({ config: CONFIG });
  assert.equal(a.error.code, "beam_http_401");
  assert.equal(a.error.providerErrorCode, "invalid_credentials");
  HANDLER = () => ({ status: 404, data: { code: "invalid_credentials", message: "x" } });
  const b = await testConnection({ config: CONFIG });
  assert.equal(b.error.code, "beam_http_404");
});

test("④ ไม่กรอก/อักขระแยก URL → ปัดก่อนแตะเน็ต (0 call)", async () => {
  let r = await testConnection({ config: {} });
  assert.equal(r.error.code, "config_missing");
  r = await testConnection({ config: { boltConnectionId: "bc/../admin" } });
  assert.equal(r.error.code, "config_invalid");
  assert.equal(CALLS.length, 0);
});

test("④ 500 → beam_http_500 + ข้อความสภาพแวดล้อม", async () => {
  HANDLER = () => ({ status: 500, data: { message: "boom" } });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "beam_http_500");
  assert.ok(/สภาพแวดล้อม/.test(r.error.message));
});

// ══ ⑤ ธงสภาพแวดล้อม ══
test("⑤ ไม่ตั้ง BEAM_ENV → playground + บอกว่าเป็นค่าตั้งต้น", async () => {
  assert.equal(environmentInfo().environment, "playground");
  assert.equal(environmentInfo().source, "default");
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123" } });
  const r = await testConnection({ config: CONFIG });
  assert.ok(CALLS[0].url.startsWith("https://playground.api.beamcheckout.com"), CALLS[0].url);
  assert.equal(r.data.environment, "playground");
  assert.ok(/ไม่ได้ตั้ง BEAM_ENV/.test(r.data.note));
});

test("⑤ BEAM_ENV=production → api.beamcheckout.com · ไม่มีคำเตือน", async () => {
  setEnv({ BEAM_ENV: "production" });
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123" } });
  const r = await testConnection({ config: CONFIG });
  assert.ok(CALLS[0].url.startsWith("https://api.beamcheckout.com"), CALLS[0].url);
  assert.equal(r.data.environment, "production");
  assert.ok(!/⚠️/.test(r.data.note));
});

test("🔴⑤ สะกดผิด 'prodution' → playground เงียบ ๆ ⇒ ผลต้องเตือนพร้อมคำที่พิมพ์ผิด", async () => {
  setEnv({ BEAM_ENV: "prodution" });
  assert.equal(environmentInfo().source, "unrecognized");
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123" } });
  const r = await testConnection({ config: CONFIG });
  assert.ok(CALLS[0].url.startsWith("https://playground.api.beamcheckout.com"));
  assert.ok(/prodution/.test(r.data.note) && /⚠️/.test(r.data.note));
});

test("⑤ '  Production ' = ตั้งใจถูก ไม่เตือน", () => {
  setEnv({ BEAM_ENV: "  Production " });
  const info = environmentInfo();
  assert.equal(info.environment, "production");
  assert.equal(info.source, "explicit");
  assert.equal(info.warning, null);
});

test("⑤ input.env ต่อคำขอชนะ _setEnv (ทั้งป้ายและ URL ที่ยิงตรงกัน)", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123" } });
  const r = await testConnection({ config: CONFIG, env: { ...BASE_ENV, BEAM_ENV: "production" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(CALLS[0].url.startsWith("https://api.beamcheckout.com"));
  assert.equal(r.data.environment, "production");
});

// ══ ⑥ createQR ══
test("🔴⑥ บาท→สตางค์ 250 = 25000 · body paired mode · referenceId · idempotency key · qr null", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_1", latestChargeId: "ch_1" } });
  const r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 250, referenceId: "pgabc" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(CALLS.length, 1);
  assert.equal(CALLS[0].method, "POST");
  assert.ok(CALLS[0].url.endsWith("/api/v1/bolt-intents"));
  const body = CALLS[0].data;
  assert.equal(body.amount, 25000);
  assert.equal(body.currency, "THB");
  assert.deepEqual(body.mode, { type: "PAIRING" });
  assert.equal(body.boltConnectionId, "bc_TEST123");
  assert.equal(body.referenceId, "pgabc");
  assert.deepEqual(body.paymentMethod, { paymentMethodType: "QR_PROMPT_PAY", qrPromptPay: {} });
  assert.ok(CALLS[0].headers["x-beam-idempotency-key"]);
  assert.deepEqual(r.data, { providerRef: "bi_1", chargeId: "ch_1", qrPayload: null, qrKind: null });
});

test("⑥ ยังไม่มี charge → chargeId null · 200 ไม่มี id → bad_response · 400 → beam_http_400", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_2" } });
  let r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 10, referenceId: "b" });
  assert.equal(r.data.chargeId, null);
  HANDLER = () => ({ status: 200, data: { boltConnectionId: "bc_TEST123" } });
  r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 10, referenceId: "b" });
  assert.equal(r.error.code, "bad_response");
  HANDLER = () => ({ status: 400, data: { message: "amount must be a positive integer" } });
  r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 10, referenceId: "b" });
  assert.equal(r.error.code, "beam_http_400");
  assert.equal(r.error.status, 400);
});

test("🔴⑥ ปัดเศษสตางค์ · ขอบล่าง/บน", () => {
  assert.equal(toSatang(19.99).satang, 1999);
  assert.equal(toSatang(0.01).satang, 1);
  assert.equal(toSatang(1000000).satang, 100000000);
  for (const bad of [0, -5, "abc", 1000001, 0.004]) assert.equal(toSatang(bad).error.error.code, "bad_amount", String(bad));
});

test("⑥ ยอดผิด / ผ่อนชำระ / ช่องทางผิดรูป → ปัดก่อนแตะเน็ต (0 call)", async () => {
  let r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 0 });
  assert.equal(r.error.code, "bad_amount");
  r = await createQR({ channel: { ...chInstallments, lastKnownAvailable: true }, config: CONFIG, amount: 100, referenceId: "b" });
  assert.equal(r.error.code, "channel_needs_per_bill_fields");
  r = await createQR({ channel: { channelId: "x" }, config: CONFIG, amount: 100 });
  assert.equal(r.error.code, "bad_channel");
  r = await createQR({ channel: { paymentMethodType: "SPAY_LATER" }, config: CONFIG, amount: 100 });
  assert.equal(r.error.code, "unsupported_payment_method");
  assert.equal(CALLS.length, 0);
});

test("⑥ ทุกวิธีจ่าย (ยกเว้นผ่อน) ประกอบ paymentMethod จาก factory จริง", async () => {
  for (const c of spec.channels) {
    if (c.paymentMethodType === "CARD_INSTALLMENTS") continue;
    CALLS = [];
    HANDLER = () => ({ status: 200, data: { id: `bi_${c.channelId}` } });
    const r = await createQR({ channel: c, config: CONFIG, amount: 5, referenceId: "b" });
    assert.equal(r.ok, true, c.channelId);
    assert.deepEqual(CALLS[0].data.paymentMethod, PAYMENT_METHOD_FACTORIES[c.paymentMethodType]());
  }
});

// ══ ⑦ inquiry ══
test("🔴⑦ ตารางสถานะ: result ก่อน · ว่าง = ดู charge · ไม่รู้จัก = error", () => {
  assert.equal(mapIntentState("CH_SUCCEEDED"), "paid");
  assert.equal(mapIntentState("CH_PROCESSING_FAILED"), "error");
  assert.equal(mapIntentState("CH_INSUFFICIENT_FUNDS"), "error");
  assert.equal(mapIntentState("CH_AUTHENTICATION_FAILED"), "error");
  assert.equal(mapIntentState("BI_EXPIRED"), "closed");
  assert.equal(mapIntentState("BI_CANCELED"), "closed");
  assert.equal(mapIntentState("CH_SUCCEEDED", "PENDING"), "paid");
  assert.equal(mapIntentState("", undefined), "waiting");
  assert.equal(mapIntentState(undefined, undefined), "waiting");
  assert.equal(mapIntentState("", "PENDING"), "waiting");
  assert.equal(mapIntentState("", "SUCCEEDED"), "paid");
  assert.equal(mapIntentState("", "FAILED"), "error");
  assert.equal(mapIntentState("BI_SOMETHING_NEW"), "error");
  assert.equal(mapIntentState("", "SOMETHING_NEW"), "error");
  assert.equal(mapIntentState(" ch_succeeded "), "paid");
});

test("⑦ จ่ายแล้ว: GET /bolt-intents/{id} · amountPaid เป็นบาท · ยังไม่จ่าย = null", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "CH_SUCCEEDED", amount: 25000 } });
  let r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9" });
  assert.equal(CALLS[0].method, "GET");
  assert.ok(CALLS[0].url.endsWith("/api/v1/bolt-intents/bi_9"));
  assert.equal(r.data.state, "paid");
  assert.equal(r.data.amountPaid, 250);
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "", amount: 25000 } });
  r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9" });
  assert.equal(r.data.state, "waiting");
  assert.equal(r.data.amountPaid, null);
});

test("⑦ expectedAmount ตรง → paid (รวม 19.99)", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "CH_SUCCEEDED", amount: 1999 } });
  const r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9", expectedAmount: 19.99 });
  assert.equal(r.data.state, "paid");
});

test("🔴⑦ expectedAmount ไม่ตรง → amount_mismatch (ไม่ใช่ paid/error) · ต่าง 1 สตางค์ · ยอดหาย/ผิดชนิด/บิลไม่มียอด", async () => {
  const cases = [
    { amount: 100, expectedAmount: 250 },
    { amount: 24999, expectedAmount: 250 },
    { amount: 2500000, expectedAmount: 250 },
    { amount: undefined, expectedAmount: 250 },
    { amount: "25000", expectedAmount: 250 },
    { amount: 25000, expectedAmount: null },
  ];
  for (const c of cases) {
    HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "CH_SUCCEEDED", amount: c.amount } });
    const r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9", expectedAmount: c.expectedAmount });
    assert.equal(r.ok, true);
    assert.equal(r.data.state, "amount_mismatch", JSON.stringify(c));
    assert.equal(r.data.expectedAmount, c.expectedAmount);
  }
});

test("⑦ ยังไม่จ่าย/ปิดแล้ว ไม่เทียบยอด · ไม่ส่ง expectedAmount = พฤติกรรมเดิม", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "BI_EXPIRED", amount: 100 } });
  let r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9", expectedAmount: 250 });
  assert.equal(r.data.state, "closed");
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "CH_SUCCEEDED", amount: 100 } });
  r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "bi_9" });
  assert.equal(r.data.state, "paid");
});

test("⑦ providerRef ว่าง/ผิดรูป → bad_input (0 call)", async () => {
  let r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "" });
  assert.equal(r.error.code, "bad_input");
  r = await inquiry({ channel: chPromptPay, config: CONFIG, providerRef: "a/b" });
  assert.equal(r.error.code, "bad_input");
  assert.equal(CALLS.length, 0);
});

// ══ ⑧ ความลับ + กุญแจรายร้าน ══
test("⑧ กุญแจร้านไม่โผล่ในผลลัพธ์แม้ Beam echo กลับ · แต่ส่งไปจริงใน Basic", async () => {
  const basic = Buffer.from(`${SHOP_MERCHANT}:${SHOP_KEY}`).toString("base64");
  HANDLER = () => ({ status: 401, data: { message: `Authorization Basic ${basic}` } });
  const r = await testConnection({ config: CONFIG });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(SHOP_KEY) && !text.includes("not-a-real-key"));
  assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(text));
  assert.ok(String(CALLS[0].headers.Authorization || "").startsWith("Basic "));
});

test("⑧ เน็ตล่ม/timeout → beam_timeout", async () => {
  HANDLER = () => ({ __throw: Object.assign(new Error("timeout"), { code: "ECONNABORTED" }) });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "beam_timeout");
});

test("⑧ ไม่ตั้ง BEAM_PARTNER_ID → beam_config_missing (0 call) · ไม่ถอยไปบัญชีบริษัท", async () => {
  BEAM._setEnv({ ...BASE_ENV, BEAM_PARTNER_ID: "" });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "beam_config_missing");
  assert.equal(CALLS.length, 0);
});

const decodeBasic = (h) => Buffer.from(String(h || "").replace(/^Basic /, ""), "base64").toString("utf8");
const ALL_SIX = (shopId, extra) => [
  ["testConnection", () => BEAM.testConnection({ shopId, config: CONFIG, ...extra })],
  ["pair", () => BEAM.pair({ shopId, pairingCode: "ABCD", ...extra })],
  ["unpair", () => BEAM.unpair({ shopId, boltConnectionId: "bc_TEST123", ...extra })],
  ["createQR", () => BEAM.createQR({ shopId, channel: chPromptPay, config: CONFIG, amount: 10, referenceId: "R1", ...extra })],
  ["inquiry", () => BEAM.inquiry({ shopId, channel: chPromptPay, config: CONFIG, providerRef: "bi_1", ...extra })],
  ["cancelQR", () => BEAM.cancelQR({ shopId, channel: chPromptPay, config: CONFIG, providerRef: "bi_1", ...extra })],
];

test("🔑 ทั้ง 6 เส้นยิงด้วย Basic merchantId:apiKey ของร้าน + X-Beam-Partner-ID · ไม่ใช่ BEAM_MERCHANT_*", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123", result: "", amount: 1000 } });
  for (const [name, call] of ALL_SIX(SHOP)) {
    CALLS = [];
    const r = await call();
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    assert.equal(CALLS.length, 1, name);
    assert.equal(decodeBasic(CALLS[0].headers.Authorization), `${SHOP_MERCHANT}:${SHOP_KEY}`, name);
    assert.equal(CALLS[0].headers["X-Beam-Partner-ID"], PARTNER_ID, name);
  }
});

test("🔑 ร้านไม่มีกุญแจ → ทั้ง 6 เส้น beam_merchant_not_configured · 0 call", async () => {
  HANDLER = () => ({ status: 200, data: {} });
  for (const [name, call] of ALL_SIX("shop_no_creds")) {
    CALLS = [];
    const r = await call();
    assert.equal(r.error.code, "beam_merchant_not_configured", name);
    assert.equal(r.error.message, BEAM.NOT_CONFIGURED_MESSAGE, name);
    assert.equal(CALLS.length, 0, name);
  }
});

test("🔑 ไม่ส่ง shopId → bad_input · 0 call", async () => {
  HANDLER = () => ({ status: 200, data: {} });
  for (const [name, call] of ALL_SIX(undefined)) {
    CALLS = [];
    const r = await call();
    assert.equal(r.error.code, "bad_input", name);
    assert.equal(CALLS.length, 0, name);
  }
});

test("🔑 กุญแจเข้ารหัสหายจาก env → gateway_cred_key_missing + แจ้งทีมงาน (0 call) · input.credKey ส่งมา = ถอดได้", async () => {
  BEAM._setEnv({ ...BASE_ENV, GATEWAY_CRED_ENC_KEY: "" });
  HANDLER = () => ({ status: 200, data: { id: "bc_TEST123" } });
  const a = await testConnection({ config: CONFIG });
  assert.equal(a.error.code, "gateway_cred_key_missing");
  assert.ok(/แจ้งทีมงาน/.test(a.error.message));
  assert.equal(CALLS.length, 0);
  const b = await testConnection({ config: CONFIG, credKey: TEST_KEY });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(decodeBasic(CALLS[0].headers.Authorization), `${SHOP_MERCHANT}:${SHOP_KEY}`);
});

test("🔑 กุญแจเข้ารหัสผิดตัว → gateway_cred_unreadable (0 call · ไม่ throw)", async () => {
  const wrong = Buffer.alloc(32, 7).toString("base64");
  const r = await testConnection({ config: CONFIG, credKey: wrong });
  assert.equal(r.error.code, "gateway_cred_unreadable");
  assert.equal(CALLS.length, 0);
});

test("🔑 กล่องของร้านอื่นย้ายมาใส่ร้านนี้ → ถอดไม่ออก (binding ผูก shopId)", async () => {
  const enc = CREDS._internal.encryptSecret("k-other", { field: "apiKey", shopId: "shop_other" }, { key: TEST_KEY });
  DOCS["beamMerchantCreds/shop_moved"] = { shopId: "shop_moved", merchantId: "m_moved", apiKey: enc.box };
  const r = await BEAM.testConnection({ shopId: "shop_moved", config: CONFIG });
  assert.equal(r.error.code, "gateway_cred_unreadable");
  assert.equal(CALLS.length, 0);
});

test("🔑 กุญแจ/merchantId ไม่รั่วนอก Authorization (body/header อื่น/ผล)", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_1" } });
  const r = await createQR({ channel: chPromptPay, config: CONFIG, amount: 10, referenceId: "R1" });
  const text = JSON.stringify(r) + JSON.stringify(CALLS[0].data) + JSON.stringify(Object.fromEntries(Object.entries(CALLS[0].headers).filter(([k]) => k !== "Authorization")));
  assert.ok(!text.includes(SHOP_KEY) && !text.includes(SHOP_MERCHANT));
});

test("🔎 400 รูปจริง {error:{errorCode,errorMessage}} → providerErrorCode + providerDetail · code/message คงเดิม", async () => {
  HANDLER = () => ({ status: 400, data: { code: 400, message: "Bad Request", error: { errorCode: "INVALID_REQUEST_ERROR", errorMessage: "ALIPAY_PLUS is not enabled" } } });
  const r = await createQR({ channel: spec.channels.find((c) => c.channelId === "beamBoltAlipayPlus"), config: CONFIG, amount: 10, referenceId: "R" });
  assert.equal(r.error.code, "beam_http_400");
  assert.equal(r.error.message, "Bad Request");
  assert.equal(r.error.providerErrorCode, "INVALID_REQUEST_ERROR");
  assert.equal(r.error.providerDetail, "ALIPAY_PLUS is not enabled");
});

// ══ ⑩ pair / unpair ══
test("⑩ pair สำเร็จ: POST {pairingCode} (trim) · idempotency · คืน id/deviceId/merchantId", async () => {
  HANDLER = (opts) => {
    assert.deepEqual(opts.data, { pairingCode: "7NC736L9" });
    return { status: 201, data: { id: "bc_NEW", deviceId: "dev_9", merchantId: "m_co", createdAt: "2026-08-15T01:02:03.000Z" } };
  };
  const r = await BEAM.pair({ shopId: SHOP, pairingCode: " 7NC736L9 " });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(CALLS[0].method, "POST");
  assert.ok(CALLS[0].url.endsWith("/api/v1/bolt-connections"));
  assert.ok(CALLS[0].headers["x-beam-idempotency-key"]);
  assert.deepEqual(r.data, { boltConnectionId: "bc_NEW", deviceId: "dev_9", merchantId: "m_co", createdAt: "2026-08-15T01:02:03.000Z", environment: "playground" });
});

test("⑩ pair 400/404/409 → pairing_code_rejected · 401 → beam_credentials_invalid · 500 → beam_http_500", async () => {
  for (const [status, code] of [[400, "API_VALIDATION_ERROR"], [404, "NOT_FOUND_ERROR"], [409, "REQUEST_CONFLICT_ERROR"]]) {
    HANDLER = () => ({ status, data: { code, message: "x" } });
    const r = await BEAM.pair({ shopId: SHOP, pairingCode: "BAD" });
    assert.equal(r.error.code, "pairing_code_rejected", String(status));
    assert.ok(/หมดอายุ/.test(r.error.message) && /จอเครื่อง/.test(r.error.message));
    assert.equal(r.error.status, status);
    assert.equal(r.error.providerErrorCode, code);
  }
  HANDLER = () => ({ status: 401, data: {} });
  let r = await BEAM.pair({ shopId: SHOP, pairingCode: "X" });
  assert.equal(r.error.code, "beam_credentials_invalid");
  assert.ok(/แจ้งทีมงาน/.test(r.error.message));
  HANDLER = () => ({ status: 500, data: {} });
  r = await BEAM.pair({ shopId: SHOP, pairingCode: "X" });
  assert.equal(r.error.code, "beam_http_500");
});

test("⑩ pair รหัสว่าง → bad_input (0 call) · 201 ไม่มี id → bad_response", async () => {
  let r = await BEAM.pair({ shopId: SHOP, pairingCode: "  " });
  assert.equal(r.error.code, "bad_input");
  assert.equal(CALLS.length, 0);
  HANDLER = () => ({ status: 201, data: { deviceId: "dev_9" } });
  r = await BEAM.pair({ shopId: SHOP, pairingCode: "X" });
  assert.equal(r.error.code, "bad_response");
});

test("⑩ unpair 202 → alreadyGone:false · 404 → alreadyGone:true · 401 → ล้ม · ค่าผิดรูป = 0 call", async () => {
  HANDLER = () => ({ status: 202, data: {} });
  let r = await BEAM.unpair({ shopId: SHOP, boltConnectionId: "bc_TEST123" });
  assert.equal(CALLS[0].method, "DELETE");
  assert.ok(CALLS[0].url.endsWith("/api/v1/bolt-connections/bc_TEST123"));
  assert.deepEqual(r.data, { boltConnectionId: "bc_TEST123", alreadyGone: false, environment: "playground" });
  HANDLER = () => ({ status: 404, data: { code: "NOT_FOUND_ERROR" } });
  r = await BEAM.unpair({ shopId: SHOP, boltConnectionId: "bc_GONE" });
  assert.equal(r.data.alreadyGone, true);
  HANDLER = () => ({ status: 401, data: {} });
  r = await BEAM.unpair({ shopId: SHOP, boltConnectionId: "bc_TEST123" });
  assert.equal(r.error.code, "beam_credentials_invalid");
  CALLS = [];
  for (const bad of [{}, { boltConnectionId: "" }, { boltConnectionId: "a/b" }, { boltConnectionId: "a b" }]) {
    r = await BEAM.unpair({ shopId: SHOP, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(CALLS.length, 0);
});

// ══ cancelQR ══
test("cancelQR สำเร็จ → PATCH /bolt-intents/{id}/cancel ไม่มี body", async () => {
  HANDLER = () => ({ status: 200, data: { id: "bi_9", result: "BI_CANCELED" } });
  const r = await BEAM.cancelQR({ shopId: SHOP, channel: chPromptPay, config: CONFIG, providerRef: "bi_9" });
  assert.equal(r.ok, true);
  assert.equal(r.data.canceled, true);
  assert.equal(CALLS[0].method, "PATCH");
  assert.equal(CALLS[0].data, undefined);
  assert.ok(/\/api\/v1\/bolt-intents\/bi_9\/cancel$/.test(CALLS[0].url));
});

test("cancelQR Beam ปฏิเสธ 409 → ok:false beam_http_409 · ref ผิด/config ขาด = 0 call", async () => {
  HANDLER = () => ({ status: 409, data: { code: "REQUEST_CONFLICT_ERROR", message: "already finalized" } });
  let r = await BEAM.cancelQR({ shopId: SHOP, channel: chPromptPay, config: CONFIG, providerRef: "bi_9" });
  assert.equal(r.error.code, "beam_http_409");
  assert.equal(r.error.providerErrorCode, "REQUEST_CONFLICT_ERROR");
  CALLS = [];
  r = await BEAM.cancelQR({ shopId: SHOP, config: CONFIG, providerRef: "" });
  assert.equal(r.error.code, "bad_input");
  r = await BEAM.cancelQR({ shopId: SHOP, config: CONFIG, providerRef: "a b/c" });
  assert.equal(r.error.code, "bad_input");
  r = await BEAM.cancelQR({ shopId: SHOP, config: {}, providerRef: "bi_9" });
  assert.equal(r.error.code, "config_missing");
  assert.equal(CALLS.length, 0);
});

// ══ webhook: verifyBeamSignature ══
// เวกเตอร์ตรวจไขว้กับ openssl: printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'secret-key-123' -binary | base64
const WH_KEY = "c2VjcmV0LWtleS0xMjM="; // base64("secret-key-123")
const WH_BODY = '{"id":"bi_1","merchant":{"merchantId":"m_1"}}';
const WH_SIG = "0ikcfobkBVNi2yx40GvCkD2UBmxznRrDVA7NW6ytOws=";

test("webhook: เวกเตอร์ที่รู้ค่า → true (สตริงและ Buffer · header มีช่องว่างหัวท้าย · ชื่อ header แทนได้)", () => {
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: WH_SIG, hmacKey: WH_KEY }), true);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: Buffer.from(WH_BODY), signatureHeader: ` ${WH_SIG} `, hmacKey: WH_KEY }), true);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, header: WH_SIG, hmacKey: WH_KEY }), true);
});

test("webhook: body ถูกแก้ 1 ตัว → false · กุญแจผิด → false · ลายเซ็น hex (ไม่ใช่ base64) → false", () => {
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY.replace("bi_1", "bi_2"), signatureHeader: WH_SIG, hmacKey: WH_KEY }), false);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY + " ", signatureHeader: WH_SIG, hmacKey: WH_KEY }), false);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: WH_SIG, hmacKey: Buffer.from("secret-key-124").toString("base64") }), false);
  // กุญแจดิบ (ไม่ถอด base64) ต้องไม่ผ่าน = พิสูจน์ว่าถอด base64 ก่อนใช้จริง
  const rawKeySig = crypto.createHmac("sha256", WH_KEY).update(WH_BODY).digest("base64");
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: rawKeySig, hmacKey: WH_KEY }), false);
  const hex = crypto.createHmac("sha256", Buffer.from(WH_KEY, "base64")).update(WH_BODY).digest("hex");
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: hex, hmacKey: WH_KEY }), false);
});

test("webhook: ลายเซ็นความยาวผิด → false (ไม่ throw จาก timingSafeEqual)", () => {
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: WH_SIG.slice(0, -2), hmacKey: WH_KEY }), false);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: WH_SIG + "AA", hmacKey: WH_KEY }), false);
  assert.equal(BEAM.verifyBeamSignature({ rawBody: WH_BODY, signatureHeader: "x", hmacKey: WH_KEY }), false);
});

test("webhook: ขาด/ผิดรูปทุกช่อง → false ไม่ throw", () => {
  const cases = [
    undefined,
    null,
    {},
    { rawBody: "", signatureHeader: WH_SIG, hmacKey: WH_KEY },
    { rawBody: Buffer.alloc(0), signatureHeader: WH_SIG, hmacKey: WH_KEY },
    { rawBody: { id: "bi_1" }, signatureHeader: WH_SIG, hmacKey: WH_KEY }, // body ที่ parse แล้ว ≠ raw
    { rawBody: WH_BODY, signatureHeader: "", hmacKey: WH_KEY },
    { rawBody: WH_BODY, signatureHeader: ["a"], hmacKey: WH_KEY },
    { rawBody: WH_BODY, signatureHeader: WH_SIG, hmacKey: "" },
    { rawBody: WH_BODY, signatureHeader: WH_SIG, hmacKey: null },
    { rawBody: WH_BODY, signatureHeader: WH_SIG, hmacKey: "!!!!" }, // ถอด base64 ได้ 0 ไบต์
  ];
  for (const c of cases) assert.equal(BEAM.verifyBeamSignature(c), false, JSON.stringify(c));
});

// ══ webhook: parseBeamEvent ══
test("parseBeamEvent: bolt_intent.paid → providerRef = id · merchantId ซ้อนก่อน · paid:true · raw", () => {
  const body = { id: "bi_1", merchant: { merchantId: "m_1" }, merchantId: "m_top", status: "PAID" };
  const r = BEAM.parseBeamEvent(body, "Bolt_Intent.Paid ");
  assert.deepEqual(r, { ok: true, providerRef: "bi_1", merchantId: "m_1", eventType: "bolt_intent.paid", paid: true, raw: body });
});

test("parseBeamEvent: charge.failed → providerRef = sourceId · merchantId ชั้นบน · paid:false", () => {
  const r = BEAM.parseBeamEvent({ id: "ch_1", sourceId: "bi_7", merchantId: "m_2" }, "charge.failed");
  assert.equal(r.ok, true);
  assert.equal(r.providerRef, "bi_7", "charge.failed ต้องชี้ intent ด้วย sourceId ไม่ใช่ id ของ charge");
  assert.equal(r.merchantId, "m_2");
  assert.equal(r.paid, false);
});

test("parseBeamEvent: canceled/expired รับ · paid:false", () => {
  for (const ev of ["bolt_intent.canceled", "bolt_intent.expired"]) {
    const r = BEAM.parseBeamEvent({ id: "bi_1", merchant: { merchantId: "m_1" } }, ev);
    assert.equal(r.ok, true, ev);
    assert.equal(r.paid, false);
  }
});

test("parseBeamEvent: ผิดรูป → ok:false พร้อมรหัส (ไม่ throw)", () => {
  assert.deepEqual(BEAM.parseBeamEvent(null, "bolt_intent.paid"), { ok: false, error: "bad_body" });
  assert.deepEqual(BEAM.parseBeamEvent([], "bolt_intent.paid"), { ok: false, error: "bad_body" });
  assert.equal(BEAM.parseBeamEvent({ id: "bi_1" }, "bolt_intent.paid").error, "no_merchant_id");
  assert.equal(BEAM.parseBeamEvent({ id: "bi_1", merchant: { merchantId: "m_1" } }, "").error, "no_event_type");
  assert.equal(BEAM.parseBeamEvent({ id: "bi_1", merchant: { merchantId: "m_1" } }, undefined).error, "no_event_type");
  const unk = BEAM.parseBeamEvent({ id: "bi_1", merchant: { merchantId: "m_1" } }, "bolt_intent.created");
  assert.equal(unk.error, "unknown_event");
  assert.equal(unk.eventType, "bolt_intent.created");
  assert.equal(BEAM.parseBeamEvent({ merchant: { merchantId: "m_1" } }, "bolt_intent.paid").error, "no_intent_id");
  assert.equal(BEAM.parseBeamEvent({ id: "bi_1", merchantId: "m_1" }, "charge.failed").error, "no_intent_id", "charge.failed ไม่มี sourceId");
});

// ══ ทะเบียนตัวจริง ══
test("ทะเบียนตัวจริงมี ./beam-bolt ใน MODULES และเห็นเจ้านี้", { skip: needIndex }, () => {
  assert.ok(INDEX.MODULES.includes("./beam-bolt"));
  assert.ok(INDEX.listProviders().some((s) => s.id === "beam-bolt"));
  assert.ok(INDEX.getChannel("beamBoltPromptPay"));
});

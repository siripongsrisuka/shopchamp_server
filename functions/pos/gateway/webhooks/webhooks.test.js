// เทส webhooks/ntt.js · kbank.js · beam.js · core.js · รัน: node --test functions/pos/gateway/webhooks/webhooks.test.js
//   ยกเรื่องที่พิสูจน์จากเทสของพี่น้อง (webhook.test.js · webhook-kbank.test.js · webhook-beam.test.js):
//   ถามผู้ให้บริการซ้ำทุกครั้ง · ยอดตรงถึงสตางค์เท่านั้นถึง mark · ยิงซ้ำไม่เขียนซ้ำ · ไม่ใช่ของเรา = 200 ไม่เขียน ·
//   Beam: ลายเซ็นก่อนอย่างอื่น (ผิด/ไม่มี = 401 · ไม่แตะ pgWebhook) · ใบร้านอื่น = ไม่แตะ · ถามเจ้าไม่ได้ = 5xx
//   🔬 กลายพันธุ์ระดับ source: ถอดการถามซ้ำ / ถอดลายเซ็น ต้องทำให้เทสแดง (คู่เทียบ 2 ทิศ)
//   ทะเบียนปลอม (connectionsTestKit) · กุญแจ Beam ผ่าน beam/beamMerchantCreds.js ตัวจริงกับฐานปลอม
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const K = require("../connectionsTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { webhookNtt } = require("./ntt");
const { webhookKbank } = require("./kbank");
const { webhookBeam } = require("./beam");

const PW_BOX = K.sealTest("pw-secret-9999", { providerId: "ntt-h2h", field: "password", shopId: "shopA" });
const HMAC = Buffer.from("beam-webhook-hmac-key-0123456789").toString("base64");
const HMAC_OTHER = Buffer.from("someone-else-key-000000000000000").toString("base64");
const doc = (x) => ({ shopId: "shopA", channelId: "nttThaiQr", providerId: "ntt-h2h", amount: 120.5, process: "request", providerRef: "OTN-1", timestamp: K.NOW, ...(x || {}) });
const seed = (x) => ({
  "gatewayCreds/shopA": { "ntt-h2h": { terminalId: "TID-1", password: PW_BOX }, "kbank-qr": { merchantId: "KB-1" }, "beam-bolt": { boltConnectionId: "BC-1" } },
  "pgWebhook/pgaaa": doc(),
  "pgWebhook/pgkbk": doc({ channelId: "kbankThaiQr", providerId: "kbank-qr", providerRef: "PTU-9" }),
  "pgWebhook/pgbm1": doc({ channelId: "beamBoltPromptPay", providerId: "beam-bolt", providerRef: "intent-1" }),
  "pgWebhook/pgbmB": doc({ shopId: "shopB", channelId: "beamBoltPromptPay", providerId: "beam-bolt", providerRef: "intent-B" }),
  "beamMerchantIndex/m-1": { shopId: "shopA", merchantId: "m-1" },
  "beamMerchantCreds/shopA": {
    shopId: "shopA", merchantId: "m-1",
    apiKey: K.sealTest("api-key-1", { providerId: "beam-bolt", field: "apiKey", shopId: "shopA" }),
    webhookHmacKey: K.sealTest(HMAC, { providerId: "beam-bolt", field: "webhookHmacKey", shopId: "shopA" }),
  },
  ...(x || {}),
});

let P;
let REG;
const deps = (x) => ({ now: () => K.NOW, credKey: K.TEST_KEY, registry: REG.registry, ...(x || {}) });
const paid = (amountPaid = 120.5) => ({ ok: true, data: { state: "paid", amountPaid, raw: {} } });
const beamReq = (body, { key = HMAC, event = "bolt_intent.paid", sig } = {}) => {
  const rawBody = JSON.stringify(body);
  return { body, rawBody, headers: { "x-beam-event": event, "x-beam-signature": sig !== undefined ? sig : K.beamSign(rawBody, key) } };
};
const intent = (id = "intent-1") => ({ id, merchant: { merchantId: "m-1" }, status: "PAID", amount: 1 });
const pgWrites = () => S.writesTo("pgWebhook");

beforeEach(() => {
  S.reset(seed());
  P = { inquiry: paid() };
  REG = K.makeRegistry(P);
});

// ── NTT ─────────────────────────────────────────────────────────────────────────
test("NTT: ถาม NTT ซ้ำด้วย providerRef ของใบ + config ถอดแล้ว → ยอดตรง → mark success ผ่าน settle", async () => {
  const r = await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1", tran_amount: "1.00", transaction_status: "SALE" } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, result: "marked", referenceId: "pgaaa" });
  assert.equal(REG.calls.inquiry.length, 1);
  const a = REG.calls.inquiry[0];
  assert.equal(a.providerRef, "OTN-1");
  assert.equal(a.expectedAmount, 120.5);
  assert.deepEqual(a.config, { terminalId: "TID-1", password: "pw-secret-9999" });
  assert.equal(S.DATA["pgWebhook/pgaaa"].process, "success");
  assert.equal(S.DATA["pgWebhook/pgaaa"].verifiedBy, "ALL_ORDERQUERY");
  assert.equal(S.DATA["pgWebhook/pgaaa"].verifiedAmount, 120.5);
});

test("NTT: deps.inquiry แทนตัวของเจ้าได้ (harness)", async () => {
  const seen = [];
  const r = await K.call(webhookNtt(deps({ inquiry: async (x) => { seen.push(x); return paid(); } })), { body: { out_trade_no: "OTN-1" } });
  assert.equal(r.body.result, "marked");
  assert.equal(seen.length, 1);
  assert.equal(REG.calls.inquiry, undefined);
});

test("🔒 NTT: ยอดที่ NTT ตอบต่าง 1 สตางค์ → ไม่ mark · ประทับ verifyMismatch อย่างเดียว · 200", async () => {
  P.inquiry = paid(120.49);
  const r = await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1", tran_amount: "120.50" } });
  assert.equal(r.code, 200);
  assert.equal(r.body.result, "mismatch");
  assert.equal(S.DATA["pgWebhook/pgaaa"].process, "request");
  assert.equal(pgWrites().length, 1);
  assert.deepEqual(Object.keys(pgWrites()[0].v), ["verifyMismatch"]);
});

test("NTT: NTT ตอบยังไม่จ่าย → 200 not_paid ไม่เขียน (payload บอกจ่ายแล้วก็ไม่เชื่อ)", async () => {
  P.inquiry = { ok: true, data: { state: "waiting", amountPaid: null } };
  const r = await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1", transaction_status: "SALE" } });
  assert.equal(r.body.result, "not_paid");
  assert.equal(S.LOG.length, 0);
});

test("NTT: ไม่ใช่ของเรา / ไม่มี out_trade_no / ใบของเจ้าอื่น → 200 ไม่ถาม ไม่เขียน", async () => {
  assert.equal((await K.call(webhookNtt(deps()), { body: { out_trade_no: "NOPE" } })).body.result, "not_ours");
  assert.equal((await K.call(webhookNtt(deps()), { body: {} })).body.result, "no_reference");
  assert.equal((await K.call(webhookNtt(deps()), { body: { out_trade_no: "PTU-9" } })).body.result, "wrong_provider");
  assert.equal(REG.calls.inquiry, undefined);
  assert.equal(S.LOG.length, 0);
});

test("NTT: ยิงซ้ำหลัง success → 200 already ไม่ถาม NTT ไม่เขียนครั้งที่ 2", async () => {
  await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } });
  S.LOG = [];
  const r = await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } });
  assert.equal(r.body.result, "already");
  assert.equal(REG.calls.inquiry.length, 1);
  assert.equal(S.LOG.length, 0);
});

test("NTT: ถาม NTT ไม่สำเร็จ/โยน → 502 verify_failed (ให้ยิงซ้ำ) ไม่เขียน · กุญแจระบบหาย → 503", async () => {
  P.inquiry = { ok: false, error: { code: "ntt_timeout" } };
  assert.equal((await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } })).code, 502);
  P.inquiry = new Error("boom");
  assert.equal((await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } })).code, 502);
  const k = await K.call(webhookNtt(deps({ credKey: undefined, env: {} })), { body: { out_trade_no: "OTN-1" } });
  assert.equal(k.code, 503);
  assert.equal(k.body.error, "gateway_cred_key_missing");
  assert.equal(S.LOG.length, 0);
});

test("NTT: ร้านปิดจอไปแล้วแต่เงินเข้า → mark success + paidAfterCancel (settle ③)", async () => {
  S.DATA["pgWebhook/pgaaa"].process = "cancelled";
  const r = await K.call(webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } });
  assert.equal(r.body.paidAfterCancel, true);
  assert.equal(S.DATA["pgWebhook/pgaaa"].paidAfterCancel, true);
});

// ── KBank ───────────────────────────────────────────────────────────────────────
test("KBank: reference1 = doc id · ถามธนาคารด้วย providerRef จากใบ (ไม่ใช่ partnerTxnUid ของ payload) → mark", async () => {
  P.inquiry = paid(120.5);
  const r = await K.call(webhookKbank(deps()), { body: { reference1: "pgkbk", partnerTxnUid: "ATTACKER-REF", txnAmount: 120.5 } });
  assert.equal(r.body.result, "marked");
  assert.equal(REG.calls.inquiry[0].providerRef, "PTU-9");
  assert.deepEqual(REG.calls.inquiry[0].config, { merchantId: "KB-1" });
  assert.equal(S.DATA["pgWebhook/pgkbk"].verifiedBy, "KBANK_INQUIRY");
});

test("KBank: ใบไม่ใช่ kbank-qr / ไม่มีใบ / reference1 ผิดรูป → 200 ไม่เขียน", async () => {
  assert.equal((await K.call(webhookKbank(deps()), { body: { reference1: "pgaaa" } })).body.result, "not_ours");
  assert.equal((await K.call(webhookKbank(deps()), { body: { reference1: "pgzzz" } })).body.result, "not_ours");
  assert.equal((await K.call(webhookKbank(deps()), { body: { reference1: "a/b" } })).body.result, "no_reference");
  assert.equal(S.LOG.length, 0);
});

// ── Beam ────────────────────────────────────────────────────────────────────────
test("Beam: ลายเซ็นถูก + Beam ยืนยันจ่ายครบ → mark · เจ้าได้ shopId+credKey ไปถอดกุญแจร้าน", async () => {
  const r = await K.call(webhookBeam(deps()), beamReq(intent()));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "marked");
  assert.equal(REG.calls.inquiry[0].shopId, "shopA");
  assert.equal(REG.calls.inquiry[0].credKey, K.TEST_KEY);
  assert.equal(S.DATA["pgWebhook/pgbm1"].verifiedBy, "BEAM_INQUIRY");
});

test("🔒 Beam: ลายเซ็นผิด / ไม่มี / merchant ไม่มีเจ้าของ / ไม่มี merchantId → 401 · ไม่อ่าน pgWebhook · ไม่ถาม · ไม่เขียน", async () => {
  const bad = [
    beamReq(intent(), { key: HMAC_OTHER }),
    beamReq(intent(), { sig: "" }),
    beamReq({ ...intent(), merchant: { merchantId: "m-unknown" } }),
    beamReq({ id: "intent-1" }),
  ];
  for (const rq of bad) {
    S.READS = [];
    const r = await K.call(webhookBeam(deps()), rq);
    assert.equal(r.code, 401);
    assert.equal(r.body.error, "bad_signature");
    assert.ok(!S.READS.some((p) => p.startsWith("pgWebhook")), `อ่าน pgWebhook ก่อนลายเซ็นผ่าน: ${S.READS}`);
  }
  // rawBody ถูกแก้หลังเซ็น = ลายเซ็นไม่ตรง
  const t = beamReq(intent());
  t.rawBody = t.rawBody.replace('"amount":1', '"amount":9');
  assert.equal((await K.call(webhookBeam(deps()), t)).code, 401);
  assert.equal(REG.calls.inquiry, undefined);
  assert.equal(S.LOG.length, 0);
});

test("Beam: Beam ตอบ amount_mismatch → ไม่ mark (verifyMismatch) · ใบร้านอื่น → 200 wrong_shop ไม่แตะ", async () => {
  P.inquiry = { ok: true, data: { state: "amount_mismatch", amountPaid: 100 } };
  const r = await K.call(webhookBeam(deps()), beamReq(intent()));
  assert.equal(r.body.result, "mismatch");
  assert.equal(S.DATA["pgWebhook/pgbm1"].process, "request");
  S.LOG = [];
  P.inquiry = paid();
  const w = await K.call(webhookBeam(deps()), beamReq(intent("intent-B")));
  assert.equal(w.body.result, "wrong_shop");
  assert.equal(S.LOG.length, 0);
});

test("Beam: event ที่ไม่ใช่จ่ายแล้ว (canceled/expired/charge.failed/ไม่รู้จัก) → 200 ไม่เขียน ไม่ถาม", async () => {
  for (const event of ["bolt_intent.canceled", "bolt_intent.expired", "charge.failed", "weird.event"]) {
    const r = await K.call(webhookBeam(deps()), beamReq({ ...intent(), sourceId: "intent-1" }, { event }));
    assert.equal(r.code, 200, event);
    assert.equal(r.body.result, "ignored_event");
  }
  assert.equal(REG.calls.inquiry, undefined);
  assert.equal(S.LOG.length, 0);
});

// ── 🔬 กลายพันธุ์ระดับ source ───────────────────────────────────────────────────
function withMutant(rel, mutate, fn) {
  const file = path.join(__dirname, rel);
  const src = fs.readFileSync(file, "utf8");
  const mutated = mutate(src);
  assert.notEqual(mutated, src, "กลายพันธุ์ไม่ได้แก้อะไร (ข้อความในไฟล์เปลี่ยน?)");
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(mutated, file);
  const saved = require.cache[file];
  const users = ["./ntt", "./kbank", "./beam"].map((x) => require.resolve(x));
  const savedUsers = users.map((u) => require.cache[u]);
  require.cache[file] = m;
  m.loaded = true;
  users.forEach((u) => { if (u !== file) delete require.cache[u]; });
  return Promise.resolve()
    .then(() => fn(m.exports, (x) => require(x)))
    .finally(() => {
      require.cache[file] = saved;
      users.forEach((u, i) => { require.cache[u] = savedUsers[i]; });
    });
}

test("🔬 กลายพันธุ์: ถอดการถามผู้ให้บริการซ้ำ (เชื่อว่าจ่ายครบ) → ใบที่ NTT บอกว่ายังไม่จ่ายกลับถูก mark = เทส not_paid ข้างบนแดง", async () => {
  P.inquiry = { ok: true, data: { state: "waiting", amountPaid: null } };
  await withMutant("core.js",
    (src) => src.replace("verified = await inquiryFn(args);", "verified = { ok: true, data: { state: \"paid\", amountPaid: doc.amount } };"),
    async (_core, req) => {
      const r = await K.call(req("./ntt").webhookNtt(deps()), { body: { out_trade_no: "OTN-1" } });
      assert.equal(r.body.result, "marked", "กลายพันธุ์ต้อง mark — ไม่ mark แปลว่ามีด่านอื่นบัง");
      assert.equal(S.DATA["pgWebhook/pgaaa"].process, "success");
    });
});

test("🔬 กลายพันธุ์: ถอดด่านลายเซ็น Beam → event ที่เซ็นด้วยกุญแจผิดกลับถูก mark", async () => {
  await withMutant("beam.js",
    (src) => src.replace("if (signed !== true) {", "if (false) {"),
    async (mut) => {
      const r = await K.call(mut.webhookBeam(deps()), beamReq(intent(), { key: HMAC_OTHER }));
      assert.equal(r.body.result, "marked", "กลายพันธุ์ต้องผ่าน — ยัง 401 แปลว่ามีด่านอื่นบัง");
    });
});

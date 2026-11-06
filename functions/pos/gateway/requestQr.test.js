// เทส gateway/requestQr.js · รัน: node --test functions/pos/gateway/requestQr.test.js
//   ยกเคสที่ใช้ได้จากพี่น้อง (`acquirer.test.js`: ลำดับเขียนใบก่อนยิง · กันกดซ้ำถามผู้ให้บริการก่อน · ปัดสตางค์ · redact · at-bill)
//   ตัดเคส autoCheckout / receiptData / remotePay / fallback NTT (ไม่ยก) · ทะเบียนเจ้า = ของปลอมใน handlerTestKit (ไม่รอทะเบียนจริง)
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { requestQr } = require("./requestQr");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const P = {};
let R;
let H;
let seq = 0;
const mk = (extra) => requestQr({ now: () => NOW, credKey: K.TEST_KEY, registry: R.registry, newReferenceId: () => `pgtest${++seq}`, ...(extra || {}) });

const PASSWORD = "secret-pass-1234";
const nttCreds = () => ({ "ntt-h2h": { terminalId: "TID001", password: K.sealTest(PASSWORD, { providerId: "ntt-h2h", field: "password", shopId: "shopA" }) } });
const base = () => ({
  "shop/shopA": { shopId: "shopA" },
  "gatewayCreds/shopA": { ...nttCreds(), "kbank-qr": { merchantId: "KB001" }, "beam-bolt": { boltConnectionId: "conn-1" } },
});
const body = (x) => ({ shopId: "shopA", channelId: "nttThaiQr", amount: 120.5, ...x });
const qrOk = { ok: true, data: { providerRef: "prov-1", chargeId: "ch-1", qrPayload: "000201...", qrKind: "text" } };

beforeEach(() => {
  S.reset(base());
  R = K.makeRegistry(P);
  P.createQR = qrOk;
  P.inquiry = { ok: true, data: { state: "waiting" } };
  P.cancelQR = { ok: true };
  seq = 0;
  H = mk();
});

test("ขอ QR ปกติ → 200 · ใบเขียนก่อนยิงผู้ให้บริการ · provider ได้ config ที่ถอดแล้ว · คำตอบไม่มีค่าเชื่อมต่อ", async () => {
  let docAtCall;
  P.createQR = (args) => { docAtCall = S.DATA[`pgWebhook/${args.referenceId}`]; return qrOk; };
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pgtest1", channelId: "nttThaiQr", providerId: "ntt-h2h", qrPayload: "000201...", qrKind: "text", reused: false });
  assert.ok(docAtCall, "ต้องมีใบ pgWebhook ก่อนเรียก createQR");
  assert.equal(docAtCall.process, "request");
  assert.equal(docAtCall.providerRef, null);
  const a = R.calls.createQR[0];
  assert.deepEqual(a.config, { terminalId: "TID001", password: PASSWORD });
  assert.equal(a.amount, 120.5);
  assert.equal(a.shopId, "shopA");
  assert.equal(a.credKey, K.TEST_KEY, "beam-bolt ถอดกุญแจรายร้านด้วย credKey ที่ส่งต่อ");
  assert.equal(JSON.stringify(r.body).includes(PASSWORD), false);
  const doc = S.DATA["pgWebhook/pgtest1"];
  assert.deepEqual(
    { ...doc, timestamp: doc.timestamp.toISOString() },
    {
      referenceId: "pgtest1", shopId: "shopA", channelId: "nttThaiQr", providerId: "ntt-h2h", amount: 120.5, timestamp: NOW.toISOString(),
      process: "request", clientRequestId: null, createdBy: "u-owner", providerRef: "prov-1", chargeId: "ch-1", qrPayload: "000201...", qrKind: "text",
    },
  );
});

test("referenceId ตั้งต้น = pg + 24 hex", async () => {
  H = requestQr({ now: () => NOW, credKey: K.TEST_KEY, registry: R.registry });
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 200);
  assert.match(r.body.referenceId, /^pg[0-9a-f]{24}$/);
});

test("createQR โยน → 502 provider_error · ใบยังอยู่แบบ request ไม่มี providerRef (เหมือนพี่น้อง)", async () => {
  P.createQR = new Error(`boom ${PASSWORD}`);
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 502);
  assert.equal(r.body.error, "provider_error");
  assert.equal(JSON.stringify(r.body).includes(PASSWORD), false);
  assert.equal(S.DATA["pgWebhook/pgtest1"].process, "request");
  assert.equal(S.DATA["pgWebhook/pgtest1"].providerRef, null);
});

test("ผู้ให้บริการตอบ error ที่มีรหัสผ่านในข้อความ → 502 ข้อความถูกปกปิด · มี code", async () => {
  P.createQR = { ok: false, error: { code: "ntt_rejected", message: `bad password ${PASSWORD} for TID001` } };
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 502);
  assert.equal(r.body.code, "ntt_rejected");
  assert.equal(r.body.message.includes(PASSWORD), false);
  assert.equal(r.body.message.includes("TID001"), false);
  assert.ok(r.body.message.includes("«ปกปิด»"));
});

test("ไม่รู้จักช่องทาง → 400 unknown_channel · ไม่แตะฐาน", async () => {
  const r = await K.callHandler(H, body({ channelId: "nope" }), K.OWNER);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "unknown_channel");
  assert.equal(S.LOG.length, 0);
  assert.equal(S.QUERIES, 0);
});

test("ช่องทางของเครื่อง EDC → 400 channel_not_server_runtime", async () => {
  const r = await K.callHandler(H, body({ channelId: "nttEdcCard" }), K.OWNER);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "channel_not_server_runtime");
  assert.equal(S.LOG.length, 0);
});

test("ทะเบียนบอกปิด (nttBblQr) · ร้านไม่เคยตรวจ → 400 · ร้านตรวจแล้ว open:true → 200 (ผลของร้านชนะ)", async () => {
  let r = await K.callHandler(H, body({ channelId: "nttBblQr" }), K.OWNER);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "unknown_channel");
  S.DATA["shop/shopA/meta/paymentGateway"] = { "ntt-h2h": { _status: { channels: { nttBblQr: { open: true } } } } };
  r = await K.callHandler(H, body({ channelId: "nttBblQr" }), K.OWNER);
  assert.equal(r.code, 200);
});

test("ทะเบียนบอกเปิด แต่ร้านตรวจแล้ว open:false → 400 unknown_channel ไม่เขียน", async () => {
  S.DATA["shop/shopA/meta/paymentGateway"] = { "ntt-h2h": { _status: { channels: { nttThaiQr: { open: false } } } } };
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 400);
  assert.equal(S.LOG.length, 0);
});

test("ยังไม่ตั้งค่า → 409 gateway_not_configured · บอกชื่อช่องเท่านั้น", async () => {
  delete S.DATA["gatewayCreds/shopA"];
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "gateway_not_configured");
  assert.deepEqual(r.body.missing, ["terminalId", "password"]);
  assert.equal(S.LOG.length, 0);
});

test("กล่องรหัสผ่านถูกย้ายมาจากร้านอื่น → 409 gateway_cred_unreadable ไม่ยิง", async () => {
  S.DATA["gatewayCreds/shopA"] = { "ntt-h2h": { terminalId: "T", password: K.sealTest(PASSWORD, { providerId: "ntt-h2h", field: "password", shopId: "shopB" }) } };
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "gateway_cred_unreadable");
  assert.equal(R.calls.createQR.length, 0);
});

test("ไม่มีกุญแจระบบ แต่ช่องลับมีค่า → 500 gateway_cred_key_missing ไม่ยิง", async () => {
  H = requestQr({ now: () => NOW, env: {}, registry: R.registry });
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "gateway_cred_key_missing");
  assert.equal(R.calls.createQR.length, 0);
});

test("ค่าลับที่เป็นข้อความดิบ (ไม่ใช่กล่อง) → ไม่ใช้ค่าดิบ · 409 gateway_cred_unreadable", async () => {
  S.DATA["gatewayCreds/shopA"] = { "ntt-h2h": { terminalId: "T", password: "plain-text" } };
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(R.calls.createQR.length, 0);
});

test("at-bill (beam) ร้านยังไม่เปิดสวิตช์ → 409 channel_not_enabled_for_shop · เปิดแล้ว → 200", async () => {
  let r = await K.callHandler(H, body({ channelId: "beamBoltPromptPay" }), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "channel_not_enabled_for_shop");
  S.DATA["shop/shopA/meta/paymentGateway"] = { "beam-bolt": { _status: { channels: { beamBoltPromptPay: { enabled: true } } } } };
  r = await K.callHandler(H, body({ channelId: "beamBoltPromptPay" }), K.OWNER);
  assert.equal(r.code, 200);
});

test("💰 ยอดเก็บเป็นสตางค์ปัดครั้งเดียว (0.29 ไม่กลายเป็น 0.28999)", async () => {
  const r = await K.callHandler(H, body({ amount: 0.29 }), K.OWNER);
  assert.equal(r.code, 200);
  assert.equal(S.DATA["pgWebhook/pgtest1"].amount, 0.29);
  assert.equal(R.calls.createQR[0].amount, 0.29);
});

test("ยอดทศนิยม 3 ตำแหน่ง → 400 invalid_request ไม่แตะฐาน", async () => {
  const r = await K.callHandler(H, body({ amount: 1.005 }), K.OWNER);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "invalid_request");
  assert.equal(S.LOG.length, 0);
});

test("ด่านร้าน: ไม่มี shopAccess 401 · body.shopId ร้านอื่น 403 · พนักงานขอได้ 200", async () => {
  assert.equal((await K.callHandler(H, body(), undefined)).code, 401);
  assert.equal((await K.callHandler(H, body({ shopId: "shopB" }), K.OWNER)).body.error, "wrong_shop");
  assert.equal((await K.callHandler(H, body(), K.STAFF)).code, 200);
});

test("ทีมงาน → ใบมี byAdmin adminUid · คำตอบมี byAdmin", async () => {
  const r = await K.callHandler(H, body(), K.ADMIN);
  assert.equal(r.body.byAdmin, true);
  assert.equal(S.DATA["pgWebhook/pgtest1"].adminUid, "u-company");
});

// ── กันกดซ้ำ ──
const prior = (x) => ({
  referenceId: "pgold", shopId: "shopA", channelId: "nttThaiQr", providerId: "ntt-h2h", amount: 120.5,
  timestamp: new Date(NOW.getTime() - 5 * 60 * 1000), process: "request", clientRequestId: "rnd1:nttThaiQr:120.5",
  providerRef: "prov-old", chargeId: "ch-old", qrPayload: "OLDQR", qrKind: "text", ...x,
});

test("กดซ้ำ ใบเดิมยังรอจ่าย → ถามผู้ให้บริการ 1 ครั้ง แล้วคืนใบเดิม reused:true ไม่ออกใหม่", async () => {
  S.DATA["pgWebhook/pgold"] = prior();
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.reused, true);
  assert.equal(r.body.referenceId, "pgold");
  assert.equal(r.body.qrPayload, "OLDQR");
  assert.equal(R.calls.inquiry.length, 1);
  assert.equal(R.calls.inquiry[0].providerRef, "prov-old");
  assert.equal(R.calls.inquiry[0].expectedAmount, 120.5);
  assert.equal(R.calls.createQR.length, 0);
  assert.equal(S.LOG.length, 0);
});

test("🔴 กดซ้ำ ผู้ให้บริการบอก QR เดิมหมดอายุ → ออกใบใหม่ (พิสูจน์ว่าถามจริง ไม่คืนตามเวลา)", async () => {
  S.DATA["pgWebhook/pgold"] = prior();
  P.inquiry = { ok: true, data: { state: "closed" } };
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.reused, false);
  assert.equal(r.body.referenceId, "pgtest1");
  assert.equal(R.calls.createQR.length, 1);
});

test("🔴 กดซ้ำ ผู้ให้บริการบอกจ่ายแล้ว → 409 already_paid ไม่คืน QR ใด ๆ ไม่ออกใหม่", async () => {
  S.DATA["pgWebhook/pgold"] = prior();
  P.inquiry = { ok: true, data: { state: "paid", amountPaid: 120.5 } };
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_paid");
  assert.equal(r.body.referenceId, "pgold");
  assert.equal(r.body.qrPayload, undefined);
  assert.equal(R.calls.createQR.length, 0);
  assert.equal(S.LOG.length, 0);
});

test("กดซ้ำ ใบเดิม success แล้ว (webhook mark) → 409 already_paid โดยไม่ต้องถาม (พี่น้องออกใบใหม่ให้จ่ายซ้ำ)", async () => {
  S.DATA["pgWebhook/pgold"] = prior({ process: "success" });
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_paid");
  assert.equal(R.calls.inquiry.length, 0);
  assert.equal(R.calls.createQR.length, 0);
});

test("กดซ้ำ ถามผู้ให้บริการไม่ได้ (โยน) → ออกใบใหม่", async () => {
  S.DATA["pgWebhook/pgold"] = prior();
  P.inquiry = new Error("net down");
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.reused, false);
});

test("ใบเดิมเกิน 15 นาที / ยอดต่าง / ช่องทางต่าง / ไม่ส่ง clientRequestId → ไม่หยิบ ไม่ถาม", async () => {
  S.DATA["pgWebhook/pgold"] = prior({ timestamp: new Date(NOW.getTime() - 16 * 60 * 1000) });
  let r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.body.reused, false);
  S.DATA["pgWebhook/pgold"] = prior();
  r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5", amount: 121 }), K.OWNER);
  assert.equal(r.body.reused, false);
  r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.body.reused, false);
  assert.equal(R.calls.inquiry.length, 0);
});

test("ใบเดิมร้านอื่นที่ clientRequestId ชนกัน → ไม่หยิบ", async () => {
  S.DATA["pgWebhook/pgold"] = prior({ shopId: "shopB" });
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.body.reused, false);
  assert.equal(R.calls.inquiry.length, 0);
});

test("ใบเดิมที่ร้านเคยปิดจอ (cancelRequestedAt) แล้วเปิดคำขอเดิม → คืนใบเดิม + ล้างป้ายปิดจอ", async () => {
  S.DATA["pgWebhook/pgold"] = prior({ cancelRequestedAt: new Date(NOW.getTime() - 60000) });
  const r = await K.callHandler(H, body({ clientRequestId: "rnd1:nttThaiQr:120.5" }), K.OWNER);
  assert.equal(r.body.reused, true);
  assert.equal(S.DATA["pgWebhook/pgold"].cancelRequestedAt, null);
  assert.deepEqual(S.DATA["pgWebhook/pgold"].reopenedAt, NOW);
});

test("สวิตช์ at-bill ปิด → ไม่คืนแม้ใบเดิม", async () => {
  S.DATA["pgWebhook/pgold"] = prior({ channelId: "beamBoltPromptPay", providerId: "beam-bolt", clientRequestId: "x" });
  const r = await K.callHandler(H, body({ channelId: "beamBoltPromptPay", clientRequestId: "x" }), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(R.calls.inquiry.length, 0);
});

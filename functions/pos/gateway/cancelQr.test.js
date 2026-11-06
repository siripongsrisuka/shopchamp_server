// เทส gateway/cancelQr.js · รัน: node --test functions/pos/gateway/cancelQr.test.js
//   ยกจากพี่น้อง (`cancel-qr.test.js`: เจ้าที่ยกเลิกได้ mark หลังสำเร็จเท่านั้น · เจ้าที่ยกเลิกไม่ได้ประทับ cancelRequestedAt คง request ·
//   ใบไม่มี channelId ยกเลิกฝั่งเรา · ใบร้านอื่น) + ของบ้านนี้: success = 409 already_paid · webhook mark ระหว่างทางไม่ถูกทับ
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { cancelQr } = require("./cancelQr");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const P = {};
let R;
let H;
const kb = (x) => ({ referenceId: "pg1", shopId: "shopA", channelId: "kbankThaiQr", providerId: "kbank-qr", amount: 50, process: "request", providerRef: "kb-ref", ...x });
const body = (x) => ({ shopId: "shopA", referenceId: "pg1", ...x });

beforeEach(() => {
  S.reset({ "pgWebhook/pg1": kb(), "gatewayCreds/shopA": { "kbank-qr": { merchantId: "KB001" } } });
  R = K.makeRegistry(P);
  P.cancelQR = { ok: true };
  H = cancelQr({ now: () => NOW, credKey: K.TEST_KEY, registry: R.registry });
});

test("เจ้าที่ยกเลิกได้ (kbank-qr) → ยิง cancelQR ด้วย providerRef + config · สำเร็จแล้ว process cancelled", async () => {
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", cancelled: true });
  assert.equal(R.calls.cancelQR[0].providerRef, "kb-ref");
  assert.deepEqual(R.calls.cancelQR[0].config, { merchantId: "KB001" });
  assert.equal(S.DATA["pgWebhook/pg1"].process, "cancelled");
  assert.deepEqual(S.DATA["pgWebhook/pg1"].cancelledAt, NOW);
});

test("🔴 ยิงยกเลิกไม่สำเร็จ → 502 · ไม่แตะใบ (QR อาจยังจ่ายได้)", async () => {
  P.cancelQR = { ok: false, error: { code: "kbank_down", message: "down" } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 502);
  assert.equal(r.body.code, "kbank_down");
  assert.equal(S.LOG.length, 0);
  P.cancelQR = new Error("boom");
  assert.equal((await K.callHandler(H, body(), K.STAFF)).code, 502);
  assert.equal(S.LOG.length, 0);
});

test("เจ้าที่ยกเลิกไม่ได้ (ntt-h2h) → ประทับ cancelRequestedAt · คง process request · ไม่ยิงใคร", async () => {
  S.DATA["pgWebhook/pg1"] = kb({ channelId: "nttThaiQr", providerId: "ntt-h2h" });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", cancelled: false, localExpired: true });
  assert.equal(S.DATA["pgWebhook/pg1"].process, "request");
  assert.deepEqual(S.DATA["pgWebhook/pg1"].cancelRequestedAt, NOW);
  assert.equal(R.calls.cancelQR.length, 0);
});

test("ใบไม่มี providerRef → ประทับ cancelRequestedAt ไม่ยิงเจ้า", async () => {
  S.DATA["pgWebhook/pg1"] = kb({ providerRef: null });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.body.localExpired, true);
  assert.equal(R.calls.cancelQR.length, 0);
});

test("ใบรุ่นเก่าไม่มี channelId → cancelled ฝั่งเรา local:true", async () => {
  S.DATA["pgWebhook/pg1"] = kb({ channelId: undefined });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", cancelled: true, local: true });
  assert.equal(S.DATA["pgWebhook/pg1"].process, "cancelled");
});

test("ใบ success → 409 already_paid ไม่เขียน · ใบ cancelled แล้ว → 200 already ไม่เขียน", async () => {
  S.DATA["pgWebhook/pg1"] = kb({ process: "success" });
  let r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_paid");
  S.DATA["pgWebhook/pg1"] = kb({ process: "cancelled" });
  r = await K.callHandler(H, body(), K.STAFF);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", cancelled: true, already: true });
  assert.equal(S.LOG.length, 0);
  assert.equal(R.calls.cancelQR.length, 0);
});

test("🔴 webhook mark success ระหว่างยิงยกเลิก → 409 already_paid · ไม่ทับเป็น cancelled", async () => {
  P.cancelQR = () => { S.DATA["pgWebhook/pg1"] = { ...S.DATA["pgWebhook/pg1"], process: "success" }; return { ok: true }; };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "already_paid");
  assert.equal(S.DATA["pgWebhook/pg1"].process, "success");
});

test("ใบไม่มี → 404 · ใบร้านอื่น → 409 pgwebhook_other_shop ไม่เขียน ไม่ยิง", async () => {
  assert.equal((await K.callHandler(H, body({ referenceId: "x" }), K.STAFF)).code, 404);
  S.DATA["pgWebhook/pg1"] = kb({ shopId: "shopB" });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "pgwebhook_other_shop");
  assert.equal(S.LOG.length, 0);
  assert.equal(R.calls.cancelQR.length, 0);
});

test("ช่องทางไม่อยู่ในทะเบียน → 409 unknown_channel", async () => {
  S.DATA["pgWebhook/pg1"] = kb({ channelId: "gone" });
  assert.equal((await K.callHandler(H, body(), K.STAFF)).body.error, "unknown_channel");
});

test("ทีมงาน → ใบมี byAdmin adminUid", async () => {
  await K.callHandler(H, body(), K.ADMIN);
  assert.equal(S.DATA["pgWebhook/pg1"].adminUid, "u-company");
});

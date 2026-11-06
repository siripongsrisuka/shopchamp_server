// เทส gateway/inquire.js · รัน: node --test functions/pos/gateway/inquire.test.js
//   ยกจากพี่น้อง (`acquirer.test.js` ส่วน inquire: อ่านทุกอย่างจากใบ · ใบร้านอื่น · ไม่มี providerRef = waiting · expectedAmount = ยอดบนใบ)
//   + ของบ้านนี้: ผู้ให้บริการตอบ paid → mark ผ่าน settle (เทียบสตางค์) · ไม่คืน raw
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { inquire } = require("./inquire");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const P = {};
let R;
let H;
const PASSWORD = "secret-pass-1234";
const doc = (x) => ({
  referenceId: "pg1", shopId: "shopA", channelId: "nttThaiQr", providerId: "ntt-h2h", amount: 120.5,
  timestamp: new Date("2026-11-10T02:55:00.000Z"), process: "request", providerRef: "prov-1", ...x,
});
const body = (x) => ({ shopId: "shopA", referenceId: "pg1", ...x });

beforeEach(() => {
  S.reset({
    "pgWebhook/pg1": doc(),
    "gatewayCreds/shopA": { "ntt-h2h": { terminalId: "TID001", password: K.sealTest(PASSWORD, { providerId: "ntt-h2h", field: "password", shopId: "shopA" }) }, "kbank-qr": { merchantId: "KB1" } },
  });
  R = K.makeRegistry(P);
  P.inquiry = { ok: true, data: { state: "waiting", raw: { secret: "x" } } };
  H = inquire({ now: () => NOW, credKey: K.TEST_KEY, registry: R.registry });
});

test("ยังรอจ่าย → 200 state waiting · ถามด้วย providerRef และยอดจากใบ · config ถอดแล้ว · ไม่คืน raw · ไม่เขียน", async () => {
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", state: "waiting", process: "request" });
  const a = R.calls.inquiry[0];
  assert.equal(a.providerRef, "prov-1");
  assert.equal(a.expectedAmount, 120.5);
  assert.equal(a.config.password, PASSWORD);
  assert.equal(S.LOG.length, 0);
});

test("ผู้ให้บริการตอบ paid ยอดตรง → mark success verifiedBy inquire · 200 state paid", async () => {
  P.inquiry = { ok: true, data: { state: "paid", amountPaid: 120.5 } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", state: "paid", process: "success" });
  const d = S.DATA["pgWebhook/pg1"];
  assert.equal(d.process, "success");
  assert.equal(d.verifiedBy, "inquire");
  assert.equal(d.verifiedAmount, 120.5);
  assert.deepEqual(d.paidAt, NOW);
});

test("🔴 paid แต่ยอดขาด 1 สตางค์ → ไม่ mark · state amount_mismatch · ประทับ verifyMismatch", async () => {
  P.inquiry = { ok: true, data: { state: "paid", amountPaid: 120.49 } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 200);
  assert.equal(r.body.state, "amount_mismatch");
  assert.equal(r.body.process, "request");
  assert.equal(S.DATA["pgWebhook/pg1"].process, "request");
  assert.equal(S.DATA["pgWebhook/pg1"].verifyMismatch.paid, 120.49);
});

test("ใบที่ร้านปิดจอแล้ว (cancelRequestedAt) แต่เงินเข้า → success + paidAfterCancel ในคำตอบ", async () => {
  S.DATA["pgWebhook/pg1"] = doc({ cancelRequestedAt: new Date("2026-11-10T02:58:00.000Z") });
  P.inquiry = { ok: true, data: { state: "paid", amountPaid: 120.5 } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.body.state, "paid");
  assert.equal(r.body.paidAfterCancel, true);
  assert.equal(S.DATA["pgWebhook/pg1"].paidAfterCancel, true);
});

test("ใบ cancelled ที่เงินเข้าทีหลัง → ยังถามผู้ให้บริการ · mark success + paidAfterCancel", async () => {
  S.DATA["pgWebhook/pg1"] = doc({ process: "cancelled" });
  P.inquiry = { ok: true, data: { state: "paid", amountPaid: 120.5 } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.body.state, "paid");
  assert.equal(r.body.paidAfterCancel, true);
});

test("ใบ success แล้ว (รวมใบ EDC) → ตอบจากใบ ไม่ถามใคร", async () => {
  S.DATA["pgWebhook/pg1"] = doc({ process: "success", channelId: "nttEdcCard", providerId: "ntt-edc", providerRef: undefined });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", state: "paid", process: "success" });
  assert.equal(R.calls.inquiry.length, 0);
});

test("ใบไม่มี → 404 pgwebhook_not_found · ใบร้านอื่น → 409 pgwebhook_other_shop ไม่คืนเนื้อ ไม่ถาม", async () => {
  let r = await K.callHandler(H, body({ referenceId: "nope" }), K.STAFF);
  assert.equal(r.code, 404);
  assert.equal(r.body.error, "pgwebhook_not_found");
  S.DATA["pgWebhook/pg1"] = doc({ shopId: "shopB" });
  r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "pgwebhook_other_shop");
  assert.equal(r.body.amount, undefined);
  assert.equal(R.calls.inquiry.length, 0);
});

test("ไม่มี providerRef → waiting ไม่ถาม", async () => {
  S.DATA["pgWebhook/pg1"] = doc({ providerRef: null });
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.body.state, "waiting");
  assert.equal(R.calls.inquiry.length, 0);
});

test("ช่องทางไม่อยู่ในทะเบียน → 409 unknown_channel · ช่องทางเครื่อง → 409 channel_not_server_runtime", async () => {
  S.DATA["pgWebhook/pg1"] = doc({ channelId: "gone" });
  assert.equal((await K.callHandler(H, body(), K.STAFF)).body.error, "unknown_channel");
  S.DATA["pgWebhook/pg1"] = doc({ channelId: "nttEdcCard", process: "request" });
  assert.equal((await K.callHandler(H, body(), K.STAFF)).body.error, "channel_not_server_runtime");
});

test("ผู้ให้บริการล้ม → 502 provider_error ข้อความปกปิดรหัสผ่าน · ไม่เขียน", async () => {
  P.inquiry = { ok: false, error: { code: "x_down", message: `fail ${PASSWORD}` } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 502);
  assert.equal(r.body.code, "x_down");
  assert.equal(r.body.message.includes(PASSWORD), false);
  assert.equal(S.LOG.length, 0);
});

test("สถานะที่ไม่รู้จัก → state error ไม่ mark", async () => {
  P.inquiry = { ok: true, data: { state: "weird" } };
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.body.state, "error");
  assert.equal(S.LOG.length, 0);
});

test("config ไม่ครบ → 409 gateway_not_configured", async () => {
  delete S.DATA["gatewayCreds/shopA"];
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 409);
  assert.deepEqual(r.body.missing, ["terminalId", "password"]);
});

test("referenceId มี / → 400 invalid_request", async () => {
  const r = await K.callHandler(H, body({ referenceId: "a/b" }), K.STAFF);
  assert.equal(r.code, 400);
});

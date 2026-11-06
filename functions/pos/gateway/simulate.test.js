// เทส gateway/simulate.js · รัน: node --test functions/pos/gateway/simulate.test.js
//   ยกแนวจากพี่น้อง (`paymentSimulate.test.js`: ยอดอ่านจากใบ · ใบร้านอื่นปัด · ด่านเทียบยอดยังยืนเมื่อยอดผิด)
//   ตัดเคส autoCheckout/ปิดบิล (บ้านนี้แอปสร้างบิลเอง) · เพิ่ม: ร้านทดสอบเท่านั้น · เจ้าของเท่านั้น
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { simulate } = require("./simulate");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const TEST_SHOP = "wJNgra1ik0pzRQFlZNOD";
const OWNER_T = { shopId: TEST_SHOP, uid: "u-owner", role: "owner", rights: [] };
const doc = (x) => ({ referenceId: "pg1", shopId: TEST_SHOP, channelId: "kbankThaiQr", providerId: "kbank-qr", amount: 99.99, process: "request", ...x });
const body = (x) => ({ shopId: TEST_SHOP, referenceId: "pg1", ...x });
let H;

beforeEach(() => {
  S.reset({ "pgWebhook/pg1": doc() });
  H = simulate({ now: () => NOW });
});

test("ร้านทดสอบ จำลองจ่าย → mark success simulated:true verifiedBy simulate ยอดจากใบ", async () => {
  const r = await K.callHandler(H, body(), OWNER_T);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: "pg1", simulated: true, outcome: "paid", state: "paid", process: "success" });
  const d = S.DATA["pgWebhook/pg1"];
  assert.equal(d.process, "success");
  assert.equal(d.simulated, true);
  assert.equal(d.verifiedBy, "simulate");
  assert.equal(d.verifiedAmount, 99.99);
});

test("🔴 outcome amount_mismatch → ยอดขาด 1 สตางค์ · settle ไม่ mark · ประทับ verifyMismatch", async () => {
  const r = await K.callHandler(H, body({ outcome: "amount_mismatch" }), OWNER_T);
  assert.equal(r.code, 200);
  assert.equal(r.body.state, "amount_mismatch");
  assert.equal(S.DATA["pgWebhook/pg1"].process, "request");
  assert.equal(S.DATA["pgWebhook/pg1"].verifyMismatch.paid, 99.98);
});

test("🔒 ร้านที่ไม่อยู่ในรายชื่อ → 403 simulate_not_allowed ไม่อ่านไม่เขียน", async () => {
  const r = await K.callHandler(H, { shopId: "shopA", referenceId: "pg1" }, K.OWNER);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "simulate_not_allowed");
  assert.equal(S.LOG.length, 0);
});

test("🔒 พนักงานร้านทดสอบ → 403 simulate_not_allowed", async () => {
  const r = await K.callHandler(H, body(), { ...OWNER_T, role: "staff", uid: "u-staff" });
  assert.equal(r.code, 403);
});

test("env GATEWAY_SIMULATE_SHOPS ตั้งเอง → ใช้รายชื่อนั้นแทนค่าตั้งต้น", async () => {
  H = simulate({ now: () => NOW, env: { GATEWAY_SIMULATE_SHOPS: " shopA , shopZ" } });
  S.DATA["pgWebhook/pg1"] = doc({ shopId: "shopA" });
  assert.equal((await K.callHandler(H, { shopId: "shopA", referenceId: "pg1" }, K.OWNER)).code, 200);
  assert.equal((await K.callHandler(H, body(), OWNER_T)).code, 403);
});

test("ใบไม่มี 404 · ร้านอื่น 409 · success 409 already_paid · cancelled 409 pgwebhook_not_waiting · ไม่เขียน", async () => {
  assert.equal((await K.callHandler(H, body({ referenceId: "x" }), OWNER_T)).code, 404);
  S.DATA["pgWebhook/pg1"] = doc({ shopId: "shopB" });
  assert.equal((await K.callHandler(H, body(), OWNER_T)).body.error, "pgwebhook_other_shop");
  S.DATA["pgWebhook/pg1"] = doc({ process: "success" });
  assert.equal((await K.callHandler(H, body(), OWNER_T)).body.error, "already_paid");
  S.DATA["pgWebhook/pg1"] = doc({ process: "cancelled" });
  assert.equal((await K.callHandler(H, body(), OWNER_T)).body.error, "pgwebhook_not_waiting");
  assert.equal(S.LOG.length, 0);
});

test("outcome แปลก → 400", async () => {
  assert.equal((await K.callHandler(H, body({ outcome: "free" }), OWNER_T)).code, 400);
});

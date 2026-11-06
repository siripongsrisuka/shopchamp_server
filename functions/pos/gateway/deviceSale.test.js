// เทส gateway/deviceSale.js · รัน: node --test functions/pos/gateway/deviceSale.test.js
//   ยกจากพี่น้อง (`device-sale.test.js`: เลขใบ deterministic · ยิงซ้ำ = ใบเดิม · ยอดต่าง = 409 · ปัดเจ้า server ·
//   shopId จาก shopAccess) + ของบ้านนี้: ntt-edc เท่านั้น · stationId · ยอดเทียบสตางค์
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { deviceSaleRecord, referenceIdOf } = require("./deviceSale");

const NOW = new Date("2026-11-10T03:00:00.000Z");
let R;
let H;
const body = (x) => ({ shopId: "shopA", channelId: "nttEdcCard", amount: 250.75, stationId: "cashier-1", invoiceNo: "000123", posRefNo: "R9", tradeType: "CARD", ...x });

beforeEach(() => {
  S.reset({});
  R = K.makeRegistry({});
  H = deviceSaleRecord({ now: () => NOW, registry: R.registry });
});

test("บันทึกผลเครื่อง → 200 duplicate:false · ใบ success verifiedBy edc-device ครบช่อง", async () => {
  const r = await K.callHandler(H, body({ approvalCode: "A1" }), K.STAFF);
  const id = referenceIdOf({ shopId: "shopA", invoiceNo: "000123", posRefNo: "R9" });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, referenceId: id, duplicate: false });
  assert.match(id, /^edcsale-[0-9a-f]{32}$/);
  const d = S.DATA[`pgWebhook/${id}`];
  assert.deepEqual(d, {
    referenceId: id, shopId: "shopA", channelId: "nttEdcCard", providerId: "ntt-edc", amount: 250.75, timestamp: NOW,
    process: "success", paidAt: NOW, verifiedBy: "edc-device", createdBy: "u-staff", stationId: "cashier-1",
    invoiceNo: "000123", posRefNo: "R9", tradeType: "CARD", approvalCode: "A1",
  });
});

test("ยิงซ้ำยอดเดิม → 200 duplicate:true ไม่เขียนซ้ำ", async () => {
  await K.callHandler(H, body(), K.STAFF);
  S.LOG = [];
  const r = await K.callHandler(H, body({ stationId: "cashier-2" }), K.STAFF);
  assert.equal(r.body.duplicate, true);
  assert.equal(S.LOG.length, 0);
});

test("🔴 กุญแจเดิมยอดต่าง → 409 edc_ref_amount_mismatch ไม่เขียนทับ", async () => {
  await K.callHandler(H, body(), K.STAFF);
  S.LOG = [];
  const r = await K.callHandler(H, body({ amount: 250.76 }), K.STAFF);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "edc_ref_amount_mismatch");
  assert.equal(r.body.existingAmount, 250.75);
  assert.equal(S.LOG.length, 0);
});

test("เลขใบผูกร้าน: ร้านอื่นเลขเครื่องเดียวกัน = คนละใบ", () => {
  assert.notEqual(referenceIdOf({ shopId: "shopA", invoiceNo: "1", posRefNo: "" }), referenceIdOf({ shopId: "shopB", invoiceNo: "1", posRefNo: "" }));
});

test("ช่องทางเจ้า server → 400 channel_not_device_runtime · ไม่รู้จัก → 400 unknown_channel · ไม่เขียน", async () => {
  let r = await K.callHandler(H, body({ channelId: "nttThaiQr" }), K.STAFF);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "channel_not_device_runtime");
  r = await K.callHandler(H, body({ channelId: "nope" }), K.STAFF);
  assert.equal(r.body.error, "unknown_channel");
  assert.equal(S.LOG.length, 0);
});

test("ไม่มีทั้ง invoiceNo และ posRefNo → 400 invalid_request", async () => {
  const r = await K.callHandler(H, body({ invoiceNo: undefined, posRefNo: undefined }), K.STAFF);
  assert.equal(r.code, 400);
  assert.equal(S.LOG.length, 0);
});

test("ไม่ส่ง stationId/tradeType → เก็บ null · ช่องเสริมไม่ส่ง = ไม่มี key", async () => {
  const r = await K.callHandler(H, body({ stationId: undefined, tradeType: undefined }), K.STAFF);
  const d = S.DATA[`pgWebhook/${r.body.referenceId}`];
  assert.equal(d.stationId, null);
  assert.equal(d.tradeType, null);
  assert.equal("approvalCode" in d, false);
});

test("shopId ในใบ = ร้านที่ผ่านด่าน · body ร้านอื่น 403", async () => {
  assert.equal((await K.callHandler(H, body({ shopId: "shopB" }), K.STAFF)).body.error, "wrong_shop");
});

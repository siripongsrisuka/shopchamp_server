// pos/gateway/providers/posxpay.test.js — เทสเจ้า POSxPay (กล่องเสียง · พร้อมเพย์) · ยกจากบ้านพี่น้อง ก้อน 7
// รัน: cd shopchamp_server/functions && node --test pos/gateway/providers/posxpay.test.js
// 🔴 ห้ามออกเน็ต — /requestpay จริง = รายการเงินจริง + QR เด้งขึ้นกล่องเสียงหน้าร้าน ⇒ ฉีด http ปลอมผ่าน _setHttp
//   http ปลอมโยนทันทีถ้าเทสไม่ได้ตั้ง handler ⇒ ทางที่ไม่ควรยิง = พิสูจน์ด้วยจำนวน call = 0
"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const PXP = require("./posxpay");
const client = require("../posxpay/posxpayClient");
const { buildRegistry } = require("./index");

const SERIAL = "WQRN-SERIAL-TEST-0001";
const TOKEN = "TOKEN-SECRET-ห้ามหลุด-42";
const CFG = { serial: SERIAL, token: TOKEN };
const CH = PXP.spec.channels[0];

let CALLS = [];
let HANDLER = null;
function fakeHttp(config) {
  CALLS.push({ method: String(config.method).toUpperCase(), url: config.url, headers: config.headers || {}, data: config.data });
  if (typeof HANDLER !== "function") throw new Error(`เทสไม่ได้ตั้ง HANDLER แต่มีการยิง ${config.method} ${config.url}`);
  const out = HANDLER(config, CALLS.length);
  if (out && out.__throw) throw out.__throw;
  return { status: out.status, data: out.data };
}
const reset = (handler) => {
  CALLS = [];
  HANDLER = handler || null;
  PXP.__resetConnectionTestCache();
};
const leaks = (obj, needle) => JSON.stringify(obj === undefined ? null : obj).includes(needle);
const httpErr = (status, data, msg) => {
  const e = new Error(msg || `Request failed with status code ${status}`);
  e.response = { status, data };
  return e;
};

beforeEach(() => {
  PXP._setHttp(fakeHttp);
  PXP._setEnv({ POSXPAY_TEST_THROTTLE_MS: "0" }); // ปิดการจำผลเป็นค่าตั้งต้น · ไม่อ่าน process.env ของเครื่อง
  reset(null);
});
after(() => {
  PXP._resetHttp();
  PXP._resetEnv();
});

// ── ① ทะเบียน + spec ─────────────────────────────────────────────────────────────
test("ทะเบียนรับ posxpay — getProvider/getChannel/findChannel หาเจอ", () => {
  const reg = buildRegistry([PXP]);
  assert.equal(reg.getProvider("posxpay"), PXP);
  const sale = reg.getChannel("posxpayPromptPay");
  assert.ok(sale, "เส้นขายหา posxpayPromptPay ไม่เจอ");
  assert.equal(sale.channel.sourceType, "promptpay");
  assert.ok(reg.findChannel("posxpayPromptPay"));
  assert.equal(reg.channelChoiceOf(PXP.spec), "at-setup");
  assert.equal(reg.canCheckChannelsOf(PXP), false);
  assert.equal(reg.canCancelOf(PXP), false, "POSxPay ไม่มี API ยกเลิก");
  assert.equal(reg.canPairOf(PXP), false);
});

test("🔐 token = secret:true และไม่มี store (ทั้งช่อง token และทุกช่อง) · serial ไม่ลับ", () => {
  const token = PXP.spec.connection.fields.find((f) => f.key === "token");
  assert.equal(token.secret, true);
  assert.equal(token.required, true);
  for (const f of PXP.spec.connection.fields) {
    assert.equal(Object.prototype.hasOwnProperty.call(f, "store"), false, `ช่อง ${f.key} มี store`);
  }
  const serial = PXP.spec.connection.fields.find((f) => f.key === "serial");
  assert.equal(serial.secret, undefined);
});

test("🔒 คู่เทียบ: ใส่ store กลับเข้าไป (แบบพี่น้อง 'plain') ⇒ ทะเบียนต้องปัด", () => {
  const evil = {
    ...PXP.spec,
    connection: {
      ...PXP.spec.connection,
      fields: PXP.spec.connection.fields.map((f) => (f.key === "token" ? { ...f, store: "plain" } : f)),
    },
  };
  assert.throws(() => buildRegistry([{ ...PXP, spec: evil }]), /store ห้ามประกาศ/);
});

test("ไม่มีของเฉพาะร้านอาหาร (checkoutType/cancelQR/webhook) และไม่ประกาศ canX ในสเปก", () => {
  assert.equal(typeof PXP.cancelQR, "undefined");
  assert.equal(typeof PXP.checkChannels, "undefined");
  for (const k of ["canCancel", "canPair", "canCheckChannels"]) assert.equal(PXP.spec[k], undefined);
});

test("connection.test.note พูดถึงช่องบังคับครบ และบอกตรง ๆ ว่าไม่ครอบ serial", () => {
  const note = PXP.spec.connection.test.note;
  assert.ok(note.includes("serial") && note.includes("token"));
  assert.match(note, /ไม่ครอบ serial/);
});

test("I18N_KEYS derive จาก spec", () => {
  assert.deepEqual(PXP.I18N_KEYS, [
    "screens.paymentGateway.provider.posxpay.name",
    "screens.paymentGateway.field.posxpay.serial",
    "screens.paymentGateway.field.posxpay.token",
    "screens.paymentGateway.channel.posxpayPromptPay",
  ]);
});

// ── ② mapStatus ───────────────────────────────────────────────────────────────────
test("mapStatus: 4 ค่าตามเอกสาร · pending = waiting (ไม่ใช่ error)", () => {
  assert.equal(PXP.mapStatus("success"), "paid");
  assert.equal(PXP.mapStatus("pending"), "waiting");
  assert.equal(PXP.mapStatus("fail"), "closed");
  assert.equal(PXP.mapStatus("cancel"), "closed");
  assert.equal(PXP.mapStatus(" SUCCESS "), "paid");
  assert.equal(PXP.mapStatus("Pending"), "waiting");
});

test("mapStatus: ค่าที่ไม่รู้จักทุกแบบ = error (ห้ามตกเป็น waiting)", () => {
  for (const v of ["", "  ", "paid", "expired", "timeout", null, undefined, 200, {}, []]) {
    assert.equal(PXP.mapStatus(v), "error", JSON.stringify(v));
  }
});

// ── ③ createQR ────────────────────────────────────────────────────────────────────
const OK_REQUEST_BODY = {
  code: 200,
  orderId: 1468843, // ของจริงเป็นตัวเลข
  amount: 1,
  qrPlainText: "00020101021230590016A00000067701011201150135557009425010207146884303051047353037645401158",
};

test("createQR: input ที่ยิงไม่ได้ = ไม่แตะเน็ตเลยสักครั้ง", async () => {
  const bad = [
    { channel: undefined, config: CFG, amount: 10, referenceId: "B1" },
    { channel: { channelId: "kbankThaiQr", qrType: "3" }, config: CFG, amount: 10, referenceId: "B1" },
    { channel: CH, config: { token: TOKEN }, amount: 10, referenceId: "B1" },
    { channel: CH, config: { serial: SERIAL }, amount: 10, referenceId: "B1" },
    { channel: CH, config: CFG, amount: 0, referenceId: "B1" },
    { channel: CH, config: CFG, amount: -5, referenceId: "B1" },
    { channel: CH, config: CFG, amount: "สิบบาท", referenceId: "B1" },
    { channel: CH, config: CFG, amount: PXP.MAX_AMOUNT_BAHT + 1, referenceId: "B1" },
    { channel: CH, config: CFG, amount: 10 },
  ];
  for (const args of bad) {
    reset(null);
    const r = await PXP.createQR(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(CALLS.length, 0);
    assert.ok(!leaks(r, TOKEN));
  }
});

test("createQR: ทางสำเร็จ — POST /requestpay ด้วย Bearer ค่าดิบ · orderId ตัวเลข → สตริง · body ไม่มี ref2", async () => {
  reset(() => ({ status: 200, data: OK_REQUEST_BODY }));
  const r = await PXP.createQR({ channel: CH, config: CFG, amount: 150.5, referenceId: "pg0123", shopId: "SHOP-9" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data, { providerRef: "1468843", chargeId: "1468843", qrPayload: OK_REQUEST_BODY.qrPlainText, qrKind: "text" });

  assert.equal(CALLS.length, 1);
  const call = CALLS[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, client.DEFAULT_BASE_URL + "/api/v1/payment/requestpay");
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  const { referenceId: sentRef, ...rest } = call.data;
  assert.equal(typeof sentRef, "number", "POSxPay รับ referenceId เป็นตัวเลขเท่านั้น");
  assert.ok(Number.isSafeInteger(sentRef) && sentRef > 0);
  assert.deepEqual(rest, { description: "Shopchamp", serial: SERIAL, sourceType: "promptpay", amount: 150.5, ref1: "SHOP-9" });
});

test("createQR: ส่ง checkoutType มาก็ไม่ไปถึง POSxPay (ตัดของร้านอาหารออกแล้ว)", async () => {
  reset(() => ({ status: 200, data: OK_REQUEST_BODY }));
  await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B", checkoutType: "table" });
  assert.equal(Object.prototype.hasOwnProperty.call(CALLS[0].data, "ref2"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(CALLS[0].data, "ref1"), false, "ไม่ส่ง shopId = ไม่ยัด ref1");
});

test("createQR: base URL มาจาก env ที่ฉีด (input.env ชนะ _setEnv)", async () => {
  reset(() => ({ status: 200, data: OK_REQUEST_BODY }));
  PXP._setEnv({ POSXPAY_BASE_URL: "https://set-env.example/" });
  await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
  assert.equal(CALLS[0].url, "https://set-env.example/api/v1/payment/requestpay");
  await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B", env: { POSXPAY_BASE_URL: "https://arg.example" } });
  assert.equal(CALLS[1].url, "https://arg.example/api/v1/payment/requestpay");
});

test("createQR: referenceId ที่ส่ง POSxPay ไม่ซ้ำ 2 คำขอติด", async () => {
  reset(() => ({ status: 200, data: OK_REQUEST_BODY }));
  await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
  await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
  assert.notEqual(CALLS[0].data.referenceId, CALLS[1].data.referenceId);
});

test("createQR: HTTP 400 รูป validator → message บอก path+msg · ไม่เอา value", async () => {
  const err = httpErr(400, { code: 400, errors: [{ type: "field", value: "jPsxeVqwrSz2dzMG1F6D", msg: "Invalid value", path: "referenceId" }] });
  reset(() => ({ __throw: err }));
  const r = await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
  assert.equal(r.error.code, "posxpay_http_400");
  assert.match(r.error.message, /referenceId: Invalid value/);
  assert.ok(!r.error.message.includes("jPsxeVqwrSz2dzMG1F6D"));
});

test("createQR: HTTP 200 แต่ body.code ≠ 200 = posxpay_rejected", async () => {
  for (const body of [{ code: 403, message: "unauthorized" }, { code: 404 }, { code: 500 }, {}]) {
    reset(() => ({ status: 200, data: body }));
    const r = await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "posxpay_rejected");
  }
});

test("createQR: code 200 แต่ของไม่ครบ = bad_response", async () => {
  reset(() => ({ status: 200, data: { code: 200, qrPlainText: "x" } }));
  assert.equal((await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" })).error.code, "bad_response");
  reset(() => ({ status: 200, data: { code: 200, orderId: 55 } }));
  assert.equal((await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" })).error.code, "bad_response");
});

test("createQR: HTTP error ที่แนบ err.config ถือ token ⇒ token ไม่หลุดออกมา", async () => {
  const err = httpErr(500, { message: "upstream down" });
  err.config = { headers: { Authorization: `Bearer ${TOKEN}` } };
  reset(() => ({ __throw: err }));
  const r = await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" });
  assert.equal(r.error.code, "posxpay_http_500");
  assert.ok(!leaks(r, TOKEN));
});

// ── ④ inquiry ─────────────────────────────────────────────────────────────────────
test("inquiry: pending = waiting · amountPaid = null · GET /inquire/<orderId>", async () => {
  reset(() => ({ status: 200, data: { code: 200, orderId: 481659, amount: 1, status: "pending" } }));
  const r = await PXP.inquiry({ channel: CH, config: CFG, providerRef: "481659" });
  assert.equal(r.data.state, "waiting");
  assert.equal(r.data.amountPaid, null);
  assert.equal(r.data.raw.status, "pending");
  assert.equal(CALLS[0].method, "GET");
  assert.ok(CALLS[0].url.endsWith("/api/v1/payment/inquire/481659"));
});

test("inquiry: success = paid + amountPaid", async () => {
  reset(() => ({ status: 200, data: { code: 200, amount: 150.5, status: "success" } }));
  const r = await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1" });
  assert.equal(r.data.state, "paid");
  assert.equal(r.data.amountPaid, 150.5);
});

test("inquiry: expectedAmount ตรงถึงสตางค์ = paid · ต่างแม้ 1 สตางค์ = amount_mismatch", async () => {
  reset(() => ({ status: 200, data: { code: 200, amount: 150.5, status: "success" } }));
  assert.equal((await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1", expectedAmount: 150.5 })).data.state, "paid");
  assert.equal((await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1", expectedAmount: 150.51 })).data.state, "amount_mismatch");
  // จ่ายแล้วแต่ไม่มียอดมาให้เทียบ = เทียบไม่ได้ ⇒ ไม่นับว่าตรง
  reset(() => ({ status: 200, data: { code: 200, status: "success" } }));
  assert.equal((await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1", expectedAmount: 1 })).data.state, "amount_mismatch");
  // ยังไม่จ่าย = ไม่เทียบ
  reset(() => ({ status: 200, data: { code: 200, amount: 9, status: "pending" } }));
  assert.equal((await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1", expectedAmount: 1 })).data.state, "waiting");
});

test("inquiry: fail/cancel = closed · ไม่รู้จัก = error · amountPaid null", async () => {
  for (const [raw, want] of [["fail", "closed"], ["cancel", "closed"], ["expired", "error"], [undefined, "error"]]) {
    reset(() => ({ status: 200, data: { code: 200, amount: 1, status: raw } }));
    const r = await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1" });
    assert.equal(r.data.state, want);
    assert.equal(r.data.amountPaid, null);
  }
});

test("inquiry: body.code ≠ 200 = posxpay_rejected · input ไม่ครบ = ไม่แตะเน็ต", async () => {
  reset(() => ({ status: 200, data: { code: 404, message: "not found" } }));
  assert.equal((await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1" })).error.code, "posxpay_rejected");
  for (const args of [{ channel: CH, config: CFG }, { channel: CH, config: { serial: SERIAL }, providerRef: "1" }, { config: CFG, providerRef: "1" }]) {
    reset(null);
    assert.equal((await PXP.inquiry(args)).ok, false);
    assert.equal(CALLS.length, 0);
  }
});

// ── ⑤ testConnection ──────────────────────────────────────────────────────────────
test("classifyTestResponse: เกณฑ์ทุกทาง + เคสจริงที่พี่น้องยิง production", () => {
  const c = PXP.classifyTestResponse;
  assert.equal(c({ httpStatus: 403, bodyCode: null }), "bad-token");
  assert.equal(c({ httpStatus: 401, bodyCode: null }), "bad-token");
  assert.equal(c({ httpStatus: 200, bodyCode: 403 }), "bad-token");
  assert.equal(c({ httpStatus: 404, bodyCode: null }), "pass");
  assert.equal(c({ httpStatus: 200, bodyCode: 404 }), "pass");
  assert.equal(c({ httpStatus: 200, bodyCode: 200 }), "pass");
  assert.equal(c({ httpStatus: 400, bodyCode: null, bodyMessage: "Order not found" }), "pass");
  assert.equal(c({ httpStatus: 400, bodyCode: null, bodyMessage: "order not found" }), "pass");
  // mutant: ห้ามเผลอเขียว
  assert.equal(c({ httpStatus: 400, bodyCode: null }), "unknown");
  assert.equal(c({ httpStatus: 400, bodyCode: null, bodyMessage: "Invalid request" }), "unknown");
  assert.equal(c({ httpStatus: 200, bodyCode: null, bodyMessage: "Order not found" }), "unknown");
  assert.equal(c({ httpStatus: 403, bodyCode: null, bodyMessage: "Order not found" }), "bad-token");
  for (const v of [{ httpStatus: 500, bodyCode: null }, { httpStatus: null, bodyCode: null }, { httpStatus: 200, bodyCode: 999 }, {}, undefined]) {
    assert.equal(c(v), "unknown", JSON.stringify(v));
  }
});

test("testConnection: ยิงแต่ GET /inquire ด้วยเลขที่ชนของจริงไม่ได้ · ไม่แตะเส้นสร้างเงิน", async () => {
  reset(() => ({ status: 404, data: { code: 404 } }));
  await PXP.testConnection({ config: CFG });
  assert.equal(CALLS.length, 1);
  assert.equal(CALLS[0].method, "GET");
  assert.equal(CALLS.filter((x) => /requestpay|requestqr/.test(x.url)).length, 0);
  const probe = decodeURIComponent(CALLS[0].url.split("/inquire/")[1]);
  assert.match(probe, /^SHOPCHAMP-CONNTEST-[0-9A-F]{24}$/);
});

test("testConnection: ผ่าน ⇒ verifiedFields = ['token'] เท่านั้น (ห้ามมี serial)", async () => {
  reset(() => ({ __throw: httpErr(400, { message: "Order not found" }) }));
  const r = await PXP.testConnection({ config: CFG, shopId: "S" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.verifiedFields, ["token"]);
  assert.equal(r.data.throttled, false);
  assert.ok(!leaks(r, TOKEN));
});

test("testConnection: 403 = posxpay_token_rejected · 400 ข้อความอื่น/500/timeout/เน็ตล่ม = inconclusive", async () => {
  reset(() => ({ __throw: httpErr(403, { message: "unauthorized" }) }));
  assert.equal((await PXP.testConnection({ config: CFG })).error.code, "posxpay_token_rejected");

  const eTimeout = new Error("timeout of 15000ms exceeded");
  eTimeout.code = "ECONNABORTED";
  for (const err of [httpErr(400, { message: "Bad request" }), httpErr(500, { message: "system error" }), eTimeout, new Error("socket hang up")]) {
    reset(() => ({ __throw: err }));
    const r = await PXP.testConnection({ config: CFG });
    assert.equal(r.error.code, "posxpay_test_inconclusive", err.message);
    assert.ok(!/ไม่ถูกต้อง/.test(r.error.message), "ห้ามชี้ว่าค่าที่ร้านกรอกผิดทั้งที่ยังตัดสินไม่ได้");
    assert.ok(!leaks(r, TOKEN));
  }
});

test("testConnection: กรอกไม่ครบ = config_missing ก่อนแตะเน็ต", async () => {
  for (const config of [undefined, {}, { serial: SERIAL }, { token: TOKEN }]) {
    reset(null);
    const r = await PXP.testConnection({ config });
    assert.equal(r.error.code, "config_missing");
    assert.equal(CALLS.length, 0);
  }
});

test("testConnection: เบรกกดรัว (throttle จาก env ที่ฉีด) — กดซ้ำไม่ยิงเพิ่ม · คนละบัญชียิงจริง", async () => {
  PXP._setEnv({ POSXPAY_TEST_THROTTLE_MS: "60000" });
  reset(() => ({ status: 404, data: { code: 404 } }));
  assert.equal((await PXP.testConnection({ config: CFG })).data.throttled, false);
  assert.equal((await PXP.testConnection({ config: CFG })).data.throttled, true);
  assert.equal(CALLS.length, 1);
  await PXP.testConnection({ config: { serial: SERIAL, token: "TOKEN-อีกอัน" } });
  assert.equal(CALLS.length, 2);
});

test("ทุกทางที่ provider คืนออกไป ไม่มี token ปน (ค้นทั้ง JSON)", async () => {
  const outs = [];
  reset(() => ({ status: 200, data: OK_REQUEST_BODY }));
  outs.push(await PXP.createQR({ channel: CH, config: CFG, amount: 1, referenceId: "B" }));
  reset(() => ({ status: 200, data: { code: 200, status: "success", amount: 1 } }));
  outs.push(await PXP.inquiry({ channel: CH, config: CFG, providerRef: "1" }));
  reset(() => ({ status: 404, data: { code: 404 } }));
  outs.push(await PXP.testConnection({ config: CFG }));
  for (const o of outs) assert.ok(!leaks(o, TOKEN));
});

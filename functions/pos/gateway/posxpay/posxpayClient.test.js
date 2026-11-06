// pos/gateway/posxpay/posxpayClient.test.js — ตัวยิง HTTP ของ POSxPay (ก้อน 7)
// รัน: cd shopchamp_server/functions && node --test pos/gateway/posxpay/posxpayClient.test.js
// ไม่ออกเน็ต: ฉีด http ปลอมด้วย _setHttp · env ด้วย _setEnv
"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const client = require("./posxpayClient");

const TOKEN = "TOKEN-SECRET-ห้ามหลุด-42";
let CALLS = [];
let HANDLER = null;

beforeEach(() => {
  CALLS = [];
  HANDLER = null;
  client._setEnv({});
  client._setHttp(async (config) => {
    CALLS.push(config);
    if (!HANDLER) throw new Error("ห้ามยิงในเคสนี้");
    return HANDLER(config);
  });
});
after(() => {
  client._resetHttp();
  client._resetEnv();
});

test("token ว่าง/ไม่ใช่ string = config_missing โดยไม่แตะเน็ต", async () => {
  for (const token of ["", "   ", undefined, null, 123]) {
    const r = await client.request({ method: "GET", path: "/x", token });
    assert.equal(r.error.code, "config_missing");
  }
  assert.equal(CALLS.length, 0);
});

test("base URL: ค่าตั้งต้น production · env ที่ฉีดชนะ · ตัด / ท้าย · env arg ชนะ _setEnv", () => {
  assert.equal(client.getBaseUrl(), client.DEFAULT_BASE_URL);
  client._setEnv({ POSXPAY_BASE_URL: " https://a.example/ " });
  assert.equal(client.getBaseUrl(), "https://a.example");
  assert.equal(client.getBaseUrl({ POSXPAY_BASE_URL: "https://b.example" }), "https://b.example");
});

test("สำเร็จ: ส่ง Bearer + JSON body · คืน {ok,status,data}", async () => {
  HANDLER = () => ({ status: 200, data: { code: 200 } });
  const r = await client.request({ method: "POST", path: "/p", token: TOKEN, body: { a: 1 } });
  assert.deepEqual(r, { ok: true, status: 200, data: { code: 200 } });
  assert.equal(CALLS[0].headers.Authorization, "Bearer " + TOKEN);
  assert.deepEqual(CALLS[0].data, { a: 1 });
  assert.equal(CALLS[0].url, client.DEFAULT_BASE_URL + "/p");
});

test("error ทุกรูปไม่มี token และไม่มี err.config", async () => {
  const e = new Error("x");
  e.response = { status: 502, data: {} };
  e.config = { headers: { Authorization: "Bearer " + TOKEN } };
  const eTimeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  const cases = [
    [e, "posxpay_http_502"],
    [eTimeout, "posxpay_timeout"],
    [new Error("ENOTFOUND"), "posxpay_network_error"],
  ];
  for (const [err, code] of cases) {
    HANDLER = () => {
      throw err;
    };
    const r = await client.request({ method: "GET", path: "/x", token: TOKEN });
    assert.equal(r.error.code, code);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.equal(r.error.config, undefined);
  }
});

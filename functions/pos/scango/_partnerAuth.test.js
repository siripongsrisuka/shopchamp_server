// เทส pos/scango/_partnerAuth.js — ยามกุญแจ ScanGo (env ไม่ตั้ง = 503 · ไม่มี/ผิด = 401 no_auth · ถูก = ผ่าน)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./_partnerAuth");

const KEY = "k".repeat(40);
const env = { [A.ENV_KEY]: KEY };
const reqOf = (h) => ({ headers: h || {} });
const resOf = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test("env ไม่ตั้ง/ว่าง = 503 partner_not_configured แม้ส่งกุญแจมา", () => {
  for (const e of [{}, { [A.ENV_KEY]: "" }]) {
    const r = A.checkPartnerKey(reqOf({ [A.HEADER]: KEY }), e);
    assert.deepEqual([r.status, r.error], [503, "partner_not_configured"]);
  }
});

test("ไม่มี header / ผิด / ยาวไม่เท่า / ไม่ใช่ข้อความ = 401 no_auth", () => {
  for (const h of [{}, { [A.HEADER]: "x".repeat(40) }, { [A.HEADER]: KEY + "x" }, { [A.HEADER]: "" }, { [A.HEADER]: ["a"] }]) {
    const r = A.checkPartnerKey(reqOf(h), env);
    assert.deepEqual([r.status, r.error], [401, "no_auth"], JSON.stringify(h));
  }
});

test("กุญแจถูก = ผ่าน · อ่านจาก req.header() ของ express ได้ · ไม่อ่านจาก body", () => {
  assert.equal(A.checkPartnerKey(reqOf({ [A.HEADER]: KEY }), env), null);
  assert.equal(A.checkPartnerKey({ header: (n) => (n === A.HEADER ? KEY : undefined) }, env), null);
  assert.equal(A.checkPartnerKey({ headers: {}, body: { [A.HEADER]: KEY } }, env).status, 401);
});

test("middleware: ผ่าน = next · ไม่ผ่าน = ซอง {ok:false} ไม่เรียก next", () => {
  const mw = A.requirePartnerKey(env);
  let called = 0;
  const res = resOf();
  mw(reqOf({ [A.HEADER]: KEY }), res, () => { called++; });
  assert.equal(called, 1);
  const bad = resOf();
  mw(reqOf({ [A.HEADER]: "nope" }), bad, () => { called++; });
  assert.equal(called, 1);
  assert.deepEqual([bad.code, bad.body.ok, bad.body.error], [401, false, "no_auth"]);
  const off = resOf();
  A.requirePartnerKey({})(reqOf({ [A.HEADER]: KEY }), off, () => { called++; });
  assert.deepEqual([off.code, off.body.error, called], [503, "partner_not_configured", 1]);
});

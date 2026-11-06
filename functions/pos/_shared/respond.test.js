// เทส respond.js · รัน: node --test functions/pos/_shared/
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("./respond");

function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test("ok: 200 ตั้งต้น · ok:true ทับค่าที่ส่งมาไม่ได้ · ไม่มีช่อง error", () => {
  const r = R.ok(res(), { ok: false, error: "x", billId: "b1" });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, billId: "b1" });
  assert.equal(R.ok(res(), undefined, 201).code, 201);
});

test("ok: status ไม่ใช่ 2xx = throw (ไม่ส่งซองผิดรูป)", () => {
  assert.throws(() => R.ok(res(), {}, 409));
  assert.throws(() => R.ok(res(), {}, 302));
});

test("fail: ซอง {ok:false, error, message} · extra ทับ ok/error/message ไม่ได้", () => {
  const r = R.fail(res(), 409, "bill_other_shop", undefined, { ok: true, error: "x", message: "y", lock: "member" });
  assert.equal(r.code, 409);
  assert.deepEqual(r.body, { ok: false, error: "bill_other_shop", message: "เอกสารนี้เป็นของร้านอื่น", lock: "member" });
  assert.equal(R.fail(res(), 403, "wrong_shop").body.message, R.MESSAGES.wrong_shop);
  assert.equal(R.fail(res(), 404, "member_not_found").body.message, "ไม่พบข้อมูล");
  assert.equal(R.fail(res(), 409, "summary_changed", "ยอดเปลี่ยน").body.message, "ยอดเปลี่ยน");
});

test("fail: status 2xx หรือรหัสผิดรูป → 500 internal_error แทน (ทิศที่ต้องปัด)", () => {
  for (const [s, e] of [[200, "x"], [409, "Bad-Code"], [409, ""], [700, "x"], [undefined, "x"], [409, undefined]]) {
    const r = R.fail(res(), s, e);
    assert.equal(r.code, 500, `${s} ${e}`);
    assert.equal(r.body.error, "internal_error");
    assert.equal(r.body.ok, false);
  }
});

test("deny + sendDeny ส่งตรงตามที่ตัวตรวจคืน", () => {
  const d = R.deny(403, "right_required", undefined, { need: "116" });
  assert.deepEqual(d, { ok: false, status: 403, error: "right_required", extra: { need: "116" } });
  const r = R.sendDeny(res(), d);
  assert.equal(r.code, 403);
  assert.equal(r.body.need, "116");
  assert.equal(R.sendDeny(res(), null).code, 500);
});

test("invalidRequest/parseOr400: issues {path, message} · ไม่คืน input ดิบ", () => {
  const fakeSchema = {
    safeParse: (b) => (b && b.ok ? { success: true, data: { v: 1 } } : { success: false, error: { issues: [{ path: ["product", 0, "qty"], message: "จำนวนต้องมากกว่า 0", input: "secret" }] } }),
  };
  const good = res();
  assert.deepEqual(R.parseOr400(fakeSchema, { ok: 1 }, good), { v: 1 });
  assert.equal(good.code, 0);
  const bad = res();
  assert.equal(R.parseOr400(fakeSchema, {}, bad), null);
  assert.equal(bad.code, 400);
  assert.equal(bad.body.error, "invalid_request");
  assert.deepEqual(bad.body.issues, [{ path: "product.0.qty", message: "จำนวนต้องมากกว่า 0" }]);
  assert.equal(JSON.stringify(bad.body).includes("secret"), false);
});

test("parseOr400 กับ schema จริงของ @shopchamp/schema (strict: field เกิน = 400)", () => {
  const { SaleGetRequest } = require("@shopchamp/schema");
  const r = res();
  assert.equal(R.parseOr400(SaleGetRequest, { shopId: "shopA", billId: "b1", uid: "x" }, r), null);
  assert.equal(r.code, 400);
  assert.ok(r.body.issues.length >= 1);
});

test("internalError: 500 · log ไม่ได้ body", () => {
  const logged = [];
  const r = R.internalError(res(), new Error("boom"), (...a) => logged.push(a));
  assert.equal(r.code, 500);
  assert.deepEqual(r.body, { ok: false, error: "internal_error", message: R.MESSAGES.internal_error });
  assert.equal(logged.length, 1);
});

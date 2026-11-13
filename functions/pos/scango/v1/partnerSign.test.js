// เทส pos/scango/v1/partnerSign.js — ยามลายเซ็น HMAC ของ ScanGo Order API v1 (newcomer drill: ถูก · ผิด · หมดอายุ · ไม่ตั้งกุญแจ)
//   ตัวเทียบลายเซ็นในเทสคิดเองด้วย crypto ตามสูตรฝั่งส่ง (scango_server `_shared/partnerSign.js` › sign: HMAC-SHA256(secret, `${ts}.` + rawBody))
//   ไม่ใช้ sign() ของไฟล์ที่ทดสอบ ⇒ ถ้าสูตรฝั่งนี้เพี้ยนจากฝั่งส่ง เทสแดง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const S = require("./partnerSign");

const KEY = "k".repeat(40);
const env = { [S.ENV_KEY]: KEY };
const NOW = new Date("2026-11-13T05:00:00.000Z");
const senderSig = (ts, raw, key = KEY) => "v1=" + crypto.createHmac("sha256", key).update(`${ts}.`, "utf8").update(Buffer.from(raw, "utf8")).digest("hex");
const reqOf = (raw, { ts = NOW.getTime(), partner = "shopchamp", sig, key, rawAsBuffer = true } = {}) => ({
  headers: { "x-scango-partner": partner, "x-scango-timestamp": String(ts), "x-scango-signature": sig || senderSig(ts, raw, key) },
  rawBody: rawAsBuffer ? Buffer.from(raw, "utf8") : undefined,
  body: JSON.parse(raw),
});
const resOf = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test("ค่าคงที่ตรงฝั่งส่ง: partner shopchamp · กุญแจ SCANGO_SHOPCHAMP_KEY · skew 5 นาที", () => {
  assert.equal(S.PARTNER_ID, "shopchamp");
  assert.equal(S.ENV_KEY, "SCANGO_SHOPCHAMP_KEY");
  assert.equal(S.SKEW_MS, 300000);
});

test("ลายเซ็นถูก (สูตรฝั่งส่ง) = ผ่าน · ไบต์ดิบที่มีช่องว่าง/ลำดับคีย์ต่างจาก JSON.stringify ก็ผ่าน (ตรวจจากไบต์จริง)", () => {
  const raw = '{ "b": 1,  "a": "ไทย" }';
  assert.equal(S.verify(reqOf(raw), { now: NOW, env }), null);
  // ขอบ 5 นาทีพอดี = ผ่าน
  assert.equal(S.verify(reqOf(raw, { ts: NOW.getTime() - 300000 }), { now: NOW, env }), null);
  assert.equal(S.verify(reqOf(raw, { ts: NOW.getTime() + 300000 }), { now: NOW, env }), null);
});

test("ลายเซ็นผิด = 401 signature_invalid: กุญแจผิด · body ถูกแก้ · partner อื่น · header ขาด/รูปผิด", () => {
  const raw = '{"orderId":"o1"}';
  const cases = [
    reqOf(raw, { key: "x".repeat(40) }),
    { ...reqOf(raw), rawBody: Buffer.from('{"orderId":"o2"}') },
    reqOf(raw, { partner: "other-partner" }),
    { ...reqOf(raw), headers: {} },
    reqOf(raw, { sig: "v1=" + "0".repeat(63) }),
    reqOf(raw, { sig: senderSig(NOW.getTime(), raw).toUpperCase() }),
    reqOf(raw, { ts: "12a" }),
  ];
  for (const r of cases) {
    const e = S.verify(r, { now: NOW, env });
    assert.deepEqual([e && e.status, e && e.code], [401, "signature_invalid"], JSON.stringify(r.headers));
  }
});

test("หมดอายุ (ห่างเกิน 5 นาทีทั้ง 2 ทิศ) = 401 signature_expired แม้ลายเซ็นถูก", () => {
  const raw = "{}";
  for (const ts of [NOW.getTime() - 300001, NOW.getTime() + 300001]) {
    const e = S.verify(reqOf(raw, { ts }), { now: NOW, env });
    assert.deepEqual([e.status, e.code], [401, "signature_expired"]);
  }
});

test("ไม่ตั้งกุญแจ/ว่าง = 503 partner_not_configured (ไม่ใช่ 401 · กุญแจว่างเซ็นมาก็ไม่ผ่าน)", () => {
  for (const e of [{}, { [S.ENV_KEY]: "" }]) {
    const r = S.verify(reqOf("{}"), { now: NOW, env: e });
    assert.deepEqual([r.status, r.code], [503, "partner_not_configured"]);
  }
});

test("ไม่มี rawBody (เรียกตรง) = ตรวจจาก JSON.stringify(body)", () => {
  const body = { a: 1 };
  const raw = JSON.stringify(body);
  assert.equal(S.verify(reqOf(raw, { rawAsBuffer: false }), { now: NOW, env }), null);
});

test("middleware: ผ่าน = next · ไม่ผ่าน = ซอง {ok:false, error, code} ไม่เรียก next", () => {
  const mw = S.requirePartnerSignature({ env, now: () => NOW });
  let called = 0;
  mw(reqOf("{}"), resOf(), () => { called++; });
  assert.equal(called, 1);
  const bad = resOf();
  mw(reqOf("{}", { key: "nope" }), bad, () => { called++; });
  assert.deepEqual([called, bad.code, bad.body.ok, bad.body.error, bad.body.code], [1, 401, false, "signature_invalid", "signature_invalid"]);
});

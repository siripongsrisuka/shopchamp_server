// เทส priceTag/create.js (ก้อน 9b) · รัน: node --test functions/pos/priceTag/create.test.js
//   ขนาดที่ใหญ่เกินใส่ใน yaml ของสัญญา: 1,000 แถวผ่าน · 1,001 แถว 400 (PT-05) · เกิน 900,000 byte 413 · กดซ้ำได้ doc เดียว (PT-14)
//   doc ที่เขียนอ่านกลับด้วย PriceTag (อ่าน) และ PriceTagWrite (เขียน) ผ่าน
//   ❌ ไม่แตะ Firestore จริง (ฐานปลอม ../member/_fakeDb.js)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { installFakeDb } = require("../member/_fakeDb");

const F = installFakeDb(path, {});
const { create } = require("./create");
const { PriceTag, PriceTagWrite } = require("@shopchamp/schema");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const deps = { now: () => NOW };
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const R = "3d2c1b0a-9f8e-4d7c-8b6a-000000000004";
const seed = () => ({ shop: { shopA: { shopId: "shopA", humanResource: [{ id: "u-owner", position: ["001"], status: "active" }] } } });
const row = (o = {}) => ({ name: "น้ำดื่ม", imageId: "", barcode: "8850001", unit: "ขวด", price: 10, promotion: { status: false, qty: "", price: "", startDate: "2026-11-01T00:00:00+07:00", endDate: "2026-11-30T00:00:00+07:00" }, ...o });
async function call(body) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await create(deps)({ body, shopAccess: OWNER }, res);
  return res;
}

test("1,000 แถวผ่าน · doc ผ่าน PriceTag และ PriceTagWrite · วันที่เป็น Date", async () => {
  F.reset(seed());
  const r = await call({ shopId: "shopA", requestId: R, uploadBy: "", products: Array.from({ length: 1000 }, (_, i) => row({ barcode: String(i) })) });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  const doc = F.data.priceTag[R];
  assert.equal(doc.products.length, 1000);
  assert.equal(PriceTag.safeParse(doc).success, true);
  assert.equal(PriceTagWrite.safeParse(doc).success, true);
  assert.ok(doc.products[0].promotion.startDate instanceof Date);
});

test("1,001 แถว → 400 (PT-05) · ไม่เขียน", async () => {
  F.reset(seed());
  const r = await call({ shopId: "shopA", requestId: R, uploadBy: "", products: Array.from({ length: 1001 }, () => row()) });
  assert.equal(r.code, 400);
  assert.equal(F.log.length, 0);
});

test("รายการเกิน 900,000 byte → 413 price_tag_too_large · ไม่เขียน", async () => {
  F.reset(seed());
  const big = "x".repeat(1900);
  const r = await call({ shopId: "shopA", requestId: R, uploadBy: "", products: Array.from({ length: 500 }, () => row({ imageId: "https://a.example/" + big })) });
  assert.equal(r.code, 413);
  assert.equal(r.body.error, "price_tag_too_large");
  assert.equal(F.log.length, 0);
});

test("กดซ้ำ 2 ครั้ง ⇒ doc เดียว ลิงก์เดียวกัน (PT-14)", async () => {
  F.reset(seed());
  const body = { shopId: "shopA", requestId: R, uploadBy: "a", products: [row()] };
  const a = await call(body);
  const b = await call(body);
  assert.equal(a.body.url, b.body.url);
  assert.equal(b.body.duplicate, true);
  assert.equal(Object.keys(F.data.priceTag).length, 1);
});

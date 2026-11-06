// เทส product/saveCentral.js (ก้อน 9b) · รัน: node --test functions/pos/product/saveCentral.test.js
//   2 ร้านฝากบาร์โค้ดเดียวกันต่อกัน ⇒ doc กลาง 1 ตัว (B3) · ร้านที่ 2 เติมรูปได้เมื่อยังไม่มี (W1) · sku วันเวลาไทย (B6)
//   ❌ ไม่แตะ Firestore จริง (ฐานปลอม ../member/_fakeDb.js)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { installFakeDb } = require("../member/_fakeDb");

const F = installFakeDb(path, {});
const { saveCentral, keyOf, skuOf } = require("./saveCentral");
const { Product } = require("@shopchamp/schema");

const NOW = new Date("2026-11-10T17:05:09.000Z"); // ไทย 00:05:09 วันที่ 11
const deps = { now: () => NOW };
const IMG = "https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg";
const shop = (id) => ({ shopId: id, humanResource: [{ id: `o-${id}`, position: ["001"], status: "active" }] });
async function call(body, access) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await saveCentral(deps)({ body, shopAccess: access }, res);
  return res;
}
const A = { shopId: "shopA", uid: "o-shopA", role: "owner", rights: [] };
const B = { shopId: "shopB", uid: "o-shopB", role: "owner", rights: [] };

test("skuOf: นาฬิกาไทย ไม่ใช่ UTC และไม่ใช่ 0NaN… (B6)", () => {
  assert.equal(skuOf(NOW), "20261111000509");
});

test("keyOf: ตายตัวต่อบาร์โค้ด ใช้เป็น doc id ได้ (ไม่มี /)", () => {
  assert.equal(keyOf("AB/12"), keyOf("AB/12"));
  assert.notEqual(keyOf("1"), keyOf("2"));
  assert.match(keyOf("AB/12"), /^bc_[0-9a-f]{40}$/);
});

test("ร้าน A ฝากไม่มีรูป → ร้าน B บาร์โค้ดเดียวกันมีรูป ⇒ doc กลาง 1 ตัว · ได้รูปของ B · ชื่อของ A คงเดิม · doc ผ่าน Product", async () => {
  F.reset({ shop: { shopA: shop("shopA"), shopB: shop("shopB") } });
  const a = await call({ shopId: "shopA", barcode: "885", name: "ชื่อ A", unit: "ชิ้น", imageUrl: "" }, A);
  assert.equal(a.body.created, true);
  const b = await call({ shopId: "shopB", barcode: "885", name: "ชื่อ B", unit: "ขวด", imageUrl: IMG }, B);
  assert.equal(b.body.created, false);
  assert.equal(b.body.imageUpdated, true);
  const docs = Object.values(F.data.product);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, "ชื่อ A");
  assert.equal(docs[0].imageId, IMG);
  assert.equal(docs[0].createdBy2, "shopA");
  assert.equal(Product.safeParse(docs[0]).success, true);
});

test("doc กลางรุ่นเก่า (auto id) มีอยู่แล้ว ⇒ ไม่สร้าง doc id ตายตัวซ้อน", async () => {
  F.reset({ shop: { shopA: shop("shopA") }, product: { old1: { barcode: "885", name: "เก่า", unit: "ชิ้น", imageId: "" } } });
  const r = await call({ shopId: "shopA", barcode: "885", name: "ใหม่", unit: "ชิ้น", imageUrl: "" }, A);
  assert.equal(r.body.productId, "old1");
  assert.equal(Object.keys(F.data.product).length, 1);
});

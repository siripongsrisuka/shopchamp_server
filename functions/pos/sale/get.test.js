// เทส sale/get.js · รัน: node --test functions/pos/sale/get.test.js
//   ครอบช่องที่ case ในสัญญายังไม่ครอบ (ผลตรวจซ้ำ lanes/dev/source/chunk4-verify/sale.get.md ข้อ 4-7)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };

let DATA = {};
const db = {
  collection: (c) => ({
    doc: (id) => ({
      get: async () => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; },
    }),
  }),
};
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db, admin: {} } };
const G = require("./get");

const handler = G.get({});
async function call(body, shopAccess) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };

function bill(x) {
  return {
    shopId: "shopA", receiptNumber: "202611000010", billDate: "20261110", dateTime: ts("2026-11-10T02:00:00.000Z"),
    receiptType: "month", moneyMustPaid: 100, payment: [{ id: 1, amount: 100, name: "เงินสด" }],
    product: [{ id: "p1", qty: 2, name: "น้ำดื่ม", net: 100, totalPrice: 100, totalCost: 60 }],
    manualDiscount: 0, productDiscount: 0, pointDiscount: { value: 0, point: 0 }, member: {}, campaign: [],
    gainPoint: 0, usedPoint: 0, shiftId: "sh1", shiftOpenTime: ts("2026-11-10T01:00:00.000Z"), receiptUUID: "shopA-x", ...x,
  };
}
function seed(bills, shops) {
  DATA = {
    shop: shops || { shopA: { shopId: "shopA", name: "ร้านทดสอบ" }, shopB: { shopId: "shopB", name: "ร้านอื่น" } },
    bill: bills,
  };
}

test("qty ทศนิยม 4 ตำแหน่ง + ยอดสตางค์ กลับมาตรงค่า (ไม่ปัด)", async () => {
  seed({ b1: bill({ moneyMustPaid: 10.25, product: [{ id: "p-meat", qty: 0.1235, name: "หมูสับ", net: 14.82, totalPrice: 14.82, totalCost: 9.8765 }] }) });
  const r = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.bill.product[0].qty, 0.1235);
  assert.equal(r.body.bill.product[0].totalCost, 9.8765);
  assert.equal(r.body.bill.moneyMustPaid, 10.25);
});

test("ทีมงาน Shopchamp ได้ byAdmin:true · เจ้าของร้านไม่มี field นี้", async () => {
  seed({ b1: bill() });
  const a = await call({ shopId: "shopA", billId: "b1" }, ADMIN);
  assert.equal(a.code, 200);
  assert.equal(a.body.byAdmin, true);
  const o = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(o.code, 200);
  assert.equal("byAdmin" in o.body, false);
});

test("ไม่มีเอกสารร้าน → 404 shop_not_found · ไม่คืนบิล", async () => {
  seed({ b1: bill() }, {});
  const r = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(r.code, 404);
  assert.equal(r.body.error, "shop_not_found");
  assert.equal(r.body.bill, undefined);
});

test("field id ปลอมในเอกสารบิล ไม่ทับ billId", async () => {
  seed({ b1: bill({ id: "fake-id" }) });
  const r = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.bill.id, "b1");
});

test("บิลไม่มี shopId → 409 bill_other_shop · ไม่คืนบิล", async () => {
  const b = bill(); delete b.shopId;
  seed({ b1: b });
  const r = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "bill_other_shop");
  assert.equal(r.body.bill, undefined);
});

test("ร้านเก่าที่ doc id ≠ field shopId (schema/shop.md S5) · บิลเก็บค่า field → 200", async () => {
  seed({ b1: bill({ shopId: "uid-owner-old" }) }, { shopA: { shopId: "uid-owner-old", name: "ร้านเก่า" } });
  const r = await call({ shopId: "shopA", billId: "b1" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(r.body.bill.id, "b1");
});

test("ไม่มี shopAccess + body ผิด → 401 ก่อน 400", async () => {
  seed({ b1: bill() });
  const r = await call({ shopId: "shopA", billId: "b1", extra: 1 }, undefined);
  assert.equal(r.code, 401);
  assert.equal(r.body.error, "no_shop_access");
});

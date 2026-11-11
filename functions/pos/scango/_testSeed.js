// pos/scango/_testSeed.js — ข้อมูลตั้งต้น + ตัวโหลดฐานปลอมของเทส scango (ไม่ใช่ handler · ไม่ถูก route)
"use strict";
const path = require("node:path");
const { install, makeRes } = require("../announcement/_testDb");

const NOW = new Date("2026-11-11T05:00:00.000Z"); // พุธ 12:00 ไทย
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const OTHER = "otherShop000000000001";
const FILES = ["_core.js", "menu.js", "deliveryQuote.js", "orderCreate.js", "orderCancel.js", "orderRemind.js", "orderState.js"].map((f) => path.join(__dirname, f));

const shop = (scango) => ({
  name: "TEST Shopchamp",
  smartCategory: [{ level: 1, value: [{ id: "c1", name: "เครื่องดื่ม", level: 1, aboveId: [] }, { id: "c2", name: "น้ำอัดลม", level: 2, aboveId: ["c1"] }] }],
  scango: {
    enabled: true, location: { lat: 13.7, lng: 100.5 }, hours: [], minOrder: 0, deliveryFee: 30, freeDeliveryMin: 500, maxKm: 5,
    prepMinutes: 10, paymentQr: "", pickupNote: "", productIds: ["p1", "p2", "p3", "pDel", "pOther", "pOut"],
    ...(scango || {}),
  },
});
const stock = (over) => ({ shopId: SHOP, name: "สินค้า", price: 20, stock: 10, stockCountStatus: true, unit: "ขวด", imageId: "https://img/x.jpg", category: ["c1"], ...(over || {}) });

function seedOf(over) {
  return {
    [`shop/${SHOP}`]: shop(),
    [`shop/${OTHER}`]: shop({ productIds: [] }),
    "stock/p1": stock({ name: "โค้ก", price: 15, category: ["c1", "c2"] }),
    "stock/p2": stock({ name: "น้ำเปล่า", price: 7, stockCountStatus: false, stock: 0 }),
    "stock/p3": stock({ name: "โปรชุด", price: 50, promotion: { status: true, qty: 1, price: 40, startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-12-01T00:00:00Z") } }),
    "stock/pDel": stock({ name: "ลบแล้ว", deleted: true }),
    "stock/pOther": stock({ name: "ร้านอื่น", shopId: OTHER }),
    "stock/pOut": stock({ name: "หมด", stock: 0 }),
    "stock/pNotListed": stock({ name: "ไม่ได้เลือกขาย" }),
    ...(over || {}),
  };
}

function load(seedOver) {
  const mem = install(seedOf(seedOver), FILES, () => NOW);
  const deps = { now: () => NOW, pushes: [], push: null };
  deps.push = (m) => { deps.pushes.push(m); return { sent: 1 }; };
  return { mem, deps, mod: (f) => require(path.join(__dirname, f)) };
}

async function call(handler, body) {
  const res = makeRes();
  await handler({ body }, res);
  return res;
}

module.exports = { NOW, SHOP, OTHER, shop, stock, seedOf, load, call };

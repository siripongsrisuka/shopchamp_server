// pos/scango/e2e.test.js — ครบวงจรร้าน Shopchamp บน ScanGo ด้วย handler ตัวจริงทุกตัว + ฐานปลอมที่เขียนลงจริง (announcement/_testDb) · ❌ ไม่แตะ Firestore จริง ❌ ไม่ออกเน็ต (http ฉีด)
//   รัน: node --test functions/pos/scango/e2e.test.js
//   รอบ 4: ไทล์ ScanGo (loginStatus) → เจ้าของขอรหัส (loginStart) → ScanGo แลก (loginRedeem) ครั้งเดียว → เว็บร้าน relay ตั้งสินค้า → เมนูเห็น
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const T = require("../announcement/_testDb");

const NOW = new Date("2026-11-11T05:00:00.000Z"); // พุธ 12:00 ไทย
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const OWNER = "oZlTxlxRjaRdmMoH4aXOORiBBK73";
const REF = "sg-e2e-0001";
const ENV = { SCANGO_SHOPCHAMP_KEY: "k-e2e" };

const seed = {
  [`shop/${SHOP}`]: {
    shopId: SHOP, name: "TEST Shopchamp", tel: "021234567", address: "123 ถนนทดสอบ", receiptPattern: "month",
    humanResource: [{ id: OWNER, position: ["001"], status: "active" }],
    shopchampPayment: [{ id: 1, name: "เงินสด" }, { id: 2, name: "โอน/พร้อมเพย์" }],
    smartCategory: [{ level: 1, value: [{ id: "c1", name: "เครื่องดื่ม", level: 1, aboveId: [] }] }],
    scango: { enabled: false, location: null, hours: [], minOrder: 0, deliveryFee: 30, freeDeliveryMin: 500, maxKm: 5, prepMinutes: 10, paymentQr: "", pickupNote: "", productIds: ["p1", "p2"] },
  },
  // login เว็บร้าน ScanGo (settingsLogin.js): profile เจ้าของชี้ร้านด้วย field shopId
  [`profile/${OWNER}`]: { name: "คุณเจ้าของ", port: [{ position: ["001"], shopId: SHOP, shopName: "TEST Shopchamp" }] },
  "stock/p1": { shopId: SHOP, name: "โค้ก", price: 15, cost: 10, stock: 10, stockCountStatus: true, unit: "ขวด", category: ["c1"], barcode: "8850001" },
  "stock/p2": { shopId: SHOP, name: "น้ำเปล่า", price: 7, cost: 4, stock: 0, stockCountStatus: false, unit: "ขวด", category: ["c1"] },
};
const FILES = ["_core.js", "_menu.js", "settingsLogin.js", "menu.js", "shop/_common.js", "shop/orderList.js", "../member/_gate.js",
  "_loginCode.js", "shop/loginStart.js", "shop/loginStatus.js", "merchantRelay.js", "shop/productsSet.js", "shop/productSearch.js", "_deliveryFee.js"].map((f) => path.join(__dirname, f));
const mem = T.install(seed, FILES, () => NOW);
const H = { menu: require("./menu").menu, list: require("./shop/orderList").orderList };

const pushes = [];
const deps = { now: () => NOW, env: ENV, log: { info() {}, warn() {}, error() {} }, push: (m) => { pushes.push(m); return { sent: 1 }; } };
const owner = { shopId: SHOP, uid: OWNER, role: "owner", rights: [] };
const PARTNER = { "x-scango-platform-key": ENV.SCANGO_SHOPCHAMP_KEY };

async function call(handler, body, extra) {
  const res = T.makeRes();
  await handler(deps)({ body, ...(extra || {}) }, res);
  return res;
}
const get = (p) => structuredClone(mem.store.get(p));
const docsOf = (coll) => [...mem.store.keys()].filter((k) => k.startsWith(coll + "/") && k.split("/").length === 2);

test("e2e · login เว็บร้าน ScanGo: idToken ของเจ้าของ → ร้านของตัวเอง → owner-check ยืนยันเจ้าของ · token ผิด 401 · ไม่เขียนฐาน", async () => {
  const SL = require("./settingsLogin");
  const writesBefore = mem.writes.length;
  const loginDeps = { ...deps, verifyIdToken: async (t) => { if (t !== "tok-owner") throw Object.assign(new Error("bad"), { code: "auth/argument-error" }); return { uid: OWNER }; } };
  const run = async (h, body) => { const res = T.makeRes(); await h(loginDeps)({ body, headers: PARTNER }, res); return res; };
  const acc = await run(SL.loginAccount, { idToken: "tok-owner" });
  assert.equal(acc.code, 200, JSON.stringify(acc.body));
  assert.deepEqual(acc.body, { ok: true, personRef: OWNER, name: "คุณเจ้าของ", shops: [{ externalId: SHOP, name: "TEST Shopchamp" }] });
  const chk = await run(SL.loginOwnerCheck, { personRef: acc.body.personRef, externalId: acc.body.shops[0].externalId });
  assert.deepEqual([chk.code, chk.body.isOwner, chk.body.shopName], [200, true, "TEST Shopchamp"]);
  const bad = await run(SL.loginAccount, { idToken: "tok-forged" });
  assert.deepEqual([bad.code, bad.body.error], [401, "account_token_invalid"]);
  assert.equal(mem.writes.length, writesBefore, "อ่านอย่างเดียว");
});

test("e2e · รอบ 4 ไทล์ ScanGo: status → start → redeem ครั้งเดียว (ซ้ำ 409) → relay ตั้งสินค้าด้วยตัวตนที่แลกได้ → เมนูเปลี่ยน · หมดอายุ 410 · ไม่ใช่เจ้าของ 403", async () => {
  const SL = require("./settingsLogin");
  const start = require("./shop/loginStart").loginStart;
  const status = require("./shop/loginStatus").loginStatus;
  const R = require("./merchantRelay");
  let clock = NOW;
  const d4 = { ...deps, now: () => clock, audit: () => {} };
  const run = async (h, body, extra) => { const res = T.makeRes(); await h(d4)({ body, ...(extra || {}) }, res); return res; };

  // ไทล์: ร้านตั้งค่าแล้วในเทสแรก (scango.enabled boolean) ⇒ connected · เจ้าของ
  const st = await run(status, { shopId: SHOP }, { shopAccess: owner });
  assert.deepEqual(st.body, { ok: true, connected: true, isOwner: true });

  // ไม่ใช่เจ้าของ (คนที่ไม่มีแถวเจ้าของในร้าน) ขอรหัส = 403 · ไม่มี doc ใหม่
  const before = docsOf("scangoSettingsLogin").length;
  const notOwner = await run(start, { shopId: SHOP }, { shopAccess: { shopId: SHOP, uid: "someStaff", role: "staff", rights: ["111"] } });
  assert.deepEqual([notOwner.code, notOwner.body.error], [403, "owner_only"]);
  assert.equal(docsOf("scangoSettingsLogin").length, before);

  // เจ้าของได้รหัส → ScanGo แลก → ตัวตนเจ้าของ · ครั้งที่ 2 = 409 already_used
  const s1 = await run(start, { shopId: SHOP }, { shopAccess: owner });
  assert.equal(s1.code, 200, JSON.stringify(s1.body));
  assert.match(s1.body.code, /^[A-Za-z0-9]{20}\.[0-9a-f]{64}$/);
  const r1 = await run(SL.loginRedeem, { code: s1.body.code }, { headers: PARTNER });
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body, { ok: true, externalId: SHOP, personRef: OWNER, name: "", venueName: "TEST Shopchamp" });
  assert.ok(get(`shop/${SHOP}`).scango.merchantLinkedAt, "ประทับว่ามีใบบน ScanGo แล้ว");
  const r2 = await run(SL.loginRedeem, { code: s1.body.code }, { headers: PARTNER });
  assert.deepEqual([r2.code, r2.body.error], [409, "already_used"]);

  // เว็บร้าน relay ตั้งสินค้าด้วยตัวตนที่แลกได้ → shop.scango.productIds เปลี่ยน → เมนูที่ ScanGo ดึงเห็นแค่ p1
  const actor = { uid: `mo:shopchamp:${r1.body.personRef}`, personRef: r1.body.personRef, name: "เจ้าของ" };
  const set = await run(R.merchantProductsSet, { externalId: r1.body.externalId, productIds: ["p1"], actor }, { headers: PARTNER });
  assert.deepEqual([set.code, set.body.selectedCount], [200, 1], JSON.stringify(set.body));
  assert.deepEqual(get(`shop/${SHOP}`).scango.productIds, ["p1"]);
  const menu = await run(H.menu, { externalId: SHOP }, { headers: PARTNER });
  assert.deepEqual(menu.body.products.map((p) => p.productId), ["p1"]);

  // รหัสใหม่ที่ไม่ได้แลกภายใน 2 นาที = 410 code_expired
  const s2 = await run(start, { shopId: SHOP }, { shopAccess: owner });
  clock = new Date(NOW.getTime() + 120001);
  const late = await run(SL.loginRedeem, { code: s2.body.code }, { headers: PARTNER });
  assert.deepEqual([late.code, late.body.error], [410, "code_expired"]);
  assert.equal(get(`scangoSettingsLogin/${s2.body.code.slice(0, 20)}`).status, "pending");
});


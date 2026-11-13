// pos/scango/e2e.test.js — ครบวงจรร้าน Shopchamp บน ScanGo ด้วย handler ตัวจริงทุกตัว + ฐานปลอมที่เขียนลงจริง (announcement/_testDb) · ❌ ไม่แตะ Firestore จริง ❌ ไม่ออกเน็ต (http ฉีด)
//   รัน: node --test functions/pos/scango/e2e.test.js
//   DEV-0009: /scango/link → ใบ v1 เซ็น HMAC ผ่าน express จริง → push → ตัวเลขใบใหม่ → event ร้านกดรับ → ลด
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
const FILES = ["_core.js", "_menu.js", "settingsLogin.js", "menu.js", "link.js", "v1/orderV1.js", "shop/_common.js", "shop/orderList.js", "../member/_gate.js",
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


test("e2e · DEV-0009 ผ่าน express จริง: ScanGo /scango/link เปิดช่องทาง → ใบ v1 เซ็น HMAC (ราคาไม่ตรง/สินค้าหมดก็รับ) → push ถึงร้าน → ตัวเลขใบใหม่ 1 → ร้านกดรับบนเว็บ (event) → 0 · ScanGo ถามสถานะ · ลายเซ็นผิด/หมดอายุ ไม่ถึงฐาน", async () => {
  const { makeApp } = require("../app");
  const { requirePartnerKey } = require("./_partnerAuth");
  const { requirePartnerSignature, sign } = require("./v1/partnerSign");
  const clock = () => NOW;
  const app = makeApp({
    fnName: "pos", deps,
    checkIfAuthenticated: (req, res, next) => { req.auth = { uid: OWNER }; next(); },
    requireShopAccess: (req, res, next) => { req.shopAccess = owner; next(); },
    requirePartnerKey: requirePartnerKey(ENV),
    requirePartnerSignature: requirePartnerSignature({ env: ENV, now: clock }),
  });
  const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const send = async (p, raw, headers) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  const signed = (raw, { ts = NOW.getTime(), key = ENV.SCANGO_SHOPCHAMP_KEY } = {}) => ({ "x-scango-partner": "shopchamp", "x-scango-timestamp": String(ts), "x-scango-signature": sign({ timestamp: ts, rawBody: raw, secret: key }) });
  const newCount = async () => (await send("/scango/shop/order-list", JSON.stringify({ shopId: SHOP, states: ["requested"] }), { authorization: "Bearer x" })).body.orders.length;
  try {
    // ① ScanGo เปิดช่องทาง (กุญแจ header) → shop.scango.enabled true (ป๊อปอัปในแอปฟังเมื่อ true)
    const ln = await send("/scango/link", JSON.stringify({ externalId: SHOP, linked: true }), PARTNER);
    assert.deepEqual([ln.status, ln.body], [200, { ok: true, linked: true }]);
    assert.equal(get(`shop/${SHOP}`).scango.enabled, true);
    const st = await send("/scango/shop/login-status", JSON.stringify({ shopId: SHOP }), { authorization: "Bearer x" });
    assert.deepEqual([st.status, st.body.connected], [200, true]);

    // ② ใบ v1 (ไบต์ดิบมีช่องว่าง · p1 ราคาจริง 15 แต่ส่ง 12 · p2 ราคา 7 ส่ง 7) — Pack A: รับ
    const order = { schema: "scango.order.v1", orderId: "sg-e2e-v1", code: "QQ11", venueRef: SHOP, items: [{ lineId: "L1", productRef: "p1", name: "โค้ก", qty: 20, unitPrice: 12, lineTotal: 240 }], bill: { subtotal: 240, discounts: [{ kind: "promotion", title: "โปร", amount: 10 }], deliveryFee: 20, total: 250 } };
    const raw = JSON.stringify(order, null, 1);
    const pushBefore = pushes.length;
    const bad = await send("/scango/v1/orders", raw, signed(raw, { key: "k-wrong" }));
    const old = await send("/scango/v1/orders", raw, signed(raw, { ts: NOW.getTime() - 300001 }));
    assert.deepEqual([bad.status, bad.body.code, old.status, old.body.code], [401, "signature_invalid", 401, "signature_expired"]);
    assert.equal(mem.store.get("scangoOrder/sg-e2e-v1"), undefined, "ลายเซ็นไม่ผ่าน = ไม่ถึงฐาน");
    const cr = await send("/scango/v1/orders", raw, signed(raw));
    assert.deepEqual([cr.status, cr.body], [200, { ok: true, partnerOrderRef: "sg-e2e-v1" }]);
    assert.deepEqual(pushes.slice(pushBefore).map((m) => m.data), [{ type: "scango_order", orderRef: "sg-e2e-v1" }]);
    assert.equal(await newCount(), 1);
    const again = await send("/scango/v1/orders", raw, signed(raw));
    assert.deepEqual([again.status, again.body.duplicate, pushes.length - pushBefore], [200, true, 1]);

    // ③ ร้านกดรับบนเว็บร้าน ScanGo → event → ตัวเลขใบใหม่ 0 · ScanGo ถามสถานะ = accepted
    const ev = JSON.stringify({ schema: "scango.order-event.v1", eventId: "ev-1", orderId: "sg-e2e-v1", type: "venue.accepted", at: NOW.toISOString(), actor: "venue" });
    const ea = await send("/scango/v1/orders/sg-e2e-v1/events", ev, signed(ev));
    assert.deepEqual([ea.status, ea.body], [200, { ok: true, applied: true }]);
    assert.equal(await newCount(), 0);
    const sr = await send("/scango/v1/orders/sg-e2e-v1/state", "{}", signed("{}"));
    assert.deepEqual([sr.status, sr.body.state, sr.body.partnerOrderRef], [200, "accepted", "sg-e2e-v1"]);

    // ④ ScanGo ปิดช่องทาง → enabled false
    const off = await send("/scango/link", JSON.stringify({ externalId: SHOP, linked: false }), PARTNER);
    assert.deepEqual([off.status, get(`shop/${SHOP}`).scango.enabled], [200, false]);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

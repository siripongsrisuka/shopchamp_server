// pos/scango/e2e.test.js — ครบวงจรร้าน Shopchamp บน ScanGo ด้วย handler ตัวจริงทุกตัว + ฐานปลอมที่เขียนลงจริง (announcement/_testDb) · ❌ ไม่แตะ Firestore จริง ❌ ไม่ออกเน็ต (http ฉีด)
//   รัน: node --test functions/pos/scango/e2e.test.js
//   เส้นทาง: ตั้งค่าร้าน (settingsSave → venue_ordering) → ScanGo ดึงเมนู → สั่ง (orderCreate · push ร้าน) → ร้านกดรับ/พร้อมส่ง (orderAction · ข่าว accepted/ready ออก)
//           → ไรเดอร์ assigned/picked_up/delivering/delivered (orderDelivery) → ปิดบิลด้วย sale/create.js ตัวจริง (เลขบิล · ตัดสต็อก · guard)
//           → orderState/orderList เห็นบิลปิดแล้ว · ข่าวที่ยิงไม่ออกลง outbox แล้วตัวกวาดยิงซ้ำสำเร็จ
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
const ENV = { SCANGO_BASE_URL: "https://scango.example/api", SCANGO_SHOPCHAMP_KEY: "k-e2e" };

const seed = {
  [`shop/${SHOP}`]: {
    shopId: SHOP, name: "TEST Shopchamp", tel: "021234567", address: "123 ถนนทดสอบ", receiptPattern: "month",
    humanResource: [{ id: OWNER, position: ["001"], status: "active" }],
    shopchampPayment: [{ id: 1, name: "เงินสด" }, { id: 2, name: "โอน/พร้อมเพย์" }],
    smartCategory: [{ level: 1, value: [{ id: "c1", name: "เครื่องดื่ม", level: 1, aboveId: [] }] }],
    scango: { enabled: false, location: null, hours: [], minOrder: 0, deliveryFee: 30, freeDeliveryMin: 500, maxKm: 5, prepMinutes: 10, paymentQr: "", pickupNote: "", productIds: ["p1", "p2"] },
  },
  [`billId/${SHOP}`]: { month: 11, receipts: 41 },
  // login เว็บร้าน ScanGo (settingsLogin.js): profile เจ้าของชี้ร้านด้วย field shopId
  [`profile/${OWNER}`]: { name: "คุณเจ้าของ", port: [{ position: ["001"], shopId: SHOP, shopName: "TEST Shopchamp" }] },
  "stock/p1": { shopId: SHOP, name: "โค้ก", price: 15, cost: 10, stock: 10, stockCountStatus: true, unit: "ขวด", category: ["c1"], barcode: "8850001" },
  "stock/p2": { shopId: SHOP, name: "น้ำเปล่า", price: 7, cost: 4, stock: 0, stockCountStatus: false, unit: "ขวด", category: ["c1"] },
};
const FILES = ["_core.js", "_menu.js", "_outbound.js", "_orderActions.js", "closeBill.js", "settingsLogin.js", "menu.js", "deliveryQuote.js", "orderCreate.js", "orderDelivery.js", "orderState.js", "outboxSweep.js",
  "shop/_common.js", "shop/settingsSave.js", "shop/orderAction.js", "shop/orderList.js", "../sale/create.js", "../member/_gate.js",
  "_loginCode.js", "shop/loginStart.js", "shop/loginStatus.js", "merchantRelay.js", "shop/productsSet.js", "shop/productSearch.js"].map((f) => path.join(__dirname, f));
const mem = T.install(seed, FILES, () => NOW);
const H = {
  menu: require("./menu").menu, quote: require("./deliveryQuote").deliveryQuote, create: require("./orderCreate").orderCreate, delivery: require("./orderDelivery").orderDelivery,
  state: require("./orderState").orderState, settingsSave: require("./shop/settingsSave").settingsSave, action: require("./shop/orderAction").orderAction, list: require("./shop/orderList").orderList,
};
const SW = require("./outboxSweep");

// ท่อ http ปลอม: บันทึกทุกคำขอ · ตั้งให้ตก 503 ได้ตาม path (outbox ต้องรับช่วง)
const http = { calls: [], failPaths: new Set() };
const fakeHttp = async (url, body, opts) => {
  http.calls.push({ url, body, headers: opts.headers });
  if ([...http.failPaths].some((p) => url.endsWith(p))) { const e = new Error("503"); e.response = { status: 503, data: {} }; throw e; }
  return { status: 200, data: { ok: true } };
};
const pushes = [];
const deps = { now: () => NOW, env: ENV, http: fakeHttp, log: { info() {}, warn() {}, error() {} }, push: (m) => { pushes.push(m); return { sent: 1 }; } };
const owner = { shopId: SHOP, uid: OWNER, role: "owner", rights: [] };
const PARTNER = { "x-scango-platform-key": ENV.SCANGO_SHOPCHAMP_KEY };

async function call(handler, body, extra) {
  const res = T.makeRes();
  await handler(deps)({ body, ...(extra || {}) }, res);
  return res;
}
const get = (p) => structuredClone(mem.store.get(p));
const docsOf = (coll) => [...mem.store.keys()].filter((k) => k.startsWith(coll + "/") && k.split("/").length === 2);

test("e2e · ร้านตั้งค่า → ScanGo ดึงเมนู → สั่ง → ร้านรับ/พร้อมส่ง → ไรเดอร์ส่งถึง → บิลออก สต็อกตัด · ข่าวครบ · outbox รับช่วง", async () => {
  // ① ร้านเปิดรับใบ (เจ้าของ) · เลขพร้อมเพย์ในช่อง paymentQr ⇒ venue_ordering พก paymentQr รูปที่ ScanGo อ่าน · venue 'sent'
  const save = await call(H.settingsSave, { shopId: SHOP, enabled: true, location: { lat: 13.7, lng: 100.5 }, hours: [{ day: 3, open: "08:00", close: "20:00" }], minOrder: 0, deliveryFee: 30, freeDeliveryMin: 500, maxKm: 5, prepMinutes: 10, paymentQr: "081-234-5678", pickupNote: "หน้าร้าน" }, { shopAccess: owner });
  assert.equal(save.code, 200, JSON.stringify(save.body));
  assert.equal(save.body.venue, "sent");
  assert.equal(get(`shop/${SHOP}`).scango.enabled, true);
  assert.deepEqual(get(`shop/${SHOP}`).scango.productIds, ["p1", "p2"], "productIds ไม่ถูกแตะ");
  const venue = http.calls[0];
  assert.equal(venue.url, `${ENV.SCANGO_BASE_URL}/provider/shopchamp/event`);
  assert.equal(venue.headers["x-scango-platform-key"], ENV.SCANGO_SHOPCHAMP_KEY);
  assert.equal(venue.body.type, "venue_ordering"); assert.equal(venue.body.externalId, SHOP); assert.equal(venue.body.enabled, true);
  assert.deepEqual(venue.body.geo, { lat: 13.7, lng: 100.5 });
  assert.deepEqual(venue.body.paymentQr, { type: "promptpay", id: "0812345678", name: "TEST Shopchamp" });
  assert.deepEqual(venue.body.businessHours, [{ day: 3, open: "08:00", close: "20:00", closed: false }]);
  assert.deepEqual(venue.body.pickup, { name: "TEST Shopchamp", address: "123 ถนนทดสอบ", lat: 13.7, lng: 100.5, phone: "021234567", note: "หน้าร้าน" });
  assert.equal(venue.body.vertical, "retail"); assert.equal(venue.body.maxKm, 5); assert.equal(venue.body.prepMinutes, 10);

  // ② ScanGo ดึงเมนู + ถามค่าส่ง (เลขเดียวกับที่ orderCreate จะคิด)
  const menu = await call(H.menu, { externalId: SHOP }, { headers: PARTNER });
  assert.equal(menu.code, 200, JSON.stringify(menu.body));
  assert.equal(menu.body.acceptingOrders, true);
  assert.deepEqual(menu.body.products.map((p) => [p.productId, p.price, p.status]), [["p1", 15, "available"], ["p2", 7, "available"]]);
  const quote = await call(H.quote, { externalId: SHOP, distanceKm: 2.3, foodSubtotal: 30 }, { headers: PARTNER });
  assert.deepEqual([quote.body.fee, quote.body.riderFee, quote.body.outOfRange], [30, 30, false]);

  // ③ ลูกค้าสั่ง (รูป ProviderOrder ของ ScanGo · ช่องเกินใน order ได้) → ใบ requested · push ร้าน
  const order = {
    orderId: REF, orderRef: REF, code: "E2E1", venueId: "V1", state: "requested", distanceKm: 2.3, distanceEstimated: false,
    items: [{ productId: "p1", name: "โค้ก", qty: 2, unitPrice: 15, lineTotal: 30, options: [], note: "" }],
    subtotal: 30, deliveryFee: quote.body.fee, riderFee: 30, shopPays: 0, total: 60,
    payment: { method: "cash" }, customer: { name: "ลูกค้า", phone: "0900000001" }, dropPoint: { lat: 13.71, lng: 100.51, detail: "บ้าน 12", note: "" },
  };
  const created = await call(H.create, { externalId: SHOP, order }, { headers: PARTNER });
  assert.equal(created.code, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body, { ok: true, providerOrderRef: REF, state: "requested" });
  let o = get(`scangoOrder/${REF}`);
  assert.equal(o.state, "requested"); assert.equal(o.total, 60); assert.equal(o.items[0].lineTotal, 30);
  assert.equal(pushes.length, 1); assert.deepEqual(pushes[0].data, { type: "scango_order", orderRef: REF });
  // ส่งซ้ำ = duplicate ไม่สร้างใบที่ 2 ไม่ push ซ้ำ
  const dup = await call(H.create, { externalId: SHOP, order }, { headers: PARTNER });
  assert.equal(dup.body.duplicate, true); assert.equal(docsOf("scangoOrder").length, 1); assert.equal(pushes.length, 1);

  // ④ ร้านกดรับ → ข่าว accepted ถึง ScanGo · กดพร้อมส่งตอน ScanGo ล่ม → ลง outbox (queued) · ธง notified ทั้งคู่
  const accept = await call(H.action, { shopId: SHOP, orderRef: REF, action: "accept" }, { shopAccess: owner });
  assert.equal(accept.code, 200, JSON.stringify(accept.body));
  assert.deepEqual([accept.body.state, accept.body.changed, accept.body.notify.sent], ["accepted", true, true]);
  const ev1 = http.calls.find((c) => c.url.endsWith("/provider/shopchamp/order/event"));
  assert.deepEqual(ev1.body, { orderRef: REF, type: "accepted", at: NOW.toISOString(), eventId: `${REF}:accepted` });
  http.failPaths.add("/provider/shopchamp/order/event");
  const ready = await call(H.action, { shopId: SHOP, orderRef: REF, action: "ready" }, { shopAccess: owner });
  assert.equal(ready.code, 200, JSON.stringify(ready.body));
  assert.deepEqual([ready.body.state, ready.body.notify.sent, ready.body.notify.queued], ["ready", false, true]);
  o = get(`scangoOrder/${REF}`);
  assert.deepEqual(o.notified, { accepted: true, ready: true });
  assert.equal(get(`scangoOutbox/${REF}:ready`).state, "pending");
  http.failPaths.clear();

  // ⑤ ไรเดอร์: assigned → picked_up → delivering → delivered (ส่งผ่าน middleware partner ชั้นแรกไม่ได้ในเทส ⇒ ด่านชั้นสองในตัวตรวจกุญแจ)
  const noKey = await call(H.delivery, { externalId: SHOP, orderRef: REF, state: "assigned", rider: { name: "วิน" } }, { headers: {} });
  assert.equal(noKey.code, 401, "ไม่มีกุญแจ = ไม่แตะใบ");
  for (const [state, extra] of [["assigned", { rider: { name: "วิน", phone: "0811111111" } }], ["picked_up", {}], ["delivering", {}]]) {
    const r = await call(H.delivery, { externalId: SHOP, orderRef: REF, state, eventId: `ev-${state}`, at: NOW.toISOString(), ...extra }, { headers: PARTNER });
    assert.equal(r.code, 200, `${state}: ${JSON.stringify(r.body)}`);
  }
  o = get(`scangoOrder/${REF}`);
  assert.equal(o.state, "delivering"); assert.equal(o.rider.name, "วิน");
  assert.equal(docsOf("bill").length, 0, "ยังไม่ส่งถึง = ยังไม่มีบิล");
  const delivered = await call(H.delivery, { externalId: SHOP, orderRef: REF, state: "delivered", eventId: "ev-delivered", at: NOW.toISOString() }, { headers: PARTNER });
  assert.equal(delivered.code, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.state, "delivered");

  // ⑥ บิลออกด้วยแกน sale.create: เลขบิล · ตัดสต็อกตัวที่นับ · guard · ค่าส่งไม่เข้าบิล · ป้ายช่องทาง
  o = get(`scangoOrder/${REF}`);
  assert.ok(o.billId, "ใบมี billId"); assert.equal(o.receiptNumber, "202611000042"); assert.equal(o.billPending, null);
  const bills = docsOf("bill");
  assert.equal(bills.length, 1);
  const bill = get(bills[0]);
  assert.equal(bills[0].slice(5), o.billId);
  assert.equal(bill.moneyMustPaid, 30, "ค่าส่ง 30 ไม่เข้าบิล");
  assert.deepEqual(bill.payment, [{ id: 1, amount: 30, name: "เงินสด", change: 0 }]);
  assert.deepEqual(bill.product.map((p) => [p.id, p.qty, p.net, p.totalCost]), [["p1", 2, 30, 20]]);
  assert.equal(bill.note, "ScanGo #E2E1"); assert.equal(bill.cashierName, "ScanGo"); assert.deepEqual(bill.scango, { orderRef: REF, code: "E2E1" });
  assert.equal(get("stock/p1").stock, 8, "ตัดสต็อก 10 → 8");
  assert.equal(get("stock/p2").stock, 0, "ไม่ได้ขาย/ไม่นับ = ไม่แตะ");
  assert.equal(get(`billId/${SHOP}`).receipts, 42);
  assert.equal(get(`receiptGuard/scango-${REF}`).billId, o.billId);
  // delivered ซ้ำ (outbox ของ ScanGo ลองซ้ำ) = บิลใบเดียว สต็อกไม่ตัดซ้ำ
  await call(H.delivery, { externalId: SHOP, orderRef: REF, state: "delivered", eventId: "ev-delivered-2", at: NOW.toISOString() }, { headers: PARTNER });
  assert.equal(docsOf("bill").length, 1); assert.equal(get("stock/p1").stock, 8);

  // ⑦ ScanGo ถามสถานะ · แอปร้านเห็นใบพร้อมบิล
  const st = await call(H.state, { externalId: SHOP, orderRef: REF }, { headers: PARTNER });
  assert.equal(st.code, 200);
  assert.deepEqual({ pos: st.body.posState, dl: st.body.deliveryState, bill: st.body.bill, notified: st.body.notified, rider: st.body.rider.name }, { pos: "ready", dl: "delivered", bill: { closed: true, pending: null }, notified: { accepted: true, ready: true, cancelled: false }, rider: "วิน" });
  const list = await call(H.list, { shopId: SHOP, states: ["delivered"] }, { shopAccess: owner });
  assert.equal(list.code, 200);
  assert.deepEqual(list.body.orders.map((x) => [x.orderRef, x.state, x.billId === o.billId, typeof x.createdAt]), [[REF, "delivered", true, "string"]]);

  // ⑧ ตัวกวาด: ข่าว ready ที่ค้างใน outbox ยิงซ้ำสำเร็จ payload เดิม · แถวหาย
  const before = http.calls.length;
  const sweep = await SW.runSweep({ now: new Date(NOW.getTime() + 60000) }, deps);
  assert.deepEqual(sweep.outbox, { picked: 1, sent: 1, retry: 0, dead: 0 });
  assert.deepEqual(sweep.bills, { picked: 0, closed: 0, failed: 0 });
  assert.equal(http.calls.length, before + 1);
  assert.deepEqual(http.calls[before].body, { orderRef: REF, type: "ready", at: NOW.toISOString(), eventId: `${REF}:ready` });
  assert.equal(docsOf("scangoOutbox").length, 0);

  // ⑨ ข่าวที่ยิงออกทั้งหมด = venue_ordering 1 · accepted 1 · ready (ครั้งแรกตก + กวาดสำเร็จ) 2
  const types = http.calls.map((c) => c.body.type);
  assert.deepEqual(types, ["venue_ordering", "accepted", "ready", "ready"]);
});

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
  const d4 = { ...deps, now: () => clock, sealKey: Buffer.alloc(32, 3).toString("base64"), audit: () => {} };
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

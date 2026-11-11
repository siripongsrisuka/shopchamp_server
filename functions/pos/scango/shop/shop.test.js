// เทส pos/scango/shop/*.js (เส้นฝั่งแอปร้าน scango.*) · รัน: node --test functions/pos/scango/shop/shop.test.js
//   ❌ ไม่แตะ Firestore จริง (ฐานปลอม ./_testDb.js) · sendVenue / _orderActions = ของปลอมผ่าน deps
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installFakeDb, call } = require("./_testDb");

const F = installFakeDb();
const { settingsGet } = require("./settingsGet");
const { settingsSave } = require("./settingsSave");
const { productsSet } = require("./productsSet");
const { productSearch, PAGE_SIZE, SCAN_LIMIT } = require("./productSearch");
const { orderList } = require("./orderList");
const { orderAction } = require("./orderAction");

const NOW = new Date("2026-11-11T03:00:00.000Z");
const FUTURE = new Date("2027-12-31T00:00:00.000Z");
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const STAFF = (rights) => ({ shopId: "shopA", uid: "u-staff", role: "staff", rights });
const WATCHER = { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true };
const ROOT = { shopId: "shopA", uid: "u-root", role: "owner", rights: [], byAdmin: true, root: true };

const shopDoc = (scango) => ({
  shopId: "shopA",
  vip: [{ type: "staff", expire: FUTURE }],
  humanResource: [{ id: "u-owner", position: ["001"], status: "active" }, { id: "u-staff", position: ["002"], status: "active" }],
  name: "ร้าน A",
  ...(scango ? { scango } : {}),
});
const prod = (o = {}) => ({ shopId: "shopA", name: "น้ำดื่ม", price: 10, barcode: "885000", unit: "ขวด", imageId: "", category: ["c1"], stock: 5, stockCountStatus: true, ...o });
const SETTINGS = (o = {}) => ({
  shopId: "shopA", enabled: false, location: { lat: 13.7, lng: 100.5 }, hours: [{ day: 1, open: "08:00", close: "20:00" }],
  minOrder: 100, deliveryFee: 20, freeDeliveryMin: 500, maxKm: 5, prepMinutes: 15,
  paymentQr: "https://firebasestorage.googleapis.com/v0/b/x/o/qr.png", pickupNote: "หน้าร้าน", ...o,
});
function venueSpy(result = { status: "sent", sent: true, queued: false }) {
  const calls = [];
  const fn = async (_deps, arg) => { calls.push(arg); return result; };
  fn.calls = calls;
  return fn;
}

// ── settingsGet ────────────────────────────────────────────────────────────────
test("settingsGet: ร้านไม่เคยตั้ง = ค่าตั้งต้น configured:false missing ครบ 3 · watcher อ่านได้", async () => {
  F.reset({ shop: { shopA: shopDoc() } });
  const r = await call(settingsGet, {}, { shopId: "shopA" }, WATCHER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.configured, false);
  assert.equal(r.body.scango.enabled, false);
  assert.equal(r.body.scango.location, null);
  assert.deepEqual(r.body.scango.productIds, []);
  assert.equal(r.body.productCount, 0);
  assert.deepEqual(r.body.missing, ["location", "hours", "products"]);
});

test("settingsGet: ร้านตั้งแล้ว = ค่าในฐาน + productCount · ร้านผิด 403 · ช่องเกิน 400 · ร้านไม่มี 404", async () => {
  F.reset({ shop: { shopA: shopDoc({ ...SETTINGS({ enabled: true }), shopId: undefined, productIds: ["p1", "p2"] }) } });
  const r = await call(settingsGet, {}, { shopId: "shopA" }, STAFF([]));
  assert.equal(r.code, 200);
  assert.equal(r.body.scango.enabled, true);
  assert.equal(r.body.productCount, 2);
  assert.deepEqual(r.body.missing, []);
  assert.equal((await call(settingsGet, {}, { shopId: "shopB" }, OWNER)).code, 403);
  assert.equal((await call(settingsGet, {}, { shopId: "shopA", x: 1 }, OWNER)).code, 400);
  F.reset({ shop: {} });
  assert.equal((await call(settingsGet, {}, { shopId: "shopA" }, OWNER)).code, 404);
});

// ── settingsSave ───────────────────────────────────────────────────────────────
test("settingsSave: เจ้าของบันทึก = เขียนเฉพาะ scango.<ช่อง> · productIds เดิมคงอยู่ · ช่องอื่นของร้านไม่ถูกแตะ · ส่ง venue", async () => {
  F.reset({ shop: { shopA: shopDoc({ productIds: ["p1"], enabled: false }) } });
  const spy = venueSpy();
  const r = await call(settingsSave, { now: () => NOW, sendVenue: spy }, SETTINGS({ enabled: true }), OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.venue, "sent");
  const s = F.data.shop.shopA;
  assert.equal(s.name, "ร้าน A");
  assert.deepEqual(s.scango.productIds, ["p1"]);
  assert.equal(s.scango.enabled, true);
  assert.deepEqual(s.scango.location, { lat: 13.7, lng: 100.5 });
  assert.equal(s.scango.freeDeliveryMin, 500);
  const keys = Object.keys(F.log[0].v).sort();
  assert.deepEqual(keys, ["deliveryFee", "enabled", "freeDeliveryMin", "hours", "location", "maxKm", "minOrder", "paymentQr", "pickupNote", "prepMinutes"].map((k) => `scango.${k}`).sort());
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].shopId, "shopA");
  assert.equal(spy.calls[0].enabled, true);
});

test("settingsSave: พนักงาน 403 owner_required · watcher 403 · ไม่เขียน ไม่ส่ง venue", async () => {
  F.reset({ shop: { shopA: shopDoc() } });
  const spy = venueSpy();
  const a = await call(settingsSave, { now: () => NOW, sendVenue: spy }, SETTINGS(), STAFF(["101", "111"]));
  assert.equal(a.code, 403);
  assert.equal(a.body.error, "owner_required");
  const w = await call(settingsSave, { now: () => NOW, sendVenue: spy }, SETTINGS(), WATCHER);
  assert.equal(w.body.error, "watcher_read_only");
  assert.equal(F.log.length, 0);
  assert.equal(spy.calls.length, 0);
});

test("settingsSave: เปิดรับใบแต่ขาดของ = 409 scango_not_ready พร้อม missing · ปิดอยู่บันทึกได้แม้ขาด", async () => {
  F.reset({ shop: { shopA: shopDoc() } });
  const spy = venueSpy();
  const r = await call(settingsSave, { now: () => NOW, sendVenue: spy }, SETTINGS({ enabled: true, location: null, hours: [] }), OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "scango_not_ready");
  assert.deepEqual(r.body.missing, ["location", "hours", "products"]);
  assert.equal(F.log.length, 0);
  const off = await call(settingsSave, { now: () => NOW, sendVenue: spy }, SETTINGS({ enabled: false, location: null, hours: [] }), OWNER);
  assert.equal(off.code, 200, JSON.stringify(off.body));
  assert.equal(F.data.shop.shopA.scango.location, null);
});

test("settingsSave: ตรวจรูปเข้ม 400 (เวลา · ช่วงทับ · QR ไม่ใช่ https · ช่องขาด/เกิน · ค่าติดลบ)", async () => {
  F.reset({ shop: { shopA: shopDoc() } });
  const d = { now: () => NOW, sendVenue: venueSpy() };
  const bad = [
    SETTINGS({ hours: [{ day: 7, open: "08:00", close: "20:00" }] }),
    SETTINGS({ hours: [{ day: 1, open: "8:00", close: "20:00" }] }),
    SETTINGS({ hours: [{ day: 1, open: "20:00", close: "08:00" }] }),
    SETTINGS({ hours: [{ day: 1, open: "08:00", close: "12:00" }, { day: 1, open: "11:00", close: "15:00" }] }),
    SETTINGS({ paymentQr: "http://x.com/qr.png" }),
    SETTINGS({ paymentQr: "ไม่ใช่ลิงก์" }),
    SETTINGS({ minOrder: -1 }),
    SETTINGS({ maxKm: 0 }),
    SETTINGS({ prepMinutes: 1.5 }),
    SETTINGS({ location: { lat: 100, lng: 1 } }),
    SETTINGS({ productIds: ["p1"] }),
    (() => { const s = SETTINGS(); delete s.pickupNote; return s; })(),
  ];
  for (const b of bad) {
    const r = await call(settingsSave, d, b, OWNER);
    assert.equal(r.code, 400, JSON.stringify(b));
    assert.equal(r.body.error, "invalid_request");
  }
  const okTwo = await call(settingsSave, d, SETTINGS({ hours: [{ day: 1, open: "08:00", close: "12:00" }, { day: 1, open: "13:00", close: "20:00" }], freeDeliveryMin: null, paymentQr: "" }), OWNER);
  assert.equal(okTwo.code, 200, JSON.stringify(okTwo.body));
  assert.equal(F.log.length, 1);
});

test("settingsSave: ส่ง venue ล้ม = ค่าตั้งบันทึกแล้ว ตอบ 200 venue:'failed' · root ได้ byAdmin", async () => {
  F.reset({ shop: { shopA: shopDoc({ productIds: ["p1"] }) } });
  const boom = async () => { throw new Error("network"); };
  const orig = console.error; console.error = () => {};
  const r = await call(settingsSave, { now: () => NOW, sendVenue: boom }, SETTINGS({ enabled: true }), ROOT);
  console.error = orig;
  assert.equal(r.code, 200);
  assert.equal(r.body.venue, "failed");
  assert.equal(r.body.byAdmin, true);
  assert.equal(F.data.shop.shopA.scango.enabled, true);
  // สถานะจาก sendVenue ส่งต่อตามจริง (ไม่เดาว่า sent): queued (ลง outbox) · skipped (env ไม่ตั้ง) · รูปที่ไม่รู้จัก/ไม่คืนอะไร = failed
  for (const [ret, want] of [[{ status: "queued", sent: false, queued: true }, "queued"], [{ status: "skipped", reason: "not_configured" }, "skipped"], [{ status: "ok" }, "failed"], [null, "failed"]]) {
    const rr = await call(settingsSave, { now: () => NOW, sendVenue: venueSpy(ret) }, SETTINGS({ enabled: true }), OWNER);
    assert.equal(rr.code, 200);
    assert.equal(rr.body.venue, want, JSON.stringify(ret));
  }
  // เลขพร้อมเพย์ในช่อง paymentQr (ทางที่ ScanGo ใช้สร้าง QR ได้) = ผ่าน · เลขผิดหลัก = 400
  assert.equal((await call(settingsSave, { now: () => NOW, sendVenue: venueSpy() }, SETTINGS({ paymentQr: "081-234-5678" }), OWNER)).code, 200);
  assert.equal((await call(settingsSave, { now: () => NOW, sendVenue: venueSpy() }, SETTINGS({ paymentQr: "0812345" }), OWNER)).code, 400);
});

// ── productsSet ────────────────────────────────────────────────────────────────
test("productsSet: ตั้งรายการ (ตัดซ้ำ คงลำดับ) เขียนช่องเดียว · พนักงานที่มี '111' ได้ · ไม่มี 403", async () => {
  F.reset({ shop: { shopA: shopDoc({ enabled: false }) }, stock: { p1: prod(), p2: prod({ name: "ขนม" }) } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p2", "p1", "p2"] }, STAFF(["111"]));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.productCount, 2);
  assert.deepEqual(F.data.shop.shopA.scango.productIds, ["p2", "p1"]);
  assert.deepEqual(Object.keys(F.log[0].v), ["scango.productIds"]);
  assert.equal(F.data.shop.shopA.scango.enabled, false);
  const no = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1"] }, STAFF(["110"]));
  assert.equal(no.code, 403);
  assert.equal(no.body.error, "right_required");
});

test("productsSet: ไม่มี / ร้านอื่น / ลบแล้ว = 409 product_not_found พร้อมรายการ · ไม่เขียน", async () => {
  F.reset({ shop: { shopA: shopDoc(), shopB: { shopId: "shopB" } }, stock: { p1: prod(), pB: prod({ shopId: "shopB" }), pDel: prod({ deleted: true }) } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1", "pB", "pDel", "nope"] }, OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "product_not_found");
  assert.deepEqual(r.body.productIds, ["pB", "pDel", "nope"]);
  assert.equal(r.body.count, 3);
  assert.equal(F.log.length, 0);
});

test("productsSet: 1000 ตัวผ่าน · 1001 ตัว 409 too_many_products (นับหลังตัดซ้ำ) ก่อนอ่าน stock", async () => {
  const stock = {};
  for (let i = 0; i < 1001; i++) stock[`p${i}`] = prod();
  F.reset({ shop: { shopA: shopDoc() }, stock });
  const ids = Object.keys(stock);
  const k = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [...ids.slice(0, 1000), "p0"] }, OWNER);
  assert.equal(k.code, 200, JSON.stringify(k.body));
  assert.equal(F.data.shop.shopA.scango.productIds.length, 1000);
  const readsBefore = F.reads;
  const over = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ids }, OWNER);
  assert.equal(over.code, 409);
  assert.equal(over.body.error, "too_many_products");
  assert.equal(over.body.count, 1001);
  assert.equal(F.reads, readsBefore);
});

test("productsSet: ร้านเปิดรับใบอยู่ ส่งรายการว่าง = 409 scango_not_ready · ปิดอยู่ ส่งว่างได้", async () => {
  F.reset({ shop: { shopA: shopDoc({ enabled: true, productIds: ["p1"] }) }, stock: { p1: prod() } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [] }, OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "scango_not_ready");
  F.reset({ shop: { shopA: shopDoc({ enabled: false, productIds: ["p1"] }) } });
  const ok = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: [] }, OWNER);
  assert.equal(ok.code, 200);
  assert.deepEqual(F.data.shop.shopA.scango.productIds, []);
});

test("productsSet: ร้าน S5 (field shopId ≠ doc id ที่พิสูจน์แล้ว) สินค้าที่ถือ field ผ่าน", async () => {
  F.reset({ shop: { shopA: { ...shopDoc(), shopId: "legacy-A" } }, stock: { p1: prod({ shopId: "legacy-A" }), p2: prod() } });
  const r = await call(productsSet, { now: () => NOW }, { shopId: "shopA", productIds: ["p1", "p2"] }, OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
});

// ── productSearch ──────────────────────────────────────────────────────────────
test("productSearch: ค้นชื่อ/บาร์โค้ด/หมวด · ข้ามที่ลบ · ธง selected · ร้านอื่นไม่ปน", async () => {
  F.reset({
    shop: { shopA: shopDoc({ productIds: ["p2"] }) },
    stock: {
      p1: prod({ name: "น้ำดื่มสิงห์", barcode: "111" }), p2: prod({ name: "ขนมปัง", barcode: "222", category: ["c2"] }),
      p3: prod({ name: "น้ำส้ม", deleted: true }), p4: prod({ shopId: "shopB", name: "น้ำแร่" }), p5: prod({ name: 12, barcode: 333, price: "15" }),
    },
  });
  const all = await call(productSearch, {}, { shopId: "shopA" }, OWNER);
  assert.equal(all.code, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.items.map((i) => i.productId), ["p1", "p2", "p5"]);
  assert.equal(all.body.nextCursor, null);
  assert.equal(all.body.selectedCount, 1);
  assert.equal(all.body.items.find((i) => i.productId === "p2").selected, true);
  const p5 = all.body.items.find((i) => i.productId === "p5");
  assert.equal(p5.name, "12"); assert.equal(p5.barcode, "333"); assert.equal(p5.price, 15);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", q: "น้ำ" }, OWNER)).body.items.map((i) => i.productId), ["p1"]);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", q: "22" }, OWNER)).body.items.map((i) => i.productId), ["p2"]);
  assert.deepEqual((await call(productSearch, {}, { shopId: "shopA", categoryId: "c2" }, OWNER)).body.items.map((i) => i.productId), ["p2"]);
  const sel = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true }, OWNER);
  assert.deepEqual(sel.body.items.map((i) => i.productId), ["p2"]);
  assert.equal((await call(productSearch, {}, { shopId: "shopA" }, STAFF(["100"]))).code, 403);
  assert.equal((await call(productSearch, {}, { shopId: "shopA", cursor: "zzz" }, OWNER)).code, 400);
});

test("productSearch: หน้าละ 50 ต่อด้วย cursor จนครบไม่ซ้ำ · อ่านต่อคำขอไม่เกินเพดาน", async () => {
  const stock = {};
  for (let i = 0; i < 1200; i++) stock[`p${String(i).padStart(4, "0")}`] = prod({ name: i % 10 === 0 ? `หายาก ${i}` : `ทั่วไป ${i}` });
  F.reset({ shop: { shopA: shopDoc() }, stock });
  const seen = [];
  let cursor;
  let rounds = 0;
  do {
    const before = F.reads;
    const r = await call(productSearch, {}, { shopId: "shopA", ...(cursor ? { cursor } : {}) }, OWNER);
    assert.equal(r.code, 200);
    assert.ok(r.body.items.length <= PAGE_SIZE);
    assert.ok(F.reads - before <= SCAN_LIMIT + 3, `อ่าน ${F.reads - before}`);
    seen.push(...r.body.items.map((i) => i.productId));
    cursor = r.body.nextCursor;
    rounds++;
  } while (cursor && rounds < 100);
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200);
  // ค้นของหายาก: บางหน้าได้น้อยกว่า 50 แต่ cursor ยังไม่ null · รวมครบ 120
  const rare = [];
  cursor = undefined; rounds = 0;
  do {
    const r = await call(productSearch, {}, { shopId: "shopA", q: "หายาก", ...(cursor ? { cursor } : {}) }, OWNER);
    rare.push(...r.body.items.map((i) => i.productId));
    cursor = r.body.nextCursor; rounds++;
  } while (cursor && rounds < 100);
  assert.equal(rare.length, 120);
});

test("productSearch: selectedOnly แบ่งหน้าตามรายการที่เลือก", async () => {
  const stock = {}; const ids = [];
  for (let i = 0; i < 120; i++) { stock[`s${i}`] = prod(); ids.push(`s${i}`); }
  F.reset({ shop: { shopA: shopDoc({ productIds: ids }) }, stock });
  const a = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true }, OWNER);
  assert.equal(a.body.items.length, 50);
  assert.equal(a.body.nextCursor, "i|50");
  const c = await call(productSearch, {}, { shopId: "shopA", selectedOnly: true, cursor: "i|100" }, OWNER);
  assert.equal(c.body.items.length, 20);
  assert.equal(c.body.nextCursor, null);
});

// ── orderList ──────────────────────────────────────────────────────────────────
test("orderList: ของร้านนี้ ใหม่สุดก่อน · กรอง states · เวลาเป็น ISO · state ผิด 400", async () => {
  F.reset({
    shop: { shopA: shopDoc() },
    scangoOrder: {
      o1: { shopId: "shopA", state: "requested", createdAt: new Date("2026-11-11T01:00:00Z") },
      o2: { shopId: "shopA", state: "accepted", createdAt: new Date("2026-11-11T02:00:00Z") },
      o3: { shopId: "shopB", state: "requested", createdAt: new Date("2026-11-11T03:00:00Z") },
    },
  });
  const all = await call(orderList, {}, { shopId: "shopA" }, STAFF([]));
  assert.equal(all.code, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.orders.map((o) => o.orderRef), ["o2", "o1"]);
  assert.equal(all.body.orders[0].createdAt, "2026-11-11T02:00:00.000Z");
  const req = await call(orderList, {}, { shopId: "shopA", states: ["requested"] }, WATCHER);
  assert.deepEqual(req.body.orders.map((o) => o.orderRef), ["o1"]);
  assert.equal((await call(orderList, {}, { shopId: "shopA", states: ["cooking"] }, OWNER)).code, 400);
  assert.equal((await call(orderList, {}, { shopId: "shopA", states: [] }, OWNER)).code, 400);
});

// ── orderAction ────────────────────────────────────────────────────────────────
function actionsSpy(result) {
  const calls = [];
  const mk = (name) => async (_deps, arg) => { calls.push({ name, ...arg }); return typeof result === "function" ? result(name) : result; };
  return { calls, actions: { accept: mk("accept"), ready: mk("ready"), reject: mk("reject") } };
}

test("orderAction: ส่งต่อ _orderActions ด้วย order + actor + reason · ผลรวมในคำตอบ", async () => {
  F.reset({ shop: { shopA: shopDoc() }, scangoOrder: { o1: { shopId: "shopA", state: "requested" } } });
  const s = actionsSpy({ state: "accepted" });
  const r = await call(orderAction, { orderActions: s.actions }, { shopId: "shopA", orderRef: "o1", action: "accept" }, STAFF(["100"]));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "accepted");
  assert.equal(r.body.orderRef, "o1");
  assert.equal(s.calls[0].name, "accept");
  assert.equal(s.calls[0].order.orderRef, "o1");
  assert.equal(s.calls[0].order.state, "requested");
  assert.deepEqual(s.calls[0].actor, { uid: "u-staff", role: "staff" });
  const rj = await call(orderAction, { orderActions: s.actions }, { shopId: "shopA", orderRef: "o1", action: "reject", reason: "ของหมด" }, OWNER);
  assert.equal(rj.code, 200);
  assert.equal(s.calls[1].reason, "ของหมด");
});

test("orderAction: reject ไม่มีเหตุผล 400 · ไม่มีสิทธิ์ขาย 403 · ใบไม่มี 404 · ใบร้านอื่น 409 · watcher 403", async () => {
  F.reset({ shop: { shopA: shopDoc() }, scangoOrder: { o1: { shopId: "shopA", state: "requested" }, oB: { shopId: "shopB", state: "requested" } } });
  const s = actionsSpy({});
  const d = { orderActions: s.actions };
  assert.equal((await call(orderAction, d, { shopId: "shopA", orderRef: "o1", action: "reject" }, OWNER)).code, 400);
  assert.equal((await call(orderAction, d, { shopId: "shopA", orderRef: "o1", action: "reject", reason: "  " }, OWNER)).code, 400);
  assert.equal((await call(orderAction, d, { shopId: "shopA", orderRef: "o1", action: "cook" }, OWNER)).code, 400);
  assert.equal((await call(orderAction, d, { shopId: "shopA", orderRef: "o1", action: "accept" }, STAFF(["111"]))).code, 403);
  const nf = await call(orderAction, d, { shopId: "shopA", orderRef: "zz", action: "accept" }, OWNER);
  assert.equal(nf.code, 404); assert.equal(nf.body.error, "scango_order_not_found");
  const other = await call(orderAction, d, { shopId: "shopA", orderRef: "oB", action: "accept" }, OWNER);
  assert.equal(other.code, 409); assert.equal(other.body.error, "scango_order_other_shop");
  assert.equal((await call(orderAction, d, { shopId: "shopA", orderRef: "o1", action: "accept" }, WATCHER)).body.error, "watcher_read_only");
  assert.equal(s.calls.length, 0);
});

test("orderAction: _orderActions ปัด (คืน deny หรือ throw .deny) = ส่งต่อเป็น error · throw อื่น = 500", async () => {
  F.reset({ shop: { shopA: shopDoc() }, scangoOrder: { o1: { shopId: "shopA", state: "delivered" } } });
  const d1 = { orderActions: { accept: async () => ({ ok: false, status: 409, error: "scango_bad_state", extra: { state: "delivered" } }) } };
  const r1 = await call(orderAction, d1, { shopId: "shopA", orderRef: "o1", action: "accept" }, OWNER);
  assert.equal(r1.code, 409); assert.equal(r1.body.error, "scango_bad_state"); assert.equal(r1.body.state, "delivered");
  const e = new Error("x"); e.deny = { ok: false, status: 409, error: "scango_bad_state" };
  const r2 = await call(orderAction, { orderActions: { ready: async () => { throw e; } } }, { shopId: "shopA", orderRef: "o1", action: "ready" }, OWNER);
  assert.equal(r2.code, 409);
  const orig = console.error; console.error = () => {};
  const r3 = await call(orderAction, { orderActions: { ready: async () => { throw new Error("boom"); } } }, { shopId: "shopA", orderRef: "o1", action: "ready" }, OWNER);
  console.error = orig;
  assert.equal(r3.code, 500);
});

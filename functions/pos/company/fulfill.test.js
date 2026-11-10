// เทส _fulfill.js — ตัวเปิดของใบสั่งซื้อบริษัท 4 ชนิด (DEV-0003 U1)
//   รัน: node --test functions/pos/company/fulfill.test.js   (จากโฟลเดอร์ shopchamp_server)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด (แบบ company.test.js) + FieldValue ปลอมจาก _shared/fakeFieldValue
//   ⚠️ สูตรแพ็กเกจอยู่ที่ @shopchamp/logic (center packages/logic/src/company.js · DEV-0003 U1) · ถ้าตัวที่ติดตั้งใน node_modules ยังไม่มีฟังก์ชันนี้
//      (แม่ยังไม่ vendor รุ่นใหม่) เทสจะโหลด src ของ center แทนชั่วคราว ⇒ เทสนี้วัดโค้ดที่จะ deploy ก็ต่อเมื่อ node_modules ตรงกับ center
"use strict";
process.env.TZ = "Asia/Bangkok";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// ── Firestore ปลอม: doc get/set/update · where ==/in + limit + select · runTransaction (เขียนหลัง fn จบ) · batch ──
let DATA = {};
let WRITES = [];
const getColl = (c) => (DATA[c] = DATA[c] || {});
function ref(c, id) {
  const r = {
    id, path: `${c}/${id}`,
    get: async () => ({ exists: getColl(c)[id] !== undefined, id, data: () => getColl(c)[id] }),
    set: async (v) => { WRITES.push({ op: "set", path: r.path }); getColl(c)[id] = v; },
    update: async (v) => { WRITES.push({ op: "update", path: r.path }); getColl(c)[id] = { ...(getColl(c)[id] || {}), ...v }; },
  };
  return r;
}
let auto = 0;
function query(c, f, op, v) {
  const q = { lim: null };
  const match = (d) => d && (op === "==" ? d[f] === v : Array.isArray(v) && v.includes(d[f]));
  const run = async () => {
    let docs = Object.entries(getColl(c)).filter(([, d]) => match(d)).map(([id, d]) => ({ id, exists: true, data: () => d, get: (k) => d[k] }));
    if (q.lim != null) docs = docs.slice(0, q.lim);
    return { empty: !docs.length, size: docs.length, docs };
  };
  const api = { limit: (n) => { q.lim = n; return api; }, select: () => api, get: run };
  return api;
}
const fakeDb = {
  collection: (c) => ({ doc: (id) => ref(c, id === undefined ? `auto${++auto}` : id), where: (f, op, v) => query(c, f, op, v) }),
  runTransaction: async (fn) => {
    const queued = [];
    const tx = { get: (r) => r.get(), set: (r, v) => { queued.push(() => r.set(v)); return tx; }, update: (r, v) => { queued.push(() => r.update(v)); return tx; } };
    const out = await fn(tx);
    for (const q of queued) await q();
    return out;
  },
  batch: () => {
    const ops = [];
    const b = { set: (r, v) => { ops.push(() => r.set(v)); return b; }, commit: async () => { for (const o of ops) await o(); } };
    return b;
  },
};
const { FieldValue, isFv } = require("../_shared/fakeFieldValue");
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {}, FieldValue } };

// logic: ใช้ตัวที่ติดตั้ง ถ้ายังไม่มีสูตร U1 ให้ใช้ src ของ center แทน (บอกไว้ที่หัวไฟล์)
const logicAbs = require.resolve("@shopchamp/logic");
let LOGIC_SOURCE = "node_modules";
if (typeof require("@shopchamp/logic").companyVipRenewal !== "function") {
  const center = path.resolve(__dirname, "../../../../shopchamp-center/packages/logic/src/index.js");
  assert.ok(fs.existsSync(center), "ไม่พบ center packages/logic และ node_modules ยังไม่มี companyVipRenewal");
  require.cache[logicAbs] = { id: logicAbs, filename: logicAbs, loaded: true, exports: require(center) };
  LOGIC_SOURCE = "center/src";
}

const F = require("./_fulfill");
const { fulfill, Refusal } = F;

const NOW = new Date("2026-11-10T03:00:00.000Z"); // 10 พ.ย. 2026 10:00 ไทย
const DAY = 86400000;
const iso = (d) => (d instanceof Date ? d.toISOString() : d && typeof d.toDate === "function" ? d.toDate().toISOString() : String(d));
const ts = (isoStr) => { const ms = Date.parse(isoStr); return { toMillis: () => ms, toDate: () => new Date(ms) }; };
const ACTOR = { uid: "staff-1", name: "ทีมงาน ก" };
const PAID = (satang) => ({ provider: "posxpay", providerRef: "PX-001", paidSatang: satang });
const UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

async function refusal(p) {
  try { await fulfill(p); } catch (e) { if (e instanceof Refusal) return e.deny; throw e; }
  assert.fail("ควรปัด");
  return null;
}

// admin/package รูปเดียวกับฐาน (วัด 2026-11-07 + แถว gateway 2026-11-08: status:false newApp:true id 11/12)
const PACKAGE_DOC = () => ({
  value: [
    { name: "พรีเมี่ยม", type: "premium", status: true, price: [{ id: "1", price: 350, save: 0, day: "1 เดือน" }, { id: "2", price: 3500, save: 700, day: "12 เดือน" }] },
    { name: "พนักงาน", type: "staff", status: true, price: [{ id: "3", price: 199, save: 0, day: "1 เดือน" }, { id: "4", price: 1990, save: 398, day: "12 เดือน" }] },
    { name: "Payment Gateway", type: "gateway", status: false, newApp: true, price: [{ id: "11", price: 350, save: "0", day: "1 เดือน" }, { id: "12", price: 3500, save: "700", day: "12 เดือน" }] },
  ],
  admin: ["u-admin"],
});
const pkgOrder = (over) => ({ shopId: "A", shopName: "ร้าน", profileId: "buyer", profileName: "ก", timestamp: NOW, imageId: "slip", net: 350, status: "order", vat: false, email: "", tel: "0", packageId: ["1"], orderNumber: "202611000001", orderUUID: UUID, source: "pos", ...over });

function setup({ shop = {}, order, collection = "packageOrder", pkg = PACKAGE_DOC() } = {}) {
  DATA = { shop: { A: { shopId: "A", name: "ร้าน", vip: [], currentPackage: [], imageMore: 0, ...shop } }, admin: { package: pkg }, [collection]: { [UUID]: order } };
  WRITES = [];
}

// ── ① แพ็กเกจ (care ApproveSoftwareScreen.js:67-112) ──
test("package manual: vip ว่าง → เพิ่มแถว premium +30 วันจากวันนี้ · currentPackage += 1 (เลข) · IsVip lossVip · ใบ success + approveId/approveName/paidVia ไม่มี payment · push เท่า care", async () => {
  setup({ order: pkgOrder() });
  const r = await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([r.ok, r.duplicate, r.status, r.shopDocId, r.amountSatang, r.paidVia], [true, false, "success", "A", 35000, "manual"]);
  const shop = DATA.shop.A;
  assert.deepEqual(shop.vip.map((v) => [v.type, iso(v.expire)]), [["premium", iso(new Date(NOW.getTime() + 30 * DAY))]]);
  assert.deepEqual([shop.currentPackage, shop.IsVip, shop.lossVip], [[1], true, false]);
  const o = DATA.packageOrder[UUID];
  assert.deepEqual([o.status, o.approveId, o.approveName, o.paidVia, iso(o.fulfilledAt), "payment" in o], ["success", "staff-1", "ทีมงาน ก", "manual", iso(NOW), false]);
  assert.deepEqual(r.push, { to: { kind: "people", ids: ["buyer"] }, heading: "อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!", content: "กรุณากดอัปเดต ข้อมูล 1 ครั้งค่ะ" });
  assert.deepEqual(WRITES.map((w) => w.path), ["shop/A", `packageOrder/${UUID}`]);
});

test("package vip ยังไม่หมด (หมดวันนี้ 23:59 ไทย) = ต่อจากวันเดิม · vip หมดแล้ว (เมื่อวาน) = นับจากวันนี้ · แถวชนิดอื่นคงไว้", async () => {
  // ยังไม่หมด: expire 10 พ.ย. 23:59:59 ไทย = วันเดียวกับวันนี้ ⇒ +30 จากวันเดิม
  setup({ shop: { vip: [{ type: "premium", expire: ts("2026-11-10T16:59:59.000Z") }, { type: "staff", expire: ts("2027-01-01T00:00:00.000Z") }] }, order: pkgOrder() });
  await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual(DATA.shop.A.vip.map((v) => [v.type, iso(v.expire)]), [["premium", "2026-12-10T16:59:59.000Z"], ["staff", "2027-01-01T00:00:00.000Z"]]);
  // หมดแล้ว: expire 9 พ.ย. 23:59:59 ไทย ⇒ +30 จากตอนนี้
  setup({ shop: { vip: [{ type: "premium", expire: ts("2026-11-09T16:59:59.000Z") }] }, order: pkgOrder() });
  await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.equal(iso(DATA.shop.A.vip[0].expire), iso(new Date(NOW.getTime() + 30 * DAY)));
});

test("package auto gateway id 12 (รายปี 3,500 → 365 วัน) และ id 11 (30 วัน): เปิดได้แม้ status:false (care อนุมัติไม่ได้) · ใบมี payment", async () => {
  setup({ order: pkgOrder({ packageId: ["12"], net: 3500 }) });
  const r = await fulfill({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(350000), now: NOW });
  assert.deepEqual(DATA.shop.A.vip.map((v) => [v.type, iso(v.expire)]), [["gateway", iso(new Date(NOW.getTime() + 365 * DAY))]]);
  assert.deepEqual(DATA.shop.A.currentPackage, [12]);
  const o = DATA.packageOrder[UUID];
  assert.deepEqual([o.status, o.approveId, o.paidVia, o.payment], ["success", "system:posxpay", "auto", { provider: "posxpay", providerRef: "PX-001", paidSatang: 350000 }]);
  assert.deepEqual(r.effects.items.map((i) => [i.id, i.type, i.days]), [["12", "gateway", 365]]);
  // 11 ต่อจาก 12 ที่ยังไม่หมด ⇒ +30 ซ้อน
  setup({ shop: { vip: [{ type: "gateway", expire: new Date(NOW.getTime() + 365 * DAY) }] }, order: pkgOrder({ packageId: ["11"], net: 350 }) });
  await fulfill({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(35000), now: NOW });
  assert.equal(iso(DATA.shop.A.vip[0].expire), iso(new Date(NOW.getTime() + 395 * DAY)));
});

test("package: ซื้อ 2 ชนิดในใบ (รายปี premium + staff รวม VAT) · ยอด auto เทียบกับ net ที่รวม VAT แล้ว", async () => {
  setup({ order: pkgOrder({ packageId: ["2", "4"], vat: true, totalPrice: 5490, vatAmount: 384.3, net: 5874.3 }) });
  const r = await fulfill({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(587430), now: NOW });
  assert.deepEqual(DATA.shop.A.vip.map((v) => v.type), ["premium", "staff"]);
  assert.deepEqual([DATA.shop.A.currentPackage, r.amountSatang], [[2, 4], 587430]);
});

test("package: แพ็กเกจในใบไม่อยู่ในแคตตาล็อก = 409 package_unresolvable · ไม่มี admin/package = 503 · ร้านไม่มี = 404 · ไม่เขียนอะไร", async () => {
  setup({ order: pkgOrder({ packageId: ["99"] }) });
  let d = await refusal({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([d.status, d.error, d.extra.packageId, d.extra.reason], [409, "package_unresolvable", "99", "PACKAGE_NOT_FOUND"]);
  assert.deepEqual(WRITES, []);
  setup({ order: pkgOrder() }); delete DATA.admin.package;
  d = await refusal({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([d.status, d.error], [503, "package_config_unavailable"]);
  setup({ order: pkgOrder({ shopId: "Z" }) });
  d = await refusal({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([d.status, d.error, WRITES], [404, "shop_not_found", []]);
});

// ── ② ซ้ำ · ยอดไม่ตรง · ยกเลิก · ไม่มี · สถานะแปลก ──
test("ซ้ำ: เปิดแล้ว (success) = {duplicate:true} ไม่เขียนอะไร · เรียก 2 ครั้งติด = ครั้งที่ 2 duplicate · vip ไม่ต่อซ้ำ", async () => {
  setup({ order: pkgOrder({ status: "success" }) });
  const r = await fulfill({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(35000), now: NOW });
  assert.deepEqual([r, WRITES], [{ ok: true, duplicate: true, kind: "package", orderUUID: UUID, status: "success" }, []]);
  setup({ order: pkgOrder() });
  await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  const expire1 = iso(DATA.shop.A.vip[0].expire);
  WRITES = [];
  const again = await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: new Date(NOW.getTime() + DAY) });
  assert.deepEqual([again.duplicate, WRITES, iso(DATA.shop.A.vip[0].expire), DATA.shop.A.currentPackage], [true, [], expire1, [1]]);
});

test("auto ยอดไม่ตรง: paidSatang 34999 กับใบ 350 บาท = 409 amount_mismatch {expectedSatang, paidSatang} ไม่เขียนอะไร · ยอดใบอ่านไม่ได้ = 409 order_amount_invalid", async () => {
  setup({ order: pkgOrder() });
  const d = await refusal({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(34999), now: NOW });
  assert.deepEqual([d.status, d.error, d.extra.expectedSatang, d.extra.paidSatang], [409, "amount_mismatch", 35000, 34999]);
  assert.deepEqual(WRITES, []);
  assert.deepEqual([DATA.packageOrder[UUID].status, DATA.shop.A.vip], ["order", []]);
  // จ่ายเกินก็ไม่เปิด (ต้องเท่าเป๊ะ · ยอดเกิน = คนละใบ)
  const over = await refusal({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(35001), now: NOW });
  assert.equal(over.error, "amount_mismatch");
  // manual ไม่เทียบยอด (สลิป · ทีมงานดูเอง)
  const ok = await fulfill({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.equal(ok.duplicate, false);
  setup({ order: pkgOrder({ net: "สามร้อย" }) });
  const bad = await refusal({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(35000), now: NOW });
  assert.deepEqual([bad.status, bad.error, WRITES], [409, "order_amount_invalid", []]);
});

test("ใบยกเลิก = 409 order_cancelled · ใบไม่มี = 404 order_not_found · สถานะไม่รู้จัก = 409 order_status_unexpected · ไม่เขียนอะไร", async () => {
  setup({ order: pkgOrder({ status: "cancel" }) });
  let d = await refusal({ kind: "package", orderUUID: UUID, via: "auto", payment: PAID(35000), now: NOW });
  assert.deepEqual([d.status, d.error], [409, "order_cancelled"]);
  setup({ order: pkgOrder() }); delete DATA.packageOrder[UUID];
  d = await refusal({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([d.status, d.error], [404, "order_not_found"]);
  setup({ order: pkgOrder({ status: "paid" }) }); // 'paid' เป็นของใบชุดสินค้า ไม่ใช่แพ็กเกจ
  d = await refusal({ kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([d.status, d.error, d.extra.status, WRITES], [409, "order_status_unexpected", "paid", []]);
});

test("รูปคำขอ: manual ไม่มี actor · auto ไม่มี payment · provider อื่น · kind/via แปลก · now ไม่ใช่ Date = 400 ก่อนแตะฐาน", async () => {
  setup({ order: pkgOrder() });
  for (const p of [
    { kind: "package", orderUUID: UUID, via: "manual", now: NOW },
    { kind: "package", orderUUID: UUID, via: "auto", now: NOW },
    { kind: "package", orderUUID: UUID, via: "auto", payment: { provider: "other", providerRef: "x", paidSatang: 35000 }, now: NOW },
    { kind: "package", orderUUID: UUID, via: "auto", payment: { provider: "posxpay", providerRef: "x", paidSatang: 350.5 }, now: NOW },
    { kind: "voucher", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW },
    { kind: "package", orderUUID: UUID, via: "webhook", actor: ACTOR, now: NOW },
    { kind: "package", orderUUID: "a/b", via: "manual", actor: ACTOR, now: NOW },
    { kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, now: "2026-11-10" },
    { kind: "package", orderUUID: UUID, via: "manual", actor: ACTOR, payment: PAID(35000), now: NOW },
  ]) {
    const d = await refusal(p);
    assert.deepEqual([d.status, d.error], [400, "invalid_request"], JSON.stringify(p));
  }
  assert.deepEqual(WRITES, []);
});

// ── ③ อุปกรณ์ (care ApproveHardwareScreen.js:41-49 · ห้ามไป sending/success) ──
const hwOrder = (over) => ({ address: "ที่อยู่", shopId: "A", shopName: "ร้าน", profileId: "buyer", profileName: "ก", timestamp: NOW, imageId: "slip", net: 1712, status: "order", tel: "0", product: [{ id: "h1", qty: 1 }], deliveryFee: 100, vat: true, vatDetail: "x", vatAmount: 112, totalPrice: 1500, nameSername: "ก ข", orderNumber: "202611000002", orderUUID: UUID, ...over });

test("hardware auto: ใบ → checked (จ่ายแล้ว) + trail + payment · ไม่แตะร้าน · ไม่ไป sending/success · push เท่า care · checked/sending/success แล้ว = duplicate", async () => {
  setup({ collection: "hardwareOrder", order: hwOrder() });
  const r = await fulfill({ kind: "hardware", orderUUID: UUID, via: "auto", actor: { uid: "cron", name: "" }, payment: PAID(171200), now: NOW });
  const o = DATA.hardwareOrder[UUID];
  assert.deepEqual([r.status, o.status, o.approveId, o.approveName, o.paidVia, o.payment.providerRef, "tracking" in o], ["checked", "checked", "cron", "", "auto", "PX-001", false]);
  assert.deepEqual(WRITES.map((w) => w.path), [`hardwareOrder/${UUID}`]);
  assert.deepEqual(r.push, { to: { kind: "people", ids: ["buyer"] }, heading: "ยืนยันการชำระเงินเสร็จสิ้น!", content: "กำลังจัดเตรียมสินค้า" });
  for (const status of ["checked", "sending", "success"]) {
    setup({ collection: "hardwareOrder", order: hwOrder({ status }) });
    const d = await fulfill({ kind: "hardware", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
    assert.deepEqual([d.duplicate, d.status, WRITES], [true, status, []]);
  }
});

// ── ④ พื้นที่รูป (care ApproveImageScreen.js:43-59) ──
const imgOrder = (over) => ({ shopId: "FIELD-A", shopName: "ร้าน", profileId: "buyer", profileName: "ก", timestamp: NOW, imageId: "slip", net: 200, qty: 2000, status: "order", orderNumber: "202611000003", orderUUID: UUID, ...over });

test("image: หาร้านด้วย field shopId (doc id ต่างกัน) · imageMore 100 → 2100 · ใบ success · push มีจำนวนรูป · imageMore ไม่ใช่เลข = เริ่ม 0", async () => {
  DATA = { shop: { DOC1: { shopId: "FIELD-A", name: "ร้าน", imageMore: 100 } }, imageOrder: { [UUID]: imgOrder() } }; WRITES = [];
  const r = await fulfill({ kind: "image", orderUUID: UUID, via: "auto", payment: PAID(20000), now: NOW });
  assert.deepEqual([r.status, r.shopDocId, r.effects, DATA.shop.DOC1.imageMore, DATA.imageOrder[UUID].status, DATA.imageOrder[UUID].approveId], ["success", "DOC1", { imageMore: 2100, added: 2000 }, 2100, "success", "system:posxpay"]);
  assert.deepEqual(r.push, { to: { kind: "people", ids: ["buyer"] }, heading: "เพิ่มพื้นที่เก็บไฟล์ 2000 รูปภาพเรียบร้อย", content: "กรุณากดอัปเดตข้อมูล 1 ครั้งค่ะ" });
  DATA = { shop: { A: { shopId: "A", imageMore: "100" } }, imageOrder: { [UUID]: imgOrder({ shopId: "A" }) } }; WRITES = [];
  await fulfill({ kind: "image", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.equal(DATA.shop.A.imageMore, 2000);
  // ไม่พบร้านทั้ง 2 ทาง = 404 (care จะ push ว่าเรียบร้อยทั้งที่ไม่ได้เพิ่ม) · qty เสีย = 409
  DATA = { shop: {}, imageOrder: { [UUID]: imgOrder() } }; WRITES = [];
  assert.equal((await refusal({ kind: "image", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW })).error, "shop_not_found");
  DATA = { shop: { A: { shopId: "A" } }, imageOrder: { [UUID]: imgOrder({ shopId: "A", qty: "มาก" }) } }; WRITES = [];
  assert.equal((await refusal({ kind: "image", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW })).error, "order_qty_invalid");
  assert.deepEqual(WRITES, []);
});

// ── ⑤ ชุดสินค้า (care ApproveStockScreen.js:45-73 + server เดิม sharedData.js:701-807) ──
const stOrder = (over) => ({ status: "order", imageId: "slip", shopId: "A", shopName: "ร้าน", profileId: "buyer", profileName: "ก", timestamp: NOW, orderNumber: "202611000004", id: 3, price: 150, qty: 1500, orderUUID: UUID, ...over });
const SECTIONS = () => ({
  s1500: { type: "1500", products: [{ barcode: "B1", category: ["AX001"], cost: "10", imageId: "i1", name: "น้ำ", price: "15", unit: "ขวด" }, { barcode: "B2", category: ["AX002"], cost: 5, imageId: "", name: "มาม่า", price: 7, unit: "ซอง" }] },
  s1501: { type: "1501", products: [{ barcode: "B3", category: ["AX006"], cost: "3", imageId: "", name: "ลูกอม", price: "5", unit: "เม็ด" }] },
  s4000: { type: "4000", products: [{ barcode: "B9", category: [], cost: "1", imageId: "", name: "ไม่ใช่ชุดนี้", price: "1", unit: "ชิ้น" }] },
});

test("stock auto: ใบ paid + stockImport done · คัดสินค้าชุด 3 (type 1500+1501) ลง stock ของร้าน ข้ามบาร์โค้ดที่มีแล้ว · รูป initialProduct เดิม · updateTime serverTimestamp · smartCategory รวม 17 หมวด · push ถึงร้าน", async () => {
  DATA = {
    shop: { A: { shopId: "A", name: "ร้าน", smartCategory: [{ level: 1, value: [{ aboveId: [], level: 1, id: "AX001", name: "เครื่องดื่ม" }, { aboveId: [], level: 1, id: "MY1", name: "ของฉัน" }] }, { level: 2, value: [] }] } },
    stock: { old1: { shopId: "A", barcode: "B2", name: "มาม่าเดิม" }, other: { shopId: "B", barcode: "B1", name: "ของร้านอื่น" } },
    masterSectionStock: SECTIONS(),
    stockOrder: { [UUID]: stOrder() },
  }; WRITES = [];
  const r = await fulfill({ kind: "stock", orderUUID: UUID, via: "auto", payment: PAID(15000), now: NOW });
  const o = DATA.stockOrder[UUID];
  assert.deepEqual([r.status, r.amountSatang, o.status, o.approveId, o.paidVia, o.payment.paidSatang], ["paid", 15000, "paid", "system:posxpay", "auto", 15000]);
  assert.deepEqual([o.stockImport.status, o.stockImport.imported, o.stockImport.skipped, o.stockImport.packId], ["done", 2, 1, 3]);
  assert.deepEqual(r.effects.stockImport, { status: "done", imported: 2, skipped: 1 });
  const added = Object.values(DATA.stock).filter((s) => s.shopId === "A" && s.barcode !== "B2");
  assert.deepEqual(added.map((s) => [s.barcode, s.name, s.cost, s.price, s.unit, s.stock, s.cashierShow, s.sku, s.barcodeStatus, s.pointStatus, isFv(s.updateTime)]).sort(), [
    ["B1", "น้ำ", 10, 15, "ขวด", 0, false, "", true, true, true],
    ["B3", "ลูกอม", 3, 5, "เม็ด", 0, false, "", true, true, true],
  ]);
  assert.equal(Object.values(DATA.stock).some((s) => s.barcode === "B9"), false, "type 4000 ไม่ใช่ชุด 3");
  const lvl1 = DATA.shop.A.smartCategory.find((c) => c.level === 1).value;
  assert.deepEqual([lvl1.length, lvl1[0].id, lvl1[1].id, lvl1[2].id, lvl1[lvl1.length - 1].id, DATA.shop.A.smartCategory.length], [18, "AX001", "MY1", "AX002", "AX017", 2]);
  assert.deepEqual(r.push, { to: { kind: "shop", shopId: "A" }, heading: "อัปเดตรายการสินค้า", content: "เพิ่มสินค้า 2 รายการเสร็จสิ้นแล้วค่ะ" });
  // ลำดับการเขียน: ใบ paid ก่อน (จองใบ) แล้วค่อย shop/stock
  assert.equal(WRITES[0].path, `stockOrder/${UUID}`);
  // เรียกซ้ำ = duplicate ไม่ import ซ้ำ
  WRITES = [];
  const again = await fulfill({ kind: "stock", orderUUID: UUID, via: "auto", payment: PAID(15000), now: NOW });
  assert.deepEqual([again.duplicate, WRITES], [true, []]);
});

test("stock: ชุดไม่รู้จัก = ใบ paid (เงินเข้าแล้ว) แต่ stockImport failed 'pack_unknown' ไม่แอบให้ชุดฟรี · ไม่ throw · ไม่มี push · ร้านไม่มี smartCategory = สร้างใหม่ 17 หมวด", async () => {
  DATA = { shop: { A: { shopId: "A" } }, masterSectionStock: SECTIONS(), stockOrder: { [UUID]: stOrder({ id: 42, price: 150 }) } }; WRITES = [];
  const r = await fulfill({ kind: "stock", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  const o = DATA.stockOrder[UUID];
  assert.deepEqual([o.status, o.stockImport.status, o.stockImport.error, r.effects.stockImport.status, r.push, DATA.stock], ["paid", "failed", "pack_unknown", "failed", null, undefined]);
  DATA = { shop: { A: { shopId: "A" } }, masterSectionStock: SECTIONS(), stockOrder: { [UUID]: stOrder({ id: 6, price: 400 }) } }; WRITES = [];
  await fulfill({ kind: "stock", orderUUID: UUID, via: "manual", actor: ACTOR, now: NOW });
  assert.deepEqual([DATA.shop.A.smartCategory.length, DATA.shop.A.smartCategory[0].value.length, Object.keys(DATA.stock).length], [1, 17, 1]);
});

test("stock: ยอด auto เทียบกับ price (ใบชุดสินค้าไม่มี net) · ไม่ตรง = 409 ไม่จองใบ ไม่ import", async () => {
  DATA = { shop: { A: { shopId: "A" } }, masterSectionStock: SECTIONS(), stockOrder: { [UUID]: stOrder() } }; WRITES = [];
  const d = await refusal({ kind: "stock", orderUUID: UUID, via: "auto", payment: PAID(10000), now: NOW });
  assert.deepEqual([d.error, d.extra.expectedSatang, DATA.stockOrder[UUID].status, WRITES, DATA.stock], ["amount_mismatch", 15000, "order", [], undefined]);
});

test(`ที่มาของสูตร logic ในเทสนี้: ${LOGIC_SOURCE}`, () => {
  assert.ok(["node_modules", "center/src"].includes(LOGIC_SOURCE));
});

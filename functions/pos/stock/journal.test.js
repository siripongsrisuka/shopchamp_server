// เทส DEV-0007 ข้อ ② · สมุด stockJournal · รัน: node --test pos/stock/journal.test.js
//   ฐานปลอม stockTestKit: commit แล้วค่าเปลี่ยนจริง · increment บวกจริง · set merge รวมลึก (fakeFieldValue)
//   พิสูจน์: ① ยอดในสมุด = ยอดที่เปลี่ยนจริงของ stock ทุก doc (ต้นวัน + Σqty = ปลายวัน)
//            ② ส่งซ้ำ / ยิงซ้ำ / ถูกปัด ไม่ลงสมุด ③ วันธุรกิจตาม cutOff ④ รูป doc ผ่าน schema StockJournal ⑤ เพดาน 1 MiB
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./stockTestKit");
const J = require("../_shared/stockJournal");
const { StockJournal, StockJournalDocId } = require("@shopchamp/schema");

const U = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const U2 = "1c6b7a2e-4f3d-4c1b-8a9e-2d3c4b5a6f70";
const RID = "3c9e1f20-1111-4000-8000-0000000000aa";
const ST = { staffId: "u-owner", staffName: "เจ้าของ" };
const DET = [{ id: "pc", linkMultiply: 12, unit: "ลัง" }, { id: "pp", linkMultiply: 1, unit: "ขวด" }];
const base = (shopX) => ({
  shop: {
    shopA: {
      shopId: "shopA", name: "ร้านเอ",
      vip: [{ type: "premium", expire: { __date__: "2027-01-01T00:00:00Z" } }],
      humanResource: [{ id: "u-owner", position: ["001"], status: "active", name: "เจ้าของ" }, { id: "u-company", position: ["001"], status: "active", name: "ทีมงาน" }],
      ...(shopX || {}),
    },
  },
  supplier: { s1: { shopId: "shopA", vender_Name: "คู่ค้า", sale_Name: "", tel: "", lineId: "", detail: "" } },
  stock: {
    p1: { shopId: "shopA", name: "น้ำ", unit: "ขวด", stock: 10, cost: 5, price: 10, stockCountStatus: true, barcode: "111" },
    p2: { shopId: "shopA", name: "ขนม", unit: "ห่อ", stock: "7", cost: 0, price: 20, stockCountStatus: true, barcode: "222" },
    pc: { shopId: "shopA", name: "ลัง", unit: "ลัง", stock: 24, cost: 120, linkId: "L1", linkMultiply: 12, stockCountStatus: true, linkDetail: DET },
    pp: { shopId: "shopA", name: "ขวด", unit: "ขวด", stock: 24, cost: 10, linkId: "L1", linkMultiply: 1, stockCountStatus: true, linkDetail: DET },
  },
  stockLink: { L1: { shopId: "shopA", stockGroupName: "น้ำ", stockLink: [{ id: "pc", linkMultiply: 12 }, { id: "pp", linkMultiply: 1 }], upgrade: false } },
});
const run = (file, fn, body, req, now) => K.call(K.loadHandler(file, fn), body, req || K.OWNER, now);
const quiet = async (f) => { const w = console.warn; console.warn = () => {}; try { return await f(); } finally { console.warn = w; } };
let seq = 0;
const saleBody = (lines, x) => ({
  shopId: "shopA", receiptUUID: `shopA6f1c2d3e-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  product: lines.map(([id, qty]) => ({ id, qty, name: id, net: qty * 10, totalPrice: qty * 10, totalCost: qty * 5 })),
  payment: [{ id: 1, amount: lines.reduce((s, [, q]) => s + q * 10, 0), name: "เงินสด" }],
  moneyMustPaid: lines.reduce((s, [, q]) => s + q * 10, 0), ...x,
});
const sell = (lines, x, now) => quiet(() => run("../sale/create.js", "create", saleBody(lines, x), undefined, now));
const journal = () => K.data().stockJournal || {};
/** Σqty ต่อ id (เลือกชนิดได้) ทุก doc ของวันนั้น */
function sumOf(day, kinds) {
  const out = {};
  for (const d of Object.values(journal())) {
    if (d.day !== day || (kinds && !kinds.includes(d.kind))) continue;
    for (const [id, q] of Object.entries(d.qty)) out[id] = Math.round(((out[id] || 0) + q) * 1e4) / 1e4;
  }
  return out;
}
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
function assertReconciles(start, day) {
  const s = sumOf(day);
  for (const [id, d] of Object.entries(K.data().stock)) {
    const before = start[id] === undefined ? 0 : num(start[id].stock);
    assert.equal(Math.round((before + (s[id] || 0)) * 1e4) / 1e4, num(d.stock), `${id}: ต้นวัน ${before} + สมุด ${s[id] || 0} ต้อง = ปลายวัน ${d.stock}`);
  }
}

test("ใบงาน check ②: ขาย 3 บิล ยกเลิก 1 บิล รับเข้า 1 ใบ → สมุดของวันนั้นตรงยอดที่เปลี่ยนจริงทุกสินค้า", async () => {
  K.reset(base());
  const start = JSON.parse(JSON.stringify(K.data().stock));
  const b1 = await sell([["p1", 2], ["pc", 1]]);
  const b2 = await sell([["p1", 1], ["p2", 3]]);
  const b3 = await sell([["pp", 5]]);
  for (const b of [b1, b2, b3]) assert.equal(b.code, 200, JSON.stringify(b.body));
  const v = await quiet(() => run("../sale/void.js", "void", { shopId: "shopA", billId: b2.body.billId, requestId: RID, reason: "x", ...ST }));
  assert.equal(v.code, 200, JSON.stringify(v.body));
  const r = await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 10, cost: 7 }], ...ST });
  assert.equal(r.code, 200, JSON.stringify(r.body));

  const day = "20261110";
  assertReconciles(start, day);
  // แยกชนิด: ขาย p1 −3 · ยกเลิกบิล 2 คืน p1 +1 p2 +3 · รับ p1 +10 · กลุ่มผูก pc/pp ขยับเท่ากันทั้งกลุ่ม (ยอดหน่วยเล็กสุด)
  assert.deepEqual(sumOf(day, ["sale"]), { p1: -3, p2: -3, pc: -17, pp: -17 });
  assert.deepEqual(sumOf(day, ["void"]), { p1: 1, p2: 3 });
  assert.deepEqual(sumOf(day, ["receive"]), { p1: 10 });
  const sale = journal()[`shopA_${day}_sale_0`];
  assert.equal(sale.events, 3, "3 บิล = 3 ครั้ง");
  assert.equal(journal()[`shopA_${day}_void_0`].events, 1);
});

test("ส่งซ้ำ / ยิงซ้ำ ไม่ลงสมุดซ้ำ: receiptUUID · void requestId · receiveUUID · requisitionUUID · productUUID · adjust · productDelete", async () => {
  K.reset(base());
  const start = JSON.parse(JSON.stringify(K.data().stock));
  const body = saleBody([["p1", 2]]);
  const a = await quiet(() => run("../sale/create.js", "create", body));
  const a2 = await quiet(() => run("../sale/create.js", "create", body));
  assert.equal(a2.body.duplicate, true);
  const vb = { shopId: "shopA", billId: a.body.billId, requestId: RID, reason: "x", ...ST };
  await quiet(() => run("../sale/void.js", "void", vb));
  const v2 = await quiet(() => run("../sale/void.js", "void", vb));
  assert.equal(v2.body.alreadyVoid, true);
  const rb = { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p2", qty: 4, cost: 1 }], ...ST };
  await run("receive.js", "receive", rb);
  assert.equal((await run("receive.js", "receive", rb)).body.duplicate, true);
  const qb = { shopId: "shopA", requisitionUUID: U, reason: "", lines: [{ id: "p1", qty: 1 }], ...ST };
  await run("requisition.js", "requisition", qb);
  assert.equal((await run("requisition.js", "requisition", qb)).body.duplicate, true);
  const cb = { op: "create", shopId: "shopA", productUUID: U2, product: { name: "ใหม่", price: 1 }, stock: 6, cost: 0, ...ST };
  await run("productSave.js", "productSave", cb);
  assert.equal((await run("productSave.js", "productSave", cb)).body.duplicate, true);
  const ab = { op: "stock", shopId: "shopA", productId: "p1", newStock: 20, seenStock: 9, ...ST };
  assert.equal((await run("adjust.js", "adjust", ab)).code, 200);
  assert.equal((await run("adjust.js", "adjust", ab)).body.unchanged, true);
  const db = { shopId: "shopA", productId: "p2", ...ST };
  await run("productDelete.js", "productDelete", db);
  assert.equal((await run("productDelete.js", "productDelete", db)).body.alreadyDeleted, true);

  const day = "20261110";
  assert.deepEqual(sumOf(day, ["sale"]), { p1: -2 });
  assert.deepEqual(sumOf(day, ["void"]), { p1: 2 });
  assert.deepEqual(sumOf(day, ["receive"]), { p2: 4 });
  assert.deepEqual(sumOf(day, ["requisition"]), { p1: -1 });
  assert.deepEqual(sumOf(day, ["create"]), { [U2]: 6 });
  assert.deepEqual(sumOf(day, ["adjust"]), { p1: 11 });
  assert.deepEqual(sumOf(day, ["delete"]), { p2: -11 }, "ลบ = ยอดคงเหลือออกจากคลัง (7 ตัวหนังสือ + รับ 4)");
  for (const d of Object.values(journal())) assert.equal(d.events, 1, `${d.kind} ลงครั้งเดียว`);
  // ลบแล้ว ช่อง stock ไม่เปลี่ยน ⇒ ต้นวัน + สมุด ≠ ปลายวัน เฉพาะตัวที่ลบ (ยอดออกจากคลัง) · ตัวอื่นตรงทุกตัว
  const s = sumOf(day);
  for (const id of ["p1", "pc", "pp", U2]) assert.equal((start[id] ? num(start[id].stock) : 0) + (s[id] || 0), num(K.data().stock[id].stock), id);
});

test("ถูกปัดกลาง tx (409 stock_changed) → ไม่ลงสมุด ไม่แตะ stock", async () => {
  K.reset(base());
  const r = await run("adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "p1", newStock: 3, seenStock: 9, ...ST });
  assert.equal(r.code, 409);
  assert.deepEqual(journal(), {});
});

test("ราคา/ต้นทุน/วันหมดอายุ ไม่ใช่การเคลื่อนไหวยอด → ไม่ลงสมุด (แต่ updateTime ขยับ)", async () => {
  K.reset(base());
  await run("adjust.js", "adjust", { op: "price", shopId: "shopA", productId: "p1", newPrice: 11, ...ST });
  await run("adjust.js", "adjust", { op: "cost", shopId: "shopA", productId: "p1", newCost: 6, ...ST });
  await run("productSave.js", "productSave", { op: "update", shopId: "shopA", productId: "p1", product: { name: "น้ำใหม่" }, ...ST });
  assert.deepEqual(journal(), {});
  assert.ok(K.data().stock.p1.updateTime instanceof Date);
});

test("กลุ่มผูก: สร้าง/เลิกผูก ลงชนิด link · ต้นวัน + สมุด = ปลายวัน", async () => {
  K.reset(base());
  const start = JSON.parse(JSON.stringify(K.data().stock));
  assert.equal((await run("link.js", "linkDelete", { shopId: "shopA", linkId: "L1" })).code, 200);
  assert.equal((await run("link.js", "linkCreate", { shopId: "shopA", linkUUID: U, stockGroupName: "ก", upgrade: false, members: [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }] })).code, 200);
  assertReconciles(start, "20261110");
  assert.ok(Object.keys(sumOf("20261110", ["link"])).length > 0);
});

test("วันธุรกิจตาม shop.cutOff (05:00 ไทย): ก่อนตัดรอบ = เมื่อวาน · หลังตัดรอบ = วันนี้", async () => {
  K.reset(base({ cutOff: { __date__: "2011-01-01T05:00:00+07:00" } }));
  await sell([["p1", 1]], undefined, "2026-11-10T21:30:00.000Z"); // 11 พ.ย. 04:30 ไทย
  await sell([["p1", 1]], undefined, "2026-11-10T22:30:00.000Z"); // 11 พ.ย. 05:30 ไทย
  assert.deepEqual(sumOf("20261110"), { p1: -1 });
  assert.deepEqual(sumOf("20261111"), { p1: -1 });
  assert.equal(J.journalDayOf(new Date("2026-11-10T21:30:00.000Z"), undefined), "20261111", "ไม่มี cutOff = เที่ยงคืนไทย");
});

test("ทีมงานทำ → สมุดมี byAdmin adminUid adminEvents", async () => {
  K.reset(base());
  await quiet(() => run("../sale/create.js", "create", saleBody([["p1", 1]]), K.ADMIN));
  const d = journal().shopA_20261110_sale_0;
  assert.equal(d.byAdmin, true);
  assert.equal(d.adminUid, "u-admin");
  assert.equal(d.adminEvents, 1);
});

test("รูป doc ที่เขียนจริงผ่าน schema StockJournal + doc id · part เสถียร", async () => {
  K.reset(base());
  await sell([["p1", 1], ["pc", 1]]);
  await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 1, cost: 5 }, { id: "p2", qty: 1, cost: 1 }, { id: "pc", qty: 1, cost: 120 }], ...ST });
  await quiet(() => run("../sale/create.js", "create", saleBody([["p1", 1]]), K.ADMIN));
  const docs = Object.entries(journal());
  assert.ok(docs.length >= 2);
  for (const [id, d] of docs) {
    const p = StockJournal.safeParse(d);
    assert.equal(p.success, true, `${id} ${JSON.stringify(p.error && p.error.issues)}`);
    assert.equal(StockJournalDocId.safeParse(id).success, true, id);
    assert.equal(id, J.journalDocId("shopA", d.day, d.kind, d.part));
    for (const pid of Object.keys(d.qty)) assert.equal(J.partOf(d.kind, pid), d.part, `${pid} ลง part ตาม hash`);
  }
  assert.equal(J.partOf("sale", "anything"), 0);
  assert.equal(J.partOf("receive", "p1"), J.partOf("receive", "p1"));
});

// ── เพดาน 1 MiB (สูตรขนาด doc ของ Firestore: ชื่อ field = ไบต์ UTF-8 + 1 · ตัวเลข 8 · ชื่อ doc = path + 16 · doc +32) ──
function docBytes(docId, qtyIds) {
  const name = `stockJournal/${docId}`.length + 1 + 16;
  let fields = 0;
  fields += "shopId".length + 1 + 21 + 1; // shop doc id 20 ตัว
  fields += "day".length + 1 + 9;
  fields += "kind".length + 1 + 12;
  fields += "part".length + 1 + 8;
  fields += "events".length + 1 + 8;
  fields += "updateTime".length + 1 + 8;
  fields += "qty".length + 1 + qtyIds.reduce((s, id) => s + Buffer.byteLength(id) + 1 + 8, 0);
  return name + fields + 32;
}
const LIMIT = 1048576;
const uuidLike = (i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`; // 36 ตัว (productUUID ของแอปใหม่ · ยาวสุดที่ใช้อยู่)

test("ขนาด: ร้าน p90 5,119 สินค้า ทุกตัวเคลื่อนไหวในชนิดเดียว 1 วัน (id 36 ตัว) < 1 MiB ต่อ doc", () => {
  const ids = Array.from({ length: 5119 }, (_, i) => uuidLike(i));
  const bytes = docBytes("wJNgra1ik0pzRQFlZNOD_20261110_sale_0", ids);
  assert.ok(bytes < LIMIT * 0.25, `${bytes} ไบต์`);
});

test("ขนาด: เพดานร้าน 50,000 สินค้า ชนิดที่แบ่ง 4 part ทุก part < 1 MiB · ถ้าไม่แบ่งจะเกิน (เหตุที่ต้องแบ่ง)", () => {
  const ids = Array.from({ length: 50000 }, (_, i) => uuidLike(i));
  const byPart = [[], [], [], []];
  for (const id of ids) byPart[J.partOf("adjust", id)].push(id);
  for (let p = 0; p < 4; p++) assert.ok(docBytes(`shopA_20261110_adjust_${p}`, byPart[p]) < LIMIT, `part ${p}: ${byPart[p].length} ตัว`);
  assert.ok(docBytes("shopA_20261110_adjust_0", ids) > LIMIT, "doc เดียวเกินเพดาน");
  assert.equal(J.PARTS.adjust, 4);
  assert.equal(J.PARTS.receive, 4);
  assert.equal(J.PARTS.create, 4);
});

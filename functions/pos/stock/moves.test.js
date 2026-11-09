// เทส DEV-0008 · รายการเคลื่อนไหวทีละครั้ง stockMove (premium) · รัน: node --test pos/stock/moves.test.js
//   ฐานปลอม stockTestKit (commit จริง) · พิสูจน์: ① ทุกครั้งที่ยอดเปลี่ยนมีรายการ ค่าก่อน/หลังต่อกันถูก หลังสุด = ยอดคงเหลือจริง
//   ② ร้านไม่ premium ไม่มีรายการเลย (สมุดรายวันยังลง) ③ ส่งซ้ำไม่ลงซ้ำ ④ รูป doc ผ่าน schema StockMove + TTL 90 วัน ⑤ ผู้ทำ/อ้างอิง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./stockTestKit");
const J = require("../_shared/stockJournal");
const { StockMove, StockMoveDocId } = require("@shopchamp/schema");

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
const moves = () => Object.entries(K.data().stockMove || {}).map(([id, d]) => ({ id, ...d }));
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const byTime = (x, y) => Number(x.id.split("_").pop()) - Number(y.id.split("_").pop());
const T = (m) => `2026-11-10T03:${String(m).padStart(2, "0")}:00.000Z`;

test("check ①: ขาย 2 บิล ยกเลิก 1 รับเข้า 1 ปรับ 1 → ทุกครั้งมีรายการ · ก่อน/หลังต่อกัน · หลังสุด = ยอดจริง", async () => {
  K.reset(base());
  const start = JSON.parse(JSON.stringify(K.data().stock));
  const b1 = await sell([["p1", 2]], {}, T(1));
  const b2 = await sell([["p1", 1], ["p2", 3]], {}, T(2));
  assert.equal(b1.code, 200, JSON.stringify(b1.body));
  assert.equal(b2.code, 200, JSON.stringify(b2.body));
  const v = await quiet(() => run("../sale/void.js", "void", { shopId: "shopA", billId: b2.body.billId, requestId: RID, reason: "ลูกค้าเปลี่ยนใจ", ...ST }, undefined, T(3)));
  assert.equal(v.code, 200, JSON.stringify(v.body));
  const r = await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 10, cost: 7 }], ...ST }, undefined, T(4));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const a = await quiet(() => run("adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "p1", newStock: 15, seenStock: 18, ...ST }, undefined, T(5)));
  assert.equal(a.code, 200, JSON.stringify(a.body));

  const p1 = moves().filter((m) => m.stockId === "p1").sort(byTime);
  assert.deepEqual(p1.map((m) => [m.kind, m.delta, m.before, m.after]), [
    ["sale", -2, 10, 8], ["sale", -1, 8, 7], ["void", 1, 7, 8], ["receive", 10, 8, 18], ["adjust", -3, 18, 15],
  ]);
  for (const [id, d] of Object.entries(K.data().stock)) {
    const list = moves().filter((m) => m.stockId === id).sort(byTime);
    let cur = num(start[id].stock);
    for (const m of list) { assert.equal(m.before, cur, `${id} ${m.id} ก่อน`); cur = m.after; }
    assert.equal(cur, num(d.stock), `${id}: หลังสุดต้อง = ยอดจริง`);
  }
  const sale1 = p1[0];
  assert.equal(sale1.refId, b1.body.billId);
  assert.equal(sale1.refNo, b1.body.receiptNumber);
  assert.equal(p1[2].note, "ลูกค้าเปลี่ยนใจ");
  assert.equal(p1[2].byName, "เจ้าของ");
  assert.equal(p1[3].refId, U);
  assert.equal(p1[4].refId, "");
});

test("check ②: ร้านไม่ premium (หมดอายุ / ไม่มีแพ็กเกจ) → ไม่มีรายการทีละครั้ง · สมุดรายวันยังลง", async () => {
  for (const vip of [[{ type: "premium", expire: { __date__: "2026-11-01T00:00:00Z" } }], []]) {
    K.reset(base({ vip }));
    const b = await sell([["p1", 2]]);
    assert.equal(b.code, 200, JSON.stringify(b.body));
    assert.equal(moves().length, 0);
    assert.ok(Object.keys(K.data().stockJournal || {}).length > 0, "สมุดรายวันต้องลง");
  }
});

test("ส่งซ้ำ receiptUUID เดิม → ไม่ลงรายการซ้ำ", async () => {
  K.reset(base());
  const body = saleBody([["p1", 2]]);
  const a = await quiet(() => run("../sale/create.js", "create", body, undefined, T(1)));
  const b = await quiet(() => run("../sale/create.js", "create", body, undefined, T(2)));
  assert.equal(a.code, 200); assert.equal(b.code, 200);
  assert.equal(moves().length, 1);
});

test("สินค้าผูก: ขายลัง 1 → ทุกตัวในกลุ่มมีรายการ ยอดหน่วยเล็กสุด", async () => {
  K.reset(base());
  const b = await sell([["pc", 1]]);
  assert.equal(b.code, 200, JSON.stringify(b.body));
  const got = Object.fromEntries(moves().map((m) => [m.stockId, [m.before, m.after]]));
  assert.deepEqual(got, { pc: [24, 12], pp: [24, 12] });
});

test("ผู้ทำ: staffName ว่าง → ใช้ชื่อใน humanResource ของ uid", async () => {
  K.reset(base());
  const r = await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U2, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 1, cost: 7 }], staffId: "u-owner", staffName: "" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(moves()[0].byName, "เจ้าของ");
  assert.equal(moves()[0].byUid, K.OWNER.shopAccess ? K.OWNER.shopAccess.uid : moves()[0].byUid);
});

test("check ④: รูป doc ผ่าน schema StockMove · id ผ่าน StockMoveDocId · expireAt = เวลา server + 90 วัน", async () => {
  K.reset(base());
  await sell([["p1", 2], ["p2", 1]]);
  assert.equal(moves().length, 2);
  for (const m of moves()) {
    const { id, ...doc } = m;
    assert.equal(StockMoveDocId.safeParse(id).success, true, id);
    const parsed = StockMove.safeParse({ ...doc, time: new Date(), expireAt: new Date(doc.expireAt) });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error && parsed.error.issues));
    assert.equal(new Date(doc.expireAt).toISOString(), "2027-02-08T03:00:00.000Z");
  }
});

test("moveContext: premium เท่านั้น · ทีมงาน = byAdmin", () => {
  const now = new Date("2026-11-10T03:00:00Z");
  const prem = { vip: [{ type: "premium", expire: new Date("2027-01-01T00:00:00Z") }], humanResource: [{ id: "u1", name: "บี" }] };
  assert.equal(J.moveContext({ shop: {}, access: { uid: "u1" }, now }), null);
  assert.deepEqual(J.moveContext({ shop: prem, access: { uid: "u1" }, now }), { byUid: "u1", byName: "บี", refId: "", refNo: "", note: "" });
  assert.equal(J.moveContext({ shop: prem, access: { uid: "x", byAdmin: true }, now, staffName: "ทีมงาน" }).byAdmin, true);
});

test("อ่านกลับผ่าน stock.moveList: ล่าสุดก่อน · ไม่มี byUid/expireAt ในคำตอบ · journalDays ตรงสมุด", async () => {
  K.reset(base());
  await sell([["p1", 2]], {}, T(1));
  await sell([["p1", 1]], {}, T(2));
  const r = await run("moveRead.js", "moveList", { shopId: "shopA", stockId: "p1" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows.map((x) => [x.delta, x.before, x.after]), [[-1, 8, 7], [-2, 10, 8]]);
  for (const row of r.body.rows) { assert.equal("byUid" in row, false); assert.equal("expireAt" in row, false); }
  const j = await run("moveRead.js", "journalDays", { shopId: "shopA", fromDay: "20261110", toDay: "20261110" });
  assert.equal(j.code, 200, JSON.stringify(j.body));
  assert.deepEqual(j.body.days, { 20261110: { sale: { p1: -3 } } });
});

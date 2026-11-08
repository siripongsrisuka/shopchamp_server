// เทส DEV-0007 ข้อ ③ · updateTime ของ stock ต้องไม่เก่ากว่าเวลา commit · รัน: node --test pos/stock/syncTime.test.js
//
// กลไกที่พิสูจน์ (ของจริง): เครื่องซิงก์ `stock where shopId == … and updateTime > lastSync` แล้วตั้ง lastSync = updateTime สูงสุดที่ได้
//   (`shopchamp_app/src/hook/useLocalStock.js:538-560` · แอปเก่า main3 `:560-580` รูปเดียวกัน)
// เหตุการณ์ที่ทำให้หลุด: tx A อ่านนาฬิกาก่อนเริ่ม (deps.now) → ระหว่างที่ A ยังไม่ commit มีอีก tx commit + เครื่อง B ซิงก์ (lastSync ขยับ)
//   → A commit ด้วย updateTime = เวลาก่อนเริ่ม < lastSync ของ B ⇒ B ไม่เห็นการเปลี่ยนของ A อีกเลย
// ฐานปลอม (stockTestKit): serverTimestamp = เวลา commit (เดินหน้าทุก commit · เริ่มหลังนาฬิกาคำขอ 1 นาที = แทน tx ที่ช้า/ถูก retry)
//   hooks.beforeCommit = แทรก "อีก tx commit + เครื่อง B ซิงก์" หลัง A อ่าน/คิดเสร็จ ก่อน A ลงค่า
// คู่เทียบ 2 ทิศ (ทำแล้ว 2026-11-08 · ผลใน lanes/dev/source/progress-shopchamp-cost-and-stock.md):
//   รันไฟล์นี้กับ handler รุ่นก่อนแก้ (updateTime: now) = ตกทุกเคส "B เห็น" · รุ่นนี้ (serverTimestamp) = ผ่าน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./stockTestKit");

const U = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const RID = "3c9e1f20-1111-4000-8000-0000000000aa";
const ST = { staffId: "u-owner", staffName: "เจ้าของ" };
const OLD = "2026-11-01T00:00:00.000Z";
const DET = [{ id: "pc", linkMultiply: 12, unit: "ลัง" }, { id: "pp", linkMultiply: 1, unit: "ขวด" }];
const at = { __date__: OLD };
const base = () => ({
  shop: {
    shopA: {
      shopId: "shopA", name: "ร้านเอ",
      vip: [{ type: "premium", expire: { __date__: "2027-01-01T00:00:00Z" } }],
      humanResource: [{ id: "u-owner", position: ["001"], status: "active", name: "เจ้าของ" }],
    },
  },
  supplier: { s1: { shopId: "shopA", vender_Name: "คู่ค้า", sale_Name: "", tel: "", lineId: "", detail: "" } },
  stock: {
    p1: { shopId: "shopA", name: "น้ำ", unit: "ขวด", stock: 10, cost: 5, price: 10, stockCountStatus: true, barcode: "111", updateTime: at },
    p2: { shopId: "shopA", name: "ขนม", unit: "ห่อ", stock: 0, cost: 0, price: 20, stockCountStatus: true, barcode: "222", updateTime: at },
    pc: { shopId: "shopA", name: "ลัง", unit: "ลัง", stock: 24, cost: 120, linkId: "L1", linkMultiply: 12, stockCountStatus: true, linkDetail: DET, updateTime: at },
    pp: { shopId: "shopA", name: "ขวด", unit: "ขวด", stock: 24, cost: 10, linkId: "L1", linkMultiply: 1, stockCountStatus: true, linkDetail: DET, updateTime: at },
    pz: { shopId: "shopA", name: "ของอื่น", unit: "ชิ้น", stock: 1, cost: 1, price: 1, stockCountStatus: true, updateTime: at },
  },
  stockLink: { L1: { shopId: "shopA", stockGroupName: "น้ำ", stockLink: [{ id: "pc", linkMultiply: 12 }, { id: "pp", linkMultiply: 1 }], upgrade: false } },
});

const ms = (v) => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : NaN);
/** เครื่องซิงก์แบบแอป: updateTime > lastSync · คืน id ที่ได้ + lastSync ใหม่ */
function deviceSync(lastSync) {
  const rows = Object.entries(K.data().stock || {}).filter(([, d]) => d.shopId === "shopA" && ms(d.updateTime) > lastSync);
  return { ids: rows.map(([id]) => id), latest: rows.reduce((m, [, d]) => Math.max(m, ms(d.updateTime)), lastSync) };
}
/** ตั้งเหตุการณ์กลางทาง: อีก tx commit pz (เวลา commit จริง) แล้วเครื่อง B ซิงก์ · คืนตัวอ่าน lastSync ของ B */
function armRace() {
  const dev = { lastSync: Date.parse(OLD) };
  K.hooks.beforeCommit = () => {
    const pz = K.data().stock.pz;
    pz.stock += 1;
    pz.updateTime = K.commitClock();
    dev.lastSync = deviceSync(dev.lastSync).latest;
  };
  return dev;
}
async function run(file, fn, body, req) {
  return K.call(K.loadHandler(file, fn), body, req || K.OWNER);
}
const quiet = async (f) => { const w = console.warn; console.warn = () => {}; try { return await f(); } finally { console.warn = w; } };

// [ชื่อ, ไฟล์, fn, body, id ที่ต้องถึงเครื่อง B, ขั้นก่อนหน้า (ไม่แทรก)]
const CASES = [
  ["stock.receive", "receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 1, cost: 5 }], ...ST }, ["p1"]],
  ["stock.adjust stock", "adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "p1", newStock: 3, seenStock: 10, ...ST }, ["p1"]],
  ["stock.adjust price", "adjust.js", "adjust", { op: "price", shopId: "shopA", productId: "p1", newPrice: 11, ...ST }, ["p1"]],
  ["stock.adjust cost (กลุ่มผูก)", "adjust.js", "adjust", { op: "cost", shopId: "shopA", productId: "pc", newCost: 144, ...ST }, ["pc", "pp"]],
  ["stock.requisition (กลุ่มผูก)", "requisition.js", "requisition", { shopId: "shopA", requisitionUUID: U, reason: "", lines: [{ id: "pc", qty: 1 }], ...ST }, ["pc", "pp"]],
  ["stock.productSave create", "productSave.js", "productSave", { op: "create", shopId: "shopA", productUUID: U, product: { name: "x", price: 1 }, stock: 4, cost: 0, ...ST }, [U]],
  ["stock.productSave update", "productSave.js", "productSave", { op: "update", shopId: "shopA", productId: "p1", product: { price: 12 }, ...ST }, ["p1"]],
  ["stock.productDelete (ลบถึงเครื่องอื่น)", "productDelete.js", "productDelete", { shopId: "shopA", productId: "p1", ...ST }, ["p1"]],
  ["stock.productDelete กลุ่มผูก", "productDelete.js", "productDelete", { shopId: "shopA", productId: "pc", ...ST }, ["pc", "pp"]],
  ["stock.linkCreate", "link.js", "linkCreate", { shopId: "shopA", linkUUID: U, stockGroupName: "ก", upgrade: false, members: [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }] }, ["p1", "p2"]],
  ["stock.linkUpdate", "link.js", "linkUpdate", { shopId: "shopA", linkId: "L1", upgrade: true }, ["pc", "pp"]],
  ["stock.linkDelete", "link.js", "linkDelete", { shopId: "shopA", linkId: "L1" }, ["pc", "pp"]],
  ["stock.receiveEdit", "receiveEdit.js", "receiveEdit", { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "p1", qty: 10, cost: 7 }, nextQty: 5, nextCost: 7, ...ST }, ["p1"],
    ["receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 10, cost: 7 }], ...ST }]],
];

for (const [name, file, fn, body, ids, pre] of CASES) {
  test(`${name}: tx ช้าแล้วมีเครื่องซิงก์ระหว่างทาง → เครื่องนั้นยังเห็นการเปลี่ยนในรอบถัดไป`, async () => {
    K.reset(base());
    if (pre) assert.equal((await run(pre[0], pre[1], pre[2])).code, 200);
    const dev = armRace();
    const r = await quiet(() => run(file, fn, body));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.ok(dev.lastSync > Date.parse(OLD), "เครื่อง B ซิงก์ไประหว่างทางแล้ว (เหตุการณ์ถูกแทรกจริง)");
    const next = deviceSync(dev.lastSync);
    for (const id of ids) assert.ok(next.ids.includes(id), `${id} ต้องถึงเครื่อง B · updateTime=${new Date(ms(K.data().stock[id].updateTime)).toISOString()} lastSync=${new Date(dev.lastSync).toISOString()}`);
  });
}

test("stock.productDelete: doc ยังอยู่ (soft delete) · deleted:true · updateTime ขยับเป็นเวลา commit", async () => {
  K.reset(base());
  const before = ms(K.data().stock.p1.updateTime);
  const r = await run("productDelete.js", "productDelete", { shopId: "shopA", productId: "p1", ...ST });
  assert.equal(r.code, 200);
  const d = K.data().stock.p1;
  assert.ok(d, "ไม่ลบ doc จริง");
  assert.equal(d.deleted, true);
  assert.ok(ms(d.updateTime) > before);
  assert.ok(ms(d.updateTime) > Date.parse("2026-11-10T03:00:00.000Z"), "เวลา commit ไม่ใช่นาฬิกาคำขอ");
});

// ── sale.create / sale.void (handler ใน pos/sale ใช้ stockTestKit ตัวเดียวกัน) ──
let seq = 0;
const saleBody = (x) => ({
  shopId: "shopA", receiptUUID: `shopA6f1c2d3e-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  product: [{ id: "p1", qty: 2, name: "น้ำ", net: 20, totalPrice: 20, totalCost: 10 }, { id: "pc", qty: 1, name: "ลัง", net: 10, totalPrice: 10, totalCost: 5 }],
  payment: [{ id: 1, amount: 30, name: "เงินสด" }], moneyMustPaid: 30, ...x,
});

test("sale.create: tx ช้าแล้วมีเครื่องซิงก์ระหว่างทาง → เครื่องนั้นเห็นยอดที่ตัด (รวมสมาชิกกลุ่มผูก)", async () => {
  K.reset(base());
  const dev = armRace();
  const r = await quiet(() => run("../sale/create.js", "create", saleBody()));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(dev.lastSync > Date.parse(OLD));
  const next = deviceSync(dev.lastSync);
  for (const id of ["p1", "pc", "pp"]) assert.ok(next.ids.includes(id), `${id} ต้องถึงเครื่อง B`);
});

test("sale.void: tx ช้าแล้วมีเครื่องซิงก์ระหว่างทาง → เครื่องนั้นเห็นยอดที่คืน", async () => {
  K.reset(base());
  const c = await quiet(() => run("../sale/create.js", "create", saleBody()));
  assert.equal(c.code, 200, JSON.stringify(c.body));
  const dev = armRace();
  dev.lastSync = deviceSync(Date.parse(OLD)).latest; // B ซิงก์หลังขายแล้ว
  const v = await quiet(() => run("../sale/void.js", "void", { shopId: "shopA", billId: c.body.billId, requestId: RID, reason: "ลูกค้าเปลี่ยนใจ", ...ST }));
  assert.equal(v.code, 200, JSON.stringify(v.body));
  const next = deviceSync(dev.lastSync);
  for (const id of ["p1", "pc", "pp"]) assert.ok(next.ids.includes(id), `${id} ต้องถึงเครื่อง B`);
});

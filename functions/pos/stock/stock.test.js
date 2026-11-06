// เทส pos/stock/* (ก้อน 9a · DEV-0001) · รัน: node --test pos/stock/stock.test.js
//   สัญญา (shopchamp-center/api/stock.*.yaml) วัดคำตอบและการเขียนต่อ case แต่ฐานปลอมของ harness ไม่ลงค่า และไม่ปัดอ่านหลังเขียน
//   ⇒ ที่นี่พิสูจน์ 3 อย่างที่ harness วัดไม่ได้:
//     ① ทุก handler อ่านครบก่อนเขียนใน transaction (ฐานปลอมของ stockTestKit ปัดการอ่านหลังเขียนแบบ Firestore จริง)
//     ② ยิงซ้ำหลัง commit จริงได้ผลเดิม ไม่เพิ่ม/ตัดซ้ำ (ST-055 ST-060)
//     ③ ลำดับหลายขั้น: รับเข้า → แก้ใบรับ · ซ่อม clone → แผนรอบ 2 ว่าง
//   ❌ ไม่แตะ Firestore จริง (stockTestKit แทน functions/firebase)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./stockTestKit");
const { buildPlan } = require("./cloneRepairPlan");

const U = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const U2 = "1c6b7a2e-4f3d-4c1b-8a9e-2d3c4b5a6f70";
const ST = { staffId: "u-owner", staffName: "เจ้าของ" };
const DET = [{ id: "pc", linkMultiply: 12, unit: "ลัง" }, { id: "pp", linkMultiply: 1, unit: "ขวด" }];
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
    p1: { shopId: "shopA", name: "น้ำ", unit: "ขวด", stock: 10, cost: 5, price: 10, stockCountStatus: true, barcode: "111" },
    p2: { shopId: "shopA", name: "ขนม", unit: "ห่อ", stock: 0, cost: 0, price: 20, stockCountStatus: true, barcode: "222" },
    pc: { shopId: "shopA", name: "ลัง", unit: "ลัง", stock: 24, cost: 120, linkId: "L1", linkMultiply: 12, stockCountStatus: true, linkDetail: DET },
    pp: { shopId: "shopA", name: "ขวด", unit: "ขวด", stock: 24, cost: 10, linkId: "L1", linkMultiply: 1, stockCountStatus: true, linkDetail: DET },
  },
  stockLink: { L1: { shopId: "shopA", stockGroupName: "น้ำ", stockLink: [{ id: "pc", linkMultiply: 12 }, { id: "pp", linkMultiply: 1 }], upgrade: false } },
});

async function run(file, fn, body, req) {
  const f = K.loadHandler(file, fn);
  return K.call(f, body, req || K.OWNER);
}

test("schema ของคำขอโหลดได้ (vendor หรือ source)", () => {
  assert.match(K.installStockSchemas(), /^(package|source)$/);
});

test("ทุก handler อ่านครบก่อนเขียน: happy path ของ 12 endpoint ผ่านฐานที่ปัดอ่านหลังเขียน", async () => {
  const calls = [
    ["receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 1, cost: 5 }, { id: "pc", qty: 1, cost: 120 }], ...ST }],
    ["requisition.js", "requisition", { shopId: "shopA", requisitionUUID: U, reason: "", lines: [{ id: "pc", qty: 1 }], ...ST }],
    ["link.js", "linkCreate", { shopId: "shopA", linkUUID: U, stockGroupName: "ก", upgrade: true, members: [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }] }],
    ["link.js", "linkUpdate", { shopId: "shopA", linkId: "L1", upgrade: true }],
    ["link.js", "linkDelete", { shopId: "shopA", linkId: "L1" }],
    ["productDelete.js", "productDelete", { shopId: "shopA", productId: "pc", ...ST }],
    ["adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "pc", newStock: 3, seenStock: 2, ...ST }],
    ["adjust.js", "adjust", { op: "price", shopId: "shopA", productId: "p1", newPrice: 11, ...ST }],
    ["productSave.js", "productSave", { op: "update", shopId: "shopA", productId: "p1", product: { price: 12 }, ...ST }],
    ["productSave.js", "productSave", { op: "create", shopId: "shopA", productUUID: U, product: { name: "x", price: 1 }, stock: 0, cost: 0, ...ST }],
    ["supplier.js", "supplier", { op: "create", shopId: "shopA", supplierUUID: U, vender_Name: "x", sale_Name: "", tel: "", lineId: "", detail: "" }],
    ["orderCreate.js", "orderCreate", { shopId: "shopA", orderUUID: U, packId: 2, price: 100, qty: 1000, imageId: "https://x/y", ...ST }],
  ];
  for (const [file, fn, body] of calls) {
    K.reset(base());
    const r = await run(file, fn, body);
    assert.equal(r.code, 200, `${fn} ${JSON.stringify(r.body)}`);
  }
});

test("รับสินค้าซ้ำด้วย receiveUUID เดิมหลัง commit จริง → คงเหลือเพิ่มครั้งเดียว (ST-055)", async () => {
  K.reset(base());
  const body = { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 10, cost: 7 }], ...ST };
  const a = await run("receive.js", "receive", body);
  const b = await run("receive.js", "receive", body);
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(K.data().stock.p1.stock, 20);
  assert.equal(K.data().stock.p1.cost, 6);
});

test("รับเข้าแล้วแก้ใบรับแถวเดิม → ค่าที่จอเห็นต้องเป็นค่าหลังรับ · แก้แล้วยอดกลับสอดคล้อง", async () => {
  K.reset(base());
  await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "p1", qty: 10, cost: 7 }], ...ST });
  const stale = await run("receiveEdit.js", "receiveEdit", { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "p1", qty: 9, cost: 7 }, nextQty: 5, nextCost: 7, ...ST });
  assert.equal(stale.code, 409);
  assert.equal(stale.body.error, "receive_line_changed");
  const okEdit = await run("receiveEdit.js", "receiveEdit", { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "p1", qty: 10, cost: 7 }, nextQty: 5, nextCost: 7, ...ST });
  assert.equal(okEdit.code, 200);
  assert.equal(K.data().stock.p1.stock, 15);
  assert.equal(K.data().importProduct[U].totalQty, 5);
  // ยิงซ้ำด้วยค่าเดิม (เน็ตหลุดหลังสำเร็จ · จอยังเห็น 10) → 200 unchanged ไม่ลดซ้ำ ไม่ขึ้นว่าเครื่องอื่นแก้ (ผลตรวจ W4)
  const again = await run("receiveEdit.js", "receiveEdit", { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "p1", qty: 10, cost: 7 }, nextQty: 5, nextCost: 7, ...ST });
  assert.equal(again.code, 200);
  assert.equal(again.body.unchanged, true);
  assert.equal(K.data().stock.p1.stock, 15);
  // เครื่องอื่นตั้งเป็นค่าอื่น (ไม่ใช่ค่าปลายทางของคำขอนี้) → ยัง 409
  const other = await run("receiveEdit.js", "receiveEdit", { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "p1", qty: 10, cost: 7 }, nextQty: 4, nextCost: 7, ...ST });
  assert.equal(other.code, 409);
  assert.equal(K.data().stock.p1.stock, 15);
});

test("เบิกซ้ำด้วย UUID เดิม → ตัดครั้งเดียว · กลุ่มผูกตัดทุกตัว", async () => {
  K.reset(base());
  const body = { shopId: "shopA", requisitionUUID: U, reason: "x", lines: [{ id: "pc", qty: 1 }], ...ST };
  await run("requisition.js", "requisition", body);
  const b = await run("requisition.js", "requisition", body);
  assert.equal(b.body.duplicate, true);
  assert.equal(K.data().stock.pc.stock, 12);
  assert.equal(K.data().stock.pp.stock, 12);
});

test("สร้างกลุ่มซ้ำ (กดยืนยัน 2 ครั้ง) → กลุ่มเดียว · ครั้งที่ 2 duplicate (ST-060)", async () => {
  K.reset(base());
  const body = { shopId: "shopA", linkUUID: U, stockGroupName: "ก", upgrade: false, members: [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }] };
  await run("link.js", "linkCreate", body);
  const b = await run("link.js", "linkCreate", body);
  assert.equal(b.body.duplicate, true);
  // กลุ่มใหม่อีกใบที่ใช้ p1 ซ้ำ → already_linked (ST-019) เพราะ doc สดมี linkId แล้ว
  const c = await run("link.js", "linkCreate", { ...body, linkUUID: U2 });
  assert.equal(c.code, 409);
  assert.equal(c.body.errors[0].code, "already_linked");
});

test("เลิกผูกซ้ำหลังเลิกไปแล้ว → alreadyDeleted ไม่แจกยอดซ้ำ (ST-020)", async () => {
  K.reset(base());
  await run("link.js", "linkDelete", { shopId: "shopA", linkId: "L1" });
  const b = await run("link.js", "linkDelete", { shopId: "shopA", linkId: "L1" });
  assert.equal(b.body.alreadyDeleted, true);
  assert.equal(K.data().stock.pc.stock, 2);
  assert.equal(K.data().stock.pp.stock, 0);
});

test("ลบหน่วยใหญ่ของกลุ่ม → ยอดย้ายไปหน่วยที่เหลือ (ST-009) · ลบซ้ำ = alreadyDeleted", async () => {
  K.reset(base());
  await run("productDelete.js", "productDelete", { shopId: "shopA", productId: "pc", ...ST });
  assert.equal(K.data().stock.pp.stock, 24);
  assert.equal(K.data().stock.pp.linkId, "");
  assert.equal(K.data().stockLink.L1, undefined);
  const b = await run("productDelete.js", "productDelete", { shopId: "shopA", productId: "pc", ...ST });
  assert.equal(b.body.alreadyDeleted, true);
});

test("แก้คงเหลือ: ขายเกิดระหว่างเปิดหน้าต่าง → 409 แล้วยืนยันด้วยค่าปัจจุบันผ่าน (ST-086)", async () => {
  K.reset(base());
  K.data().stock.p1.stock = 8; // เครื่องอื่นขายไป 2 หลังจอเปิดหน้าต่าง (จอเห็น 10)
  const a = await run("adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "p1", newStock: 7, seenStock: 10, ...ST });
  assert.equal(a.code, 409);
  assert.equal(a.body.currentStock, 8);
  const b = await run("adjust.js", "adjust", { op: "stock", shopId: "shopA", productId: "p1", newStock: 7, seenStock: a.body.currentStock, ...ST });
  assert.equal(b.code, 200);
  assert.equal(K.data().stock.p1.stock, 7);
});

test("เลขใบ stockOrder เดินต่อกันจาก server · กดซ้ำไม่เผาเลข", async () => {
  K.reset({ ...base(), admin: { stockNumber: { value: 7 } } });
  const body = { shopId: "shopA", orderUUID: U, packId: 3, price: 150, qty: 1500, imageId: "https://x/y", ...ST };
  const a = await run("orderCreate.js", "orderCreate", body);
  const b = await run("orderCreate.js", "orderCreate", body);
  const c = await run("orderCreate.js", "orderCreate", { ...body, orderUUID: U2 });
  assert.equal(a.body.orderNumber, "202611000008");
  assert.equal(b.body.orderNumber, "202611000008");
  assert.equal(c.body.orderNumber, "202611000009");
});

// ── cloneRepair ──
const cloneData = () => {
  const D = [{ id: "sx", linkMultiply: 6, unit: "ลัง" }, { id: "sy", linkMultiply: 1, unit: "ขวด" }];
  return {
    shop: { shopA: base().shop.shopA },
    stock: {
      cX: { shopId: "shopA", id: "sx", barcode: "6", stockCountStatus: true, linkId: "LS", linkMultiply: 6, linkDetail: D, linkNext: "" },
      cY: { shopId: "shopA", id: "sy", barcode: "1", stockCountStatus: true, linkId: "LS", linkMultiply: 1, linkDetail: D, linkNext: "6" },
      sx: { shopId: "shopS", barcode: "6", stock: 30, linkId: "LS", linkDetail: D },
      sy: { shopId: "shopS", barcode: "1", stock: 30, linkId: "LS", linkDetail: D },
    },
    stockLink: {
      LC: { shopId: "shopA", stockLink: [{ id: "sx", barcode: "6", linkMultiply: 6 }, { id: "sy", barcode: "1", linkMultiply: 1 }] },
      LS: { shopId: "shopS", stockLink: [{ id: "sx" }, { id: "sy" }] },
    },
  };
};

test("cloneRepair: plan → apply → ร้านนี้ขาย/เบิกได้ด้วย API ใหม่ · ร้านต้นทางไม่ถูกแตะ · plan รอบ 2 ว่าง", async () => {
  K.reset(cloneData());
  const before = await run("requisition.js", "requisition", { shopId: "shopA", requisitionUUID: U, reason: "", lines: [{ id: "cX", qty: 1 }], ...ST });
  assert.equal(before.code, 409); // ก่อนซ่อม: กลุ่มชี้ร้านอื่น ⇒ API ใหม่ปัด (#10)
  const plan = await run("cloneRepair.js", "cloneRepair", { mode: "plan", shopId: "shopA" }, K.ADMIN);
  assert.equal(plan.body.counts.stockFixes, 2);
  const srcBefore = JSON.stringify([K.data().stock.sx, K.data().stock.sy, K.data().stockLink.LS]);
  const apply = await run("cloneRepair.js", "cloneRepair", { mode: "apply", shopId: "shopA", approvalRef: "Pack อนุมัติ", planHash: plan.body.planHash }, K.ADMIN);
  assert.equal(apply.code, 200);
  assert.equal(JSON.stringify([K.data().stock.sx, K.data().stock.sy, K.data().stockLink.LS]), srcBefore);
  assert.deepEqual(K.data().stock.cY.linkDetail.map((r) => r.id), ["cX", "cY"]);
  assert.equal(K.data().stock.cY.linkId, "LC");
  assert.equal(K.data().stock.cY.linkNext, "cX");
  const again = await run("cloneRepair.js", "cloneRepair", { mode: "plan", shopId: "shopA" }, K.ADMIN);
  assert.equal(again.body.counts.stockFixes + again.body.counts.linkFixes, 0);
  const after = await run("requisition.js", "requisition", { shopId: "shopA", requisitionUUID: U2, reason: "", lines: [{ id: "cX", qty: 1 }], ...ST });
  assert.equal(after.code, 200, JSON.stringify(after.body));
});

test("buildPlan: barcode ซ้ำ + ไม่มี field id = unresolved ไม่เดา", () => {
  const stocks = new Map([
    ["a", { shopId: "x", barcode: "1", linkId: "LZ", linkDetail: [{ id: "far", linkMultiply: 1 }] }],
    ["b", { shopId: "x", barcode: "1" }],
  ]);
  const p = buildPlan(stocks, new Map());
  assert.equal(p.stockFixes.length, 0);
  assert.deepEqual(p.unresolved, [{ kind: "stock", id: "a" }]);
});

test("buildPlan: ร้านว่าง (ไม่มีสินค้า) = แผนว่าง hash คงที่", () => {
  const a = buildPlan(new Map(), new Map());
  const b = buildPlan(new Map(), new Map());
  assert.equal(a.counts.stockFixes, 0);
  assert.equal(a.planHash, b.planHash);
});

test("แก้คงเหลือสำเร็จแล้วยิงซ้ำ body เดิม (เน็ตหลุด) → 200 unchanged ไม่ใช่ 409 stock_changed (ผลตรวจ W4)", async () => {
  K.reset(base());
  const body = { op: "stock", shopId: "shopA", productId: "p1", newStock: 7, seenStock: 10, ...ST };
  const a = await run("adjust.js", "adjust", body);
  assert.equal(a.code, 200);
  const b = await run("adjust.js", "adjust", body);
  assert.equal(b.code, 200, JSON.stringify(b.body));
  assert.equal(b.body.unchanged, true);
  assert.equal(K.data().stock.p1.stock, 7);
  assert.equal(K.log().filter((w) => w.c === "notification").length, 1);
});

test("รับเข้าพร้อมวันหมดอายุ → แก้วันหมดอายุของแถว → ล็อตย้ายทั้งกลุ่ม · ยิงซ้ำไม่ย้ายซ้ำ (ST-112)", async () => {
  K.reset(base());
  await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "pc", qty: 1, cost: 120, exp: "2027-01-01T00:00:00.000Z" }], ...ST });
  assert.equal(K.data().stock.pp.expReport.length, 1);
  const body = { shopId: "shopA", importId: U, lineIndex: 0, expect: { id: "pc", qty: 1, cost: 120 }, nextQty: 1, nextCost: 120, nextExp: "2027-03-01T00:00:00.000Z", ...ST };
  const a = await run("receiveEdit.js", "receiveEdit", body);
  assert.equal(a.code, 200, JSON.stringify(a.body));
  const b = await run("receiveEdit.js", "receiveEdit", body);
  assert.equal(b.body.unchanged, true);
  for (const id of ["pc", "pp"]) {
    const list = K.data().stock[id].expReport;
    assert.equal(list.length, 1);
    assert.equal(new Date(list[0]).toISOString(), "2027-03-01T00:00:00.000Z");
  }
  assert.equal(K.data().stock.pc.stock, 36); // คงเหลือไม่แตะ
  assert.equal(new Date(K.data().importProduct[U].product[0].exp).toISOString(), "2027-03-01T00:00:00.000Z");
});

test("รับสินค้าที่ตัวคูณของตัวเองพัง → 409 receive_unsafe ไม่มีการเขียนเลย (ผลตรวจ M3)", async () => {
  K.reset(base());
  K.data().stock.pc.linkMultiply = "abc";
  K.data().stock.pc.linkDetail = [{ id: "pc", linkMultiply: "abc" }, { id: "pp", linkMultiply: 1 }];
  const r = await run("receive.js", "receive", { shopId: "shopA", receiveUUID: U, supplierId: "s1", billNumber: "", lines: [{ id: "pc", qty: 1, cost: 120 }], ...ST });
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "receive_unsafe");
  assert.equal(K.log().length, 0);
  assert.equal(K.data().stock.pc.stock, 24);
});

test("เพิ่มสินค้าแค่ชื่อ+ราคา → doc มีช่องรูปเดิมครบ แอปเก่าอ่าน category / stockCountStatus ได้ (ผลตรวจ M1)", async () => {
  K.reset(base());
  const r = await run("productSave.js", "productSave", { op: "create", shopId: "shopA", productUUID: U, product: { name: "x", price: 1 }, stock: 0, cost: 0, ...ST });
  assert.equal(r.code, 200);
  const d = K.data().stock[U];
  assert.deepEqual(d.category, []); // DashboardStockScreen.js:46 a.category.includes
  assert.equal(d.category.includes("c1"), false);
  assert.equal(d.stockCountStatus, true);
  assert.deepEqual(d.expReport, []);
  assert.equal(d.unit, "ชิ้น");
  assert.deepEqual(d.safetyStock, { status: false, qty: "" });
  assert.equal(d.promotion.status, false);
});

test("จัดเรียงสินค้า 1,000 ตัว → batch หลายชุด · timestamp ตามลำดับ · ร้านอื่นปน = ไม่เขียนสักตัว (ผลตรวจ M4)", async () => {
  K.reset(base());
  const ids = Array.from({ length: 1000 }, (_, i) => `r${i}`);
  for (const id of ids) K.data().stock[id] = { shopId: "shopA", name: id, cashierShow: true };
  const a = await run("reorder.js", "reorder", { shopId: "shopA", ids });
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.equal(a.body.updated, 1000);
  const t = (id) => new Date(K.data().stock[id].timestamp).getTime();
  assert.equal(t("r1") - t("r0"), 30000);
  assert.equal(t("r999") - t("r0"), 999 * 30000);
  K.reset(base());
  K.data().stock.pB = { shopId: "shopB", name: "อื่น" };
  const b = await run("reorder.js", "reorder", { shopId: "shopA", ids: ["p1", "pB"] });
  assert.equal(b.code, 409);
  assert.equal(K.log().length, 0);
});

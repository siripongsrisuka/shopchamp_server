// pos/e2e/package-vat.e2e.js — ใบซื้อแพ็กเกจขอใบกำกับภาษีบน emulator (DEV-0002 · Pack เคาะ 2026-11-07)
//   ใบกำกับได้เฉพาะแพ็กเกจรายปี (admin/package.value[].price[].day = "12 เดือน") · VAT 7% คิดที่ server ปัดสตางค์
//   ฐานจริงของ emulator (transaction จริง · Timestamp จริง) · ใบที่ขอใบกำกับมีช่องชื่อเดียวกับใบอุปกรณ์ที่ care อ่าน
//   ⚠️ admin/package · admin/packageNumber เป็น doc กลาง ⇒ ไฟล์นี้ตั้งค่าเองทุกเทส (run.js รันทีละไฟล์)
// รัน: cd functions && node pos/e2e/run.js pos/e2e/package-vat.e2e.js
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./_env");
const { packageOrder } = require("../company/packageOrder");

const { call, seed, get, clock, ns, dump } = E;
const NOW = clock("2026-11-10T03:00:00.000Z");
const SLIP = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/packageOrder%2Fslip.jpg?alt=media&token=t";
const VD = "บริษัท ทดสอบ จำกัด 0105556000000 · 1 ถนนทดสอบ";
// รูปเดียวกับฐานจริง (วัด 2026-11-07) · ราคาเป็นค่าสมมติ
const PACKAGE = {
  value: [
    { name: "พรีเมี่ยม", type: "premium", status: true, color: "#f00", imageId: "", price: [{ id: "1", price: 350, save: 0, day: "1 เดือน" }, { id: "2", price: 3500, save: 700, day: "12 เดือน" }] },
    { name: "พนักงาน", type: "staff", status: true, color: "#0f0", imageId: "", price: [{ id: "3", price: 300, save: 0, day: "1 เดือน" }, { id: "4", price: 3000, save: 600, day: "12 เดือน" }] },
  ],
  admin: [], payment: [],
};

before(() => E.ready());

test("ใบกำกับรายปีครบวง: ออกใบ VAT · ส่งซ้ำได้ใบเดิม · รายเดือน/ปน ปัดไม่เขียน · ไม่ขอใบกำกับได้รูปเดิม", async () => {
  const n = ns();
  const A = `shopA${n}`, owner = `u-owner${n}`;
  await seed({
    shop: { [A]: { shopId: A, name: "ร้านทดสอบ", humanResource: [{ id: owner, name: "เจ้าของ", position: ["001"], status: "active" }] } },
    profile: { [owner]: { name: "เจ้าของ", tel: "0000000000" } },
    admin: { package: PACKAGE, packageNumber: { value: 41 } },
  });
  const access = { shopId: A, uid: owner, role: "owner", rights: [] };
  const uuid = (k) => `9b1deb4d-3b7d-4bad-9bdd-${n}${k}`.padEnd(36, "0");
  const body = (x) => ({ shopId: A, slipUrl: SLIP, ...x });

  // ① รายปี 2 ตัวขอใบกำกับ → VAT ของยอดรวม 6500 = 455 · net 6955
  const u1 = uuid("0001");
  const r1 = await call(packageOrder, NOW, { body: body({ packageIds: ["2", "4"], expectedNet: 6955, vat: true, vatDetail: VD, orderUUID: u1 }), shopAccess: access });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.net, r1.body.orderNumber, r1.body.duplicate], [6955, "202611000042", false]);
  const o1 = await get("packageOrder", u1);
  assert.deepEqual([o1.shopId, o1.vat, o1.totalPrice, o1.vatAmount, o1.vatDetail, o1.net, o1.status, o1.email], [A, true, 6500, 455, VD, 6955, "order", ""]);
  assert.deepEqual(o1.packageId, ["2", "4"]);
  assert.equal(typeof o1.timestamp.toMillis, "function", "timestamp เป็น Timestamp จริง");
  assert.equal((await get("notification", `packageOrder-${u1}`)).categoryId, 99);

  // ② ส่งซ้ำ = ใบเดิม ไม่ขยับตัวนับ
  const again = await call(packageOrder, NOW, { body: body({ packageIds: ["4", "2"], expectedNet: 6955, vat: true, vatDetail: VD, orderUUID: u1 }), shopAccess: access });
  assert.deepEqual([again.status, again.body.duplicate, again.body.orderNumber], [200, true, "202611000042"]);
  assert.equal((await get("admin", "packageNumber")).value, 42);

  // ③ รายเดือน / ปน / ยอดก่อน VAT = ปัด ไม่เขียนอะไรเลย
  const snap = await dump();
  const m = await call(packageOrder, NOW, { body: body({ packageIds: ["1"], expectedNet: 374.5, vat: true, vatDetail: VD, orderUUID: uuid("0002") }), shopAccess: access });
  assert.deepEqual([m.status, m.body.error, m.body.packageId], [409, "tax_invoice_yearly_only", "1"]);
  const mix = await call(packageOrder, NOW, { body: body({ packageIds: ["2", "3"], expectedNet: 4066, vat: true, vatDetail: VD, orderUUID: uuid("0003") }), shopAccess: access });
  assert.deepEqual([mix.status, mix.body.error, mix.body.packageId], [409, "tax_invoice_yearly_only", "3"]);
  const pre = await call(packageOrder, NOW, { body: body({ packageIds: ["2"], expectedNet: 3500, vat: true, vatDetail: VD, orderUUID: uuid("0004") }), shopAccess: access });
  assert.deepEqual([pre.status, pre.body.error, pre.body.net], [409, "price_changed", 3745]);
  assert.deepEqual(await dump(), snap, "ปัดแล้วฐานไม่เปลี่ยน");

  // ④ ไม่ขอใบกำกับ (รูปที่แอปรุ่นก่อนส่ง) = รูปเดิม ไม่มีช่อง VAT เพิ่ม
  const u5 = uuid("0005");
  const plain = await call(packageOrder, NOW, { body: body({ packageIds: ["1"], expectedNet: 350, orderUUID: u5 }), shopAccess: access });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const o5 = await get("packageOrder", u5);
  assert.deepEqual([o5.vat, o5.net, o5.orderNumber], [false, 350, "202611000043"]);
  for (const k of ["totalPrice", "vatAmount", "vatDetail"]) assert.equal(k in o5, false, k);
});

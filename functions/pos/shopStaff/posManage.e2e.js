// pos/shopStaff/posManage.e2e.js — pos.manage + shop.migrateLegacy บน Firestore emulator ตัวจริง (ก้อน 10 รอบ 2a · DEV-0001)
//   วัดสิ่งที่ฐานปลอมวัดไม่ได้: transaction จริงของ SDK (retry ตอนชนกัน) · auto id ของ doc shift · 2 เครื่องยิงพร้อมกันจริง
// รัน: cd shopchamp_server/functions && node pos/e2e/run.js pos/shopStaff/posManage.e2e.js
//   ❌ ไม่แตะฐานจริง: _env ปัดถ้าไม่ใช่ emulator บนเครื่องนี้ + project demo-
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../e2e/_env");
const { posManage } = require("./posManage");
const { shopMigrateLegacy } = require("./shopMigrateLegacy");
const { manage: shiftManage } = require("../shift/manage");

const { call, seed, get, where, T, ns, clock } = E;
before(() => E.ready());
const NOW = clock("2026-11-10T03:00:00.000Z");
const far = T("2027-01-01T00:00:00.000Z");
const shiftDoc = (shopId, posId, extra) => ({ closeBy: "", closeCash: "", closeComment: "", closeDiff: "", closeTime: "", closeWithDraw: "", duringShift: [], openBy: "", openCash: "", openComment: "", openDiff: "", openTime: "", openWithDraw: "", shopId, posId, currentCash: 0, status: false, lastShiftDate: "20230909", shiftCount: 0, receiptNumber: "", ...extra });

function fixture() {
  const n = ns();
  const id = { shop: `shopP${n}`, owner: `u-owner${n}`, staff: `u-staff${n}`, sh1: `sh1${n}`, sh2: `sh2${n}` };
  const shop = {
    shopId: id.shop, name: "ร้านทดสอบ",
    POSs: [{ id: "pos-1", name: "จุด 1", shiftId: id.sh1, uniqueId: "dev-1", deviceName: "แท็บเล็ต", drawer: true }, { id: "pos-2", name: "จุด 2", shiftId: id.sh2, uniqueId: "", deviceName: "" }],
    humanResource: [
      { id: id.owner, name: "เจ้าของ", position: ["001"], status: "active", rights: [], password: "1234" },
      { id: id.staff, name: "พนักงานบี", position: [], status: "active", rights: ["101", "102"], password: "9999" },
    ],
    vip: [{ type: "premium", expire: far }, { type: "staff", expire: far }],
  };
  const access = (uid, role, rights) => ({ shopId: id.shop, uid, role, rights });
  return {
    id, data: { shop: { [id.shop]: shop }, shift: { [id.sh1]: shiftDoc(id.shop, "pos-1"), [id.sh2]: shiftDoc(id.shop, "pos-2") } },
    owner: access(id.owner, "owner", []), staff: access(id.staff, "staff", ["101", "102"]),
  };
}

test("e2e: 2 เครื่องแก้จุดขายพร้อมกัน (A เพิ่มจุด 3 · B ลบจุด 2) → ได้ครบทั้งคู่ · doc shift ใหม่ 1 ใบ · doc เก่าถูกลบ", async () => {
  const f = fixture(); await seed(f.data);
  const pm = (ops, who) => call(posManage, NOW, { body: { shopId: f.id.shop, ops }, shopAccess: who });
  const [a, b] = await Promise.all([pm([{ op: "add", id: "pos-3", name: "จุด 3" }], f.owner), pm([{ op: "remove", id: "pos-2" }], f.staff)]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  const shop = await get("shop", f.id.shop);
  assert.deepEqual(shop.POSs.map((r) => r.id), ["pos-1", "pos-3"]);
  assert.equal(shop.POSs[0].drawer, true);
  const sid = shop.POSs[1].shiftId;
  assert.match(sid, /^[A-Za-z0-9]{20}$/, "auto id ของ Firestore แบบแอปเก่า");
  const sh = await get("shift", sid);
  assert.equal(sh.posId, "pos-3"); assert.equal(sh.shopId, f.id.shop); assert.equal(sh.status, false);
  assert.equal(await get("shift", f.id.sh2), undefined);
  assert.equal((await where("shift", "posId", "pos-3")).filter((d) => d.shopId === f.id.shop).length, 1, "retry ของ transaction ไม่ทิ้ง doc shift ลอย");
  const again = await pm([{ op: "add", id: "pos-3", name: "จุด 3" }], f.owner);
  assert.equal(again.body.changed, false);
});

test("e2e: จุดขายใหม่เปิดกะได้ · กะเปิดอยู่ลบไม่ได้ (409) ไม่เขียนอะไร", async () => {
  const f = fixture(); await seed(f.data);
  const add = await call(posManage, NOW, { body: { shopId: f.id.shop, ops: [{ op: "add", id: "pos-3", name: "จุด 3" }] }, shopAccess: f.owner });
  const sid = add.body.createdShifts[0].shiftId;
  const open = await call(shiftManage, NOW, { body: { shopId: f.id.shop, op: "open", shiftId: sid, staffId: f.id.staff, staffName: "พนักงานบี", requestId: `o${sid}`, openCash: "100" }, shopAccess: f.staff });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const rm = await call(posManage, NOW, { body: { shopId: f.id.shop, ops: [{ op: "remove", id: "pos-3" }] }, shopAccess: f.owner });
  assert.equal(rm.status, 409); assert.equal(rm.body.error, "pos_shift_open");
  assert.ok(await get("shift", sid), "doc ยังอยู่");
  assert.equal((await get("shop", f.id.shop)).POSs.length, 3);
});

test("e2e: ย้ายโครงร้านรุ่นแรก 2 เครื่องพร้อมกัน → เขียนครั้งเดียว อีกเครื่อง changed:false · รูปที่แอปเก่าอ่าน", async () => {
  const f = fixture();
  const s = f.data.shop[f.id.shop];
  Object.assign(s, { payment: [{ id: "001", name: "เงินสด" }, { id: "035", name: "เงินเซ็น" }], printers: [{ id: "p1", ipAddress: "192.168.1.9" }], receipt: { header: "หัว" }, receiptPay: { status: true, paymentId: "001", footer: "ขอบคุณ" } });
  s.POSs[0].printerId = "p1";
  await seed(f.data);
  const printer = { printerType: "ethernet", printerSize: "80", printerBluetooth: { android: { address: "", name: "" }, ios: { address: "", name: "" } } };
  const m = (who) => call(shopMigrateLegacy, NOW, { body: { shopId: f.id.shop, printer }, shopAccess: who });
  const [a, b] = await Promise.all([m(f.owner), m(f.staff)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.body.changed, b.body.changed].sort(), [false, true]);
  const shop = await get("shop", f.id.shop);
  assert.deepEqual(shop.payment, []);
  assert.equal(shop.shift, true);
  assert.equal(shop.POSs[0].printerEthernet, "192.168.1.9");
  assert.deepEqual(shop.shopchampPayment.map((x) => x.status), [true, false, true]);
  assert.equal(shop.humanResource[0].rights.length, 52);
  assert.equal(shop.humanResource[0].password, "1234");
  assert.ok(shop.settingsUpdate.at && typeof shop.settingsUpdate.at.toMillis === "function", "เวลาเป็น Timestamp");
});

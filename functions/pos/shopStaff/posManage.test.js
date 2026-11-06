// เทส pos.manage + shop.migrateLegacy (ก้อน 10 รอบ 2a · DEV-0001) · รัน: node --test functions/pos/shopStaff/posManage.test.js
//   ฐานปลอมแบบมีสถานะ (testKit.makeStore) ⇒ วัดสิ่งที่สัญญาวัดไม่ได้: ส่งซ้ำหลังสำเร็จ · 2 เครื่องแก้ต่อกัน · doc shift ที่สร้างแล้วเปิดกะต่อได้
//   คู่เทียบ 2 ทิศ: ทางเขียนแบบแอปเก่า (POSs ทั้งก้อนจากสำเนา `main3:POSScreen.js:143-163`) ทำแถวของเครื่องแรกหาย + doc shift ค้าง ในฐานเดียวกัน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const kit = require("./testKit");

const store = kit.makeStore();
kit.install(store);
// ก่อนแม่ผูก export ของรอบนี้: เติมคำขอจาก src ของ center ลงตัวที่ติดตั้ง (แบบเดียวกับ testKit.ensureSchema)
(function ensurePosSchema() {
  const abs = require.resolve("@shopchamp/schema");
  const cur = require(abs);
  if (cur.PosManageRequest && cur.ShopMigrateLegacyRequest) return;
  const esbuild = require(require.resolve("esbuild", { paths: [kit.CENTER] }));
  const src = path.join(kit.CENTER, "packages/schema/src");
  const out = esbuild.buildSync({ stdin: { contents: `export * from ${JSON.stringify(path.join(src, "requests/posManage"))};`, resolveDir: src, loader: "ts" }, bundle: true, platform: "node", format: "cjs", external: ["zod"], write: false });
  const m = new module.constructor(abs, module);
  m.filename = abs;
  m.paths = module.constructor._nodeModulePaths(path.dirname(abs));
  m._compile(out.outputFiles[0].text, abs);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: { ...cur, ...m.exports } };
})();
const schema = require("@shopchamp/schema");
const { posManage } = require("./posManage");
const { shopMigrateLegacy } = require("./shopMigrateLegacy");
const { manage: shiftManage } = require("../shift/manage");

const NOW = new Date("2026-11-10T03:00:00.000Z");
let n = 0;
const deps = { now: () => NOW, newId: () => `gen-${++n}` };
const call = kit.caller(posManage(deps));
const mig = kit.caller(shopMigrateLegacy(deps));
const shiftCall = kit.caller(shiftManage(deps));

const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const STAFF = { shopAccess: { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["101"] } };
const CASH = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const OFF = { shopAccess: { shopId: "shopA", uid: "u-off", role: "staff", rights: ["101"] } };
const ADMIN = { shopAccess: { shopId: "shopA", uid: "u-team", role: "owner", rights: [], byAdmin: true } };
const far = new Date("2027-01-01T00:00:00.000Z");
const shiftDoc = (posId, extra) => ({ closeBy: "", closeCash: "", closeComment: "", closeDiff: "", closeTime: "", closeWithDraw: "", duringShift: [], openBy: "", openCash: "", openComment: "", openDiff: "", openTime: "", openWithDraw: "", shopId: "shopA", posId, currentCash: 0, status: false, lastShiftDate: "20230909", shiftCount: 0, receiptNumber: "", ...extra });

function seed(over) {
  n = 0;
  store.reset({
    shop: {
      shopA: {
        shopId: "shopA", name: "ร้านทดสอบ",
        POSs: [
          { id: "pos-1", name: "จุด 1", shiftId: "sh1", uniqueId: "dev-1", deviceName: "แท็บเล็ต", drawer: true },
          { id: "pos-2", name: "จุด 2", shiftId: "sh2", uniqueId: "", deviceName: "" },
        ],
        humanResource: [
          { id: "u-owner", position: ["001"], status: "active", password: "1234" },
          { id: "u-staff", position: [], status: "active", rights: ["101"] },
          { id: "u-cash", position: [], status: "active", rights: ["100"] },
          { id: "u-off", position: [], status: "inActive", rights: ["101"] },
        ],
        vip: [{ type: "premium", expire: far }, { type: "staff", expire: far }],
        ...over,
      },
    },
    shift: { sh1: shiftDoc("pos-1"), sh2: shiftDoc("pos-2") },
  });
}
const shop = () => store.data.shop.shopA;
const body = (ops) => ({ shopId: "shopA", ops });

test("add: สร้างแถว + doc shift ใน transaction เดียว · ส่งซ้ำ = ไม่เขียน · doc shift ใหม่เปิดกะผ่าน shift.manage ได้", async () => {
  seed();
  const r = await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const row = shop().POSs[2];
  assert.equal(row.id, "pos-3");
  assert.ok(row.shiftId);
  assert.deepEqual(r.body.createdShifts, [{ posId: "pos-3", shiftId: row.shiftId }]);
  const sh = store.data.shift[row.shiftId];
  assert.equal(sh.posId, "pos-3");
  assert.equal(sh.shopId, "shopA");
  assert.equal(sh.status, false);
  assert.ok(schema.Shift.safeParse(sh).success, "แอปเก่าอ่าน doc shift ใหม่ได้ (entity)");
  assert.ok(schema.ShopPos.safeParse(row).success, "แถวใหม่ผ่าน entity จุดขาย");
  store.log = [];
  const again = await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), OWNER);
  assert.equal(again.code, 200);
  assert.equal(again.body.changed, false);
  assert.equal(store.log.length, 0, "ส่งซ้ำไม่เขียน");
  assert.equal(Object.keys(store.data.shift).length, 3, "ไม่มี doc shift เกิน");
  const open = await shiftCall({ shopId: "shopA", op: "open", shiftId: row.shiftId, staffId: "u-owner", staffName: "เจ้าของ", requestId: "rq-open-1", openCash: "100" }, OWNER);
  assert.equal(open.code, 200, `กะของจุดขายใหม่เปิดได้: ${JSON.stringify(open.body)}`);
});

test("remove: ลบแถว + doc shift · กะเปิดอยู่ 409 · doc shift ร้านอื่น 409 · แถวแรก 409 · ไม่มีแถว = ส่งซ้ำได้", async () => {
  seed();
  store.data.shift.sh2.status = true;
  const open = await call(body([{ op: "remove", id: "pos-2" }]), OWNER);
  assert.equal(open.code, 409);
  assert.equal(open.body.error, "pos_shift_open");
  assert.equal(shop().POSs.length, 2, "ไม่เขียนอะไร");
  store.data.shift.sh2 = shiftDoc("pos-2", { shopId: "shopB" });
  const other = await call(body([{ op: "remove", id: "pos-2" }]), OWNER);
  assert.equal(other.body.error, "shift_other_shop");
  assert.ok(store.data.shift.sh2, "ไม่ลบ doc ของร้านอื่น");
  store.data.shift.sh2 = shiftDoc("pos-2");
  const first = await call(body([{ op: "remove", id: "pos-1" }]), OWNER);
  assert.equal(first.body.error, "first_pos");
  const okr = await call(body([{ op: "remove", id: "pos-2" }]), OWNER);
  assert.equal(okr.code, 200);
  assert.deepEqual(shop().POSs.map((r) => r.id), ["pos-1"]);
  assert.equal(store.data.shift.sh2, undefined, "doc shift ถูกลบ");
  assert.deepEqual(okr.body.deletedShifts, ["sh2"]);
  const again = await call(body([{ op: "remove", id: "pos-2" }]), OWNER);
  assert.equal(again.code, 200);
  assert.equal(again.body.changed, false);
});

test("ทั้งชุดหรือไม่เลย: op แรกผ่าน op หลังตก = ไม่เขียนสักตัว (ไม่มี doc shift ลอย)", async () => {
  seed();
  const r = await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }, { op: "rename", id: "ghost", name: "x" }]), OWNER);
  assert.equal(r.code, 404);
  assert.equal(r.body.error, "row_not_found");
  assert.equal(shop().POSs.length, 2);
  assert.equal(Object.keys(store.data.shift).length, 2);
});

test("2 เครื่อง: A เพิ่มจุด 3 · B (สำเนาเก่า) ลบจุด 2 + เปลี่ยนชื่อจุด 1 → ของทั้ง 2 เครื่องอยู่ครบ · คู่เทียบ: ทางแอปเก่าทำจุด 3 หายและ doc shift ค้าง", async () => {
  seed();
  assert.equal((await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), OWNER)).code, 200);
  assert.equal((await call(body([{ op: "remove", id: "pos-2" }, { op: "rename", id: "pos-1", name: "หน้าร้าน" }]), STAFF)).code, 200);
  assert.deepEqual(shop().POSs.map((r) => [r.id, r.name]), [["pos-1", "หน้าร้าน"], ["pos-3", "จุด 3"]]);
  assert.equal(shop().POSs[0].drawer, true, "คีย์ที่ไม่รู้จักของแถวเดิมคงไว้");

  // ทางแอปเก่า: B ถือสำเนาก่อน A เพิ่ม แล้วเขียน POSs ทั้งก้อน
  seed();
  const stale = structuredClone(shop().POSs);
  await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), OWNER);
  const sh3 = shop().POSs[2].shiftId;
  await store.db.runTransaction(async (tx) => {
    tx.delete(store.db.collection("shift").doc("sh2"));
    tx.update(store.db.collection("shop").doc("shopA"), { POSs: [{ ...stale[0], name: "หน้าร้าน" }] });
  });
  assert.deepEqual(shop().POSs.map((r) => r.id), ["pos-1"], "แอปเก่า: จุด 3 ของเครื่อง A หาย");
  assert.ok(store.data.shift[sh3], "แอปเก่า: doc shift ของจุด 3 ค้างไม่มีเจ้าของ");
});

test("disconnect ล้างเครื่องที่ผูก · repair เติม id/shiftId คงลำดับ · ส่งซ้ำไม่เขียน", async () => {
  seed();
  const d = await call(body([{ op: "disconnect", id: "pos-1" }]), OWNER);
  assert.equal(d.code, 200);
  assert.equal(shop().POSs[0].uniqueId, "");
  assert.equal(shop().POSs[0].deviceName, "");
  seed({ POSs: [{ name: "เก่า 1", drawer: true }, { id: "pos-2", name: "จุด 2", shiftId: "sh2" }, { id: "pos-x", name: "ไม่มีกะ" }] });
  const r = await call(body([{ op: "repair" }]), OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const rows = shop().POSs;
  assert.deepEqual(rows.map((x) => x.name), ["เก่า 1", "จุด 2", "ไม่มีกะ"], "ลำดับเดิม (P-85)");
  assert.equal(rows[0].id, "gen-1");
  assert.ok(rows[0].shiftId && rows[2].shiftId);
  assert.equal(store.data.shift[rows[0].shiftId].posId, "gen-1");
  assert.equal(store.data.shift[rows[2].shiftId].posId, "pos-x");
  store.log = [];
  const again = await call(body([{ op: "repair" }]), OWNER);
  assert.equal(again.body.changed, false);
  assert.equal(store.log.length, 0);
});

test("ด่าน: ไม่มีสิทธิ์ 101 · พนักงานปิดสถานะ · แพ็กเกจหมดเพิ่มไม่ได้แต่ลบได้ · ทีมงานมีร่องรอย · field เกิน 400", async () => {
  seed();
  assert.equal((await call(body([{ op: "rename", id: "pos-1", name: "x" }]), CASH)).body.error, "right_required");
  assert.equal((await call(body([{ op: "rename", id: "pos-1", name: "x" }]), OFF)).body.error, "not_shop_member");
  seed({ vip: [{ type: "premium", expire: new Date("2020-01-01T00:00:00.000Z") }] });
  assert.equal((await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), OWNER)).body.error, "premium_required");
  assert.equal((await call(body([{ op: "remove", id: "pos-2" }]), OWNER)).code, 200);
  seed();
  const a = await call(body([{ op: "add", id: "pos-3", name: "จุด 3" }]), ADMIN);
  assert.equal(a.body.byAdmin, true);
  assert.equal(store.data.shift[shop().POSs[2].shiftId].adminUid, "u-team");
  assert.equal(shop().settingsUpdate.adminUid, "u-team");
  assert.equal((await call(body([{ op: "add", id: "pos-4", name: "x", shiftId: "evil" }]), OWNER)).code, 400);
  assert.equal((await call(body([{ op: "repair" }, { op: "remove", id: "pos-2" }]), OWNER)).code, 400);
  assert.equal((await call({ shopId: "shopB", ops: [{ op: "remove", id: "pos-2" }] }, OWNER)).body.error, "wrong_shop");
});

// ───────── shop.migrateLegacy (U20) ─────────
const PRINTER = { printerType: "ethernet", printerSize: "80", printerBluetooth: { android: { address: "", name: "" }, ios: { address: "", name: "" } } };
function seedLegacy(over) {
  store.reset({
    shop: {
      shopA: {
        shopId: "shopA",
        POSs: [{ id: "pos-1", name: "จุด 1", shiftId: "sh1", printerId: "p1", drawer: true }, { id: "pos-2", name: "จุด 2", shiftId: "sh2" }],
        printers: [{ id: "p1", ipAddress: "192.168.1.50" }],
        payment: [{ id: "001", name: "เงินสด" }, { id: "009", name: "พร้อมเพย์", promptpayId: "0811111111" }, { id: "037", name: "บัตร" }, { id: "036", imageId: "https://img.example.com/qr.png" }],
        receipt: { header: "หัว" },
        receiptPay: { status: true, paymentId: "009", footer: "ขอบคุณ" },
        humanResource: [{ id: "u-owner", position: ["001"], status: "active", rights: [], password: "1234" }, { id: "u-cash", position: [], status: "active", rights: ["100"] }],
        vip: [{ type: "staff", expire: far }],
        ...over,
      },
    },
  });
}

test("migrateLegacy: สูตรเดียวกับ HomeScreen.js handleNewStructure · ไม่คืนรหัสแคชเชียร์ · ส่งซ้ำ/เครื่องที่ 2 = ไม่เขียน", async () => {
  seedLegacy();
  const r = await mig({ shopId: "shopA", printer: PRINTER }, CASH);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const s = shop();
  assert.deepEqual(s.payment, []);
  assert.equal(s.shift, true);
  assert.deepEqual(s.shopchampPayment.map((a) => [a.id, a.status, a.mortal]), [[1, true, true], [2, true, true], [3, false, true], [4, true, false]]);
  assert.equal(s.POSs[0].printerEthernet, "192.168.1.50");
  assert.equal(s.POSs[1].printerEthernet, "");
  assert.equal(s.POSs[0].printerType, "ethernet");
  assert.equal(s.POSs[0].drawer, true);
  assert.deepEqual(s.receipt, { header: "หัว", promptpayStatus: true, promptpayId: "0811111111", footerImage: { status: false, imageId: "https://img.example.com/qr.png" }, footerStatus: true, footer: "ขอบคุณ" });
  assert.equal(s.humanResource[0].rights.length, 52);
  assert.equal(s.humanResource[0].password, "1234", "ช่องอื่นของคนแรกคงไว้");
  assert.deepEqual(s.humanResource[1].rights, ["100"]);
  assert.equal(JSON.stringify(r.body).includes("1234"), false, "คำตอบไม่มีรหัสแคชเชียร์");
  assert.equal(r.body.ownerRights.id, "u-owner");
  store.log = [];
  const again = await mig({ shopId: "shopA", printer: PRINTER }, OWNER);
  assert.equal(again.body.changed, false);
  assert.equal(store.log.length, 0);
});

test("migrateLegacy: receiptPay ไม่มี = ค่าตั้งต้นเดิม · ร้านไม่มี payment = ไม่เขียน · พนักงานปิดสถานะ 403", async () => {
  seedLegacy({ receiptPay: undefined, payment: [{ id: "035" }] });
  delete store.data.shop.shopA.receiptPay;
  const r = await mig({ shopId: "shopA", printer: PRINTER }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(shop().receipt, { header: "หัว", footerStatus: false, footer: "" });
  assert.equal(shop().shopchampPayment[2].status, true);
  seedLegacy({ payment: [] });
  store.log = [];
  assert.equal((await mig({ shopId: "shopA", printer: PRINTER }, OWNER)).body.changed, false);
  assert.equal(store.log.length, 0);
  seedLegacy();
  store.data.shop.shopA.humanResource[1].status = "inActive";
  assert.equal((await mig({ shopId: "shopA", printer: PRINTER }, CASH)).body.error, "not_shop_member");
  assert.equal((await mig({ shopId: "shopA", printer: { ...PRINTER, printerType: "usb" } }, OWNER)).code, 400);
});

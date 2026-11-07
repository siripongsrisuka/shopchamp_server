// เทสโดเมนร้านและพนักงาน (ก้อน 9c · DEV-0001) · รัน: node --test functions/pos/shopStaff/shopStaff.test.js
//   สัญญา (api/shop.update · staff.manage · staff.checkIn · expense.manage · expenseReport.manage · profile.manage) วัดทีละคำขอกับ seed คงที่
//   ไฟล์นี้วัดสิ่งที่สัญญาวัดไม่ได้ ด้วยฐานปลอมที่ค่าเปลี่ยนจริงหลัง commit (testKit.makeStore):
//     ① 2 เครื่องแก้ตั้งค่าร้านต่อกัน ของเครื่องแรกไม่หาย (#14) · เครื่องที่ถือค่าเก่าถูกปัดแล้วโหลดใหม่ผ่าน
//     ② ลำดับหลายขั้น + ส่งซ้ำหลังสำเร็จ ได้ผลเดิม ไม่เขียนซ้ำ
//     ③ ของที่เขียนแล้ว แอปเก่าอ่านได้: รูปผ่าน entity schema (passthrough) · ค้นด้วยคีย์เดิมของแอปเก่าเจอ
//     ④ คู่เทียบ 2 ทิศ: ทางเขียนแบบแอปเก่า (ทั้งก้อนจากสำเนา) ทำของเครื่องแรกหายจริงในฐานปลอมเดียวกัน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const kit = require("./testKit");

const store = kit.makeStore();
kit.install(store);
const schema = kit.ensureSchema();
const { shopUpdate } = require("./shopUpdate");
const { staffManage } = require("./staffManage");
const { checkIn } = require("./checkIn");
const { expenseManage } = require("./expenseManage");
const { expenseReportManage } = require("./expenseReportManage");
const { profileManage } = require("./profileManage");

let NOW = new Date("2026-11-10T03:00:00.000Z");
const deps = { now: () => NOW };
const shopCall = kit.caller(shopUpdate(deps));
const staffCall = kit.caller(staffManage(deps));
const ciCall = kit.caller(checkIn(deps));
const expCall = kit.caller(expenseManage(deps));
const repCall = kit.caller(expenseReportManage(deps));
const profCall = kit.caller(profileManage(deps));

const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const STAFF = { shopAccess: { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["101", "103", "131"] } };
const far = new Date("2027-01-01T00:00:00.000Z");
function seed() {
  store.reset({
    shop: {
      shopA: {
        shopId: "shopA", name: "ร้านทดสอบ",
        POSs: [{ id: "pos-1", name: "จุด 1", drawer: true }, { id: "pos-2", name: "จุด 2" }],
        shopchampPayment: [{ id: 1, name: "เงินสด", mortal: true }],
        humanResource: [
          { id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active", password: "1234" },
          { id: "u-staff", name: "พนักงานบี", position: [], status: "active", rights: ["101", "103", "131"], password: "9999" },
        ],
        vip: [{ type: "premium", expire: far }, { type: "staff", expire: far }],
        smartCategory: [{ level: 1, value: [{ id: "c1", name: "หมวดเอ", level: 1, aboveId: [] }] }],
        categoryExpense: [{ level: 1, value: [{ id: "ce1", name: "ค่าน้ำไฟ", level: 1, aboveId: [] }] }],
        notiShift: ["u-owner"], notiCancelBill: ["u-owner"],
      },
    },
    profile: {
      "u-owner": { name: "เจ้าของ", tel: "0811111110", email: "o@example.com", port: [], currentLogin: { shopId: "", rights: [], printer: [] } },
      "u-staff": { name: "พนักงานบี", tel: "0811111112", email: "s@example.com", port: [], currentLogin: { shopId: "", rights: [], printer: [] } },
      "u-new": { name: "คนใหม่", tel: "0811111119", email: "n@example.com", imageId: "", port: [] },
    },
    admin: { adminConfig: { admin: ["u-company"] } },
  });
}

// ───────── ① #14 สองเครื่อง ─────────

test("#14: เครื่อง A แก้จุดขาย 1 · เครื่อง B แก้จุดขาย 2 จากสำเนาเก่า → ของทั้ง 2 เครื่องอยู่ครบ", async () => {
  seed();
  const a = await shopCall({ shopId: "shopA", ops: [{ op: "patchRow", field: "POSs", id: "pos-1", patch: { name: "หน้าร้าน" } }] }, OWNER);
  const b = await shopCall({ shopId: "shopA", ops: [{ op: "patchRow", field: "POSs", id: "pos-2", patch: { name: "หลังร้าน" } }] }, STAFF);
  assert.equal(a.code, 200); assert.equal(b.code, 200);
  assert.deepEqual(store.data.shop.shopA.POSs, [{ id: "pos-1", name: "หน้าร้าน", drawer: true }, { id: "pos-2", name: "หลังร้าน" }]);
  assert.equal(store.data.shop.shopA.settingsUpdate.by, "u-staff");
});

test("#14 คู่เทียบ: ทางเขียนแอปเก่า (ทั้งช่องจากสำเนาตอนเปิดจอ) ทำของเครื่อง A หายจริง", async () => {
  seed();
  const staleB = JSON.parse(JSON.stringify(store.data.shop.shopA.POSs)); // เครื่อง B โหลดตอนเปิดจอ
  await shopCall({ shopId: "shopA", ops: [{ op: "patchRow", field: "POSs", id: "pos-1", patch: { name: "หน้าร้าน" } }] }, OWNER);
  staleB[1].name = "หลังร้าน";
  await store.db.runTransaction(async (tx) => tx.update({ c: "shop", id: "shopA" }, { POSs: staleB })); // updateFieldShop เดิม
  assert.equal(store.data.shop.shopA.POSs[0].name, "จุด 1", "ของเครื่อง A หาย = บั๊กเดิมยืนยันในฐานปลอมเดียวกัน");
});

test("#14: หมวดสินค้าทั้งก้อน เครื่องที่ถือค่าเก่าถูกปัด 409 · โหลดใหม่แล้วผ่าน · ของเครื่องแรกไม่หาย", async () => {
  seed();
  const base = JSON.parse(JSON.stringify(store.data.shop.shopA.smartCategory));
  const addC2 = [{ level: 1, value: [...base[0].value, { id: "c2", name: "หมวดบี", level: 1, aboveId: [] }] }];
  const addC3 = [{ level: 1, value: [...base[0].value, { id: "c3", name: "หมวดซี", level: 1, aboveId: [] }] }];
  assert.equal((await shopCall({ shopId: "shopA", ops: [{ op: "set", field: "smartCategory", base, value: addC2 }] }, OWNER)).code, 200);
  const stale = await shopCall({ shopId: "shopA", ops: [{ op: "set", field: "smartCategory", base, value: addC3 }] }, STAFF);
  assert.equal(stale.code, 409); assert.equal(stale.body.error, "shop_changed");
  const fresh = JSON.parse(JSON.stringify(store.data.shop.shopA.smartCategory));
  const merged = [{ level: 1, value: [...fresh[0].value, { id: "c3", name: "หมวดซี", level: 1, aboveId: [] }] }];
  assert.equal((await shopCall({ shopId: "shopA", ops: [{ op: "set", field: "smartCategory", base: fresh, value: merged }] }, STAFF)).code, 200);
  assert.deepEqual(store.data.shop.shopA.smartCategory[0].value.map((x) => x.id), ["c1", "c2", "c3"]);
});

test("shop.update: เขียนแล้ว doc ร้านยังผ่าน entity Shop (แอปเก่าอ่านรูปเดิม) · cutOff เป็นเวลา", async () => {
  seed();
  await shopCall({ shopId: "shopA", ops: [{ op: "set", field: "cutOff", value: "2011-01-01T06:00:00+07:00" }, { op: "merge", field: "receipt", value: { footer: "ขอบคุณ" } }] }, OWNER);
  const doc = store.data.shop.shopA;
  assert.ok(doc.cutOff instanceof Date);
  assert.equal(schema.Shop.safeParse(doc).success, true);
});

// ───────── ② ลำดับหลายขั้น ─────────

test("staff.manage: เพิ่ม → แก้ → ถอด · ผู้รับแจ้งเตือนตามจริง · ถอดซ้ำ = removed:false", async () => {
  seed();
  assert.equal((await staffCall({ shopId: "shopA", op: "add", staffId: "u-new", rights: ["100"], notify: ["shift"] }, OWNER)).code, 200);
  assert.deepEqual(store.data.shop.shopA.notiShift, ["u-owner", "u-new"]);
  const u = await staffCall({ shopId: "shopA", op: "update", staffId: "u-new", password: "5555", notify: { cancel: true } }, OWNER);
  assert.equal(u.body.staff.hasPassword, true); assert.equal(u.body.staff.password, undefined);
  assert.deepEqual(store.data.shop.shopA.notiCancelBill, ["u-owner", "u-new"]);
  assert.equal(store.data.shop.shopA.humanResource.find((p) => p.id === "u-staff").password, "9999", "รหัสคนอื่นไม่ถูกทับ (C18)");
  assert.equal((await staffCall({ shopId: "shopA", op: "remove", staffId: "u-new" }, OWNER)).body.removed, true);
  assert.deepEqual([store.data.shop.shopA.notiShift, store.data.shop.shopA.notiCancelBill], [["u-owner"], ["u-owner"]]);
  assert.equal((await staffCall({ shopId: "shopA", op: "remove", staffId: "u-new" }, OWNER)).body.removed, false);
});

test("DI-12: ถอดพนักงานที่ค้างเข้างาน แล้วเพิ่มกลับ → กดครั้งแรกเป็นเข้างาน (ไม่ใช่ออกด้วยเวลาเก่า)", async () => {
  seed();
  const req = { auth: { uid: "u-staff" } };
  const img = "https://img.example.com/a.jpg";
  assert.equal((await ciCall({ shopId: "shopA", op: "in", requestId: "r-in-1", imageUrl: img }, req)).code, 200);
  await staffCall({ shopId: "shopA", op: "remove", staffId: "u-staff" }, OWNER);
  assert.equal(store.data.checkIn && store.data.checkIn["shopAu-staff"], undefined);
  const closed = Object.values(store.data.checkInHistory || {});
  assert.equal(closed.length, 1); assert.equal(closed[0].autoClosed, "staff_removed");
  await staffCall({ shopId: "shopA", op: "add", staffId: "u-staff", rights: ["103"] }, OWNER);
  const out = await ciCall({ shopId: "shopA", op: "out", requestId: "r-out-1", imageUrl: img }, req);
  assert.equal(out.code, 409); assert.equal(out.body.error, "not_checked_in");
});

test("staff.checkIn: เข้า → ออก → ออกซ้ำ (duplicate) → เข้าใหม่ · ประวัติ 1 ใบ แจ้งเตือน 2 ใบ · ค้นด้วยคีย์แอปเก่าเจอ", async () => {
  seed();
  const req = { auth: { uid: "u-staff" } };
  const img = "https://img.example.com/a.jpg";
  await ciCall({ shopId: "shopA", op: "in", requestId: "r1", imageUrl: img }, req);
  NOW = new Date("2026-11-10T11:00:00.000Z");
  const o1 = await ciCall({ shopId: "shopA", op: "out", requestId: "r2", imageUrl: img }, req);
  const o2 = await ciCall({ shopId: "shopA", op: "out", requestId: "r2", imageUrl: img }, req);
  assert.equal(o1.body.duplicate, false); assert.equal(o2.body.duplicate, true);
  const hist = Object.values(store.data.checkInHistory);
  assert.equal(hist.length, 1);
  // แอปเก่า: where('id','==', shop.id + profileId) · เว็บ: where shopId == shop doc id · billDate
  assert.equal(hist[0].id, "shopAu-staff"); assert.equal(hist[0].shopId, "shopA"); assert.equal(hist[0].billDate, "20261110");
  assert.equal(schema.CheckInHistory.safeParse(hist[0]).success, true);
  assert.equal(Object.keys(store.data.notification).length, 2);
  const again = await ciCall({ shopId: "shopA", op: "in", requestId: "r3", imageUrl: img }, req);
  assert.equal(again.code, 200);
  assert.equal(schema.CheckIn.safeParse(store.data.checkIn["shopAu-staff"]).success, true);
  NOW = new Date("2026-11-10T03:00:00.000Z");
});

test("expense: สร้างซ้ำ (เน็ตหลุด) ได้ใบเดียว · แอปเก่าค้น where shopId == field ร้านเจอ · ผ่าน entity Expense", async () => {
  seed();
  const body = { shopId: "shopA", op: "create", expenseId: "e-new", name: "ค่าน้ำ", category: ["ce1"], priceStatus: true, price: "300" };
  assert.equal((await expCall(body, OWNER)).body.duplicate, false);
  assert.equal((await expCall(body, OWNER)).body.duplicate, true);
  const found = await store.db.collection("expense").where("shopId", "==", "shopA").get();
  assert.equal(found.docs.length, 1);
  assert.equal(schema.Expense.safeParse(found.docs[0].data()).success, true);
});

test("expenseReport: เพิ่ม → แก้ → ลบ · ยอดสรุปตามจริง · ร่องรอยแก้ลบ · ผ่าน entity ExpenseReport", async () => {
  seed();
  await expCall({ shopId: "shopA", op: "create", expenseId: "e1", name: "ค่าไฟ", category: [], priceStatus: false, price: "" }, OWNER);
  const add = (rowId, price) => repCall({ shopId: "shopA", op: "add", month: "202611", rowId, expenseId: "e1", price, note: "" }, STAFF);
  assert.equal((await add("r1", "0.1")).body.created, true);
  const a2 = await add("r2", "0.2");
  assert.equal(a2.body.summary.total, 0.3, "บวกเป็นสตางค์ ไม่ใช่ 0.30000000000000004");
  await repCall({ shopId: "shopA", op: "update", month: "202611", rowId: "r1", price: "1" }, OWNER);
  const del = await repCall({ shopId: "shopA", op: "delete", month: "202611", rowId: "r2" }, OWNER);
  assert.equal(del.body.summary.total, 1);
  const doc = store.data.expenseReport.shopA202611;
  assert.equal(doc.expenses[0].updatedBy, "เจ้าของ"); assert.equal(doc.expenses[0].createdby, "พนักงานบี");
  assert.equal(doc.deleted[0].id, "r2"); assert.equal(doc.deleted[0].deletedBy, "เจ้าของ");
  assert.equal(schema.ExpenseReport.safeParse(doc).success, true);
});

test("profile: สร้าง → เข้าร้าน → profile.loading ของแอปเก่าหาเจอ (currentLogin.shopId = field ร้าน) → เอาร้านออก", async () => {
  seed();
  assert.equal((await profCall({ op: "create", name: "ใหม่", tel: "0899999999", email: "x@example.com" }, { auth: { uid: "u-x" } })).body.created, true);
  store.data.shop.shopA.humanResource.push({ id: "u-x", position: [], status: "active", rights: ["100"] });
  const e = await profCall({ op: "enterShop", shopId: "shopA" }, { auth: { uid: "u-x" } });
  assert.equal(e.code, 200);
  const p = store.data.profile["u-x"];
  const hit = await store.db.collection("shop").where("shopId", "==", p.currentLogin.shopId).get();
  assert.equal(hit.docs.length, 1);
  assert.equal(schema.Profile.safeParse(p).success, true);
  await profCall({ op: "removePort", portShopId: "shopA" }, { auth: { uid: "u-x" } });
  assert.deepEqual(store.data.profile["u-x"].port, []);
});

test("พนักงานที่ถูกปิดใช้งานระหว่างใช้งาน → ทุกทางเขียนปัด (decision 2026-11-06 · ตรวจซ้ำใน transaction)", async () => {
  seed();
  await staffCall({ shopId: "shopA", op: "update", staffId: "u-staff", status: "inActive" }, OWNER);
  const r = await Promise.all([
    shopCall({ shopId: "shopA", ops: [{ op: "set", field: "name", value: "x" }] }, STAFF),
    staffCall({ shopId: "shopA", op: "update", staffId: "u-staff", status: "active" }, STAFF),
    expCall({ shopId: "shopA", op: "delete", expenseId: "e1" }, STAFF),
    repCall({ shopId: "shopA", op: "delete", month: "202611", rowId: "r1" }, STAFF),
    ciCall({ shopId: "shopA", op: "in", requestId: "r9", imageUrl: "https://img.example.com/a.jpg" }, { auth: { uid: "u-staff" } }),
    profCall({ op: "enterShop", shopId: "shopA" }, { auth: { uid: "u-staff" } }),
  ]);
  for (const x of r) { assert.equal(x.code, 403); assert.equal(x.body.error, "not_shop_member"); }
});

// ───────── รอบแก้ 9c (ผลตรวจ 9c-shop-staff.verify.md) ─────────
const CASHIER = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const addCashier = () => store.data.shop.shopA.humanResource.push({ id: "u-cash", name: "แคชเชียร์", position: [], status: "active", rights: ["100"], password: "" });

test("W1 + M1: แคชเชียร์สิทธิ์ 100 ผูกเครื่อง A กับจุด 2 · เครื่อง B ผูกซ้ำโดนปัด · เครื่อง A ส่งซ้ำได้ผลเดิม", async () => {
  seed(); addCashier();
  const claim = (dev) => shopCall({ shopId: "shopA", ops: [{ op: "claimPos", field: "POSs", id: "pos-2", uniqueId: dev, deviceName: `เครื่อง ${dev}` }] }, CASHIER);
  const a = await claim("dev-A");
  assert.equal(a.code, 200); assert.equal(a.body.pos.uniqueId, "dev-A");
  const b = await claim("dev-B");
  assert.equal(b.code, 409); assert.equal(b.body.error, "pos_in_use");
  assert.equal(store.data.shop.shopA.POSs[1].uniqueId, "dev-A", "เครื่องหลังไม่ทับเงียบ");
  const again = await claim("dev-A");
  assert.equal(again.code, 200); assert.equal(again.body.changed, false); assert.equal(again.body.pos.id, "pos-2");
  assert.equal(store.data.shop.shopA.POSs[0].drawer, true, "จุดอื่นไม่ถูกแตะ");
});

test("W1 + C18: แคชเชียร์ตั้งรหัสครั้งแรก → ส่งซ้ำได้ผลเดิม → อีกเครื่องตั้งทับไม่ได้ · ตั้งรหัสเจ้าของไม่ได้", async () => {
  seed(); addCashier();
  const set = (staffId, password) => staffCall({ shopId: "shopA", op: "setCashierCode", staffId, password }, CASHIER);
  assert.equal((await set("u-cash", "5555")).body.duplicate, false);
  assert.equal((await set("u-cash", "5555")).body.duplicate, true);
  const over = await set("u-cash", "0000");
  assert.equal(over.code, 409); assert.equal(over.body.error, "code_already_set");
  store.data.shop.shopA.humanResource[0].password = "";
  assert.equal((await set("u-owner", "0000")).body.error, "owner_required");
  const hr = store.data.shop.shopA.humanResource;
  assert.equal(hr.find((p) => p.id === "u-cash").password, "5555");
  assert.equal(hr.find((p) => p.id === "u-owner").password, "");
});

test("W2: แก้หมวดสินค้าสำเร็จแล้วส่งคำขอเดิมซ้ำ (เน็ตหลุดตอนรอคำตอบ) → 200 ไม่ใช่ 409", async () => {
  seed();
  const base = JSON.parse(JSON.stringify(store.data.shop.shopA.smartCategory));
  const value = [{ level: 1, value: [...base[0].value, { id: "c2", name: "หมวดบี", level: 1, aboveId: [] }] }];
  const body = { shopId: "shopA", ops: [{ op: "set", field: "smartCategory", base, value }] };
  assert.equal((await shopCall(body, OWNER)).code, 200);
  const again = await shopCall(body, OWNER);
  assert.equal(again.code, 200); assert.equal(again.body.changed, false);
});

test("W3: เข้างาน R1 → ออกงาน R2 → ส่งเข้างาน R1 ซ้ำ → ไม่เกิดใบเข้างานลอย", async () => {
  seed();
  const ci = (op, requestId) => ciCall({ shopId: "shopA", op, requestId, imageUrl: "https://img.example.com/a.jpg" }, { auth: { uid: "u-staff" } });
  assert.equal((await ci("in", "R1")).body.duplicate, false);
  NOW = new Date("2026-11-10T09:00:00.000Z");
  assert.equal((await ci("out", "R2")).body.duplicate, false);
  const late = await ci("in", "R1");
  assert.equal(late.code, 200); assert.equal(late.body.duplicate, true);
  assert.equal(store.data.checkIn && store.data.checkIn["shopAu-staff"], undefined, "ไม่มีใบค้างใหม่");
  NOW = new Date("2026-11-10T03:00:00.000Z");
});

test("W4: ค้นเบอร์คืนแค่ id ชื่อ รูป inShop · เพิ่มพนักงานไม่คืนอีเมล เบอร์", async () => {
  seed();
  const f = await staffCall({ shopId: "shopA", op: "find", tel: "0811111119" }, OWNER);
  assert.deepEqual(Object.keys(f.body.people[0]).sort(), ["id", "imageId", "inShop", "name"]);
  const a = await staffCall({ shopId: "shopA", op: "add", staffId: "u-new", rights: ["100"], notify: [] }, OWNER);
  assert.equal(a.body.staff.email, undefined); assert.equal(a.body.staff.tel, undefined); assert.equal(a.body.staff.password, undefined);
  assert.equal(store.data.shop.shopA.humanResource.at(-1).email, "n@example.com", "ในฐานยังเก็บรูปเดิมให้แอปเก่า");
});

test("M5: เพิ่มพนักงานสำเร็จแล้วส่งซ้ำ → 200 existed ไม่เกิดแถวซ้ำ", async () => {
  seed();
  const body = { shopId: "shopA", op: "add", staffId: "u-new", rights: ["100"], notify: ["shift"] };
  assert.equal((await staffCall(body, OWNER)).body.existed, false);
  const again = await staffCall(body, OWNER);
  assert.equal(again.code, 200); assert.equal(again.body.existed, true);
  assert.equal(store.data.shop.shopA.humanResource.filter((p) => p.id === "u-new").length, 1);
  assert.equal(store.data.shop.shopA.notiShift.filter((x) => x === "u-new").length, 1);
});

test("M3: ปิดใช้งานพนักงานที่ยังไม่ออกงาน → ใบค้างถูกปิดเข้าประวัติ ไม่ค้างตลอดไป", async () => {
  seed();
  await ciCall({ shopId: "shopA", op: "in", requestId: "R1", imageUrl: "https://img.example.com/a.jpg" }, { auth: { uid: "u-staff" } });
  const r = await staffCall({ shopId: "shopA", op: "update", staffId: "u-staff", status: "inActive" }, OWNER);
  assert.equal(r.body.closedCheckIn, true);
  assert.equal(store.data.checkIn["shopAu-staff"], undefined);
  const hist = Object.values(store.data.checkInHistory || {});
  assert.equal(hist.length, 1); assert.equal(hist[0].autoClosed, "staff_inactive"); assert.equal(hist[0].requestId, "R1");
  assert.equal(schema.CheckInHistory.safeParse(hist[0]).success, true, "ใบที่ระบบปิดให้ผ่าน entity");
});

test("W6: ช่องจ่ายใหม่ส่ง mortal:true → ในฐาน mortal:false · ลบได้", async () => {
  seed();
  await shopCall({ shopId: "shopA", ops: [{ op: "upsertRow", field: "shopchampPayment", row: { id: 9, name: "คูปอง", mortal: true } }] }, OWNER);
  assert.equal(store.data.shop.shopA.shopchampPayment.find((r) => r.id === 9).mortal, false);
  const del = await shopCall({ shopId: "shopA", ops: [{ op: "removeRow", field: "shopchampPayment", id: 9 }] }, OWNER);
  assert.equal(del.code, 200);
});

// ───────── จุดขายเพิ่ม/ลบผ่าน pos.manage อย่างเดียว (Pack เคาะ 2026-11-07 · gaps-round-2a) ─────────
test("POSs: เพิ่มแถวใหม่หรือลบแถว ผ่าน shop.update → 409 use_pos_manage ไม่เขียน · แก้แถวเดิม (ชื่อ เครื่องพิมพ์) ยังได้", async () => {
  seed();
  const before = JSON.parse(JSON.stringify(store.data.shop.shopA));
  const add = await shopCall({ shopId: "shopA", ops: [{ op: "upsertRow", field: "POSs", row: { id: "pos-3", name: "จุด 3" } }] }, OWNER);
  assert.equal(add.code, 409); assert.equal(add.body.error, "use_pos_manage"); assert.equal(add.body.op, "upsertRow");
  const del = await shopCall({ shopId: "shopA", ops: [{ op: "removeRow", field: "POSs", id: "pos-2" }] }, OWNER);
  assert.equal(del.code, 409); assert.equal(del.body.error, "use_pos_manage"); assert.equal(del.body.op, "removeRow");
  const gone = await shopCall({ shopId: "shopA", ops: [{ op: "removeRow", field: "POSs", id: "pos-9" }] }, OWNER);
  assert.equal(gone.code, 409, "แถวที่ไม่มีก็ปัด ไม่ใช่ผ่านเงียบ"); assert.equal(gone.body.error, "use_pos_manage");
  const mixed = await shopCall({ shopId: "shopA", ops: [{ op: "set", field: "name", value: "ชื่อใหม่" }, { op: "upsertRow", field: "POSs", row: { id: "pos-3", name: "จุด 3" } }] }, OWNER);
  assert.equal(mixed.code, 409);
  assert.deepEqual(JSON.parse(JSON.stringify(store.data.shop.shopA)), before, "ทุกคำขอที่ถูกปัดไม่เขียนอะไรเลย");
  assert.equal(Object.keys(store.data.shift || {}).length, 0, "ไม่มี doc shift เกิด");

  const edit = await shopCall({ shopId: "shopA", ops: [{ op: "upsertRow", field: "POSs", row: { id: "pos-1", printerType: "bluetooth", printerSize: 58 } }] }, OWNER);
  assert.equal(edit.code, 200);
  const patch = await shopCall({ shopId: "shopA", ops: [{ op: "patchRow", field: "POSs", id: "pos-2", patch: { printerEthernet: "192.168.1.50" } }] }, STAFF);
  assert.equal(patch.code, 200);
  assert.deepEqual(store.data.shop.shopA.POSs, [
    { id: "pos-1", name: "จุด 1", drawer: true, printerType: "bluetooth", printerSize: 58 },
    { id: "pos-2", name: "จุด 2", printerEthernet: "192.168.1.50" },
  ]);
});

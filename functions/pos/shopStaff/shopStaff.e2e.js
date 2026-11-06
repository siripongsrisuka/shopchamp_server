// pos/shopStaff/shopStaff.e2e.js — โดเมนร้านและพนักงานบน Firestore emulator ตัวจริง (ก้อน 9c · DEV-0001 · M6 ของผลตรวจ)
//   วัดสิ่งที่ฐานปลอมวัดไม่ได้: transaction จริงของ SDK (อ่านก่อนเขียน · retry ตอนชนกัน) · resolveShopRef ที่ query นอก tx กลาง callback
//   · Timestamp จริง · 2 เครื่องยิงพร้อมกันจริง
// รัน: cd shopchamp_server/functions && node pos/e2e/run.js pos/shopStaff/shopStaff.e2e.js
//   ❌ ไม่แตะฐานจริง: _env ปัดถ้าไม่ใช่ emulator บนเครื่องนี้ + project demo-
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../e2e/_env");
const kit = require("./testKit");
const S = kit.ensureSchema(); // ก่อนแม่ผูก export: ใช้ schema จาก src ของ center (ไม่แทน firebase · ใช้ตัวจริงที่ต่อ emulator)
kit.ensureLogic();
const { shopUpdate } = require("./shopUpdate");
const { staffManage } = require("./staffManage");
const { checkIn } = require("./checkIn");
const { expenseManage } = require("./expenseManage");
const { expenseReportManage } = require("./expenseReportManage");

const { call, seed, get, where, T, ns, clock } = E;
before(() => E.ready());

function fixture() {
  const n = ns();
  const id = { shop: `shop9c${n}`, owner: `u-owner${n}`, staff: `u-staff${n}`, cash: `u-cash${n}` };
  const far = T("2027-01-01T00:00:00.000Z");
  const shop = {
    shopId: id.shop, name: "ร้านทดสอบ", receiptPattern: "month",
    POSs: [{ id: "pos-1", name: "จุด 1", shiftId: "sh1", drawer: true }, { id: "pos-2", name: "จุด 2", shiftId: "sh2" }],
    shopchampPayment: [{ id: 1, name: "เงินสด", mortal: true, status: true }],
    taxCustomer: [],
    humanResource: [
      { id: id.owner, name: "เจ้าของ", email: "o@example.com", tel: "0811111110", imageId: "", position: ["001"], status: "active", rights: [], password: "1234" },
      { id: id.staff, name: "พนักงานบี", email: "s@example.com", tel: "0811111112", imageId: "", position: [], status: "active", rights: ["101", "103", "131"], password: "9999" },
      { id: id.cash, name: "แคชเชียร์", email: "c@example.com", tel: "0811111113", imageId: "", position: [], status: "active", rights: ["100", "103"], password: "" },
    ],
    vip: [{ type: "premium", expire: far }, { type: "staff", expire: far }],
    smartCategory: [{ level: 1, value: [{ id: "c1", name: "หมวดเอ", level: 1, aboveId: [] }] }],
    categoryExpense: [{ level: 1, value: [{ id: "ce1", name: "ค่าน้ำไฟ", level: 1, aboveId: [] }] }],
    notiShift: [id.owner], notiCancelBill: [id.owner], cutOff: T("2010-12-31T17:00:00.000Z"),
  };
  const profile = {
    [id.owner]: { name: "เจ้าของ", tel: "0811111110", email: "o@example.com", imageId: "", port: [], currentLogin: { shopId: "", rights: [], printer: [] } },
    [id.staff]: { name: "พนักงานบี", tel: "0811111112", email: "s@example.com", imageId: "", port: [], currentLogin: { shopId: "", rights: [], printer: [] } },
    [id.cash]: { name: "แคชเชียร์", tel: "0811111113", email: "c@example.com", imageId: "", port: [], currentLogin: { shopId: "", rights: [], printer: [] } },
  };
  const access = (uid, role, rights) => ({ shopId: id.shop, uid, role, rights });
  return {
    id, data: { shop: { [id.shop]: shop }, profile },
    owner: access(id.owner, "owner", []), staff: access(id.staff, "staff", ["101", "103", "131"]), cash: access(id.cash, "staff", ["100", "103"]),
  };
}
const NOW = clock("2026-11-10T03:00:00.000Z");
const img = "https://img.example.com/a.jpg";

test("e2e W1+M1: 2 เครื่องแคชเชียร์ผูกจุดขายเดียวกันพร้อมกัน → ได้เครื่องเดียว อีกเครื่อง 409 · จุดอื่นไม่ถูกแตะ", async () => {
  const f = fixture(); await seed(f.data);
  const claim = (dev) => call(shopUpdate, NOW, { body: { shopId: f.id.shop, ops: [{ op: "claimPos", field: "POSs", id: "pos-2", uniqueId: dev, deviceName: dev }] }, shopAccess: f.cash });
  const [a, b] = await Promise.all([claim("dev-A"), claim("dev-B")]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([a.body, b.body]));
  const shop = await get("shop", f.id.shop);
  const winner = a.status === 200 ? "dev-A" : "dev-B";
  assert.equal(shop.POSs[1].uniqueId, winner);
  assert.equal(shop.POSs[0].drawer, true);
  assert.ok(shop.cutOff && typeof shop.cutOff.toMillis === "function", "cutOff ยังเป็น Timestamp");
});

test("e2e #14 + W2: 2 เครื่องแก้คนละจุดขายพร้อมกันไม่ทับกัน · ส่งหมวดซ้ำหลังสำเร็จ 200", async () => {
  const f = fixture(); await seed(f.data);
  const p = (id, name, who) => call(shopUpdate, NOW, { body: { shopId: f.id.shop, ops: [{ op: "patchRow", field: "POSs", id, patch: { name } }] }, shopAccess: who });
  const r = await Promise.all([p("pos-1", "หน้าร้าน", f.owner), p("pos-2", "หลังร้าน", f.staff)]);
  assert.deepEqual(r.map((x) => x.status), [200, 200]);
  const shop = await get("shop", f.id.shop);
  assert.deepEqual(shop.POSs.map((x) => x.name), ["หน้าร้าน", "หลังร้าน"]);
  const base = shop.smartCategory;
  const value = [{ level: 1, value: [...base[0].value, { id: "c2", name: "หมวดบี", level: 1, aboveId: [] }] }];
  const body = { shopId: f.id.shop, ops: [{ op: "set", field: "smartCategory", base, value }] };
  assert.equal((await call(shopUpdate, NOW, { body, shopAccess: f.owner })).status, 200);
  const again = await call(shopUpdate, NOW, { body, shopAccess: f.owner });
  assert.equal(again.status, 200); assert.equal(again.body.changed, false);
});

test("e2e W1+C18: แคชเชียร์ตั้งรหัสครั้งแรกพร้อมกัน 2 เครื่อง (คนละรหัส) → รหัสเดียวติด อีกเครื่อง 409", async () => {
  const f = fixture(); await seed(f.data);
  const set = (pw) => call(staffManage, NOW, { body: { shopId: f.id.shop, op: "setCashierCode", staffId: f.id.cash, password: pw }, shopAccess: f.cash });
  const [a, b] = await Promise.all([set("1111"), set("2222")]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const hr = (await get("shop", f.id.shop)).humanResource;
  assert.equal(hr.find((x) => x.id === f.id.cash).password, a.status === 200 ? "1111" : "2222");
  assert.equal(hr.find((x) => x.id === f.id.owner).password, "1234");
  const w5 = await call(staffManage, NOW, { body: { shopId: f.id.shop, op: "update", staffId: f.id.owner, password: "0000" }, shopAccess: f.staff });
  assert.equal(w5.status, 403); assert.equal(w5.body.error, "owner_required");
});

test("e2e W3+M3: เข้างาน R1 → ออก R2 → ส่ง R1 ซ้ำไม่เกิดใบ · เข้าใหม่แล้วถูกปิดใช้งาน → ใบปิดเข้าประวัติ แอปเก่าค้นเจอ", async () => {
  const f = fixture(); await seed(f.data);
  const ci = (op, requestId, iso) => call(checkIn, clock(iso), { body: { shopId: f.id.shop, op, requestId, imageUrl: img }, auth: { uid: f.id.staff } });
  const r1 = `R1${f.id.shop}`, r2 = `R2${f.id.shop}`, r3 = `R3${f.id.shop}`;
  assert.equal((await ci("in", r1, "2026-11-10T01:00:00.000Z")).status, 200);
  assert.equal((await ci("out", r2, "2026-11-10T09:00:00.000Z")).status, 200);
  const late = await ci("in", r1, "2026-11-10T09:05:00.000Z");
  assert.equal(late.status, 200); assert.equal(late.body.duplicate, true);
  assert.equal(await get("checkIn", `${f.id.shop}${f.id.staff}`), undefined);
  assert.equal((await ci("in", r3, "2026-11-10T10:00:00.000Z")).status, 200);
  const off = await call(staffManage, clock("2026-11-10T11:00:00.000Z"), { body: { shopId: f.id.shop, op: "update", staffId: f.id.staff, status: "inActive" }, shopAccess: f.owner });
  assert.equal(off.status, 200); assert.equal(off.body.closedCheckIn, true);
  assert.equal(await get("checkIn", `${f.id.shop}${f.id.staff}`), undefined);
  const hist = await where("checkInHistory", "id", `${f.id.shop}${f.id.staff}`); // แอปเก่าค้นด้วย where id == (CheckInScreen.js:48)
  assert.equal(hist.length, 2);
  for (const h of hist) assert.equal(S.CheckInHistory.safeParse(h).success, true, JSON.stringify(h).slice(0, 300));
  assert.deepEqual(hist.map((h) => h.autoClosed || "").sort(), ["", "staff_inactive"]);
});

test("e2e M5 + W4: เพิ่มพนักงานพร้อมกัน 2 ครั้ง → แถวเดียว · คำตอบไม่มีอีเมลเบอร์", async () => {
  const f = fixture(); f.data.profile["u-new" + f.id.shop] = { name: "คนใหม่", tel: "0899999998", email: "n@example.com", imageId: "", port: [] };
  await seed(f.data);
  const body = { shopId: f.id.shop, op: "add", staffId: "u-new" + f.id.shop, rights: ["100"], notify: ["shift"] };
  const r = await Promise.all([call(staffManage, NOW, { body, shopAccess: f.owner }), call(staffManage, NOW, { body, shopAccess: f.owner })]);
  assert.deepEqual(r.map((x) => x.status), [200, 200]);
  assert.deepEqual(r.map((x) => x.body.existed).sort(), [false, true]);
  for (const x of r) { assert.equal(x.body.staff.email, undefined); assert.equal(x.body.staff.tel, undefined); }
  const shop = await get("shop", f.id.shop);
  assert.equal(shop.humanResource.filter((p) => p.id === body.staffId).length, 1);
  assert.equal(shop.notiShift.filter((x) => x === body.staffId).length, 1);
});

test("e2e expense + expenseReport: resolveShopRef ใน transaction จริง · doc เดือน id = field ร้าน + เดือน · แอปเก่าค้นเจอ", async () => {
  const f = fixture(); await seed(f.data);
  const eid = `e${f.id.shop}`;
  const c = await call(expenseManage, NOW, { body: { shopId: f.id.shop, op: "create", expenseId: eid, name: "ค่าไฟ", category: ["ce1"], priceStatus: false, price: "" }, shopAccess: f.owner });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const add = (rowId) => call(expenseReportManage, NOW, { body: { shopId: f.id.shop, op: "add", month: "202611", rowId, expenseId: eid, price: "0.1", note: "" }, shopAccess: f.staff });
  const r = await Promise.all([add("r1"), add("r2")]);
  assert.deepEqual(r.map((x) => x.status), [200, 200], JSON.stringify(r.map((x) => x.body)));
  const doc = await get("expenseReport", `${f.id.shop}202611`);
  assert.equal(doc.expenses.length, 2, "2 เครื่องเพิ่มพร้อมกัน ไม่หายแถว");
  assert.equal(S.ExpenseReport.safeParse(doc).success, true);
  const byShop = await where("expense", "shopId", f.id.shop); // expenseSlice.js:30
  assert.equal(byShop.length, 1);
});

// เทสเว็บแฟรนไชส์ (ก้อน 9f · DEV-0002) · ของที่ชุด case ของสัญญา franchise.*.yaml คุมไม่ได้
//   harness เทียบ body แบบ partial ⇒ พิสูจน์ "ช่องไม่โผล่ในแถวของ array" ไม่ได้ · ที่นี่เทียบช่องของแถวครบทุกตัว
//   รัน: node --test functions/pos/franchise/franchise.test.js
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ด้วยฐานปลอมของ gate/api-harness.js ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const CENTER = path.resolve(__dirname, "../../../../shopchamp-center");
const HARNESS = path.join(CENTER, "gate/api-harness.js");
const HAVE_CENTER = fs.existsSync(HARNESS);
const S = require("@shopchamp/schema");
const READY = HAVE_CENTER && !!S.FranchiseGetRequest;
const skip = !READY && "ต้องมี shopchamp-center และ @shopchamp/schema ที่มี Franchise* (vendor รุ่นก้อน 9f)";

let H, DB = {}, WRITES = [];
function load(file) {
  H = H || require(HARNESS);
  const fbAbs = require.resolve("../../firebase");
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: H.makeDb(() => DB, (w) => WRITES.push(w)), admin: {}, bucket: {} } };
  for (const f of ["./_franchise", "./read", "./branch", "./staff", "./franchise", "./billList", "./breakdown"]) delete require.cache[require.resolve(f)];
  return require(file);
}
async function call(make, body, uid) {
  DB = H.reviveSeed(SEED());
  WRITES = [];
  const res = H.makeRes();
  await make({ now: () => new Date("2026-11-10T03:00:00.000Z") })({ body, auth: uid ? { uid } : undefined }, res);
  return res;
}
const SEED = () => ({
  // ทีมงาน = watcher/roster (DEV-0001 watcher) · u-admin = root · u-watch = watcher อ่านอย่างเดียว · u-old อยู่แค่ adminConfig (ขาเก่า ต้องไม่ใช่ทีมงาน)
  watcher: { roster: { uids: ["u-admin", "u-watch"], rootUids: ["u-admin"] } },
  admin: { adminConfig: { admin: ["u-admin", "u-old"] } },
  franchise: {
    FA: {
      name: "เอ", humanResource: ["u-owner"],
      humanRight: [{ id: "u-owner", name: "เจ้าของ", tel: "081", email: "o@x", imageId: "", rights: ["100", "128", "723"], port: [{ shopId: "s1" }], currentLogin: { shopId: "s1", rights: ["1"] }, birthday: "2000", gender: "x" }],
    },
  },
  shop: {
    s1: { shopId: "s1", name: "สาขา", tel: "0811000001", franchiseId: "FA", humanResource: [{ id: "u", password: "1234" }], line: { token: "t" }, vip: [] },
    s2: { shopId: "s2", name: "ร้านยังไม่มีสังกัด", tel: "0811000002" },
  },
  profile: { p1: { name: "ใหม่", tel: "0899999999", email: "n@x", imageId: "", port: [{ shopId: "s9" }], currentLogin: { shopId: "s9" }, birthday: "1999" } },
  bill: {
    b1: { franchiseId: "FA", shopId: "s1", billDate: "20261110", dateTime: { __ts__: "2026-11-10T05:00:00.000Z" }, receiptNumber: "R1", moneyMustPaid: 90, manualDiscount: 10,
      member: { id: "m1", name: "สมาชิก", tel: "0899" }, payment: [{ id: 1, name: "เงินสด", amount: 90 }],
      product: [{ id: "p1", name: "น้ำ", barcode: "885001", qty: 1, net: 60, totalPrice: 60, totalCost: 30 }, { id: "p2", name: "ขนม", barcode: "", qty: 1, net: 40, totalPrice: 40, totalCost: 20 }] },
    bv: { franchiseId: "FA", shopId: "s1", billDate: "20261110", dateTime: { __ts__: "2026-11-10T06:00:00.000Z" }, receiptNumber: "RV", moneyMustPaid: 50, void: true, product: [] },
  },
});

test("franchise.get · แถว humanRight มีแค่ช่องของแถว (SF-02 · ไม่มี port currentLogin birthday gender)", { skip }, async () => {
  const { get } = load("./read");
  const r = await call(get, { franchiseId: "FA" }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.franchise.humanRight[0]).sort(), ["email", "id", "imageId", "name", "rights", "tel"]);
});

test("franchise.branchList · แถวสาขามีแค่ id name tel dateTime (FD-B2 · ไม่มี humanResource line vip)", { skip }, async () => {
  const { branchList } = load("./read");
  const r = await call(branchList, { franchiseId: "FA" }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.branches[0]).sort(), ["dateTime", "id", "name", "tel"]);
  assert.ok(!JSON.stringify(r.body).includes("1234"), "รหัสพนักงานหลุดในคำตอบ");
});

test("franchise.branchFind · แถวร้านมีแค่ 5 ช่อง ไม่มีรหัสพนักงาน (FD-B2)", { skip }, async () => {
  const { branchFind } = load("./branch");
  const r = await call(branchFind, { franchiseId: "FA", tel: "0811000001" }, "u-admin");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.shops[0]).sort(), ["franchiseId", "id", "inThisFranchise", "name", "tel"]);
  assert.ok(!JSON.stringify(r.body).includes("1234"));
});

test("franchise.staffFind · แถว profile มีแค่ 5 ช่อง (SF-16)", { skip }, async () => {
  const { staffFind } = load("./staff");
  const r = await call(staffFind, { franchiseId: "FA", tel: "0899999999" }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.profiles[0]).sort(), ["alreadyStaff", "id", "imageId", "name", "tel"]);
});

test("franchise.staffSave add · แถวที่เขียนทุกแถวมีแค่ช่องของแถว (SF-02 · ล้างของเดิมด้วย)", { skip }, async () => {
  const { staffSave } = load("./staff");
  const r = await call(staffSave, { franchiseId: "FA", op: "add", staffUid: "p1", rights: ["100"] }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const w = WRITES.find((x) => x.path === "franchise/FA");
  for (const row of w.data.humanRight) assert.deepEqual(Object.keys(row).sort(), ["email", "id", "imageId", "name", "rights", "tel"]);
  assert.ok(!JSON.stringify(w.data).includes("s9"), "ช่องของ profile ติดลงแถว");
});

test("franchise.create · doc ใหม่ผ่าน schema อ่าน Franchise และแถวผู้สร้างผ่าน FranchiseStaffRow", { skip }, async () => {
  const { create } = load("./franchise");
  const r = await call(create, { franchiseUUID: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", name: "บี" }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const w = WRITES[0];
  const doc = { ...w.data, timestamp: new Date(w.data.timestamp) };
  assert.ok(S.Franchise.safeParse(doc).success);
  assert.deepEqual(doc.humanRight[0].rights, ["100", "103", "104", "107", "128", "723", "130"]);
});

test("franchise.breakdown · ตัวเลขเท่า logic.salesBreakdown ของสาขาตรง ๆ (สูตรกลาง · Pack เคาะ 2026-11-07) · แถวมีแค่ช่องของแถว ไม่มีบิล สมาชิก ช่องจ่าย ต้นทุน", { skip }, async () => {
  const { breakdown } = load("./breakdown");
  const logic = require("@shopchamp/logic");
  const r = await call(breakdown, { franchiseId: "FA", fromDay: "20261110", toDay: "20261110" }, "u-owner");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["fromDay", "hours", "items", "ok", "shops", "toDay", "totals"]);
  assert.deepEqual(Object.keys(r.body.shops[0]).sort(), ["average", "billQty", "inFranchise", "shopId", "totalSale", "voidQty", "voidTotal"]);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ["barcode", "billDiscountShare", "count", "key", "name", "net", "netAfterBillDiscount", "qty", "totalPrice"]);
  assert.deepEqual(Object.keys(r.body.hours[0]).sort(), ["billQty", "key", "totalSale"]);
  const txt = JSON.stringify(r.body);
  for (const leak of ["m1", "0899", "เงินสด", "totalCost", "R1"]) assert.ok(!txt.includes(leak), `คำตอบมี ${leak}`);
  // ไม้บรรทัด: สาขาเดียว ⇒ ยอดเท่ารายงานร้าน (salesBreakdown) ของร้านนั้นวันเดียวกัน
  const entries = Object.entries(H.reviveSeed(SEED()).bill).map(([id, data]) => ({ id, data }));
  const shopTotals = logic.salesBreakdown(entries, { fromDay: "20261110", toDay: "20261110", dimension: "total" }).totals;
  assert.deepEqual([r.body.totals.billQty, r.body.totals.totalSale, r.body.totals.voidQty, r.body.totals.voidTotal], [shopTotals.billQty, shopTotals.totalSale, shopTotals.voidQty, shopTotals.voidTotal]);
  const shopItems = logic.salesBreakdown(entries, { fromDay: "20261110", toDay: "20261110", dimension: "item" }).rows;
  assert.deepEqual(r.body.items.map((x) => x.netAfterBillDiscount).sort(), shopItems.map((x) => x.netAfterBillDiscount).sort());
  assert.deepEqual(r.body.items.map((x) => x.netAfterBillDiscount).sort(), [36, 54]);
});

// ── DEV-0001 watcher (Pack เคาะ 2026-11-07 ข้อ 2 · 4) ──
test("watcher: อ่านได้ (get · branchList · billList · breakdown) · access มี watcher/readOnly", { skip }, async () => {
  const R = load("./read");
  const g = await call(R.get, { franchiseId: "FA" }, "u-watch");
  assert.equal(g.code, 200, JSON.stringify(g.body));
  assert.equal(g.body.access.watcher, true);
  assert.equal(g.body.access.readOnly, true);
  assert.equal(g.body.access.byAdmin, undefined);
  assert.equal((await call(R.branchList, { franchiseId: "FA" }, "u-watch")).code, 200);
  const { breakdown } = load("./breakdown");
  assert.equal((await call(breakdown, { franchiseId: "FA", fromDay: "20261110", toDay: "20261110" }, "u-watch")).code, 200);
  const l = await call(R.list, {}, "u-watch");
  assert.equal(l.body.staffRole, "watcher");
  assert.equal(l.body.byAdmin, undefined);
  assert.equal((await call(R.list, {}, "u-admin")).body.staffRole, "root");
});

test("watcher: เขียนไม่ได้ (staffSave · profileUpdate · create) → 403 watcher_read_only ไม่เขียน", { skip }, async () => {
  const { staffSave } = load("./staff");
  const r2 = await call(staffSave, { franchiseId: "FA", op: "add", staffUid: "p1", rights: ["100"] }, "u-watch");
  assert.equal(r2.code, 403, JSON.stringify(r2.body));
  assert.equal(r2.body.error, "watcher_read_only");
  const { profileUpdate, create } = load("./franchise");
  const r3 = await call(profileUpdate, { franchiseId: "FA", name: "ใหม่" }, "u-watch");
  assert.equal(r3.body.error, "watcher_read_only");
  const r4 = await call(create, { franchiseUUID: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", name: "บี" }, "u-watch");
  assert.equal(r4.body.error, "watcher_read_only");
  assert.equal(WRITES.length, 0);
});

test("watcher: ค้นสาขาได้ · ผูกสาขาได้ (ข้อยกเว้นเดียว) และลง watcherWriteLog · root ผูกไม่ลงบันทึก", { skip }, async () => {
  const B = load("./branch");
  assert.equal((await call(B.branchFind, { franchiseId: "FA", tel: "0811000001" }, "u-watch")).code, 200);
  const r = await call(B.branchAttach, { franchiseId: "FA", shopId: "s2" }, "u-watch");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(WRITES.map((w) => w.path.split("/")[0]).sort(), ["shop", "watcherWriteLog"]);
  const log = WRITES.find((w) => w.path.startsWith("watcherWriteLog/"));
  assert.equal(log.path, "watcherWriteLog/FA_s2_" + new Date("2026-11-10T03:00:00.000Z").getTime());
  assert.equal(log.data.uid, "u-watch");
  assert.equal(log.data.op, "franchise.branchAttach");
  const rr = await call(B.branchAttach, { franchiseId: "FA", shopId: "s2" }, "u-admin");
  assert.equal(rr.code, 200);
  assert.equal(rr.body.byAdmin, true);
  assert.deepEqual(WRITES.map((w) => w.path), ["shop/s2"]);
});

test("ขาเก่า: uid ที่อยู่แค่ admin/adminConfig (ไม่อยู่ใน watcher/roster) ไม่ใช่ทีมงาน · ค้นสาขา 403", { skip }, async () => {
  const B = load("./branch");
  const r = await call(B.branchFind, { franchiseId: "FA", tel: "0811000001" }, "u-old");
  assert.equal(r.code, 403);
  const { list } = load("./read");
  assert.equal((await call(list, {}, "u-old")).body.staffRole, undefined);
});

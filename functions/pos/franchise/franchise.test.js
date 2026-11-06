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
  for (const f of ["./_franchise", "./read", "./branch", "./staff", "./franchise"]) delete require.cache[require.resolve(f)];
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
  admin: { adminConfig: { admin: ["u-admin"] } },
  franchise: {
    FA: {
      name: "เอ", humanResource: ["u-owner"],
      humanRight: [{ id: "u-owner", name: "เจ้าของ", tel: "081", email: "o@x", imageId: "", rights: ["100", "128", "723"], port: [{ shopId: "s1" }], currentLogin: { shopId: "s1", rights: ["1"] }, birthday: "2000", gender: "x" }],
    },
  },
  shop: { s1: { shopId: "s1", name: "สาขา", tel: "0811000001", franchiseId: "FA", humanResource: [{ id: "u", password: "1234" }], line: { token: "t" }, vip: [] } },
  profile: { p1: { name: "ใหม่", tel: "0899999999", email: "n@x", imageId: "", port: [{ shopId: "s9" }], currentLogin: { shopId: "s9" }, birthday: "1999" } },
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

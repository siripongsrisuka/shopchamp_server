// เทส staff.verifyCashierCode (บั๊ก #13 · DEV-0001) · รัน: node --test functions/pos/shopStaff/verifyCashierCode.test.js
//   สัญญา (api/staff.verifyCashierCode.yaml) วัดทีละคำขอกับ seed คงที่ · ไฟล์นี้วัดลำดับหลายคำขอบนฐานปลอมที่ค่าเปลี่ยนจริง (testKit.makeStore):
//   ① ผิดครบ 5 = ล็อก · ระหว่างล็อกรหัสถูกก็ไม่ผ่านและไม่นับ · หมดเวลาแล้วถูก = ผ่านและล้างใบนับผิด
//   ② ล็อกซ้ำยาวขึ้นเท่าตัว ไม่เกิน 60 นาที · ผิดครั้งล่าสุดเก่ากว่า 24 ชม. = เริ่มนับใหม่
//   ③ ไม่มีคำตอบไหนมีรหัส · ใบนับผิดไม่เก็บรหัส · ทีมงานถูกนับเหมือนกันและมีร่องรอย
//   ④ คู่เทียบ: ตัวกลายพันธุ์ที่ไม่ตรวจล็อกก่อนเทียบรหัส ต้องทำ ① แดง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const kit = require("./testKit");

const store = kit.makeStore();
kit.install(store);
const V = require("./verifyCashierCode");

let NOW = new Date("2026-11-10T03:00:00.000Z");
const deps = { now: () => NOW };
const call = kit.caller(V.verifyCashierCode(deps));
const at = (min) => { NOW = new Date(Date.parse("2026-11-10T03:00:00.000Z") + min * 60000); };

const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const CASHIER = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const NO_SALE = { shopAccess: { shopId: "shopA", uid: "u-stock", role: "staff", rights: ["131"] } };
const ADMIN = { shopAccess: { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true } };
const far = new Date("2027-01-01T00:00:00.000Z");
function seed() {
  at(0);
  store.reset({
    shop: {
      shopA: {
        shopId: "shopA", name: "ร้านทดสอบ",
        humanResource: [
          { id: "u-owner", name: "เจ้าของ", email: "o@example.com", tel: "0811111110", position: ["001"], status: "active", password: "1234" },
          { id: "u-cash", name: "แคชเชียร์", email: "c@example.com", tel: "0811111111", position: [], status: "active", rights: ["100"], password: "5555" },
          { id: "u-space", name: "รหัสมีช่องว่าง", position: [], status: "active", rights: ["100"], password: "12 34" },
          { id: "u-num", name: "รหัสเป็นตัวเลข", position: [], status: "active", rights: ["100"], password: 4321 },
          { id: "u-new", name: "ยังไม่ตั้ง", position: [], status: "active", rights: ["100"], password: "" },
          { id: "u-off", name: "ออกแล้ว", position: [], status: "inActive", rights: ["100"], password: "7777" },
          { id: "u-stock", name: "คลัง", position: [], status: "active", rights: ["131"], password: "8888" },
        ],
        vip: [{ type: "premium", expire: far }, { type: "staff", expire: far }],
      },
    },
  });
}
const v = (staffId, password, who = CASHIER) => call({ shopId: "shopA", staffId, password }, who);
const guard = (staffId) => (store.data.cashierCodeGuard || {})[`shopA_${staffId}`];

test("รหัสถูก → 200 แถวไม่มีรหัส อีเมล เบอร์ · ไม่เขียนอะไรเลยเมื่อไม่มีใบนับผิด", async () => {
  seed();
  const r = await v("u-cash", "5555");
  assert.equal(r.code, 200);
  assert.equal(r.body.staffId, "u-cash");
  assert.equal(r.body.staff.hasPassword, true);
  for (const k of ["password", "email", "tel"]) assert.equal(k in r.body.staff, false, k);
  assert.ok(!JSON.stringify(r.body).includes("5555"));
  assert.equal(store.log.length, 0);
});

test("รหัสรูปที่แอปเก่าตั้งได้ (มีช่องว่าง · เก็บเป็นตัวเลข) ตรวจผ่าน · ไม่ตัดช่องว่าง", async () => {
  seed();
  assert.equal((await v("u-space", "12 34")).code, 200);
  assert.equal((await v("u-space", "1234")).code, 403);
  assert.equal((await v("u-num", "4321")).code, 200);
});

test("① ผิด 4 ครั้งเหลือ 4..1 · ครั้งที่ 5 ล็อก 5 นาที · ระหว่างล็อกรหัสถูกก็ 429 ไม่เขียน · หมดเวลาแล้วถูก = 200 ล้างใบ", async () => {
  seed();
  for (let i = 1; i <= 4; i++) {
    const r = await v("u-cash", "0000");
    assert.equal(r.code, 403); assert.equal(r.body.error, "wrong_code"); assert.equal(r.body.attemptsLeft, 5 - i);
  }
  const lock = await v("u-cash", "0000");
  assert.equal(lock.code, 429); assert.equal(lock.body.error, "code_locked"); assert.equal(lock.body.retryAfterSec, 300);
  const g = guard("u-cash");
  assert.equal(g.failCount, 0); assert.equal(g.lockCount, 1); assert.equal(g.lastFailBy, "u-cash");
  assert.ok(!JSON.stringify(g).includes("5555") && !JSON.stringify(g).includes("0000"), "ใบนับผิดไม่เก็บรหัส");
  at(2);
  const before = store.log.length;
  const during = await v("u-cash", "5555");
  assert.equal(during.code, 429); assert.equal(during.body.retryAfterSec, 180);
  assert.equal(store.log.length, before, "ระหว่างล็อกไม่เขียน");
  at(6);
  const after = await v("u-cash", "5555");
  assert.equal(after.code, 200);
  assert.equal(guard("u-cash"), undefined, "ถูกแล้วล้างใบนับผิด");
});

test("② ล็อกรอบสองนาน 10 นาที · รอบที่ 6 ขึ้นไปไม่เกิน 60 นาที · ผิดล่าสุดเก่ากว่า 24 ชม. = เริ่มใหม่", async () => {
  seed();
  const lockRound = async () => { let r; for (let i = 0; i < 5; i++) r = await v("u-cash", "0000"); return r; };
  assert.equal((await lockRound()).body.retryAfterSec, 300);
  at(6); assert.equal((await lockRound()).body.retryAfterSec, 600);
  at(17); assert.equal((await lockRound()).body.retryAfterSec, 1200);
  at(38); assert.equal((await lockRound()).body.retryAfterSec, 2400);
  at(79); assert.equal((await lockRound()).body.retryAfterSec, 3600);
  at(140); assert.equal((await lockRound()).body.retryAfterSec, 3600);
  at(140 + 60 * 25);
  const fresh = await v("u-cash", "0000");
  assert.equal(fresh.code, 403); assert.equal(fresh.body.attemptsLeft, 4, "เก่ากว่า 24 ชม. เริ่มนับใหม่");
  assert.equal(guard("u-cash").lockCount, 0);
});

test("ใบนับผิดแยกต่อพนักงาน: ผิดของคนหนึ่งไม่ล็อกอีกคน", async () => {
  seed();
  for (let i = 0; i < 5; i++) await v("u-cash", "0000");
  assert.equal((await v("u-owner", "1234")).code, 200);
});

test("ปัดก่อนเทียบรหัส: ไม่มีแถว 404 · ไม่ใช่แคชเชียร์ 409 · ปิดใช้งาน 409 · ยังไม่ตั้ง 409 · ผู้เรียกไม่มี 100/101 403 · ร้านอื่น 403 · ไม่นับผิด", async () => {
  seed();
  assert.equal((await v("u-ghost", "1")).body.error, "staff_not_found");
  assert.equal((await v("u-stock", "8888")).body.error, "not_cashier");
  assert.equal((await v("u-off", "7777")).body.error, "staff_inactive");
  assert.equal((await v("u-new", "1")).body.error, "code_not_set");
  const nr = await v("u-cash", "5555", NO_SALE);
  assert.equal(nr.code, 403); assert.equal(nr.body.error, "right_required");
  const ws = await call({ shopId: "shopB", staffId: "u-cash", password: "5555" }, CASHIER);
  assert.equal(ws.code, 403); assert.equal(ws.body.error, "wrong_shop");
  assert.equal(store.log.length, 0);
});

test("คำขอผิดรูป = 400 (field เกิน · รหัสว่าง)", async () => {
  seed();
  assert.equal((await call({ shopId: "shopA", staffId: "u-cash", password: "5555", op: "x" }, CASHIER)).code, 400);
  assert.equal((await call({ shopId: "shopA", staffId: "u-cash", password: "" }, CASHIER)).code, 400);
});

test("③ ทีมงาน (byAdmin): ตรวจได้ คำตอบมี byAdmin · ผิดถูกนับเหมือนคนอื่น และใบมีร่องรอยทีมงาน", async () => {
  seed();
  const ok = await v("u-owner", "1234", ADMIN);
  assert.equal(ok.code, 200); assert.equal(ok.body.byAdmin, true);
  const bad = await v("u-owner", "0000", ADMIN);
  assert.equal(bad.code, 403); assert.equal(bad.body.byAdmin, true); assert.equal(bad.body.attemptsLeft, 4);
  const g = guard("u-owner");
  assert.equal(g.byAdmin, true); assert.equal(g.adminUid, "u-company"); assert.equal(g.lastFailBy, "u-company");
});

test("④ คู่เทียบ: ตัวกลายพันธุ์ที่เทียบรหัสก่อนดูล็อก → ระหว่างล็อกรหัสถูกผ่านได้ (เทส ① ต้องจับได้)", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "verifyCashierCode.js"), "utf8");
  const lockLine = "if (lockedUntil !== null && lockedUntil > nowMs) return { locked: true, retryAfterSec: Math.ceil((lockedUntil - nowMs) / 1000) };";
  assert.ok(src.includes(lockLine), "บรรทัดด่านล็อกต้องยังอยู่ (ถอด = เดารหัสระหว่างล็อกได้)");
  const mutated = src.replace(lockLine, "");
  const m = new module.constructor(path.join(__dirname, "verifyCashierCode.mutant.js"), module);
  m.filename = path.join(__dirname, "verifyCashierCode.mutant.js");
  m.paths = module.paths;
  m._compile(mutated, m.filename);
  const mcall = kit.caller(m.exports.verifyCashierCode(deps));
  seed();
  for (let i = 0; i < 5; i++) await mcall({ shopId: "shopA", staffId: "u-cash", password: "0000" }, CASHIER);
  at(2);
  const during = await mcall({ shopId: "shopA", staffId: "u-cash", password: "5555" }, CASHIER);
  assert.equal(during.code, 200, "ตัวกลายพันธุ์ปล่อยผ่านระหว่างล็อก = เทส ① แยกได้");
});

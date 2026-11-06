// เทส promotion/{save,delete,setStatus}.js (ก้อน 9b) · รัน: node --test functions/pos/promotion/promotion.test.js
//   ลำดับหลายคำขอ: สร้าง → แก้ด้วย updatedAt ที่ได้ → เครื่องค่าเก่าแก้ทับไม่ได้ (ไม่มีรหัสบั๊ก) · doc ที่เขียนอ่านกลับด้วย Promotion และ PromotionWrite ผ่าน
//   ❌ ไม่แตะ Firestore จริง (ฐานปลอม ../member/_fakeDb.js)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { installFakeDb } = require("../member/_fakeDb");

const F = installFakeDb(path, {});
const { save } = require("./save");
const { del } = require("./delete");
const { setStatus } = require("./setStatus");
const { Promotion, PromotionWrite } = require("@shopchamp/schema");

let NOW = new Date("2026-11-10T03:00:00.000Z");
const deps = { now: () => NOW };
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const PID = "0b5c9a1d-2e3f-4a5b-8c6d-000000000003";
const FUTURE = new Date("2027-12-31T00:00:00.000Z");
const DAYS = [1, 2, 3, 4, 5, 6, 0].map((id) => ({ id, name: String(id), color: "#000", status: true, allDay: true, period: [] }));
const BODY = (o = {}) => ({
  name: "ซื้อครบ 500 ลด 50", detail: "", promotionId: "7", type: "minimumSale", rewardType: "discount", tier: false,
  tierTarget: ["500"], tierReward: ["50"], tierBox: [], barcode: [], slot1: [], slot2: [], rewardBarcode: [], scope: [], scopeTarget: "onInvoice",
  exchangePrice: "", expireType: "infinity", startDate: "2026-11-01T00:00:00+07:00", endDate: "2026-11-30T23:59:59+07:00",
  status: true, auto: true, workingDays: DAYS, customer: "all", channels: [], specialPromotion: "none", ...o,
});
const seed = () => ({ shop: { shopA: { shopId: "shopA", vip: [{ type: "premium", expire: FUTURE }], humanResource: [{ id: "u-owner", position: ["001"], status: "active" }] } } });
async function call(h, body, access = OWNER) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h(deps)({ body, shopAccess: access }, res);
  return res;
}

test("สร้าง → doc ในฐานผ่าน Promotion (อ่าน) และ PromotionWrite (เขียน) · ส่งซ้ำไม่ทับ", async () => {
  F.reset(seed());
  const r = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY() });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const doc = F.data.promotion[PID];
  assert.equal(Promotion.safeParse(doc).success, true);
  assert.equal(PromotionWrite.safeParse(doc).success, true);
  assert.ok(doc.startDate instanceof Date);
  NOW = new Date("2026-11-10T04:00:00.000Z");
  const again = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ name: "ชื่ออื่น" }) });
  assert.equal(again.body.duplicate, true);
  assert.equal(F.data.promotion[PID].name, "ซื้อครบ 500 ลด 50");
});

test("เครื่องค่าเก่า: เครื่อง A แก้ด้วย updatedAt ล่าสุดได้ · เครื่อง B ที่ถือค่าเก่าแก้ทับไม่ได้ · timestamp เดิมคงอยู่", async () => {
  F.reset(seed());
  NOW = new Date("2026-11-10T03:00:00.000Z");
  const c = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY() });
  const base = c.body.updatedAt;
  NOW = new Date("2026-11-10T05:00:00.000Z");
  const a = await call(save, { shopId: "shopA", mode: "update", id: PID, baseUpdatedAt: base, promotion: BODY({ name: "A แก้" }) });
  assert.equal(a.code, 200, JSON.stringify(a.body));
  NOW = new Date("2026-11-10T06:00:00.000Z");
  const b = await call(save, { shopId: "shopA", mode: "update", id: PID, baseUpdatedAt: base, promotion: BODY({ name: "B ทับ" }) });
  assert.equal(b.code, 409);
  assert.equal(b.body.error, "promotion_changed");
  assert.equal(F.data.promotion[PID].name, "A แก้");
  assert.equal(F.data.promotion[PID].timestamp.toISOString(), "2026-11-10T03:00:00.000Z");
});

test("setStatus ปิด → เปิด · K06 เปิดโปรไม่มีวันทำงานไม่ได้ · ลบแล้วลบซ้ำ 404", async () => {
  F.reset(seed());
  await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ status: false, workingDays: DAYS.map((d) => ({ ...d, status: false })) }) });
  const on = await call(setStatus, { shopId: "shopA", id: PID, status: true });
  assert.equal(on.code, 409);
  assert.equal(on.body.error, "promotion_no_working_day");
  assert.equal(F.data.promotion[PID].status, false);
  assert.equal((await call(del, { shopId: "shopA", id: PID })).code, 200);
  assert.equal(F.data.promotion[PID], undefined);
  assert.equal((await call(del, { shopId: "shopA", id: PID })).code, 404);
});

test("K06 ช่วงวันเทียบวันไทยไม่ขึ้นกับโซนของ server: เริ่ม 00:30 ไทย จบ 23:00 ไทย วันเดียวกัน ผ่าน", async () => {
  F.reset(seed());
  const r = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ expireType: "limit", startDate: "2026-11-20T00:30:00+07:00", endDate: "2026-11-20T23:00:00+07:00" }) });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const on = await call(setStatus, { shopId: "shopA", id: PID, status: true });
  assert.equal(on.code, 200, JSON.stringify(on.body));
});

// ───────── แก้ตามผลตรวจอิสระ 9b (2026-11-06) ─────────
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };

test("ผ6 แก้โปรสำเร็จแล้วเน็ตหลุด ส่งคำขอเดิมซ้ำ ⇒ 200 duplicate (ไม่ใช่ 409 ถูกแก้จากเครื่องอื่น) · คนอื่นส่งเนื้อเดียวกันด้วย base เก่า ⇒ ยัง 409", async () => {
  F.reset(seed());
  NOW = new Date("2026-11-10T03:00:00.000Z");
  const c = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY() });
  NOW = new Date("2026-11-10T05:00:00.000Z");
  const req = { shopId: "shopA", mode: "update", id: PID, baseUpdatedAt: c.body.updatedAt, promotion: BODY({ name: "แก้แล้ว" }) };
  const a = await call(save, req);
  assert.equal(a.code, 200, JSON.stringify(a.body));
  NOW = new Date("2026-11-10T05:00:05.000Z");
  const again = await call(save, req);
  assert.equal(again.code, 200, JSON.stringify(again.body));
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.updatedAt, a.body.updatedAt);
  F.data.shop.shopA.humanResource.push({ id: "u-staff", position: ["002"], status: "active", rights: ["101"] });
  F.data.shop.shopA.vip.push({ type: "staff", expire: FUTURE });
  const other = await call(save, req, { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["101"] });
  assert.equal(other.code, 409);
  const diff = await call(save, { ...req, promotion: BODY({ name: "อีกชื่อ" }) });
  assert.equal(diff.code, 409, "เนื้อไม่ตรง = ยังเป็นเครื่องค่าเก่า");
});

test("ผ3 ทีมงานเปิดปิดโปร ⇒ doc มี byAdmin adminUid · เจ้าของแก้ต่อ (save update / setStatus) ⇒ ล้างรอย", async () => {
  F.reset(seed());
  const c = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ status: false }) });
  assert.equal((await call(setStatus, { shopId: "shopA", id: PID, status: true }, ADMIN)).code, 200);
  assert.equal(F.data.promotion[PID].byAdmin, true);
  assert.equal(F.data.promotion[PID].adminUid, "u-company");
  assert.equal((await call(setStatus, { shopId: "shopA", id: PID, status: false })).code, 200);
  assert.equal(F.data.promotion[PID].byAdmin, false);
  assert.equal(F.data.promotion[PID].adminUid, null);
  NOW = new Date("2026-11-10T07:00:00.000Z");
  const u1 = await call(save, { shopId: "shopA", mode: "update", id: PID, baseUpdatedAt: F.data.promotion[PID].updatedAt.toISOString(), promotion: BODY({ name: "ทีมงานแก้" }) }, ADMIN);
  assert.equal(u1.code, 200, JSON.stringify(u1.body));
  assert.equal(F.data.promotion[PID].byAdmin, true);
  NOW = new Date("2026-11-10T08:00:00.000Z");
  const u2 = await call(save, { shopId: "shopA", mode: "update", id: PID, baseUpdatedAt: u1.body.updatedAt, promotion: BODY({ name: "ร้านแก้" }) });
  assert.equal(u2.code, 200, JSON.stringify(u2.body));
  assert.equal(F.data.promotion[PID].byAdmin, false);
  assert.equal(F.data.promotion[PID].adminUid, null);
  void c;
});

test("ข2 K06: วันที่เปิดแต่ allDay false และไม่มีชั่วโมง = ไม่มีชั่วโมงทำงาน ⇒ save 400 · setStatus เปิด 409 · มีชั่วโมง = ผ่าน", async () => {
  F.reset(seed());
  const noHour = DAYS.map((d) => ({ ...d, allDay: false, period: [] }));
  const s = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ workingDays: noHour }) });
  assert.equal(s.code, 400, JSON.stringify(s.body));
  assert.ok(s.body.issues.some((i) => i.path === "promotion.workingDays"));
  const s2 = await call(save, { shopId: "shopA", mode: "create", id: PID, promotion: BODY({ status: false, workingDays: noHour }) });
  assert.equal(s2.code, 200, JSON.stringify(s2.body));
  const on = await call(setStatus, { shopId: "shopA", id: PID, status: true });
  assert.equal(on.code, 409);
  assert.equal(on.body.error, "promotion_no_working_day");
  const withHour = DAYS.map((d) => ({ ...d, allDay: false, period: d.id === 1 ? [10, 11] : [] }));
  const PID2 = "0b5c9a1d-2e3f-4a5b-8c6d-000000000004";
  assert.equal((await call(save, { shopId: "shopA", mode: "create", id: PID2, promotion: BODY({ workingDays: withHour }) })).code, 200);
});

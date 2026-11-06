// เทส premium.js · รัน: node --test functions/pos/_shared/
//   กติกาแอปเดิม shopSlice.js:47-51: วันที่ไทยของ expire ≥ วันนี้ (ทั้งวันหมดอายุยังใช้ได้) · server รัน UTC
"use strict";
process.env.TZ = "UTC";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./premium");

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };
const shopWith = (vip) => ({ vip });
const NOW = new Date("2026-11-10T03:00:00.000Z"); // 10:00 ไทย 10 พ.ย.

test("ต้องผ่าน: หมดปีหน้า · หมดวันนี้ (ไทย) · หมดวันนี้ตอนเที่ยงคืนต้นวัน", () => {
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2027-01-01T00:00:00Z") }]), NOW), true);
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2026-11-10T16:59:00Z") }]), NOW), true); // 23:59 ไทยวันนี้
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2026-11-09T17:00:00Z") }]), NOW), true); // 00:00 ไทยวันนี้ (UTC ยังเมื่อวาน)
});

test("ต้องปัด: หมดเมื่อวาน (ไทย) · ปีก่อน · ไม่มีแถว premium · ไม่มี vip · expire อ่านไม่ได้", () => {
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2026-11-09T16:59:59Z") }]), NOW), false); // 23:59 ไทยเมื่อวาน
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2026-01-01T00:00:00Z") }]), NOW), false);
  assert.equal(P.isPremiumActive(shopWith([{ type: "staff", expire: ts("2027-01-01T00:00:00Z") }]), NOW), false);
  for (const shop of [{}, null, undefined, { vip: "premium" }, shopWith([null, 1, { type: "premium" }, { type: "premium", expire: "x" }, { type: "premium", expire: {} }])]) {
    assert.equal(P.isPremiumActive(shop, NOW), false);
  }
});

test("ขอบเที่ยงคืนไทยฝั่ง now: 23:00 ไทยวันหมด = ผ่าน · 00:00 ไทยวันถัดไป = ปัด (server UTC ยังวันเดียวกัน)", () => {
  const shop = shopWith([{ type: "premium", expire: ts("2026-11-10T05:00:00Z") }]);
  assert.equal(P.isPremiumActive(shop, new Date("2026-11-10T16:00:00Z")), true);
  assert.equal(P.isPremiumActive(shop, new Date("2026-11-10T17:00:00Z")), false);
});

test("หลายแถวชนิดเดียวกัน: แถวไหนยังไม่หมดก็พอ (forEach ของแอปเดิม)", () => {
  const shop = shopWith([{ type: "premium", expire: ts("2025-01-01T00:00:00Z") }, { type: "premium", expire: ts("2027-01-01T00:00:00Z") }]);
  assert.equal(P.isPremiumActive(shop, NOW), true);
});

test("แพ็กเกจพนักงาน: ดูแถวแรกเท่านั้น (vip.find ของ LoadingScreen.js:72)", () => {
  const firstExpired = shopWith([{ type: "staff", expire: ts("2025-01-01T00:00:00Z") }, { type: "staff", expire: ts("2027-01-01T00:00:00Z") }]);
  assert.equal(P.isStaffPackageActive(firstExpired, NOW), false);
  assert.equal(P.isStaffPackageActive(shopWith([{ type: "staff", expire: ts("2027-01-01T00:00:00Z") }]), NOW), true);
});

test("expire หลายรูปที่ไหลในระบบ: Timestamp · {seconds} · {_seconds} · Date · ms · ISO", () => {
  const ms = Date.parse("2027-01-01T00:00:00Z");
  for (const expire of [ts("2027-01-01T00:00:00Z"), { seconds: ms / 1000, nanoseconds: 0 }, { _seconds: ms / 1000, _nanoseconds: 0 }, new Date(ms), ms, "2027-01-01T00:00:00Z"]) {
    assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire }]), NOW), true, JSON.stringify(expire));
  }
});

test("now เพี้ยน = ไม่ให้สิทธิ์ (fail-closed)", () => {
  const shop = shopWith([{ type: "premium", expire: ts("2027-01-01T00:00:00Z") }]);
  for (const now of [undefined, new Date("x"), "2026-11-10"]) assert.equal(P.isPremiumActive(shop, now), false);
});

test("seed ของสัญญา sale.amend: 2027-01-01 = ผ่าน · 2026-01-01 = ปัด", () => {
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2027-01-01T00:00:00.000Z") }]), NOW), true);
  assert.equal(P.isPremiumActive(shopWith([{ type: "premium", expire: ts("2026-01-01T00:00:00.000Z") }]), NOW), false);
});

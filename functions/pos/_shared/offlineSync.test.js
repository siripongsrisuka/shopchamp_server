// เทส offlineSync.js · รัน: node --test functions/pos/_shared/
//   ขอบเวลาตามสัญญา sale.create (3 วัน 23 ชม. ผ่าน · 4 วัน 1 ชม. clamp · ล่วงหน้า 4 นาทีผ่าน · 6 นาที clamp) + ขอบพอดี
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const O = require("./offlineSync");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const iso = (deltaMs) => new Date(NOW.getTime() + deltaMs).toISOString();
const H = 3600e3, D = 24 * H, M = 60e3;
const run = (soldAt, extra) => O.resolveOfflineSync({ flag: true, soldAt, trusted: true, now: NOW, ...extra });

test("ต้องผ่าน (ไม่ clamp): ย้อน 3 วัน 23 ชม. · ย้อนพอดี 4 วัน · ล่วงหน้า 4 นาที · ล่วงหน้าพอดี 5 นาที · ตอนนี้", () => {
  for (const d of [-(3 * D + 23 * H), -4 * D, 4 * M, 5 * M, 0]) {
    const r = run(iso(d));
    assert.equal(r.offlineSync, true, `${d}`);
    assert.equal(r.soldAtClamped, false, `${d}`);
    assert.equal(r.soldAt.getTime(), NOW.getTime() + d);
  }
  // ตัวอย่างในสัญญา: soldAt 2026-11-06T04:00Z (ย้อน 3 วัน 23 ชม.)
  assert.equal(run("2026-11-06T04:00:00.000Z").soldAtClamped, false);
  // offset ไทย: 11:00+07:00 = 04:00Z
  assert.equal(run("2026-11-06T11:00:00+07:00").soldAt.toISOString(), "2026-11-06T04:00:00.000Z");
});

test("ต้อง clamp (ใช้ now + soldAtClamped · ไม่ปัดการขาย): ย้อน 4 วัน 1 ms · 4 วัน 1 ชม. · ล่วงหน้า 5 นาที 1 ms · 6 นาที", () => {
  for (const d of [-(4 * D + 1), -(4 * D + H), 5 * M + 1, 6 * M]) {
    const r = run(iso(d));
    assert.equal(r.offlineSync, true, `${d}`);
    assert.equal(r.soldAtClamped, true, `${d}`);
    assert.equal(r.soldAt.getTime(), NOW.getTime());
  }
});

test("soldAt อ่านไม่ออก / ไม่มีโซน / ไม่ใช่ string = clamp (ยังเป็นบิลออฟไลน์)", () => {
  for (const bad of [undefined, null, "", "2026", "2026-11-09", "2026-11-09T10:00:00", "2026-11-09 10:00:00Z", 1794279600000, {}, "2026-13-45T99:00:00Z"]) {
    const r = run(bad);
    assert.equal(r.offlineSync, true, String(bad));
    assert.equal(r.soldAtClamped, true, String(bad));
  }
});

test("ป้ายเชื่อเฉพาะ flag === true · ไม่ใช่ = บิลปกติ soldAt = now", () => {
  for (const flag of [undefined, false, "true", 1, {}]) {
    const r = O.resolveOfflineSync({ flag, soldAt: iso(-H), trusted: true, now: NOW });
    assert.deepEqual(r, { offlineSync: false, soldAt: NOW, soldAtClamped: false, ignored: null });
  }
});

test("ไม่ผ่านด่านร้าน (trusted ไม่ใช่ true) = เมินป้าย + บอกเหตุ", () => {
  for (const trusted of [undefined, false, "yes", 1]) {
    const r = O.resolveOfflineSync({ flag: true, soldAt: iso(-H), trusted, now: NOW });
    assert.equal(r.offlineSync, false);
    assert.equal(r.ignored, "not_trusted");
    assert.equal(r.soldAt, NOW);
  }
});

test("ไม่มีสวิตช์ร้าน: shop.offlineEnable ไม่มีผล (decision 1-1)", () => {
  const r = O.resolveOfflineSync({ flag: true, soldAt: iso(-H), trusted: true, now: NOW, shopDoc: { offlineEnable: false } });
  assert.equal(r.offlineSync, true);
});

test("now เพี้ยน = clamp (ไม่เชื่อ soldAt เมื่อเทียบไม่ได้)", () => {
  const r = O.resolveOfflineSync({ flag: true, soldAt: iso(-H), trusted: true, now: new Date("x") });
  assert.equal(r.soldAtClamped, true);
});

test("stampOfflineFields: ตัดช่องที่ผู้ส่งแนบทิ้งเสมอ · ประทับเองเมื่อได้สิทธิ์ · ไม่แตะ timestamp", () => {
  const syncedAt = NOW;
  const off = run(iso(-H));
  const data = { product: [], offline: true, soldAt: "x", offlineSync: false, syncedAt: "x", soldAtClamped: false, offlineRef: "evil", timestamp: "keep" };
  const out = O.stampOfflineFields(data, off, syncedAt, { ref: "  T261106-AB12-01 " });
  assert.equal(out, data);
  assert.deepEqual(out, { product: [], timestamp: "keep", offlineSync: true, soldAt: off.soldAt, syncedAt, offlineRef: "T261106-AB12-01" });

  const clamped = O.stampOfflineFields({}, run("bad"), syncedAt, { ref: "R" });
  assert.equal(clamped.soldAtClamped, true);

  const online = O.stampOfflineFields({ a: 1, offline: true, soldAt: "x", offlineRef: "T1" }, O.resolveOfflineSync({ now: NOW }), syncedAt, { ref: "T1" });
  assert.deepEqual(online, { a: 1 });

  const longRef = O.stampOfflineFields({}, off, syncedAt, { ref: "x".repeat(41) });
  assert.equal("offlineRef" in longRef, false);
});

// เทส idempotency.js · รัน: node --test functions/pos/_shared/
//   guard 3 รูปตามสัญญา sale.create (รูปใหม่ · รูปแอปเก่า · ร้านอื่น) + ขอบที่สัญญาไม่ได้ครอบ (prefix ซ้อน · รูปเพี้ยน)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const I = require("./idempotency");

const UUID = "6f1c2d3e-0000-4000-8000-000000000001";
const SHOP = { shopDocId: "shopA", shopField: "shopA" };

test("readReceiptUUID: ไม่มี / ว่าง / ช่องว่าง / ไม่ใช่ string = null · มีค่า = ค่าเดิมไม่ trim", () => {
  for (const b of [undefined, null, {}, { receiptUUID: "" }, { receiptUUID: "   " }, { receiptUUID: 5 }, { receiptUUID: null }]) {
    assert.equal(I.readReceiptUUID(b), null);
  }
  assert.equal(I.readReceiptUUID({ receiptUUID: `shopA${UUID}` }), `shopA${UUID}`);
});

test("guard ไม่มี = none (ออกบิลใหม่ได้)", () => {
  assert.deepEqual(I.classifyGuard({ guardId: `shopA${UUID}`, guard: undefined, ...SHOP }), { kind: "none" });
  assert.deepEqual(I.classifyGuard({ guardId: `shopA${UUID}`, guard: null, ...SHOP }), { kind: "none" });
});

test("ต้องเป็น duplicate: รูปใหม่ของร้านนี้ (สัญญา: billId b7 เลข 202611000007)", () => {
  const r = I.classifyGuard({ guardId: `shopA${UUID}`, guard: { usedBy: "202611000007", billId: "b7", shopId: "shopA" }, ...SHOP });
  assert.deepEqual(r, { kind: "duplicate", shape: "current", billId: "b7", receiptNumber: "202611000007" });
});

test("ต้องเป็น duplicate: รูป route เดิม (มี shopId ไม่มี billId) = เลขจาก usedBy", () => {
  const r = I.classifyGuard({ guardId: "anything", guard: { usedBy: "202611000003", shopId: "shopA" }, ...SHOP });
  assert.deepEqual(r, { kind: "duplicate", shape: "route", billId: null, receiptNumber: "202611000003" });
});

test("ต้องเป็น duplicate: รูปแอปเก่า prefix = shop.shopId (สัญญา: usedBy b9 → อ่านบิล → 202611000009)", () => {
  const c = I.classifyGuard({ guardId: `shopA${UUID}`, guard: { usedBy: "b9" }, ...SHOP });
  assert.deepEqual(c, { kind: "duplicate", shape: "legacyApp", billId: "b9", receiptNumber: null, needsBillRead: true });
  const filled = I.legacyDuplicateFromBill(c, { shopId: "shopA", receiptNumber: "202611000009" }, { id: "shopA", shopId: "shopA" });
  assert.deepEqual(filled, { kind: "duplicate", shape: "legacyApp", billId: "b9", receiptNumber: "202611000009", needsBillRead: false });
  // บิลหายไปแล้ว: ยังเป็น duplicate (ห้ามออกบิลซ้ำ) แค่ไม่มีเลข
  assert.equal(I.legacyDuplicateFromBill(c, undefined, { id: "shopA", shopId: "shopA" }).kind, "duplicate");
});

test("ร้านเก่าที่ doc id ≠ field shopId: guard รูปแอปเก่าใช้ field (prefix) · รูปใหม่ใช้ doc id", () => {
  const ref = { shopDocId: "docX", shopField: "uidOwner123" };
  assert.equal(I.classifyGuard({ guardId: `uidOwner123${UUID}`, guard: { usedBy: "b1" }, ...ref }).kind, "duplicate");
  assert.equal(I.classifyGuard({ guardId: `docX${UUID}`, guard: { usedBy: "b1" }, ...ref }).kind, "other_shop");
  assert.equal(I.classifyGuard({ guardId: "x", guard: { usedBy: "1", billId: "b", shopId: "docX" }, ...ref }).kind, "duplicate");
  assert.equal(I.classifyGuard({ guardId: "x", guard: { usedBy: "1", billId: "b", shopId: "uidOwner123" }, ...ref }).kind, "other_shop");
});

test("ต้องเป็น other_shop: guard มี shopId ร้านอื่น · รูปแอปเก่า prefix ร้านอื่น (สัญญา 2 case)", () => {
  assert.deepEqual(I.classifyGuard({ guardId: `shopA${UUID}`, guard: { usedBy: "202611000003", billId: "bB", shopId: "shopB" }, ...SHOP }), { kind: "other_shop" });
  assert.deepEqual(I.classifyGuard({ guardId: `shopB${UUID}`, guard: { usedBy: "bB" }, ...SHOP }), { kind: "other_shop" });
});

test("ต้องเป็น other_shop: prefix ซ้อน (shopId ร้านนี้เป็น prefix ของอีกร้าน) · ส่วนท้ายไม่ใช่ uuid · รูปเพี้ยน", () => {
  assert.equal(I.classifyGuard({ guardId: `shopAB${UUID}`, guard: { usedBy: "b1" }, ...SHOP }).kind, "other_shop");
  assert.equal(I.classifyGuard({ guardId: "shopA-not-a-uuid", guard: { usedBy: "b1" }, ...SHOP }).kind, "other_shop");
  assert.equal(I.classifyGuard({ guardId: `shopA${UUID}`, guard: { usedBy: "b1" }, shopDocId: "shopA", shopField: "" }).kind, "other_shop");
  assert.equal(I.classifyGuard({ guardId: `shopA${UUID}`, guard: "x", ...SHOP }).kind, "other_shop");
  assert.equal(I.classifyGuard({ guardId: `shopA${UUID}`, guard: [], ...SHOP }).kind, "other_shop");
});

test("legacyDuplicateFromBill: บิลที่ usedBy ชี้เป็นของร้านอื่น = other_shop (ไม่คืนเลข)", () => {
  const c = I.classifyGuard({ guardId: `shopA${UUID}`, guard: { usedBy: "bX" }, ...SHOP });
  assert.deepEqual(I.legacyDuplicateFromBill(c, { shopId: "shopB", receiptNumber: "1" }, { id: "shopA", shopId: "shopA" }), { kind: "other_shop" });
});

test("guardDoc: รูปใหม่ {createdAt, usedBy:เลข, billId, shopId:doc id} + ร่องรอยทีมงาน", () => {
  const now = new Date("2026-11-10T03:00:00Z");
  assert.deepEqual(I.guardDoc({ now, receiptNumber: "202611000042", billId: "b42", shopDocId: "shopA" }), { createdAt: now, usedBy: "202611000042", billId: "b42", shopId: "shopA" });
  const a = I.guardDoc({ now, receiptNumber: "1", billId: "b", shopDocId: "shopA", trail: { byAdmin: true, adminUid: "u-company" } });
  assert.equal(a.byAdmin, true);
  assert.equal(a.adminUid, "u-company");
  assert.equal(a.shopId, "shopA");
});

test("findByKey / sameRequestId", () => {
  const list = [{ entryId: "r1" }, null, { entryId: "r2" }];
  assert.deepEqual(I.findByKey(list, "entryId", "r2"), { entryId: "r2" });
  assert.equal(I.findByKey(list, "entryId", "r3"), null);
  assert.equal(I.findByKey(list, "entryId", ""), null);
  assert.equal(I.findByKey(undefined, "entryId", "r1"), null);
  assert.equal(I.sameRequestId("r1", "r1"), true);
  for (const [s, r] of [[undefined, "r1"], ["", ""], ["r1", "r2"], [null, null]]) assert.equal(I.sameRequestId(s, r), false);
});

test("shiftHistoryDocId: <shiftId>_<ms> จาก Timestamp/Date · อ่านไม่ได้ = null", () => {
  const ms = Date.parse("2026-11-10T01:00:00.000Z");
  assert.equal(I.shiftHistoryDocId("sh1", { toMillis: () => ms }), `sh1_${ms}`);
  assert.equal(I.shiftHistoryDocId("sh1", new Date(ms)), `sh1_${ms}`);
  assert.equal(I.shiftHistoryDocId("sh1", { seconds: ms / 1000, nanoseconds: 0 }), `sh1_${ms}`);
  for (const [id, t] of [["", new Date(ms)], ["a/b", new Date(ms)], ["sh1", undefined], ["sh1", "x"], [5, new Date(ms)]]) {
    assert.equal(I.shiftHistoryDocId(id, t), null);
  }
});

test("amendReceiptUUID: amend:<billId>:<requestId>", () => {
  assert.equal(I.amendReceiptUUID("b1", "r1"), "amend:b1:r1");
});

test("amendLockState: free · done · resume · busy (< 5 นาที) · free หลัง 5 นาที · taken", () => {
  const now = new Date("2026-11-10T03:00:00Z");
  const at = (minAgo) => ({ toMillis: () => now.getTime() - minAgo * 60e3 });
  assert.equal(I.amendLockState(undefined, "r1", now), "free");
  assert.equal(I.amendLockState({ status: "done", requestId: "r1" }, "r1", now), "done");
  assert.equal(I.amendLockState({ status: "done", requestId: "r0" }, "r1", now), "taken");
  assert.equal(I.amendLockState({ status: "pending", requestId: "r1", at: at(1) }, "r1", now), "resume");
  assert.equal(I.amendLockState({ status: "pending", requestId: "r0", at: at(4.99) }, "r1", now), "busy");
  assert.equal(I.amendLockState({ status: "pending", requestId: "r0", at: at(5) }, "r1", now), "free");
  assert.equal(I.amendLockState({ status: "pending", requestId: "r0", at: "garbage" }, "r1", now), "busy");
  assert.equal(I.amendLockState({ status: "pending", requestId: "r0", at: at(1) }, "r1", new Date("x")), "busy");
});

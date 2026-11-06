// เทสข้างไฟล์ของ discardPendingDoc.js · รัน: node --test functions/pos/sale/discardPendingDoc.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bodyStorable, bodyFields, discardDoc, decide, MAX_BODY_BYTES } = require("./discardPendingDoc");

const UUID = "6f1c2d3e-0000-4000-8000-0000000000dd";
const REF = { id: "docA", shopId: "shopA" };

test("bodyStorable: รูปปกติผ่าน · รูปที่ Firestore ปัดไม่ผ่าน", () => {
  assert.equal(bodyStorable({ a: 1, b: [{ c: "x" }], d: null, e: true }), true);
  assert.equal(bodyStorable({ a: [[1]] }), false); // array ซ้อน array
  assert.equal(bodyStorable({ "": 1 }), false);
  assert.equal(bodyStorable({ __name__: 1 }), false);
  let deep = {}; const root = deep;
  for (let i = 0; i < 25; i++) { deep.x = {}; deep = deep.x; }
  assert.equal(bodyStorable(root), false);
});

test("bodyFields: เก็บตรง · เก็บเป็นข้อความ · ใหญ่เกิน", () => {
  assert.deepEqual(bodyFields({ a: 1 }), { body: { a: 1 } });
  assert.deepEqual(bodyFields({ a: [[1]] }), { bodyJson: "{\"a\":[[1]]}" });
  const big = bodyFields({ s: "x".repeat(MAX_BODY_BYTES + 1) });
  assert.equal(big.bodyTooLarge, true);
  assert.equal("body" in big, false);
});

test("discardDoc: field ครบ · ไม่ใส่ undefined · ทีมงานมีรอย", () => {
  const now = new Date("2026-11-10T03:00:00Z");
  const d = discardDoc({ input: { receiptUUID: "u", body: {}, reason: "r" }, access: { shopId: "docA", uid: "u1" }, now, trail: {} });
  assert.deepEqual(d, { shopId: "docA", receiptUUID: "u", body: {}, reason: "r", by: "u1", at: now });
  const a = discardDoc({ input: { receiptUUID: "u", body: {}, reason: "r", offlineRef: "T1", deviceAt: "2026-11-09T10:00:00+07:00" }, access: { shopId: "docA", uid: "adm" }, now, trail: { byAdmin: true, adminUid: "adm" } });
  assert.equal(a.byAdmin, true); assert.equal(a.adminUid, "adm"); assert.equal(a.offlineRef, "T1"); assert.equal(a.deviceAt, "2026-11-09T10:00:00+07:00");
});

test("decide: ลำดับด่าน", () => {
  const id = `shopA${UUID}`;
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: null, guard: null }), { kind: "write" });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: { shopId: "docA" }, guard: null }), { kind: "duplicate" });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: { shopId: "shopA" }, guard: null }), { kind: "duplicate" }); // ตรง field shopId
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: { shopId: "docB" }, guard: null }), { kind: "other_shop" });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: {}, guard: null }), { kind: "other_shop" }); // ไม่มี shopId = fail-closed
  // ร่องรอยของร้านนี้ + guard ร้านอื่น = ร้านอื่น (ไม่ตอบ duplicate)
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: { shopId: "docA" }, guard: { shopId: "docB", usedBy: "1", billId: "b" } }), { kind: "other_shop" });
  // บิลขึ้นทีหลังร่องรอย = synced มาก่อน duplicate
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: { shopId: "docA" }, guard: { shopId: "docA", usedBy: "R1", billId: "b1" } }), { kind: "synced", billId: "b1", receiptNumber: "R1" });
});

test("decide: guard รูปแอปเก่า ต้องอ่านบิล", () => {
  const id = `shopA${UUID}`;
  const guard = { createdAt: 1, usedBy: "billX" };
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: null, guard }), { kind: "need_bill", billId: "billX" });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: null, guard, billOfGuard: { shopId: "shopA", receiptNumber: "R9" } }), { kind: "synced", billId: "billX", receiptNumber: "R9" });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: null, guard, billOfGuard: null }), { kind: "synced", billId: "billX", receiptNumber: null });
  assert.deepEqual(decide({ receiptUUID: id, shopRef: REF, discard: null, guard, billOfGuard: { shopId: "shopB" } }), { kind: "other_shop" });
  // doc id ไม่ขึ้นต้นด้วย shopId ของร้านนี้ = ร้านอื่น
  assert.deepEqual(decide({ receiptUUID: `shopB${UUID}`, shopRef: REF, discard: null, guard }), { kind: "other_shop" });
});

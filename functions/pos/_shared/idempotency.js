// pos/_shared/idempotency.js — กันทำซ้ำ: receiptGuard (บิล) · requestId (ยกเลิก กะ แก้บิล) (ก้อน 4 · DEV-0001)
//
// receiptGuard/{receiptUUID} = collection เดิมที่แอปเก่าใช้ · doc มี 3 รูป (`schema/receiptGuard.md` RG-B6 · `entities/receiptGuard.ts`):
//   รูปแอปเก่า  {createdAt, usedBy:<bill doc id>}                      ไม่มี shopId · doc id = `${shop.shopId}${uuid}`
//   รูป route เดิม {createdAt, usedBy:<receiptNumber>, shopId:<shop doc id>}
//   รูปใหม่     {createdAt, usedBy:<receiptNumber>, billId, shopId:<shop doc id>}   (+ byAdmin adminUid เมื่อทีมงานทำ)
// ด่านข้ามร้าน (architecture-plan ก้อน 4 · พี่น้องไม่ตรวจข้อนี้):
//   มี shopId = เทียบกับ shop doc id ของผู้เรียก · ไม่มี shopId = doc id ต้องเป็น `<shop.shopId ของผู้เรียก><uuid>`
//     (ร้านไม่มี field shopId = `undefined<uuid>` · field ของร้าน S5 ต้องผ่าน auth.resolveShopRef ก่อน)
//   ไม่ผ่าน = other_shop ⇒ handler ตอบ 409 receipt_uuid_other_shop โดย ❌ ไม่คืน billId / receiptNumber
// ทุกตัวในไฟล์นี้ pure (ไม่แตะฐาน) · handler อ่าน doc ใน transaction แล้วส่ง data เข้ามา
"use strict";

const { toMillis } = require("@shopchamp/logic");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMEND_PENDING_TTL_MS = 5 * 60 * 1000; // สัญญา sale.amend: pending คำขออื่น < 5 นาที → 409 amend_in_progress

/**
 * readReceiptUUID(body) — ด่านปากทางก่อน Zod และก่อนแตะฐาน (สัญญา sale.create: 400 invalid_receipt_uuid)
 * @returns {string|null} ค่าเดิม (ไม่ trim · doc id ต้องตรงตัว) หรือ null เมื่อไม่มี / ไม่ใช่ string / ว่างหรือช่องว่างล้วน
 */
function readReceiptUUID(body) {
  const v = body && typeof body === "object" ? body.receiptUUID : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * legacyGuardPrefix(shopField, shopFieldState) — ข้อความหน้า uuid ที่แอปเก่าเขียนเป็น doc id: `${shop.shopId}${uuid}`
 *   (`main3:src/screens/CheckoutScreen.js:113,710` · shopId มาจาก state.shop)
 *   field มีค่า = ค่านั้น · ร้านไม่มี field = 'undefined' · field เป็น null = 'null' (ตามที่ template string ของ JS ให้)
 *   shopFieldState มาจาก shopRef.fieldState (auth.js) · ไม่ส่ง = ใช้ shopField อย่างเดียว (พฤติกรรมเดิม)
 *   field มีค่าแต่ยังไม่ผ่านการพิสูจน์ (shopField null + state 'present') = null ⇒ ไม่รับ guard รูปแอปเก่า (fail-closed)
 */
function legacyGuardPrefix(shopField, shopFieldState) {
  if (typeof shopField === "string" && shopField !== "") return shopField;
  if (shopFieldState === "missing") return "undefined";
  if (shopFieldState === "null") return "null";
  return null;
}

/** doc id รูปแอปเก่าเป็นของร้านนี้ไหม: `${prefix}${uuid}` เป๊ะ (prefix อย่างเดียวไม่พอ · shopId ร้านหนึ่งเป็น prefix ของอีกร้านได้) */
function legacyGuardIdOfShop(guardId, shopField, shopFieldState) {
  const prefix = legacyGuardPrefix(shopField, shopFieldState);
  if (typeof guardId !== "string" || prefix === null) return false;
  if (!guardId.startsWith(prefix)) return false;
  return UUID_RE.test(guardId.slice(prefix.length));
}

/**
 * classifyGuard({guardId, guard, shopDocId, shopField, shopFieldState})
 * @param {string} p.guardId receiptUUID (= doc id)
 * @param {object|null|undefined} p.guard `snap.data()` · ไม่มี doc = null/undefined
 * @param {string} p.shopDocId shop doc id ที่ผ่านด่าน (req.shopAccess.shopId)
 * @param {string|null} p.shopField shopRef.shopId (field shop.shopId ที่เชื่อได้ · จาก resolveShopRef)
 * @param {string} [p.shopFieldState] shopRef.fieldState · 'missing' = ร้านไม่มี field ⇒ guard แอปเก่ามี id `undefined<uuid>`
 *   guard `undefined<uuid>` ไม่ผูกร้าน (ทุกร้านที่ไม่มี field ใช้ prefix เดียวกัน) ⇒ หลักฐานคือรู้ uuid + บิลที่ guard ชี้ต้องไม่ใช่ของร้านอื่น
 *   (legacyDuplicateFromBill ตรวจ · บิลไม่มีให้อ่าน = duplicate ที่ไม่มีเลข)
 * @returns
 *   {kind:'none'}                                     ยังไม่มีบิลจาก uuid นี้ ⇒ ออกบิลใหม่ได้
 *   {kind:'other_shop'}                               ⇒ 409 receipt_uuid_other_shop (ไม่คืนอะไร)
 *   {kind:'duplicate', shape:'current', billId, receiptNumber}      ตอบ duplicate ได้ทันที
 *   {kind:'duplicate', shape:'route', billId:null, receiptNumber}   route เดิมไม่เก็บ billId
 *   {kind:'duplicate', shape:'legacyApp', billId, receiptNumber:null, needsBillRead:true}
 *       ⇒ อ่าน bill/{billId} ใน transaction แล้วใช้ legacyDuplicateFromBill
 */
function classifyGuard({ guardId, guard, shopDocId, shopField, shopFieldState } = {}) {
  if (guard === undefined || guard === null) return { kind: "none" };
  if (typeof guard !== "object" || Array.isArray(guard)) return { kind: "other_shop" }; // รูปเพี้ยน = ไม่คืนอะไร (fail-closed)
  const hasShop = typeof guard.shopId === "string" && guard.shopId !== "";
  if (hasShop) {
    if (typeof shopDocId !== "string" || guard.shopId !== shopDocId) return { kind: "other_shop" };
    const receiptNumber = typeof guard.usedBy === "string" && guard.usedBy ? guard.usedBy : null;
    if (typeof guard.billId === "string" && guard.billId) {
      return { kind: "duplicate", shape: "current", billId: guard.billId, receiptNumber };
    }
    return { kind: "duplicate", shape: "route", billId: null, receiptNumber };
  }
  if (!legacyGuardIdOfShop(guardId, shopField, shopFieldState)) return { kind: "other_shop" };
  const billId = typeof guard.usedBy === "string" && guard.usedBy && !guard.usedBy.includes("/") ? guard.usedBy : null;
  return { kind: "duplicate", shape: "legacyApp", billId, receiptNumber: null, needsBillRead: billId !== null };
}

/**
 * legacyDuplicateFromBill(classified, billData, shopRef) — guard รูปแอปเก่า: เติมเลขจาก bill/{usedBy}
 *   บิลเป็นของร้านอื่น (bill.shopId ไม่ตรงทั้ง doc id และ field) = other_shop · ไม่มีบิล = duplicate ที่ไม่มีเลข (ยังเป็น duplicate · ห้ามออกบิลซ้ำ)
 * @param {{id:string, shopId:string}} shopRef doc id และ field shopId ของร้านผู้เรียก
 */
function legacyDuplicateFromBill(classified, billData, shopRef) {
  if (!classified || classified.kind !== "duplicate") return classified;
  if (!billData || typeof billData !== "object") return { ...classified, needsBillRead: false };
  const owner = billData.shopId;
  const ref = shopRef || {};
  if (typeof owner === "string" && owner !== "" && owner !== ref.id && owner !== ref.shopId) return { kind: "other_shop" };
  const rn = billData.receiptNumber;
  return { ...classified, needsBillRead: false, receiptNumber: typeof rn === "string" && rn ? rn : null };
}

/**
 * guardDoc({now, receiptNumber, billId, shopDocId, trail}) — doc ที่เขียนลง receiptGuard/{receiptUUID} พร้อมบิล (transaction เดียว)
 *   trail = adminTrail(req.shopAccess) จาก auth.js ({} หรือ {byAdmin:true, adminUid})
 */
function guardDoc({ now, receiptNumber, billId, shopDocId, trail } = {}) {
  return { ...(trail || {}), createdAt: now, usedBy: receiptNumber, billId, shopId: shopDocId };
}

/** findByKey(list, key, value) — หาแถวที่ทำไปแล้วด้วย requestId (เช่น shift.duringShift[].entryId) · ไม่เจอ = null */
function findByKey(list, key, value) {
  if (!Array.isArray(list) || typeof value !== "string" || value === "") return null;
  return list.find((x) => x && typeof x === "object" && x[key] === value) || null;
}

/** sameRequestId(stored, requestId) — ยิงซ้ำด้วย requestId เดิม (bill.voidRequestId · shift.openRequestId · shiftHistory.closeRequestId) */
function sameRequestId(stored, requestId) {
  return typeof stored === "string" && stored !== "" && stored === requestId;
}

/** shiftHistoryDocId(shiftId, openTime) — `<shiftId>_<openTime ms>` ⇒ 1 รอบได้ประวัติใบเดียว (SC-19) · อ่านเวลาไม่ได้ = null */
function shiftHistoryDocId(shiftId, openTime) {
  if (typeof shiftId !== "string" || shiftId === "" || shiftId.includes("/")) return null;
  const ms = toMillis(openTime);
  return ms === null ? null : `${shiftId}_${Math.trunc(ms)}`;
}

/** amendReceiptUUID(billId, requestId) — receiptUUID ของใบใหม่ตอนแก้บิล · ยิงซ้ำได้ duplicate (สัญญา sale.amend ข้อ ②) */
function amendReceiptUUID(billId, requestId) {
  return `amend:${billId}:${requestId}`;
}

/**
 * amendLockState(amend, requestId, now) — สถานะล็อกแก้บิลบน bill.amend {status, requestId, at}
 * @returns 'free'   ไม่มีล็อก หรือ pending คำขออื่นที่ค้างเกิน 5 นาที (รับช่วงต่อได้)
 *          'done'   requestId เดิมทำจบแล้ว ⇒ 200 duplicate (ตรวจก่อนด่านยกเลิก)
 *          'resume' requestId เดิมค้าง pending ⇒ เดินต่อจากขั้นที่ค้าง
 *          'busy'   pending คำขออื่น < 5 นาที ⇒ 409 amend_in_progress
 *          'taken'  done ด้วยคำขออื่น ⇒ ให้ด่านบิล (ยกเลิกแล้ว / amendedBy) ตัดสินต่อ
 */
function amendLockState(amend, requestId, now) {
  if (!amend || typeof amend !== "object") return "free";
  const mine = sameRequestId(amend.requestId, requestId);
  if (amend.status === "done") return mine ? "done" : "taken";
  if (amend.status !== "pending") return "free";
  if (mine) return "resume";
  const at = toMillis(amend.at);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (at === null || !Number.isFinite(nowMs)) return "busy"; // อ่านเวลาไม่ได้ = ถือว่ายังค้าง (fail-closed · ไม่แก้ซ้อน)
  return nowMs - at < AMEND_PENDING_TTL_MS ? "busy" : "free";
}

module.exports = {
  readReceiptUUID,
  legacyGuardPrefix,
  legacyGuardIdOfShop,
  classifyGuard,
  legacyDuplicateFromBill,
  guardDoc,
  findByKey,
  sameRequestId,
  shiftHistoryDocId,
  amendReceiptUUID,
  amendLockState,
  AMEND_PENDING_TTL_MS,
};

// pos/sale/discardPendingDoc.js — ตัวช่วย pure ของ sale.discardPending (ก้อน 4 · DEV-0001)
//
// หน้าที่: ประกอบ doc ร่องรอย pendingDiscard/{receiptUUID} และตัดสินลำดับด่าน โดยไม่แตะฐาน
//   ⇒ เทสข้างไฟล์ได้โดยไม่ต้องมี Firestore
//
// ทำไมต้องตรวจ body ก่อนเขียน: สัญญารับ body ทุกรูป (ใบที่ลบมักเป็นใบเสีย) แต่ Firestore ปัด
//   array ซ้อน array · map ลึกเกิน 20 ชั้น · ชื่อ field ว่าง หรือรูป `__x__` · doc เกิน 1 MiB
//   ถ้าเขียนตรง ๆ ใบเสียแบบนี้จะได้ 500 และเจ้าของลบไม่ได้ ⇒ เก็บเป็นข้อความ JSON ใน bodyJson แทน (ร่องรอยไม่หาย)
"use strict";

const { belongsToShop } = require("../_shared/auth");
const { classifyGuard, legacyDuplicateFromBill } = require("../_shared/idempotency");

const MAX_DEPTH = 20; // Firestore: map/array ซ้อนได้ไม่เกิน 20 ชั้น
const MAX_BODY_BYTES = 512 * 1024; // เผื่อที่ให้ field อื่นใน doc 1 MiB
const RESERVED_KEY = /^__.*__$/;

/** bodyStorable(v) — เก็บเป็น map ใน Firestore ได้ตรง ๆ ไหม (array ซ้อน array · ลึกเกิน · ชื่อ field ต้องห้าม = ไม่ได้) */
function bodyStorable(v, depth = 0, inArray = false) {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) {
    if (inArray) return false;
    return v.every((x) => bodyStorable(x, depth + 1, true));
  }
  if (v !== null && typeof v === "object") {
    return Object.keys(v).every((k) => k !== "" && !RESERVED_KEY.test(k) && bodyStorable(v[k], depth + 1, false));
  }
  if (typeof v === "number") return Number.isFinite(v);
  return v === null || typeof v === "string" || typeof v === "boolean";
}

/**
 * bodyFields(body) — field ของ body ที่จะลง doc
 *   เก็บได้ตรง ๆ = {body} · เก็บไม่ได้ = {bodyJson} · ใหญ่เกิน = {bodyTooLarge:true, bodyBytes}
 */
function bodyFields(body) {
  let json;
  try { json = JSON.stringify(body); } catch (_) { json = undefined; }
  if (typeof json !== "string") return { bodyUnreadable: true };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_BODY_BYTES) return { bodyTooLarge: true, bodyBytes: bytes };
  return bodyStorable(body) ? { body } : { bodyJson: json };
}

/**
 * discardDoc({input, access, now, trail}) — doc ที่เขียนลง pendingDiscard/{receiptUUID}
 *   {shopId, receiptUUID, offlineRef?, body, reason, by, at, deviceAt?} (+ byAdmin adminUid เมื่อทีมงานทำ)
 *   shopId = shop doc id ที่ผ่านด่าน · at = เวลา server · deviceAt = ข้อความเวลาเครื่องตามที่ส่งมา (ไม่เชื่อ ไม่แปลง)
 *   field ที่ไม่ได้ส่ง = ไม่ใส่ (Firestore ปัด undefined)
 */
function discardDoc({ input, access, now, trail } = {}) {
  const doc = {
    ...(trail || {}),
    shopId: access.shopId,
    receiptUUID: input.receiptUUID,
    ...bodyFields(input.body),
    reason: input.reason,
    by: access.uid,
    at: now,
  };
  if (input.offlineRef !== undefined) doc.offlineRef = input.offlineRef;
  if (input.deviceAt !== undefined) doc.deviceAt = input.deviceAt;
  return doc;
}

/**
 * decide({receiptUUID, shopRef, discard, guard, billOfGuard}) — ผลของคำขอจาก doc ที่อ่านใน transaction
 *   ลำดับ: ร้านอื่น (ทั้งร่องรอยและ guard) → ซิงก์แล้ว → ส่งซ้ำ → เขียนใหม่
 *   ซิงก์แล้วมาก่อนส่งซ้ำ: ถ้าบิลขึ้น server ทีหลังร่องรอย แอปต้องรู้ว่าบิลอยู่บน server (เปลี่ยนแถวเป็น synced)
 * @returns {{kind:'other_shop'}|{kind:'synced', billId, receiptNumber}|{kind:'duplicate'}|{kind:'write'}|{kind:'need_bill', billId}}
 */
function decide({ receiptUUID, shopRef, discard, guard, billOfGuard } = {}) {
  if (discard !== undefined && discard !== null && !belongsToShop(discard && discard.shopId, shopRef)) {
    return { kind: "other_shop" };
  }
  let g = classifyGuard({ guardId: receiptUUID, guard, shopDocId: shopRef.id, shopField: shopRef.shopId, shopFieldState: shopRef.fieldState });
  if (g.kind === "other_shop") return { kind: "other_shop" };
  if (g.kind === "duplicate" && g.needsBillRead) {
    if (billOfGuard === undefined) return { kind: "need_bill", billId: g.billId };
    g = legacyDuplicateFromBill(g, billOfGuard, shopRef);
    if (g.kind === "other_shop") return { kind: "other_shop" };
  }
  if (g.kind === "duplicate") return { kind: "synced", billId: g.billId || null, receiptNumber: g.receiptNumber || null };
  if (discard !== undefined && discard !== null) return { kind: "duplicate" };
  return { kind: "write" };
}

const UUID_TAIL_LEN = 36;
const UUID_TAIL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * foreignPrefixOf(receiptUUID, shopRef) — B-7 (agent เลือกทางปลอดภัย 2026-11-06 · Pack ให้เลือกเอง)
 *   รหัสรูปแอปเก่า `<shop.shopId><uuid>` ที่ prefix ไม่ใช่ของร้านนี้ = ต้องตรวจว่าเป็นของร้านอื่นไหมก่อนจองร่องรอย
 *   (doc id ร่องรอย = receiptUUID ร่วมทุกร้าน ⇒ ร้าน B จอง `shopA<uuid>` ได้ แล้วร้าน A ลบใบนั้นได้ 409 ตลอด)
 * @returns {null} ไม่ต้องตรวจ (ไม่มี prefix · uuid ล้วน · prefix = doc id หรือ field ของร้านนี้)
 *   | {{refuse:true}} prefix 'undefined'/'null' แต่ร้านนี้มี field (ไม่ใช่ prefix ของร้านนี้แน่ · ไม่ผูกร้านใด = ปัดเลย)
 *   | {{prefix}} ให้ handler อ่าน shop/{prefix} และ shop where shopId == prefix
 */
function foreignPrefixOf(receiptUUID, shopRef) {
  if (typeof receiptUUID !== "string" || receiptUUID.length <= UUID_TAIL_LEN) return null;
  const tail = receiptUUID.slice(-UUID_TAIL_LEN);
  if (!UUID_TAIL_RE.test(tail)) return null;
  const prefix = receiptUUID.slice(0, -UUID_TAIL_LEN);
  const ref = shopRef || {};
  if (prefix === ref.id || (typeof ref.shopId === "string" && ref.shopId !== "" && prefix === ref.shopId)) return null;
  if (prefix === "undefined") return ref.fieldState === "missing" ? null : { refuse: true };
  if (prefix === "null") return ref.fieldState === "null" ? null : { refuse: true };
  return { prefix };
}

module.exports = { bodyStorable, bodyFields, discardDoc, decide, foreignPrefixOf, MAX_BODY_BYTES, MAX_DEPTH };

// pos/report/_reportShared — ด่านและตัวค้นที่ route รายงานทุกตัวใช้ร่วมกัน (ก้อน 9e · DEV-0001)
//
// route รายงานอยู่บน function `pos_heavy` (workloads.js · 2GiB · concurrency 1 · 300 วิ) · อ่านอย่างเดียว ไม่มีการเขียนฐาน
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// openReport ลำดับด่าน (เหมือน sale.get + ด่านสิทธิ์และสถานะพนักงาน):
//   ไม่มี req.shopAccess 401 no_shop_access → body ผิด schema 400 invalid_request → body.shopId ≠ ร้านที่ผ่านด่าน 403 wrong_shop
//   → สิทธิ์ (พนักงานต้องมีรหัสใดรหัสหนึ่ง · เจ้าของ/ทีมงานผ่าน) 403 right_required
//   → อ่าน shop/{shopId} · ไม่มี 404 shop_not_found
//   → ผู้เรียกที่ไม่ใช่ทีมงานต้องอยู่ใน humanResource และ status active (ด่านซ้ำของ requireShopAccess · Pack เคาะ B-11 2026-11-06)
//     ไม่อยู่ 403 not_shop_member reason not_a_member · ไม่ active 403 not_shop_member reason inactive
//   → resolveShopRef (ร้าน S5 doc id ≠ field · บิลเก่าถือค่า field) → คืน {access, input, shop, shopRef, keys}
// keys = ค่า shopId ที่เอกสารของร้านนี้ถือได้ (doc id + field ที่พิสูจน์แล้ว) · ค้นทีละค่าแล้วรวม (ไม่ใช้ `in` เพื่อให้ใช้ index เดิม)
"use strict";

const { db } = require("../../firebase");
const { fail, deny, sendDeny, parseOr400 } = require("../_shared/respond");
const { callerAccess, resolveShopRef, hasRight, staffStatusOf, belongsToShop, isStaffAccess } = require("../_shared/auth");
const { readNow } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const logic = require("@shopchamp/logic");

// สิทธิ์ของแอปเก่า (main3 src/screens/StaffScreen.js:52-66 · HomeScreen.js:56-59 · CashierScreen.js:635)
const RIGHT = Object.freeze({ REPORT: "106", BILL_HISTORY: "117", SHIFT: "102" });

/**
 * openReport(req, res, schema, {rights}) → Promise<null | {access, input, shop, shopRef, keys}>
 *   null = ส่งคำตอบไปแล้ว (handler return res)
 *   rights = รหัสสิทธิ์ที่พนักงานมีตัวใดตัวหนึ่งก็พอ
 */
async function openReport(req, res, schema, { rights } = {}) {
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const gate = callerAccess(req, body.shopId, { read: true }); // รายงานอ่านอย่างเดียว ⇒ watcher ผ่าน
  if (!gate.ok && gate.status === 401) { sendDeny(res, gate); return null; }
  const input = parseOr400(schema, body, res);
  if (input === null) return null;
  if (!gate.ok) { sendDeny(res, gate); return null; }
  const access = gate.access;
  const need = Array.isArray(rights) ? rights : [];
  if (need.length && !need.some((r) => hasRight(access, r))) { sendDeny(res, deny(403, "right_required")); return null; }

  const shopSnap = await db.collection("shop").doc(access.shopId).get();
  if (!shopSnap.exists) { fail(res, 404, "shop_not_found"); return null; }
  const shop = shopSnap.data() || {};
  if (!isStaffAccess(access)) {
    const st = staffStatusOf(shop, access.uid, access);
    if (st !== "active") {
      sendDeny(res, deny(403, "not_shop_member", undefined, { reason: st === "inactive" ? "inactive" : "not_a_member" }));
      return null;
    }
  }
  const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });
  const keys = [shopRef.id];
  if (typeof shopRef.shopId === "string" && shopRef.shopId !== "" && shopRef.shopId !== shopRef.id) keys.push(shopRef.shopId);
  return { access, input, shop, shopRef, keys };
}

/**
 * freeWindowGate(deps, shop, fromDay, res) → Promise<boolean> · false = ตอบ 403 premium_required ไปแล้ว
 *   ด่านแพ็กเกจเดิมของเว็บ (own:components/TimeContainer.js:77-83): ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วันไม่ได้
 *   ใช้กับ billList salesTotals shiftHistory · ทีมงาน Shopchamp ก็ติดเหมือนกัน (เป็นสมบัติของร้าน เหมือนรายงานภาษี)
 *   ❓ ค่าตั้งต้นรอ Pack ยืนยัน (chunk9/9e-reports.md คำถาม 7) · นาฬิกาจาก deps.now (readNow) ครั้งเดียวต่อคำขอ
 */
async function freeWindowGate(deps, shop, fromDay, res) {
  const now = await readNow(deps);
  if (isPremiumActive(shop, now)) return true;
  if (logic.freeWindowOk({ fromDay, now, cutOff: shop.cutOff })) return true;
  fail(res, 403, "premium_required");
  return false;
}

/** รวมผลค้นหลายชุด · id ซ้ำนับครั้งเดียว · เอกสารที่ไม่ใช่ของร้านนี้ทิ้ง (กันผลค้นผิดพลาด) */
function mergeSnaps(snaps, shopRef) {
  const seen = new Map();
  for (const snap of snaps) {
    const docs = snap && Array.isArray(snap.docs) ? snap.docs : [];
    for (const d of docs) {
      if (seen.has(d.id)) continue;
      const data = d.data();
      if (!data || !belongsToShop(data.shopId, shopRef)) continue;
      seen.set(d.id, { id: d.id, data });
    }
  }
  return [...seen.values()];
}

/**
 * billsByTime({keys, shopRef, after, upTo, fields, limit}) — บิลของร้านที่ after < dateTime <= upTo
 *   index ที่ใช้: bill(shopId ASC, dateTime DESC) มีแล้วใน firestore.indexes.json
 *   fields = select (ลดขนาด) · limit ต่อค่า key
 */
async function billsByTime({ keys, shopRef, after, upTo, fields, limit }) {
  const snaps = await Promise.all(keys.map((k) => {
    let q = db.collection("bill").where("shopId", "==", k).where("dateTime", ">", after).where("dateTime", "<=", upTo).orderBy("dateTime", "desc");
    if (Array.isArray(fields) && fields.length) q = q.select(...fields);
    if (Number.isInteger(limit) && limit > 0) q = q.limit(limit);
    return q.get();
  }));
  return mergeSnaps(snaps, shopRef);
}

/**
 * billsByPrefix({keys, shopRef, field, prefix, fields}) — บิลที่ field (receiptNumber | taxNumber) ขึ้นต้นด้วย prefix
 *   index ที่ใช้: bill(shopId, receiptNumber) · bill(shopId, taxNumber) มีแล้ว
 */
async function billsByPrefix({ keys, shopRef, field, prefix, fields }) {
  const snaps = await Promise.all(keys.map((k) => {
    let q = db.collection("bill").where("shopId", "==", k).where(field, ">=", prefix).where(field, "<=", `${prefix}`);
    if (Array.isArray(fields) && fields.length) q = q.select(...fields);
    return q.get();
  }));
  return mergeSnaps(snaps, shopRef);
}

module.exports = { RIGHT, openReport, freeWindowGate, mergeSnaps, billsByTime, billsByPrefix };

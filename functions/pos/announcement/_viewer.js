// pos/announcement/_viewer.js — ของร่วมของ feed.js และ seen.js: ร้าน + คน + ประกาศที่เป็นไปได้ (DEV-0003 0e · ประกาศถึงร้าน)
//
// ความจริงเรื่อง "ใครเห็น/เห็นช่องไหน/รอบไหน" อยู่ที่ @shopchamp/logic announcement.js ที่เดียว · ไฟล์นี้แค่อ่านฐานแล้วประกอบส่งให้ logic
//   ป้ายประเภทร้านอ่านจาก shopCategoryTag/{shopId} (office ติด · ร้านเขียนช่องบน doc ร้านเองไม่มีผล)
//   ประกาศที่เป็นไปได้ 2 query (ไม่ต้องมี index ผสม):
//     ① ชั่วคราว: startAt <= now · ใหม่สุดก่อน · เพดาน CAMPAIGN_LIMIT (ข่าวเก่ากว่านั้นหลุดจากกล่องข่าว · ตั้งใจ)
//     ② ถาวร: kind == evergreen && active == true · เพดาน EVERGREEN_LIMIT
//   ซื้อแพ็กเกจล่าสุด (เงื่อนไข purchased) = packageOrder ของร้าน status success · อ่านเฉพาะเมื่อมีประกาศ purchased ที่ร้าน/คนผ่าน
//     เวลาใบ = fulfilledAt (ทางใหม่ _fulfill.js ประทับตอนเปิดของ) · ไม่มี = timestamp (เวลาสั่งซื้อ · care อนุมัติไม่ประทับเวลา ApproveSoftwareScreen.js:102-106)
//     ชนิด/ชื่อแพ็กเกจ = logic.companyPackageFulfillItems(admin/package, packageId) · อ่านไม่ได้ = ไม่มีชื่อ (ประกาศยังขึ้น)
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");

const COLLECTION = "announcement";
const SEEN = "seen";
const TAGS = "shopCategoryTag";
const CAMPAIGN_LIMIT = 100;
const EVERGREEN_LIMIT = 200;
const ORDER_LIMIT = 200;
const NO_MATCH = Object.freeze({ match: false, cycleKey: null, vars: null });

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const annCol = () => db.collection(COLLECTION);

/** ใบซื้อแพ็กเกจสำเร็จล่าสุดของร้าน → {at, types, packageName} | null */
async function lastPurchaseOf(shopId) {
  const snap = await db.collection("packageOrder").where("shopId", "==", shopId).where("status", "==", "success").limit(ORDER_LIMIT).get();
  let best = null;
  for (const d of snap.docs) {
    const o = d.data() || {};
    const ms = logic.toMillis(o.fulfilledAt) !== null ? logic.toMillis(o.fulfilledAt) : logic.toMillis(o.timestamp);
    if (ms !== null && (!best || ms > best.ms)) best = { ms, order: o };
  }
  if (!best) return null;
  let types = [];
  let packageName = null;
  try {
    const pkg = await db.collection("admin").doc("package").get();
    const r = logic.companyPackageFulfillItems(pkg && pkg.exists ? pkg.data() : null, Array.isArray(best.order.packageId) ? best.order.packageId : []);
    if (r.ok) {
      types = r.items.map((x) => x.type);
      const names = [...new Set(r.items.map((x) => (typeof x.name === "string" ? x.name.trim() : "")).filter(Boolean))];
      packageName = names.length ? names.join(", ") : null;
    }
  } catch (_) { /* ชื่อแพ็กเกจไม่มี = ใช้ชื่อตามชนิด/ว่าง */ }
  return { at: new Date(best.ms), types, packageName };
}

/**
 * viewerOf(shopId, uid, now) → ตัวตัดสินของคนนี้ในร้านนี้ (อ่าน shop + ป้ายครั้งเดียว)
 *   matches(a)    ร้าน+คนผ่าน
 *   evergreen(a)  ผลรอบของประกาศถาวร (async · อ่านใบซื้อเมื่อจำเป็นครั้งเดียว) · ชั่วคราว = ไม่ match
 *   vars          ตัวแปรของประกาศชั่วคราว ({ชื่อร้าน})
 */
async function viewerOf(shopId, uid, now) {
  const [shopSnap, tagSnap] = await Promise.all([db.collection("shop").doc(shopId).get(), db.collection(TAGS).doc(shopId).get()]);
  const shop = shopSnap && shopSnap.exists ? shopSnap.data() || {} : {};
  const tag = tagSnap && tagSnap.exists ? tagSnap.data() || {} : {};
  const ctx = { shopId, shop, categoryIds: Array.isArray(tag.categoryIds) ? tag.categoryIds : [] };
  let purchase;
  return {
    shop,
    vars: { shopName: typeof shop.name === "string" && shop.name.trim() !== "" ? shop.name.trim() : null, packageName: null, expireDate: null, daysLeft: null },
    matches: (a) => logic.announcementMatchesShop(a, ctx, now) && logic.announcementMatchesPerson(a, shop, uid),
    async evergreen(a) {
      if (!isObj(a) || a.kind !== "evergreen") return NO_MATCH;
      const needsPurchase = isObj(a.trigger) && a.trigger.type === "purchased";
      if (needsPurchase && purchase === undefined) purchase = await lastPurchaseOf(shopId);
      return logic.announcementEvergreenMatch(a, { shop, lastPurchase: needsPurchase ? purchase : null }, now);
    },
  };
}

/** ประกาศที่เป็นไปได้ทั้งหมดของ feed (ยังไม่คัด) → [{...data, id}] */
async function candidates(now) {
  const [camp, ever] = await Promise.all([
    annCol().where("startAt", "<=", now).orderBy("startAt", "desc").limit(CAMPAIGN_LIMIT).get(),
    annCol().where("kind", "==", "evergreen").where("active", "==", true).limit(EVERGREEN_LIMIT).get(),
  ]);
  const byId = new Map();
  for (const d of camp.docs) { const a = d.data() || {}; if (a.kind === "campaign") byId.set(d.id, { ...a, id: d.id }); }
  for (const d of ever.docs) if (!byId.has(d.id)) byId.set(d.id, { ...(d.data() || {}), id: d.id });
  return [...byId.values()];
}

const seenRef = (id, uid) => annCol().doc(id).collection(SEEN).doc(uid);

/** seen ของ uid ต่อประกาศ (getAll ก้อนเดียว) → Map id → data */
async function readSeen(list, uid) {
  const out = new Map();
  if (!list.length) return out;
  const snaps = await db.getAll(...list.map((a) => seenRef(a.id, uid)));
  snaps.forEach((s, i) => { if (s && s.exists) out.set(list[i].id, s.data()); });
  return out;
}

/** FieldValue ตัวจริงจาก admin · harness/เทสส่งของปลอมทาง functions/firebase (แบบ _shared/stockJournal.js) */
function fieldValue() {
  const fb = require("../../firebase");
  const fv = fb && (fb.FieldValue || (fb.admin && fb.admin.firestore && fb.admin.firestore.FieldValue));
  if (!fv || typeof fv.increment !== "function") throw new Error("functions/firebase ไม่มี FieldValue.increment");
  return fv;
}

module.exports = { COLLECTION, SEEN, TAGS, CAMPAIGN_LIMIT, EVERGREEN_LIMIT, NO_MATCH, annCol, seenRef, viewerOf, candidates, readSeen, lastPurchaseOf, fieldValue };

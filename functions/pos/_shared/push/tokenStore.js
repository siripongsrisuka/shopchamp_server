// pos/_shared/push/tokenStore.js — ทะเบียนเครื่องรับแจ้งเตือน `pushDevices` ของแอปรุ่นใหม่ (DEV-0001 push)
//
// ยกจากบ้านพี่น้อง (tokenStore.js · `push-pattern-from-sibling.md` §1.2) แล้วแก้ชื่อ · รูป doc = @shopchamp/schema PushDevice
//   doc id = `app-<sha256(deviceKey) 32 ตัว>` · 1 doc ต่อเครื่อง · server เท่านั้นที่เขียน
//
// ผู้รับ (แปลตรงจาก filter tag ของ OneSignal ที่แอปเก่าใช้ · `APP/src/api/onesignal.js:553-603`):
//   { kind:'shop',   shopId }        = pushByShopFilter / pushByOneFilter (ทั้งร้าน)
//   { kind:'staff',  shopId, ids }   = pushByTwoFilter ราย id (id AND shopId) · หลายคน = OR ของรายคน
//   { kind:'people', ids }           = pushByIdFilter (คนนี้ทุกร้าน · ผู้ซื้อแพ็กเกจ · ทีมงาน Shopchamp)
//   ⚠️ ids ว่าง / shopId ว่าง = [] (ห้ามตกไปทั้งร้านหรือทุกเครื่อง)
// เลือกเฉพาะ `client:'native'` (แอปใหม่) และไม่ invalid · กรองในหน่วยความจำ ⇒ ไม่ต้องพึ่ง composite index
"use strict";

const crypto = require("crypto");

const COLLECTION = "pushDevices";
const IN_LIMIT = 30; // เพดานของ Firestore `in`

function defaultDb() {
  return require("../../../firebase").db; // lazy
}

/** deviceIdOf(deviceKey) → `app-<sha256 32 ตัว>` · ค่าดิบไม่ถูกเก็บ */
function deviceIdOf(deviceKey) {
  return "app-" + crypto.createHash("sha256").update(String(deviceKey)).digest("hex").slice(0, 32);
}

const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x.trim() !== ""))];

function rowsOf(snap, shopId) {
  const out = [];
  (snap.docs || []).forEach((doc) => {
    const d = doc.data() || {};
    if (d.invalid === true || d.client !== "native") return;
    if (typeof d.token !== "string" || !d.token) return;
    if (d.platform !== "android" && d.platform !== "ios") return;
    if (shopId !== undefined && d.shopId !== shopId) return;
    out.push({ docId: doc.id, token: d.token, platform: d.platform, staffId: d.staffId || null, shopId: d.shopId || null });
  });
  return out;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((t) => (seen.has(t.token) ? false : (seen.add(t.token), true)));
}

/** findTargets(to, { db }) → [{docId, token, platform, staffId, shopId}] · รูปผิด = [] (ไม่เดา) */
async function findTargets(to, deps = {}) {
  if (!to || typeof to !== "object") return [];
  const db = deps.db || defaultDb();
  const coll = db.collection(COLLECTION);
  if (to.kind === "shop") {
    if (typeof to.shopId !== "string" || !to.shopId) return [];
    return dedupe(rowsOf(await coll.where("shopId", "==", to.shopId).get(), to.shopId));
  }
  if (to.kind === "staff") {
    if (typeof to.shopId !== "string" || !to.shopId) return [];
    const ids = cleanIds(to.ids);
    const all = [];
    for (let i = 0; i < ids.length; i += IN_LIMIT) {
      const chunk = ids.slice(i, i + IN_LIMIT);
      const snap = await coll.where("shopId", "==", to.shopId).where("staffId", "in", chunk).get();
      all.push(...rowsOf(snap, to.shopId).filter((r) => chunk.includes(r.staffId)));
    }
    return dedupe(all);
  }
  if (to.kind === "people") {
    const ids = cleanIds(to.ids);
    const all = [];
    for (let i = 0; i < ids.length; i += IN_LIMIT) {
      const chunk = ids.slice(i, i + IN_LIMIT);
      const snap = await coll.where("staffId", "in", chunk).get();
      all.push(...rowsOf(snap).filter((r) => chunk.includes(r.staffId)));
    }
    return dedupe(all);
  }
  return [];
}

/** markInvalid(docIds, reason, { db, now }) — ติดธง token ตาย (ไม่ลบ doc) · คืนจำนวน */
async function markInvalid(docIds, reason, deps = {}) {
  const ids = [...new Set((docIds || []).filter(Boolean))];
  if (ids.length === 0) return 0;
  const db = deps.db || defaultDb();
  const now = deps.now || new Date();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + 400)) {
      batch.set(db.collection(COLLECTION).doc(id), { invalid: true, invalidReason: String(reason || "dead"), invalidAt: now, updatedAt: now }, { merge: true });
    }
    await batch.commit();
  }
  return ids.length;
}

module.exports = { COLLECTION, IN_LIMIT, deviceIdOf, findTargets, markInvalid };

// pos/member/_gate.js — ด่านร่วมของโดเมนสมาชิกและสินค้า ก้อน 9b (member.* promotion.* product.* priceTag.*) · DEV-0001
//
// ทำไมมีไฟล์นี้ (ไม่ใช่ _shared): กติกาข้อ collision ของก้อน 9 ห้ามแก้ _shared ⇒ รวมของที่ 10 handler ของโดเมนนี้ใช้ซ้ำไว้ที่เดียว
//   ถ้าแม่จะย้ายเข้า _shared ภายหลัง ย้ายได้ทั้งไฟล์ (ไม่มี state)
//
// readShopForWrite({tx, shopDocId, access, now}) — อ่าน shop ใน transaction เป็นตัวแรก แล้วตรวจซ้ำในตัว handler:
//   ไม่มี doc ร้าน 404 shop_not_found
//   ผู้เรียกที่ไม่ใช่ทีมงาน ต้องยัง active ในร้านตอนนี้ (กติกาเดียวกับ requireShopAccess · `_shared/auth.js` memberStatusOf)
//     ⇒ พนักงานถูกปิดสถานะระหว่างที่ token ยังใช้ได้ = 403 not_shop_member reason inactive (Pack เคาะ B-11 · ก้อน 4)
//     middleware ปัดอยู่แล้วตอนเข้า route · ที่นี่ปัดซ้ำใน transaction เพราะ harness ไม่รัน middleware และกันจังหวะชนกัน
//   คืน {shop, ref, shopField, fieldUnproven} · shopField = ค่าที่แอปเก่าเขียนลง `<doc>.shopId` (field ของร้านที่พิสูจน์แล้ว · ไม่มี = doc id)
//   fieldUnproven = ร้าน S5 ที่ field ≠ doc id และพิสูจน์ไม่ผ่าน (เช่น field ใช้ร่วม 2 ร้าน · วัด 2026-11-06: 107 ร้าน)
//     ⇒ สมาชิกเดิมของแอปเก่าถือ field แต่ server นับด้วย doc id ไม่เห็น ⇒ ตัวนับ/เพดานต้องใช้ตัวนับเดิมของร้านประกอบ (ผลตรวจ 9b ผ4)
//   trailFor(access, prev) — รอยทีมงานบน doc ที่ update: ทีมงาน = {byAdmin:true, adminUid} · คนในร้านแก้ doc ที่รอยล่าสุดเป็นทีมงาน
//     = {byAdmin:false, adminUid:null} (รอย = คนเขียนล่าสุด แบบ shift/manage.js) · ไม่เคยมีรอย = {} (decision 3-2 · ผลตรวจ 9b ผ3)
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const { memberStatusOf, resolveShopRef, adminTrail, isStaffAccess } = require("../_shared/auth");

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

async function readShopForWrite({ tx, shopDocId, access, now }) {
  const shopRef = db.collection("shop").doc(shopDocId);
  const snap = await tx.get(shopRef);
  if (!snap.exists) refuse(deny(404, "shop_not_found"));
  const shop = snap.data() || {};
  if (!isStaffAccess(access)) {
    const st = memberStatusOf(shop, access && access.uid, now);
    if (st.status !== "active") refuse(deny(403, "not_shop_member", undefined, { reason: st.status }));
  }
  const ref = await resolveShopRef({ db, shopDocId, shop });
  const fieldUnproven = !ref.shopId && ref.fieldState === "present" && shop.shopId !== shopDocId;
  return { shopRef, shop, ref, shopField: ref.shopId || shopDocId, fieldUnproven };
}

function trailFor(access, prev) {
  if (access && access.byAdmin === true) return adminTrail(access);
  return prev && prev.byAdmin === true ? { byAdmin: false, adminUid: null } : {};
}

/** ตัวนับเดิมของร้าน (shop.totalMember) ที่ใช้ได้ = จำนวนเต็ม ≥ 0 · อย่างอื่น = 0 */
function storedCount(shop) {
  const n = shop ? shop.totalMember : undefined;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

module.exports = { Refusal, refuse, readShopForWrite, isObj, trailFor, storedCount };

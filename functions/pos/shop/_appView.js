// pos/shop/_appView.js — ข้อมูลร้านก้อนที่แอปเก็บลง redux (DEV-0010 คลื่น 2 · กลุ่ม shop)
//
// ใช้ที่: shop.get · profile.manage op enterShop · company.shopCreate (ของเพิ่มในคำตอบ · แอปเก่าไม่อ่าน)
// = shopView ของ profile.loading (ช่องตาม SHOP_FIELDS + id + staff) + ช่องที่แอปยังอ่านจากก้อนร้านแต่ profile.loading ไม่ส่ง
//   Pack 2026-11-14 ข้อ 7: ส่งเหมือนเดิม รวม humanResource (มี password) · line · taxCustomer · lineNoti · lineUsers
//   ❌ ไม่ทำระบบปกปิดแบบแอปพี่น้อง (hasPin · server ส่ง LINE แทน)
//   + scango (แอปอ่าน `shop.scango.enabled` ที่ `shopchamp_app/src/domain/scangoOrders.js:275` · ช่องเดียวที่ server เขียนคือ enabled)
//   หาช่องด้วย grep `shop.<ช่อง>` + destructure จาก shop ทั้ง `shopchamp_app/src` เทียบกับ SHOP_FIELDS (2026-11-14) ⇒ ขาดแค่ 6 ช่องนี้
// ยังเป็นรายการช่องที่อนุญาต (allowlist) ⇒ ช่องใหม่ที่ใครเพิ่มในฐานพรุ่งนี้ไม่หลุดออก API เอง
// ❌ ไม่แก้ profile.loading (คำสั่งแม่ · ลูกกลุ่ม member ขยายทีหลัง)
"use strict";

const { shopView, toPlain } = require("../profile/loading");
const { isStaffAccess, staffStatusOf } = require("../_shared/auth");
const { deny } = require("../_shared/respond");

const APP_EXTRA_FIELDS = Object.freeze(["humanResource", "line", "taxCustomer", "lineNoti", "lineUsers", "scango"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** appShopView(docId, shop) — ก้อนร้านที่ส่งให้แอป · id = doc id · shopId = field (ร้านเก่า 2 ค่านี้ต่างกันได้) */
function appShopView(docId, shop) {
  const src = isPlainObject(shop) ? shop : {};
  const out = shopView(docId, src);
  for (const f of APP_EXTRA_FIELDS) if (src[f] !== undefined) out[f] = toPlain(src[f]);
  return out;
}

/**
 * memberDeny(shop, access) — ด่านซ้ำในตัว handler (harness ส่ง req.shopAccess มาเอง ไม่รัน middleware) แบบ report/_reportShared.openReport
 *   ทีมงาน (root/watcher) ข้าม · คนอื่นต้องอยู่ใน humanResource และ status active
 * @returns deny 403 not_shop_member {reason} | null (ผ่าน)
 */
function memberDeny(shop, access) {
  if (isStaffAccess(access)) return null;
  const st = staffStatusOf(shop, access.uid, access);
  if (st === "active") return null;
  return deny(403, "not_shop_member", undefined, { reason: st === "inactive" ? "inactive" : "not_a_member" });
}

module.exports = { appShopView, memberDeny, APP_EXTRA_FIELDS };

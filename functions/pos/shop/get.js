// pos/shop/get — ข้อมูลร้านก้อนที่แอปเก็บลง redux (DEV-0010 คลื่น 2 · กลุ่ม shop)
//
// สัญญา: shopchamp-center/api/shop.get.yaml · route POST /pos/shop/get (auth shop · อ่านอย่างเดียว)
// แทน: fetchShop `shopchamp_app/src/redux/shopSlice.js:59` (shop where shopId == field · ทั้ง doc ลง redux)
//   ผู้เรียกเดิม: StockWarehouseScreen.js:503 · StaffScreen.js:297 · shopSlice.js:99 (saveShopOps ได้ 409 shop_changed)
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง `functions/claude/shop/get.js` (auth shop · คืนก้อนร้าน)
//   ต่างจากต้นแบบ: ❌ ไม่ตัด password/LINE token (Pack 2026-11-14 ข้อ 7) · ก้อน = appShopView (shop/_appView.js)
// ด่าน: requireShopAccess (สมาชิก active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน) → ด่านซ้ำสมาชิก active (memberDeny)
//   ไม่มีเลขสิทธิ์ (ก้อนเดียวกับที่ทุกคนได้ตอนเปิดแอปจาก profile.loading · แอปเดิมอ่านได้ทุกคนในร้าน · Pack ข้อ 9)
// Firestore อ่าน: shop 1 ครั้ง (ด่าน requireShopAccess · handler ใช้ doc ที่ด่านแนบ shopSnapOf ไม่อ่านซ้ำ)
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { callerAccess, adminFlag, shopSnapOf } = require("../_shared/auth");
const { schemaOf } = require("../stock/_shared");
const { appShopView, memberDeny } = require("./_appView");

function get(_deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
      const input = parseOr400(schemaOf("ShopGetRequest"), body, res);
      if (!input) return res;
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const snap = await shopSnapOf(db, access);
      if (!snap.exists) return fail(res, 404, "shop_not_found");
      const shop = snap.data() || {};
      const denied = memberDeny(shop, access);
      if (denied) return sendDeny(res, denied);
      return ok(res, { ...adminFlag(access), shop: appShopView(access.shopId, shop) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { get };

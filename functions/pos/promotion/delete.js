// pos/promotion/delete — ลบโปรโมชัน (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/promotion.delete.yaml · คำขอ PromotionDeleteRequest
// ทางเดิม: W3 `promotion/{id}.delete()` ลบจริง ไม่ soft (`main3:src/redux/promotionSlice.js:53-57`) ← ปุ่มลบที่จอตั้งค่า
// ด่าน: สิทธิ์ '101' · พรีเมี่ยม (_common) · promotion ไม่มี 404 · ร้านอื่น 409 promotion_other_shop
// เขียน: delete promotion/{id} อย่างเดียว · บิลเก่าที่ใช้โปรนี้มีสำเนาใน bill.campaign[] อยู่แล้ว (schema/promotion.md §3) ไม่กระทบ
//   ส่งซ้ำหลังลบสำเร็จ = 404 promotion_not_found ไม่เขียนอะไร (แอปถือว่าลบแล้ว)
"use strict";

const { db } = require("../../firebase");
const { PromotionDeleteRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag, belongsToShop } = require("../_shared/auth");
const { Refusal, refuse, readShopForWrite, isObj } = require("../member/_gate");
const { OTHER_SHOP_MSG, rightDeny, requirePremium } = require("./_common");

function del(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(PromotionDeleteRequest, body, res);
      if (!input) return;
      const rd = rightDeny(access);
      if (rd) return sendDeny(res, rd);

      const now = await readNow(deps);
      const promoRef = db.collection("promotion").doc(input.id);
      await db.runTransaction(async (tx) => {
        const { shop, ref } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        requirePremium(shop, now);
        const snap = await tx.get(promoRef);
        if (!snap.exists) refuse(deny(404, "promotion_not_found"));
        if (!belongsToShop((snap.data() || {}).shopId, ref)) refuse(deny(409, "promotion_other_shop", OTHER_SHOP_MSG));
        tx.delete(promoRef);
      });
      return ok(res, { id: input.id, deleted: true, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { delete: del, del };

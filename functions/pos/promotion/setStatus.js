// pos/promotion/setStatus — เปิดหรือปิดโปรโมชัน (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/promotion.setStatus.yaml · คำขอ PromotionSetStatusRequest
// ทางเดิม: W4 `update({status})` (`main3:src/redux/promotionSlice.js:59-63`) ← สวิตช์ที่จอรายการ (`main3:src/screens/PromotionScreen.js:53-59`)
// ด่าน: สิทธิ์ '101' · พรีเมี่ยม · 404 / 409 ร้านอื่น
//   เปิด (true) ต้องผ่าน K06 เท่าที่ doc มีข้อมูล: มี workingDays แต่ไม่เปิดสักวัน = 409 promotion_no_working_day
//     · expireType limit แต่วันสิ้นสุดก่อนวันเริ่ม = 409 promotion_date_range (โปรขึ้นว่าเปิดแต่ขายไม่ลด)
//   ปิด (false) ไม่ตรวจเนื้อ (doc รุ่นเก่าที่ไม่ผ่าน PromotionWrite ยังปิดได้)
// เขียน: update {status, updatedAt: now, updatedBy: uid} (status = ฟิลด์เดิม · 2 ตัวหลังเพิ่มอย่างเดียว)
//   + รอยทีมงาน (_gate trailFor: ทีมงาน = byAdmin adminUid · คนในร้านเปิดปิดต่อ doc ที่รอยเป็นทีมงาน = ล้างเป็น false/null)
"use strict";

const { db } = require("../../firebase");
const { PromotionSetStatusRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag, belongsToShop } = require("../_shared/auth");
const { Refusal, refuse, readShopForWrite, isObj, trailFor } = require("../member/_gate");
const { OTHER_SHOP_MSG, rightDeny, requirePremium, statusOnProblem } = require("./_common");

const PROBLEM_MSG = {
  promotion_no_working_day: "โปรนี้ไม่ได้เปิดวันไหนเลย กรุณาเลือกวันทำงานก่อนเปิด",
  promotion_date_range: "วันสิ้นสุดอยู่ก่อนวันเริ่ม กรุณาแก้ช่วงวันก่อนเปิด",
};

function setStatus(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(PromotionSetStatusRequest, body, res);
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
        const cur = snap.data() || {};
        if (!belongsToShop(cur.shopId, ref)) refuse(deny(409, "promotion_other_shop", OTHER_SHOP_MSG));
        if (input.status === true) {
          const p = statusOnProblem(cur);
          if (p) refuse(deny(409, p, PROBLEM_MSG[p]));
        }
        tx.update(promoRef, { status: input.status, updatedAt: now, updatedBy: access.uid, ...trailFor(access, cur) });
      });
      return ok(res, { id: input.id, status: input.status, updatedAt: now.toISOString(), ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { setStatus };

// pos/company/imageOrder — ร้านซื้อพื้นที่เก็บรูปเพิ่ม (แนบสลิป รอทีมงานอนุมัติ) · ก้อน 9d DEV-0001
//
// สัญญา: shopchamp-center/api/company.imageOrder.yaml · คำขอ CompanyImageOrderRequest (@shopchamp/schema)
// แทน: main3 src/screens/ImageLimitScreen.js:103-161 (admin/imageNumber · imageOrder · notification ตรงใน transaction
//   และอัปสลิป **ใน** transaction · IO-4 AC-20 ⇒ ทางใหม่แอปอัปก่อนแล้วส่ง URL)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ลำดับ: callerAccess (401/403) → รูปคำขอ (400) → runOrder (_orders.js) · ราคา = ตารางในโค้ด (logic.companyImageQuote)
// เขียน (รูปเดิม 10 field + เพิ่มอย่างเดียว):
//   imageOrder/{orderUUID} {shopId, shopName, profileId, profileName, timestamp: now, imageId: slipUrl, net, qty, status:'order', orderNumber}
//     + {orderUUID, source, byAdmin?, adminUid?}
//     shopId = field shop.shopId ที่พิสูจน์แล้ว (care หาร้านด้วย where shopId == · imageOrder.md §1 แถว 1) · พิสูจน์ไม่ได้ = doc id
//   admin/imageNumber · notification {heading:'ซื้อพิ้นที่เก็บรูปภาพ <qty> รายการ' (คำผิดคงเดิม), categoryId:99}
"use strict";

const { CompanyImageOrderRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { notify } = require("../_shared/push/notify");
const { runOrder, orderPushes, PENDING_PUSH_TEXT, Refusal, notiShopIdOf, buyerOf, str } = require("./_orders");

function imageOrder(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(CompanyImageOrderRequest, body, res);
      if (!input) return;
      const now = await readNow(deps);

      const out = await runOrder({
        access, input, now,
        collection: "imageOrder", counterDoc: "imageNumber", priceDoc: null,
        quote: () => {
          const q = logic.companyImageQuote(input.optionId);
          return q.ok ? q : deny(400, "invalid_request");
        },
        sameOrder: (prev) => prev.qty === logic.companyImageQuote(input.optionId).qty,
        buildOrder: ({ shop, ref, shopDocId, profile, q }) => {
          const buyer = buyerOf(access, profile);
          return {
            shopId: notiShopIdOf(ref, shopDocId),
            shopName: str(shop.name),
            profileId: buyer.profileId,
            profileName: buyer.profileName,
            timestamp: now,
            imageId: input.slipUrl,
            net: q.net,
            qty: q.qty,
            status: "order",
          };
        },
        buildNoti: ({ ref, shopDocId, q }) => ({
          heading: logic.companyImageNotiHeading(q.qty),
          shopId: notiShopIdOf(ref, shopDocId),
          notificationContent: logic.COMPANY_ORDER_PENDING_TEXT,
        }),
      });
      const { shopName, ...result } = out;
      if (!out.duplicate) {
        // ทีมงาน: แอปเก่าส่งแบบ id AND shopId ของร้านลูกค้า (ImageLimitScreen.js:137) = เครื่องทีมงานแทบไม่เคยได้ ⇒ ทางใหม่ส่งหาคนทุกร้านแบบใบแพ็กเกจ
        await notify(deps, await orderPushes({
          access, adminDoc: "package",
          buyer: { heading: "สั่งซื้อพื้นที่เก็บรูปสำเร็จ!", content: PENDING_PUSH_TEXT },
          staff: { heading: "ลูกค้าซื้อพื้นที่เก็บรูป!", content: `ร้าน ${shopName}` },
        }));
      }
      return ok(res, { ...result, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { imageOrder };

// pos/company/hardwareOrder — ร้านซื้ออุปกรณ์ (แนบสลิป รอทีมงานอนุมัติและจัดส่ง) · ก้อน 9d DEV-0001
//
// สัญญา: shopchamp-center/api/company.hardwareOrder.yaml · คำขอ CompanyHardwareOrderRequest (@shopchamp/schema)
// แทน: main3 src/screens/HardwareSummaryScreen.js:105-178 (admin/hardwareNumber · hardwareOrder · notification ตรงใน transaction)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ลำดับ: callerAccess (401/403) → รูปคำขอ (400) → runOrder (_orders.js)
//   ราคา: admin/hardware ใน transaction (logic.companyHardwareQuote) · ไม่ใช้ราคาที่ค้างในตะกร้า (B14)
//     doc ไม่มี/ผิดรูป 503 hardware_config_unavailable · ปิดขาย/ไม่มี/ราคาเสีย 409 hardware_unavailable {hardwareId} (B19)
//     เกิน limit 409 qty_over_limit {hardwareId, limit} (AC-67 · limit '' = 999)
//   ยอด: ปัดสตางค์ (B6) · ค่าส่ง 0 เมื่อยอดสินค้า ≥ 4000 ไม่งั้น 100 · vat = 7% ของยอดสินค้า
// เขียน (รูปเดิม + เพิ่มอย่างเดียว):
//   hardwareOrder/{orderUUID} {address, shopId: doc id, shopName, profileId, profileName, timestamp: now, imageId: slipUrl, net, status:'order',
//     tel, product[], deliveryFee, vat, vatDetail (vat=false → '' · B12), vatAmount, totalPrice, nameSername, orderNumber} + {orderUUID, source, byAdmin?, adminUid?}
//     tel/nameSername/address = ที่ผู้ซื้อกรอก (เดิมมาจาก state.device · ไม่ใช่ profile)
//   admin/hardwareNumber · notification {heading:'สั่งซื้ออุปกรณ์สำเร็จ', categoryId:99}
//   ⚠️ เดิม admin/hardwareNumber ไม่มี = transaction ล้ม (admin B9) · ทางใหม่สร้าง {value:1}
// วิธีจ่าย (DEV-0003 U2b · schema 0.1.23): payMethod 'qr' = ใบ {imageId:'', payMethod:'qr'} รอจ่าย QR (company.payRequest) · ไม่ส่ง = สลิป รูปเดิม
//   ส่ง orderUUID เดิมแบบสลิปขณะใบเป็น QR ไม่มีสลิป = แนบสลิปเข้าใบเดิม 200 duplicate slipAttached · เงินเข้าแล้ว 409 pay_received (_orders.js › slipAttachPatch)
"use strict";

const { CompanyHardwareOrderRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { notify } = require("../_shared/push/notify");
const { runOrder, orderPushes, PENDING_PUSH_TEXT, Refusal, notiShopIdOf, buyerOf, str, payFieldsOf } = require("./_orders");

function quoteOf(lines, vat) {
  return (doc) => {
    const q = logic.companyHardwareQuote(doc, lines, vat);
    if (q.ok) return q;
    if (q.error === "HARDWARE_DOC_INVALID") return deny(503, "hardware_config_unavailable", "ยังเปิดขายอุปกรณ์ไม่ได้ กรุณาติดต่อทีมงาน");
    if (q.error === "QTY_OVER_LIMIT") {
      return deny(409, "qty_over_limit", `สั่งได้สูงสุด ไม่เกิน ${q.limit} ชิ้น/ครั้ง หากต้องการจำนวนมากกรุณาติดต่อแอดมิน`, { hardwareId: q.id, limit: q.limit });
    }
    if (q.error === "HARDWARE_UNAVAILABLE" || q.error === "HARDWARE_PRICE_INVALID") {
      return deny(409, "hardware_unavailable", "มีอุปกรณ์ที่ไม่เปิดขายแล้วในตะกร้า", { hardwareId: q.id });
    }
    return deny(400, "invalid_request");
  };
}

/** ใบเดิมคือการกดเดียวกัน: รายการ id+qty ตรงกันทุกแถว (ไม่สนลำดับ) */
function sameLines(prev, input) {
  const key = (rows) => rows.map((r) => `${r.id}\u0000${r.qty}`).sort().join("\u0001");
  const a = Array.isArray(prev.product) ? prev.product.filter((r) => r && typeof r === "object") : [];
  return key(a) === key(input.lines) && prev.vat === input.vat;
}

function hardwareOrder(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(CompanyHardwareOrderRequest, body, res);
      if (!input) return;
      const now = await readNow(deps);

      const out = await runOrder({
        access, input, now,
        kind: "hardware", collection: "hardwareOrder", counterDoc: "hardwareNumber", priceDoc: "hardware",
        quote: quoteOf(input.lines, input.vat),
        sameOrder: sameLines,
        buildOrder: ({ shop, shopDocId, profile, q }) => {
          const buyer = buyerOf(access, profile);
          return {
            address: input.address,
            shopId: shopDocId,
            shopName: str(shop.name),
            profileId: buyer.profileId,
            profileName: buyer.profileName,
            timestamp: now,
            ...payFieldsOf(input.payMethod, input.slipUrl),
            net: q.net,
            status: "order",
            tel: input.tel,
            product: q.product,
            deliveryFee: q.deliveryFee,
            vat: input.vat,
            vatDetail: input.vat ? input.vatDetail : "",
            vatAmount: q.vatAmount,
            totalPrice: q.totalPrice,
            nameSername: input.nameSername,
          };
        },
        buildNoti: ({ ref, shopDocId, q }) => ({
          heading: "สั่งซื้ออุปกรณ์สำเร็จ",
          shopId: notiShopIdOf(ref, shopDocId),
          notificationContent: logic.companyHardwareNotiText(q.product),
        }),
      });
      const { shopName, ...result } = out;
      if (!out.duplicate) {
        await notify(deps, await orderPushes({
          access, adminDoc: "hardware",
          buyer: { heading: "สั่งซื้ออุปกรณ์สำเร็จ", content: PENDING_PUSH_TEXT, data: { sound: "สั่งซื้ออุปกรณ์สำเร็จค่ะ" } },
          staff: { heading: `${shopName} ซื้ออุปกรณ์ ${out.net} บาท!`, content: `ร้าน ${shopName}`, data: { sound: `อุปกรณ์ขายออก ${out.net} บาทค่ะ` } },
        }));
      }
      return ok(res, { ...result, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { hardwareOrder, sameLines };

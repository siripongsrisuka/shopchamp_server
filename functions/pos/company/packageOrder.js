// pos/company/packageOrder — ร้านซื้อแพ็กเกจ (แนบสลิป รอทีมงานอนุมัติ) · ก้อน 9d DEV-0001
//
// สัญญา: shopchamp-center/api/company.packageOrder.yaml · คำขอ CompanyPackageOrderRequest (@shopchamp/schema)
// แทน: main3 src/screens/PayScreen.js:123-176 (เขียน admin/packageNumber · packageOrder · notification ตรงใน transaction)
//   เว็บเจ้าของร้าน own:modal/Modal_Package.js เป็นทางเดิมอีกทาง (DEV-0002 ย้ายมาใช้เส้นนี้ได้)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ลำดับ: callerAccess (401/403) → รูปคำขอ (400) → runOrder (_orders.js)
//   ราคา: admin/package ใน transaction · แถว status truthy หรือ newApp === true (logic.companyPackageOrderQuote · logic 0.1.8 · gateway ขายเฉพาะแอปใหม่)
//     doc ไม่มี/ผิดรูป 503 package_config_unavailable · id ไม่ขาย 409 package_unavailable {packageId} · ซ้ำ 400 (schema กันแล้ว)
//   VAT (DEV-0002 · Pack เคาะ 2026-11-07): vat:true = ขอใบกำกับ · ได้เฉพาะเมื่อทุกแพ็กเกจเป็นรายปี (price[].day = 12 เดือน)
//     ไม่ใช่ 409 tax_invoice_yearly_only {packageId} · VAT 7% ของยอดรวมปัดสตางค์ · expectedNet เทียบกับยอดรวม VAT แล้ว (price_changed)
// สิทธิ์: สมาชิกร้านที่ active ทุกคน (แอปเก่าไม่ตรวจสิทธิ์ในจอ · packageOrder W1) · ทีมงานทำแทนได้ (byAdmin)
// เขียน (รูปเดิม 13 field + เพิ่มอย่างเดียว):
//   packageOrder/{orderUUID} {shopId: doc id ร้าน (care ใช้ .doc(shopId) อนุมัติ · PO-02), shopName, profileId, profileName, timestamp: now,
//     imageId: slipUrl, net, status:'order', vat, email:'', tel, packageId[], orderNumber} + {orderUUID, source:'pos', byAdmin?, adminUid?}
//     vat:true เพิ่ม {totalPrice (ก่อน VAT), vatAmount, vatDetail} ชื่อเดียวกับใบอุปกรณ์ (care ApproveSoftwareScreen/Modal_SoftwareHistory destructure ไว้แล้ว)
//   admin/packageNumber {value, timestamp} · notification {heading:'สั่งซื้อแพ็กเกจสำเร็จ', ..., categoryId:99}
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น (ผ่าน _orders.js)
"use strict";

const { CompanyPackageOrderRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { notify } = require("../_shared/push/notify");
const { runOrder, orderPushes, PENDING_PUSH_TEXT, Refusal, notiShopIdOf, buyerOf, str } = require("./_orders");

function quoteOf(ids, vat) {
  return (doc) => {
    const q = logic.companyPackageOrderQuote(doc, ids, vat);
    if (q.ok) return q;
    if (q.error === "TAX_INVOICE_YEARLY_ONLY") {
      return deny(409, "tax_invoice_yearly_only", "ขอใบกำกับภาษีได้เฉพาะแพ็กเกจรายปี", { packageId: String(q.id) });
    }
    if (q.error === "PACKAGE_DOC_INVALID") return deny(503, "package_config_unavailable", "ยังเปิดขายแพ็กเกจไม่ได้ กรุณาติดต่อทีมงาน");
    if (q.error === "DUPLICATE_PACKAGE" || q.error === "NO_PACKAGE") return deny(400, "invalid_request");
    return deny(409, "package_unavailable", "แพ็กเกจนี้ไม่เปิดขายแล้ว", { packageId: String(q.id) });
  };
}

/** ใบเดิมคือการกดเดียวกัน: ชุด packageId เท่ากัน (เทียบแบบข้อความ ไม่สนลำดับ) และขอใบกำกับเหมือนกัน */
function samePackages(prev, input) {
  const a = Array.isArray(prev.packageId) ? prev.packageId.map(String).sort() : [];
  const b = input.packageIds.map(String).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]) && (prev.vat === true) === (input.vat === true);
}

function packageOrder(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(CompanyPackageOrderRequest, body, res);
      if (!input) return;
      const now = await readNow(deps);

      const out = await runOrder({
        access, input, now,
        collection: "packageOrder", counterDoc: "packageNumber", priceDoc: "package",
        quote: quoteOf(input.packageIds, input.vat === true),
        sameOrder: samePackages,
        buildOrder: ({ shop, shopDocId, profile, q }) => ({
          shopId: shopDocId,
          shopName: str(shop.name),
          ...buyerOf(access, profile),
          timestamp: now,
          imageId: input.slipUrl,
          net: q.net,
          status: "order",
          vat: q.vat,
          email: "",
          packageId: q.items.map((i) => i.id),
          // ขอใบกำกับ (รายปีเท่านั้น) = ช่องชื่อเดียวกับใบอุปกรณ์ที่ care อ่าน · ไม่ขอ = รูปเดิม 13 field ไม่มีช่องเพิ่ม
          ...(q.vat ? { totalPrice: q.totalPrice, vatAmount: q.vatAmount, vatDetail: input.vatDetail } : {}),
        }),
        buildNoti: ({ ref, shopDocId, q }) => ({
          heading: "สั่งซื้อแพ็กเกจสำเร็จ",
          shopId: notiShopIdOf(ref, shopDocId),
          notificationContent: logic.companyPackageNotiText(q.items),
        }),
      });
      const { shopName, ...result } = out;
      if (!out.duplicate) {
        await notify(deps, await orderPushes({
          access, adminDoc: "package",
          buyer: { heading: "สั่งซื้อแพ็กเกจสำเร็จ", content: PENDING_PUSH_TEXT, data: { sound: "สั่งซื้อแพ็กเกจสำเร็จค่ะ" } },
          staff: { heading: `${shopName} ซื้อแพ็กเกจ ${out.net} บาท!`, content: `ร้าน ${shopName}`, data: { sound: `สั่งซื้อแพ็กเกจ ${out.net} บาทค่ะ` } },
        }));
      }
      return ok(res, { ...result, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { packageOrder, samePackages };

// pos/company/packageOrder — ร้านซื้อแพ็กเกจ (แนบสลิป รอทีมงานอนุมัติ) · ก้อน 9d DEV-0001
//
// สัญญา: shopchamp-center/api/company.packageOrder.yaml · คำขอ CompanyPackageOrderRequest (@shopchamp/schema)
// แทน: main3 src/screens/PayScreen.js:123-176 (เขียน admin/packageNumber · packageOrder · notification ตรงใน transaction)
//   เว็บเจ้าของร้าน own:modal/Modal_Package.js เป็นทางเดิมอีกทาง (DEV-0002 ย้ายมาใช้เส้นนี้ได้)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ลำดับ: callerAccess (401/403) → รูปคำขอ (400) → runOrder (_orders.js)
//   ราคา: admin/package ใน transaction · แถว status truthy เท่านั้น (logic.companyPackageQuote)
//     doc ไม่มี/ผิดรูป 503 package_config_unavailable · id ไม่ขาย 409 package_unavailable {packageId} · ซ้ำ 400 (schema กันแล้ว)
// สิทธิ์: สมาชิกร้านที่ active ทุกคน (แอปเก่าไม่ตรวจสิทธิ์ในจอ · packageOrder W1) · ทีมงานทำแทนได้ (byAdmin)
// เขียน (รูปเดิม 13 field + เพิ่มอย่างเดียว):
//   packageOrder/{orderUUID} {shopId: doc id ร้าน (care ใช้ .doc(shopId) อนุมัติ · PO-02), shopName, profileId, profileName, timestamp: now,
//     imageId: slipUrl, net, status:'order', vat:false, email:'', tel, packageId[], orderNumber} + {orderUUID, source:'pos', byAdmin?, adminUid?}
//   admin/packageNumber {value, timestamp} · notification {heading:'สั่งซื้อแพ็กเกจสำเร็จ', ..., categoryId:99}
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น (ผ่าน _orders.js)
"use strict";

const { CompanyPackageOrderRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { runOrder, Refusal, notiShopIdOf, buyerOf, str } = require("./_orders");

function quoteOf(ids) {
  return (doc) => {
    const q = logic.companyPackageQuote(doc, ids);
    if (q.ok) return q;
    if (q.error === "PACKAGE_DOC_INVALID") return deny(503, "package_config_unavailable", "ยังเปิดขายแพ็กเกจไม่ได้ กรุณาติดต่อทีมงาน");
    if (q.error === "DUPLICATE_PACKAGE" || q.error === "NO_PACKAGE") return deny(400, "invalid_request");
    return deny(409, "package_unavailable", "แพ็กเกจนี้ไม่เปิดขายแล้ว", { packageId: String(q.id) });
  };
}

/** ใบเดิมคือการกดเดียวกัน: ชุด packageId เท่ากัน (เทียบแบบข้อความ ไม่สนลำดับ) */
function samePackages(prev, input) {
  const a = Array.isArray(prev.packageId) ? prev.packageId.map(String).sort() : [];
  const b = input.packageIds.map(String).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
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
        quote: quoteOf(input.packageIds),
        sameOrder: samePackages,
        buildOrder: ({ shop, shopDocId, profile, q }) => ({
          shopId: shopDocId,
          shopName: str(shop.name),
          ...buyerOf(access, profile),
          timestamp: now,
          imageId: input.slipUrl,
          net: q.net,
          status: "order",
          vat: false,
          email: "",
          packageId: q.items.map((i) => i.id),
        }),
        buildNoti: ({ ref, shopDocId, q }) => ({
          heading: "สั่งซื้อแพ็กเกจสำเร็จ",
          shopId: notiShopIdOf(ref, shopDocId),
          notificationContent: logic.companyPackageNotiText(q.items),
        }),
      });
      return ok(res, { ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { packageOrder, samePackages };

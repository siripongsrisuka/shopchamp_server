// pos/priceTag/create — บันทึกชุดป้ายราคาแล้วคืนลิงก์เว็บทำ PDF (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/priceTag.create.yaml · คำขอ PriceTagCreateRequest (requests/priceTag.ts)
// ทางเดิม: `main3:src/screens/PriceCardScreen.js:189-205` `priceTag/{auto}.set({timestamp, shopId, uploadBy, products})`
//   แล้วเปิด `https://shopchamp-merchant-owner.firebaseapp.com/tag/<id>` · สิทธิ์เดิม = เมนู '108' ทำป้ายราคา (`main3:src/screens/HomeScreen.js:67`)
//
// ลำดับ:
//   1. callerAccess · PriceTagCreateRequest (PT-11 รายการว่าง · PT-06 PT-07 รูปแถว · PT-05 ไม่เกิน 1,000 แถว) · สิทธิ์ '108' → 403
//      ขนาด doc ประมาณจาก JSON ของ products เกิน 900,000 byte = 413 price_tag_too_large (เพดาน doc 1 MiB · PT-05)
//   2. transaction: shop (ด่าน _gate) · priceTag/{requestId}
//      มีแล้วของร้านนี้ = 200 duplicate ลิงก์เดิม (กดซ้ำ PT-14) · ของร้านอื่น = 409 request_id_other_shop (ไม่คืนลิงก์)
//   3. เขียน priceTag/{requestId} รูปเดิม {timestamp, shopId: shopField, uploadBy, products} · วันที่ในโปรเป็น Date (ฐานเก็บ Timestamp)
//      ทีมงาน = {byAdmin, adminUid} เพิ่ม · เว็บอ่าน products อย่างเดียว (field อื่นไม่มีคนอ่าน)
"use strict";

const { db } = require("../../firebase");
const { PriceTagCreateRequest, PriceTagWrite } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, belongsToShop } = require("../_shared/auth");
const { Refusal, refuse, readShopForWrite, isObj } = require("../member/_gate");

const PRICE_TAG_RIGHT = "108"; // ทำป้ายราคา (main3 src/screens/StaffScreen.js:54)
const TAG_URL = "https://shopchamp-merchant-owner.firebaseapp.com/tag/"; // ลิงก์เดิม PriceCardScreen.js:199
const MAX_BYTES = 900000;

const urlOf = (id) => TAG_URL + id;

function rowsOf(products) {
  return products.map((r) => ({
    name: r.name,
    imageId: r.imageId,
    barcode: r.barcode,
    unit: r.unit,
    price: r.price,
    promotion: {
      status: r.promotion.status,
      qty: r.promotion.qty,
      price: r.promotion.price,
      startDate: new Date(r.promotion.startDate),
      endDate: new Date(r.promotion.endDate),
    },
  }));
}

function create(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(PriceTagCreateRequest, body, res);
      if (!input) return;
      if (!hasRight(access, PRICE_TAG_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: PRICE_TAG_RIGHT }));
      if (Buffer.byteLength(JSON.stringify(input.products), "utf8") > MAX_BYTES) {
        return sendDeny(res, deny(413, "price_tag_too_large", "รายการป้ายมากเกินไป กรุณาแบ่งทำหลายครั้ง"));
      }

      const now = await readNow(deps);
      const tagRef = db.collection("priceTag").doc(input.requestId);
      const out = await db.runTransaction(async (tx) => {
        const { ref, shopField } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const snap = await tx.get(tagRef);
        if (snap.exists) {
          if (!belongsToShop((snap.data() || {}).shopId, ref)) refuse(deny(409, "request_id_other_shop", "รหัสรายการนี้เป็นของร้านอื่น"));
          return { duplicate: true };
        }
        const doc = { timestamp: now, shopId: shopField, uploadBy: input.uploadBy, products: rowsOf(input.products), ...adminTrail(access) };
        if (!PriceTagWrite.safeParse(doc).success) refuse(deny(500, "internal_error")); // รูปที่เขียนผิด = บั๊กของ handler
        tx.set(tagRef, doc);
        return { duplicate: false };
      });

      return ok(res, { priceTagId: input.requestId, url: urlOf(input.requestId), duplicate: out.duplicate, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { create, rowsOf, urlOf };

// pos/product/saveCentral — ฝากชื่อ หน่วย รูป ของบาร์โค้ดเข้าคลังสินค้ากลาง `product` (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/product.saveCentral.yaml · คำขอ ProductSaveCentralRequest (requests/product.ts)
// ทางเดิม: `main3:src/screens/ProductSetting.js:672-690` ตอนเพิ่มสินค้าใหม่ที่มีบาร์โค้ด (คู่กับ addProduct ของ stock · ก้อน 9a)
//   เจอ doc กลาง (`where barcode ==` · `docs[0]`) ที่ยังไม่มีรูป + ฟอร์มมีรูป = update {imageId} (W1) · ไม่เจอ = add 9 field (W2)
//   ไม่ await · ไม่อยู่ transaction · ไม่ตรวจสิทธิ์ (B9) · sku เป็น `0NaN…` เสมอ (B6) · createdBy ว่าง (B2 · C42)
//
// ลำดับ:
//   1. callerAccess · ProductSaveCentralRequest (บาร์โค้ดว่าง B4 · unit ว่าง B7 B10) · สิทธิ์ '110' เพิ่มสินค้าใหม่ (B9) → 403
//   2. transaction: shop (ด่าน _gate) · query `product where barcode == X limit 1` · product/{key}
//      key = `bc_` + sha256(barcode) 40 ตัวแรก ⇒ 2 ร้านกดพร้อมกันผ่าน API ใหม่ชนกันที่ doc เดียว ไม่ได้ 2 doc (B3)
//      เจอ (query ก่อน · ไม่เจอค่อยดู key): ไม่มีรูป + ส่งรูปมา = update {imageId} · อย่างอื่นไม่เขียน (ชื่อกลางไม่ถูกร้านถัดไปทับ · ตามเดิม)
//      ไม่เจอ: set product/{key} 9 field เดิม + ใหม่ {createdByUid} · sku = วันเวลาไทย YYYYMMDDHHmmss (B6) · createdBy2 = ร้าน (B2 ตามรอยได้)
//   ❓ C42 (ร้านแรกเขียนชื่อรูปให้ทุกร้าน) คงเดิมตามค่าตั้งต้น · B1 ไฟล์รูปถูกลบโดยร้านเจ้าของรูป ไม่ได้แก้ที่นี่ (เป็นงานของ stock 9a)
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const { ProductSaveCentralRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag } = require("../_shared/auth");
const { Refusal, readShopForWrite, isObj } = require("../member/_gate");

const ADD_PRODUCT_RIGHT = "110"; // เพิ่มสินค้าใหม่ (main3 src/screens/StaffScreen.js:56)
const TH_OFFSET_MS = 7 * 60 * 60 * 1000;

/** keyOf(barcode) — doc id ตายตัวต่อบาร์โค้ด (บาร์โค้ดมีอักขระที่ใช้เป็น doc id ไม่ได้ เช่น /) */
function keyOf(barcode) {
  return "bc_" + crypto.createHash("sha256").update(String(barcode), "utf8").digest("hex").slice(0, 40);
}

/** skuOf(now) — `stringYMDHMS` ของแอปเดิมที่ตั้งใจ (`main3:src/Utility/dateTime.js:216-227`) บนนาฬิกาไทย (server เป็น UTC) */
function skuOf(now) {
  const t = new Date(now.getTime() + TH_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return p(t.getUTCFullYear(), 4) + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) + p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds());
}

function saveCentral(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(ProductSaveCentralRequest, body, res);
      if (!input) return;
      if (!hasRight(access, ADD_PRODUCT_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: ADD_PRODUCT_RIGHT }));

      const now = await readNow(deps);
      const keyRef = db.collection("product").doc(keyOf(input.barcode));
      const query = db.collection("product").where("barcode", "==", input.barcode).limit(1);

      const out = await db.runTransaction(async (tx) => {
        const { shopField } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const [qs, keySnap] = await Promise.all([tx.get(query), tx.get(keyRef)]);
        const hit = qs && Array.isArray(qs.docs) && qs.docs.length ? qs.docs[0] : keySnap.exists ? keySnap : null;

        if (hit) {
          const cur = hit.data() || {};
          const hasImage = typeof cur.imageId === "string" && cur.imageId !== "";
          if (!hasImage && input.imageUrl) {
            tx.update(db.collection("product").doc(hit.id), { imageId: input.imageUrl });
            return { productId: hit.id, created: false, imageUpdated: true };
          }
          return { productId: hit.id, created: false, imageUpdated: false };
        }

        tx.set(keyRef, {
          sku: skuOf(now),
          barcode: input.barcode,
          imageId: input.imageUrl,
          adminChecked: false,
          name: input.name,
          unit: input.unit,
          createdBy: "",
          createdBy2: shopField,
          createdByUid: access.uid,
          dateTime: now,
          ...adminTrail(access),
        });
        return { productId: keyRef.id, created: true, imageUpdated: false };
      });

      return ok(res, { ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { saveCentral, keyOf, skuOf };

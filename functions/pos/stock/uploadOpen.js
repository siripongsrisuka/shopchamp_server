// pos/stock/uploadOpen — เปิดหน้าเว็บนำเข้าสินค้าจากไฟล์: สร้าง doc `uploadProduct` ให้เว็บอ่าน (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.uploadOpen.yaml · คำขอ StockUploadOpenRequest
// ทางเดิม: `main3:src/Modal/Modal_StockOption.js:97-105` handleUploadStock
//   add {shopId, timestamp, barcodes: latestStocks.map(barcode)} แล้วเปิด `https://shopchamp-merchant-owner.firebaseapp.com/upload/<id>`
//   เว็บอ่าน barcodes เพื่อกันนำเข้าซ้ำ (`function-tables/webowner/UploadProductScreen.md`)
//
// ด่าน: callerAccess → schema → สิทธิ์ '110' เพิ่มสินค้าใหม่ (นำเข้า = เพิ่มสินค้า)
// อ่าน: shop · stock ของร้าน (select barcode deleted) · barcodes จากฐาน ไม่ใช่จากเครื่อง (เดิมเครื่องที่แคชค้างส่งรายการเก่า ST-003)
//   ไม่เอาสินค้าที่ลบแล้ว (ST-056 บาร์โค้ดของที่ลบยังนับว่าซ้ำ) · ตัดค่าว่างและซ้ำ · บาร์โค้ดตัวเลข → สตริง
// เขียน: uploadProduct/{auto} รูปเดิม {shopId, timestamp, barcodes} + {createdBy}
// ⚠️ ร้านสินค้าเยอะมาก barcodes ใหญ่จน doc เกิน 1 MiB ได้ (เดิมก็เป็น) ⇒ เกิน 40,000 รายการ = 413 too_many_products ไม่เขียน doc ที่ Firestore ปัด
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef } = require("../_shared/auth");
const S = require("./_shared");

const WEB_BASE = "https://shopchamp-merchant-owner.firebaseapp.com/upload/";
const MAX_BARCODES = 40000;

function uploadOpen(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockUploadOpenRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.ADD_PRODUCT)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);

      const shopSnap = await db.collection("shop").doc(access.shopId).get();
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() || {} });
      const keys = [...new Set([ref.id, ref.shopId].filter(Boolean))];
      const seen = new Set();
      for (const k of keys) {
        const q = await db.collection("stock").where("shopId", "==", k).select("barcode", "deleted").get();
        for (const d of q.docs || []) {
          const x = d.data() || {};
          if (x.deleted === true) continue;
          const b = typeof x.barcode === "number" ? String(x.barcode) : x.barcode;
          if (typeof b === "string" && b !== "") seen.add(b);
        }
      }
      if (seen.size > MAX_BARCODES) return sendDeny(res, deny(413, "too_many_products", "สินค้าในร้านมากเกินกว่าหน้านำเข้าจะรับได้ กรุณาติดต่อทีมงาน", { count: seen.size }));
      const added = await db.collection("uploadProduct").add({
        shopId: ref.shopId || access.shopId,
        timestamp: now,
        barcodes: [...seen],
        createdBy: access.uid,
        ...adminTrail(access),
      });
      return ok(res, { uploadId: added.id, url: WEB_BASE + added.id, barcodeCount: seen.size, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { uploadOpen };

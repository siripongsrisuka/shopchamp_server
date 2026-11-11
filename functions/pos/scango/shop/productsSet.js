// pos/scango/shop/productsSet — ตั้งรายการสินค้าที่ขายบน ScanGo ทั้งก้อน (สัญญา scango.productsSet · auth 'shop' · Pack เคาะ B2)
//
// คำขอ {shopId, productIds[]} · แทนทั้งรายการ (ลำดับตามที่ส่ง · ตัวซ้ำตัดทิ้ง) · [] = ไม่ขายสักตัว
// ด่าน: callerAccess (เขียน) → schema 400 → สิทธิ์ '111' แก้สินค้า (เจ้าของ/ทีมงานผ่าน) 403 right_required
//   ไม่ซ้ำเกิน 1000 = 409 too_many_products {limit, count}
//   อ่าน stock ทุกตัว (นอก transaction · ทีละ 100) → ไม่มี / เป็นของร้านอื่น / ลบแล้ว = 409 product_not_found {productIds (≤50), count}
//     ของร้านอื่นตอบรหัสเดียวกับไม่มี (ไม่บอกว่ามีอยู่ที่ร้านอื่น)
//   transaction: shop ไม่มี 404 · ผู้เรียกไม่ active 403 · ร้านเปิดรับใบอยู่แต่ส่ง [] = 409 scango_not_ready {missing:['products']}
//   เขียน `tx.update` ช่องเดียว `scango.productIds`
// คำตอบ 200 {ok, productCount}
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { readNow } = require("../../_shared/deps");
const { callerAccess, hasRight, adminFlag, resolveShopRef, belongsToShop } = require("../../_shared/auth");
const { readShopForWrite, Refusal: GateRefusal } = require("../../member/_gate");
const C = require("./_common");

const CHUNK = 100;
const SHOW_MAX = 50;

async function badProductIds(ids, shopRef) {
  const bad = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const snaps = await Promise.all(part.map((id) => db.collection("stock").doc(id).get()));
    snaps.forEach((s, j) => {
      const d = s && s.exists ? s.data() : undefined;
      if (!C.isObj(d) || !belongsToShop(d.shopId, shopRef) || d.deleted === true) bad.push(part[j]);
    });
  }
  return bad;
}

function productsSet(deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.ProductsSetRequest, body, res);
      if (!input) return;
      if (!hasRight(access, C.RIGHTS.EDIT_PRODUCT)) return sendDeny(res, deny(403, "right_required", undefined, { right: C.RIGHTS.EDIT_PRODUCT }));
      const ids = C.uniq(input.productIds);
      if (ids.length > C.PRODUCT_LIMIT) {
        return sendDeny(res, deny(409, "too_many_products", `เลือกสินค้าได้ไม่เกิน ${C.PRODUCT_LIMIT} รายการ`, { limit: C.PRODUCT_LIMIT, count: ids.length }));
      }
      const now = await readNow(deps);

      const pre = await db.collection("shop").doc(access.shopId).get();
      if (!pre.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop: pre.data() || {} });
      const bad = await badProductIds(ids, shopRef);
      if (bad.length) {
        return sendDeny(res, deny(409, "product_not_found", "มีสินค้าที่ไม่พบหรือถูกลบแล้ว", { productIds: bad.slice(0, SHOW_MAX), count: bad.length }));
      }

      await db.runTransaction(async (tx) => {
        const { shopRef: ref, shop } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        if (!ids.length && C.scangoOf(shop).enabled === true) {
          C.refuse(409, "scango_not_ready", "ร้านเปิดรับออเดอร์อยู่ ต้องมีสินค้าอย่างน้อย 1 รายการ", { missing: ["products"] });
        }
        tx.update(ref, { "scango.productIds": ids });
      });
      return ok(res, { productCount: ids.length, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof C.Refusal || e instanceof GateRefusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { productsSet };

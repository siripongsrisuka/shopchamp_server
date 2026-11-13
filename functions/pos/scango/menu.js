// pos/scango/menu.js — POST /pos/scango/menu {externalId} (auth 'partner' · ScanGo ดึงเมนูร้าน)
//
// สินค้า = เฉพาะ shop.scango.productIds (≤1000 · B2) ที่ยังมีจริง เป็นของร้านนี้ และไม่ถูกลบ · ลำดับตาม productIds
// ราคา/หมด/หมวด/ค่าส่ง = _menu.buildMenu  · ร้านปิดรับ = 200 acceptingOrders:false (ไม่โยน)
// 404 shop_not_found · ช่องเกิน = 400 invalid_request
"use strict";

const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const C = require("./_core");
const M = require("./_menu");

function menu(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId"]);
    const shopId = C.idOf(b.externalId, "externalId");
    const now = await readNow(deps);
    const shop = await C.loadShop(shopId);
    const ids = M.configOf(shop).productIds;
    const byId = await C.loadProducts(shopId, ids);
    const products = ids.map((id) => byId.get(id)).filter(Boolean);
    return ok(res, M.buildMenu({ shop, products, now }));
  });
}

module.exports = { menu };

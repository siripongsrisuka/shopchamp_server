// pos/scango/deliveryQuote.js — POST /pos/scango/delivery/quote {externalId, distanceKm, foodSubtotal?} (auth 'partner')
//
// เลขเดียวกับที่ orderCreate คิด (_menu.quoteDelivery · สูตรแบบช่วง _deliveryFee ยกจากพี่น้อง) · ระยะ = ระยะถนนที่ ScanGo วัดเอง (ฝั่งนี้ไม่วัด)
// outOfRange = 200 พร้อมธง (ScanGo ซ่อนร้าน) · ไม่ขึ้นกับ enabled · 404 shop_not_found · 400 invalid_request
"use strict";

const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const C = require("./_core");
const M = require("./_menu");

const KM_MAX = 1000;
const BAHT_MAX = 10000000;

function parseQuoteBody(b) {
  C.onlyKeys(b, ["externalId", "distanceKm", "foodSubtotal"]);
  const shopId = C.idOf(b.externalId, "externalId");
  const km = b.distanceKm;
  if (typeof km !== "number" || !Number.isFinite(km) || km < 0 || km > KM_MAX) C.bad(`distanceKm ต้องเป็นตัวเลข 0-${KM_MAX} (ระยะถนน กม.)`);
  let foodSubtotal = null;
  if (b.foodSubtotal !== undefined && b.foodSubtotal !== null) {
    const f = b.foodSubtotal;
    if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > BAHT_MAX) C.bad("foodSubtotal ต้องเป็นตัวเลข ≥ 0");
    foodSubtotal = f;
  }
  return { shopId, distanceKm: km, foodSubtotal };
}

function deliveryQuote(deps) {
  return C.wrap(async (req, res) => {
    const p = parseQuoteBody(C.bodyOf(req));
    await readNow(deps);
    const shop = await C.loadShop(p.shopId);
    return ok(res, M.quoteDelivery(shop, { distanceKm: p.distanceKm, foodSubtotal: p.foodSubtotal }));
  });
}

module.exports = { deliveryQuote, parseQuoteBody };

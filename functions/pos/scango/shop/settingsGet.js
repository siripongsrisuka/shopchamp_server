// pos/scango/shop/settingsGet — อ่านค่าตั้ง ScanGo ของร้าน (สัญญา scango.settingsGet · auth 'shop')
//
// คำขอ {shopId} · คำตอบ 200 {ok, scango:{...ค่าตั้งครบทุกช่อง + productIds}, productCount, missing[], configured}
//   ร้านที่ไม่เคยตั้ง = ค่าตั้งต้น (_common DEFAULTS) · configured:false
//   missing = ของที่ขาดก่อนเปิดรับใบ ('location' · 'hours' · 'products') ⇒ จอบอกได้ก่อนกดเปิด
// ด่าน: callerAccess (อ่าน · ทีมงานดูได้) → schema → shop/{shopId} ไม่มี 404 · สมาชิกทุกคนในร้านอ่านได้ (จอรับใบต้องรู้สถานะเปิด/ปิด)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { callerAccess, adminFlag } = require("../../_shared/auth");
const C = require("./_common");

function settingsGet(_deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.SettingsGetRequest, body, res);
      if (!input) return;
      const snap = await db.collection("shop").doc(access.shopId).get();
      if (!snap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = snap.data() || {};
      const scango = C.scangoOf(shop);
      return ok(res, {
        scango: C.jsonSafe(scango),
        productCount: scango.productIds.length,
        missing: C.missingForEnable(scango),
        configured: C.isObj(shop.scango),
        ...adminFlag(access),
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { settingsGet };

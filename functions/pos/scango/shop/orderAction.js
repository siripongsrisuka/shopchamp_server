// pos/scango/shop/orderAction — ร้านกดรับ / พร้อมส่ง / ปฏิเสธ ใบสั่ง ScanGo (สัญญา scango.orderAction · auth 'shop')
//
// คำขอ {shopId, orderRef, action:'accept'|'ready'|'reject', reason?} · reject ต้องมี reason (≤200 ตัว) · ไม่งั้น 400
// ด่าน: callerAccess (เขียน) → schema → สิทธิ์ขาย '100' (เจ้าของ/ทีมงานผ่าน) 403 right_required
//   scangoOrder/{orderRef} ไม่มี 404 scango_order_not_found · shopId ไม่ตรงร้าน 409 scango_order_other_shop
// แล้วส่งต่อ `../_orderActions`[accept|ready|reject](deps, {order:{orderRef, ...doc}, actor, reason})
//   (หรือ deps.orderActions ในเทส) · ตัวนั้นตรวจสถานะ + เขียน + ส่งสถานะกลับ ScanGo เอง
//   actor = {uid, role, byAdmin?}
//   ผลที่เป็น deny {ok:false,status,error} หรือ throw ที่มี .deny = ส่งต่อเป็นคำตอบ error · ผลอื่น (object) = รวมในคำตอบ 200
// คำตอบ 200 {ok, orderRef, action, ...ผลจาก _orderActions (เช่น state)}
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { callerAccess, hasRight, adminFlag, checkOwnedDoc } = require("../../_shared/auth");
const C = require("./_common");

function actionsOf(deps) {
  const v = deps ? deps.orderActions : undefined;
  if (v === undefined || v === null) return require("../_orderActions");
  if (typeof v !== "object") throw new TypeError("deps.orderActions ต้องเป็น object");
  return v;
}

function orderAction(deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.OrderActionRequest, body, res);
      if (!input) return;
      if (!hasRight(access, C.RIGHTS.SALE)) return sendDeny(res, deny(403, "right_required", undefined, { right: C.RIGHTS.SALE }));

      const snap = await db.collection("scangoOrder").doc(input.orderRef).get();
      const data = snap.exists ? snap.data() : undefined;
      // externalId = shop doc id ⇒ ใบถือ shopId = doc id ร้านเสมอ (ไม่ใช้ field ของร้าน S5)
      const owned = checkOwnedDoc("scango_order", data, { id: access.shopId, shopId: null });
      if (!owned.ok) return sendDeny(res, owned);

      const fn = actionsOf(deps)[input.action];
      if (typeof fn !== "function") throw new Error(`_orderActions ไม่มี ${input.action}`);
      const actor = { uid: access.uid, role: access.role, ...(access.byAdmin === true ? { byAdmin: true } : {}) };
      let out;
      try {
        out = await fn(deps, { order: { ...data, orderRef: input.orderRef }, actor, reason: input.reason });
      } catch (e) {
        if (e && C.isObj(e.deny) && e.deny.ok === false) return sendDeny(res, e.deny);
        throw e;
      }
      if (C.isObj(out) && out.ok === false && Number.isInteger(out.status)) return sendDeny(res, out);
      const extra = C.isObj(out) ? C.jsonSafe(out) : {};
      delete extra.ok;
      return ok(res, { ...extra, orderRef: input.orderRef, action: input.action, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { orderAction };

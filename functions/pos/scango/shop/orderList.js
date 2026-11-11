// pos/scango/shop/orderList — ใบสั่ง ScanGo ของร้าน ใหม่สุดก่อน (สัญญา scango.orderList · auth 'shop')
//
// คำขอ {shopId, states?: ['requested'|'accepted'|'ready'|'picked_up'|'delivering'|'delivered'|'cancelled'|'failed']}
// คำตอบ 200 {ok, orders:[{orderRef, ...เนื้อ scangoOrder (เวลาเป็น ISO)}], limit}
//   ≤100 ใบ เรียง createdAt ใหม่สุดก่อน (เพดานอ่าน · จอ 3 แท็บส่ง states ของแท็บ)
// query: scangoOrder where shopId == <shop doc id> [where state in states] orderBy createdAt desc limit 100
//   ⚠️ ต้องมี index ประกอบ: (shopId ASC, createdAt DESC) และ (shopId ASC, state ASC, createdAt DESC)
// ด่าน: callerAccess (อ่าน) → schema → สมาชิกทุกคนในร้านเห็นได้ (จอรับใบ) · กรองซ้ำในหน่วยความจำว่าเป็นของร้านนี้
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError } = require("../../_shared/respond");
const { callerAccess, adminFlag } = require("../../_shared/auth");
const C = require("./_common");

const LIST_LIMIT = 100;

const msOf = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v && typeof v.seconds === "number") return v.seconds * 1000;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
  return 0;
};

function orderList(_deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.OrderListRequest, body, res);
      if (!input) return;
      const states = input.states ? C.uniq(input.states) : null;
      let q = db.collection("scangoOrder").where("shopId", "==", access.shopId);
      if (states) q = q.where("state", "in", states);
      const snap = await q.orderBy("createdAt", "desc").limit(LIST_LIMIT).get();
      const orders = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((e) => e.d.shopId === access.shopId && (!states || states.includes(e.d.state)))
        .sort((a, b) => msOf(b.d.createdAt) - msOf(a.d.createdAt))
        .map((e) => ({ ...C.jsonSafe(e.d), orderRef: e.id }));
      return ok(res, { orders, limit: LIST_LIMIT, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { orderList, LIST_LIMIT };

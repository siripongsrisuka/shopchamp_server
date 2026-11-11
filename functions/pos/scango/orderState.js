// pos/scango/orderState.js — POST /pos/scango/order/state {externalId, orderRef} (auth 'partner' · อ่านอย่างเดียว · ตัวกวาดใบค้างของ ScanGo)
//
// คำตอบรูปเดียวกับพี่น้อง (connector getOrderState อ่าน posState ก่อน):
//   posState  = requested | accepted | ready | cancelled (ฝั่งร้าน · ไรเดอร์รับของไปแล้วทุกแบบ = ready)
//   deliveryState = requested | picked_up | delivering | delivered | failed | cancelled (ฝั่งไรเดอร์)
//   + cancelReason (เฉพาะ cancelled) · cancelledBy · acceptedAt · riderAssignedAt · rider · updatedAt (ISO) · notified · bill{closed, pending}
// ไม่มี/ใบร้านอื่น = 404 order_not_found
"use strict";

const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const C = require("./_core");

const POS_OF = Object.freeze({ requested: "requested", accepted: "accepted", ready: "ready", picked_up: "ready", delivering: "ready", delivered: "ready", failed: "ready", cancelled: "cancelled" });
const DELIVERY = Object.freeze(["picked_up", "delivering", "delivered", "failed", "cancelled"]);

function isoOrNull(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  return null;
}

/** stateView(doc) → คำตอบของเส้นนี้ (pure) */
function stateView(d) {
  const st = C.str(d.state) || "requested";
  const at = C.isObj(d.stateAt) ? d.stateAt : {};
  const rider = C.isObj(d.rider) && C.str(d.rider.name) ? { name: C.str(d.rider.name), phone: C.str(d.rider.phone) || null, plate: C.str(d.rider.plate) || null } : null;
  const nt = C.isObj(d.notified) ? d.notified : {};
  const posState = POS_OF[st] || "requested";
  return {
    orderRef: C.str(d.orderRef),
    posState,
    deliveryState: DELIVERY.includes(st) ? st : "requested",
    cancelReason: posState === "cancelled" ? C.str(d.cancelReason) || null : null,
    cancelledBy: C.str(d.cancelledBy) || null,
    acceptedAt: isoOrNull(at.accepted),
    riderAssignedAt: isoOrNull(d.riderAssignedAt),
    rider,
    updatedAt: isoOrNull(d.updatedAt),
    notified: { accepted: nt.accepted === true, ready: nt.ready === true, cancelled: nt.cancelled === true },
    bill: { closed: C.str(d.billId) !== "", pending: C.isObj(d.billPending) ? C.str(d.billPending.reason) || "pending" : null },
  };
}

function orderState(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId", "orderRef"]);
    const shopId = C.idOf(b.externalId, "externalId");
    const orderRef = C.idOf(b.orderRef, "orderRef");
    await readNow(deps);
    const { data } = await C.loadShopOrder(shopId, orderRef);
    return ok(res, stateView(data));
  });
}

module.exports = { orderState, stateView };

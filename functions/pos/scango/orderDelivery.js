// pos/scango/orderDelivery — POST /scango/order/delivery · ScanGo แจ้งสถานะงานไรเดอร์ (auth 'partner' · แบบงาน shopchamp-scango-design.md §เส้นเชื่อม)
//
// body { externalId (= shopId ของ Shopchamp), orderRef, state, rider?, at?, eventId?, reason? }
// state: assigned | picked_up | delivering | delivered | failed
//
// กติกา (ท่าเดียวกับเส้น delivery ของร้านพี่น้อง · ScanGo ส่งผ่าน outbox+retry ⇒ ข่าวซ้ำ/สลับลำดับได้):
//   · `eventId` ที่เคยเห็นแล้ว (เก็บ 50 ตัวล่าสุดใน `deliveryEvents`) = 200 duplicate ไม่เขียนสถานะ
//       แต่ delivered ซ้ำที่บิลยังไม่ปิด = ลองปิดบิลอีกรอบ (closeBill idempotent)
//   · ใบถูกยกเลิกแล้ว = 409 invalid_state · ใบจบแล้ว (delivered/failed) ไม่ขยับต่อ · สถานะย้อนลำดับไม่ได้ (RANK)
//   · assigned  → `rider` + `riderAssignedAt` (= at) · ไม่แตะ `state` · ข่าวที่ at เก่ากว่าที่ถืออยู่ = ทิ้ง
//   · failed    → state 'failed' + failReason · ธง notified.cancelled = true (ScanGo รู้อยู่แล้ว ห้ามยิง cancelled กลับ) · ไม่มีบิล
//   · delivered → state 'delivered' แล้วปิดบิล (closeBill.js) หลัง commit · ปิดไม่ได้ = billPending (ไม่กระทบคำตอบ)
//   · ใบของร้านอื่น (externalId ไม่ตรง shopId ของใบ) = 404 order_not_found
// คำตอบ 200 {ok:true, state, changed, duplicate?, riderAssigned?} · error {ok:false, error, message}
//
// auth: _partnerAuth.checkPartnerKey(req, deps.env) → null ผ่าน / {status, error, message} (ชั้นสองใต้ middleware route partner) · deps.checkPartner แทนได้ (เทส)
// รูป: factory (deps) => handler(req, res) · deps: now · closeBill · checkPartner · env · ที่เหลือส่งต่อ closeBill
"use strict";

const { db } = require("../../firebase");
const { ok, fail, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");

const DELIVERY_STATES = Object.freeze(["assigned", "picked_up", "delivering", "delivered", "failed"]);
const RANK = Object.freeze({ requested: 0, accepted: 1, ready: 2, picked_up: 3, delivering: 4, delivered: 5, failed: 5, cancelled: 9 });
const ENDED = Object.freeze(["delivered", "failed"]);
const SEEN_EVENTS_MAX = 50;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const tsMs = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  return null;
};

/** at ที่ ScanGo ส่ง (ISO) · อ่านไม่ออก/อนาคตเกิน 5 นาที = now */
function eventAtOf(v, now) {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t > now.getTime() + 5 * 60 * 1000) return now;
  return new Date(t);
}

function riderOf(raw) {
  if (!isObj(raw)) return null;
  const name = str(raw.name).slice(0, 100);
  if (!name) return null;
  return { name, phone: str(raw.phone).slice(0, 30) || null, plate: str(raw.plate).slice(0, 30) || null };
}

/**
 * planDelivery(order, {state, rider, at, eventId, reason}, now) — pure · ตัดสินว่าเขียนอะไร
 * @returns {{kind:'duplicate'|'cancelled'|'apply', patch?:object, changed?:boolean, nextState?:string}}
 */
function planDelivery(order, { state, rider, at, eventId, reason }, now) {
  const cur = str(order.state) || "requested";
  const seen = Array.isArray(order.deliveryEvents) ? order.deliveryEvents : [];
  if (eventId && seen.includes(eventId)) return { kind: "duplicate", nextState: cur };
  if (cur === "cancelled") return { kind: "cancelled", nextState: cur };
  const patch = { updatedAt: now };
  if (eventId) patch.deliveryEvents = [...seen, eventId].slice(-SEEN_EVENTS_MAX);
  const ended = ENDED.includes(cur);
  let changed = false;
  if (state === "assigned") {
    const prevAt = tsMs(order.riderAssignedAt);
    if (!ended && rider && (prevAt === null || at.getTime() >= prevAt)) {
      patch.rider = rider;
      patch.riderAssignedAt = at;
      changed = true;
    }
    return { kind: "apply", patch, changed, nextState: cur };
  }
  if (rider && !ended) patch.rider = rider;
  if (!ended && RANK[state] > (RANK[cur] === undefined ? 0 : RANK[cur])) {
    changed = true;
    patch.state = state;
    patch.stateAt = { ...(isObj(order.stateAt) ? order.stateAt : {}), [state]: at };
    if (rider && !order.riderAssignedAt) patch.riderAssignedAt = at;
    if (state === "failed") {
      patch.failReason = str(reason).slice(0, 200) || null;
      patch.notified = { ...(isObj(order.notified) ? order.notified : {}), cancelled: true };
    }
  }
  return { kind: "apply", patch, changed, nextState: changed ? state : cur };
}

function orderDelivery(deps) {
  return async function handler(req, res) {
    // ชั้นสองใต้ middleware ของ route auth 'partner' (handler ถูกผูกผิดที่ก็ยังไม่เปิด) · null = ผ่าน
    const check = deps && typeof deps.checkPartner === "function"
      ? deps.checkPartner
      : (r) => require("./_partnerAuth").checkPartnerKey(r, deps && deps.env);
    const gate = check(req);
    if (gate) return fail(res, gate.status || 401, gate.error || "no_auth", gate.message);

    const body = req && isObj(req.body) ? req.body : {};
    const shopId = str(body.externalId);
    const orderRef = str(body.orderRef);
    const state = str(body.state);
    const eventId = str(body.eventId).slice(0, 200);
    if (!shopId || !orderRef || orderRef.includes("/") || orderRef.length > 128) {
      return fail(res, 400, "bad_request", "ต้องระบุ externalId และ orderRef");
    }
    if (!DELIVERY_STATES.includes(state)) return fail(res, 400, "bad_state", `state ต้องเป็น ${DELIVERY_STATES.join("|")}`);

    try {
      const now = await readNow(deps);
      const at = eventAtOf(body.at, now);
      const rider = riderOf(body.rider);
      const ref = db.collection("scangoOrder").doc(orderRef);
      const plan = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const order = snap && snap.exists ? snap.data() : undefined;
        if (!order || order.shopId !== shopId) return { kind: "not_found" };
        const p = planDelivery(order, { state, rider, at, eventId, reason: body.reason }, now);
        if (p.kind === "apply") tx.update(ref, p.patch);
        p.billId = order.billId;
        return p;
      });
      if (plan.kind === "not_found") return fail(res, 404, "order_not_found", "ไม่พบออเดอร์นี้");
      if (plan.kind === "cancelled") return fail(res, 409, "invalid_state", "ออเดอร์นี้ถูกยกเลิกไปแล้ว", { state: plan.nextState });

      // ปิดบิล: delivered ครั้งแรก · หรือข่าวซ้ำ/ส่งซ้ำของใบที่ delivered แล้วแต่บิลยังไม่ปิด
      if (state === "delivered" && plan.nextState === "delivered" && !plan.billId) {
        const close = deps && typeof deps.closeBill === "function"
          ? deps.closeBill
          : (a, d) => require("./closeBill").closeBill(a, d);
        try {
          await close({ orderRef }, deps);
        } catch (e) {
          console.error("pos/scango/orderDelivery closeBill threw", orderRef, e && e.message);
        }
      }
      const out = { state: plan.nextState, changed: plan.kind === "apply" ? plan.changed : false };
      if (plan.kind === "duplicate") out.duplicate = true;
      if (state === "assigned" && plan.kind === "apply") out.riderAssigned = true;
      return ok(res, out);
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { orderDelivery, planDelivery, DELIVERY_STATES, RANK };

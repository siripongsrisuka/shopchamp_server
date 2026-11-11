// pos/scango/_orderActions — ร้านกด รับ / พร้อมส่ง / ปฏิเสธ ออเดอร์ ScanGo (แบบงาน shopchamp-scango-design.md · `scango.orderAction`)
//
// ใช้โดย route ฝั่งร้าน (auth 'shop' · คนละไฟล์) · ไฟล์นี้ไม่ตรวจตัวตน: ผู้เรียกส่ง shopId ที่ผ่านด่านร้านแล้วมาเท่านั้น
//
// เครื่องสถานะ (scangoOrder.state):
//   accept : requested           → accepted   · ยิงข่าว accepted
//   ready  : accepted            → ready      · ยิงข่าว ready   (ร้านปลีกไม่มีขั้น cooking)
//   reject : requested|accepted  → cancelled  · ยิงข่าว cancelled + reason (บังคับ) · ไรเดอร์รับงานแล้ว = ปัด 409 rider_assigned
//   กดซ้ำสถานะเดิม (accept บน accepted ฯลฯ) = สำเร็จแบบ changed:false · ยังลองยิงข่าวที่ค้าง (ธง notified กันซ้ำ)
//   นอกนั้น = 409 invalid_state {state}
//
// 2 ชั้น:
//   planAction(order, action, {reason, now, by}) — pure · ตัดสินอย่างเดียว ไม่แตะฐาน
//   applyAction({shopId, orderRef, action, reason, by}, deps) — tx อ่าน/เขียนใบ แล้วยิงข่าวหลัง commit (ยิงไม่ออกไม่ทำให้การกดล้ม)
"use strict";

const { db } = require("../../firebase");
const { notifyOrder } = require("./_outbound");

const ACTIONS = Object.freeze({
  accept: Object.freeze({ from: Object.freeze(["requested"]), to: "accepted", event: "accepted" }),
  ready: Object.freeze({ from: Object.freeze(["accepted"]), to: "ready", event: "ready" }),
  reject: Object.freeze({ from: Object.freeze(["requested", "accepted"]), to: "cancelled", event: "cancelled" }),
});
const REASON_MAX = 200;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const refusal = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) });

/**
 * planAction(order, action, {reason, now, by}) — pure
 * @param {object} order  ข้อมูล scangoOrder (ไม่มี = 404)
 * @param {'accept'|'ready'|'reject'} action
 * @param {{reason?:string, now:Date, by?:{uid?:string, name?:string}}} ctx
 * @returns {{ok:true, changed:boolean, state:string, patch:object|null, event:{type:string, reason?:string, at:Date}}
 *          | {ok:false, status:number, error:string, state?:string}}
 *   patch = ช่องที่ต้อง update บนใบ (state · stateAt map ทั้งก้อน · cancelReason/cancelledBy เมื่อปฏิเสธ · updatedAt)
 */
function planAction(order, action, ctx) {
  const rule = ACTIONS[action];
  if (!rule) return refusal(400, "bad_action");
  if (!isObj(order)) return refusal(404, "order_not_found");
  const now = ctx && ctx.now instanceof Date ? ctx.now : new Date();
  const cur = str(order.state) || "requested";
  const reason = str(ctx && ctx.reason).slice(0, REASON_MAX);
  if (action === "reject" && !reason) return refusal(400, "reason_required");

  if (cur === rule.to) {
    // กดซ้ำ — ไม่เขียน · ข่าวใช้เวลาเดิมของสถานะนั้น
    const prevAt = isObj(order.stateAt) ? order.stateAt[rule.to] : undefined;
    const at = toDate(prevAt) || now;
    const ev = { type: rule.event, at };
    if (rule.event === "cancelled") ev.reason = str(order.cancelReason) || reason;
    return { ok: true, changed: false, state: cur, patch: null, event: ev };
  }
  if (!rule.from.includes(cur)) return refusal(409, "invalid_state", { state: cur });
  if (action === "reject" && isObj(order.rider)) return refusal(409, "rider_assigned", { state: cur });

  const stateAt = { ...(isObj(order.stateAt) ? order.stateAt : {}), [rule.to]: now };
  const patch = { state: rule.to, stateAt, updatedAt: now };
  const by = ctx && isObj(ctx.by) ? { uid: str(ctx.by.uid) || null, name: str(ctx.by.name) || null } : null;
  if (by) patch[`${action}By`] = by;
  const ev = { type: rule.event, at: now };
  if (action === "reject") {
    patch.cancelReason = reason;
    patch.cancelledBy = "shop";
    ev.reason = reason;
  }
  return { ok: true, changed: true, state: rule.to, patch, event: ev };
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (v && typeof v.toDate === "function") return v.toDate();
  return null;
}

/**
 * applyAction({shopId, orderRef, action, reason?, by?}, deps) — ทำจริง · ไม่โยน error ธุรกิจ (คืน refusal) · error ฐาน = โยน (ผู้เรียกตอบ 500)
 *   ใบของร้านอื่น = 404 order_not_found (ไม่บอกว่ามีอยู่)
 *   deps: now() · notifyOrder (ฉีดในเทส · ไม่ส่ง = _outbound.notifyOrder) · env/http/log ส่งต่อให้ _outbound
 * @returns {Promise<{ok:true, state, changed, notify:{sent,queued,reason?}} | {ok:false, status, error, state?}>}
 */
async function applyAction({ shopId, orderRef, action, reason, by }, deps) {
  if (!ACTIONS[action]) return refusal(400, "bad_action");
  const ref = str(orderRef);
  if (!ref || ref.includes("/")) return refusal(400, "bad_order_ref");
  const now = deps && typeof deps.now === "function" ? deps.now() : new Date();
  const docRef = db.collection("scangoOrder").doc(ref);
  const plan = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const order = snap && snap.exists ? snap.data() : undefined;
    if (!order || order.shopId !== shopId) return refusal(404, "order_not_found");
    const p = planAction(order, action, { reason, now, by });
    if (p.ok && p.patch) tx.update(docRef, p.patch);
    return p;
  });
  if (!plan.ok) return plan;
  const send = deps && typeof deps.notifyOrder === "function" ? deps.notifyOrder : notifyOrder;
  let notify;
  try {
    notify = await send({ orderRef: ref, type: plan.event.type, reason: plan.event.reason, at: plan.event.at }, deps);
  } catch (e) {
    notify = { sent: false, queued: false, reason: "error" };
  }
  return { ok: true, state: plan.state, changed: plan.changed, notify };
}

/**
 * รูปที่ shop/orderAction.js เรียก: `accept|ready|reject(deps, {order:{orderRef, ...doc}, actor, reason})`
 *   order.shopId = ร้านที่ผ่านด่านแล้ว (route ตรวจ checkOwnedDoc ก่อน) · ผลปัด = deny {ok:false, status, error, extra:{state}} (sendDeny ส่ง extra)
 */
function routeAction(action) {
  return async function run(deps, { order, actor, reason } = {}) {
    const o = isObj(order) ? order : {};
    const by = isObj(actor) ? { uid: actor.uid, name: actor.name } : undefined;
    const r = await applyAction({ shopId: o.shopId, orderRef: o.orderRef, action, reason, by }, deps);
    if (r.ok) return r;
    const { ok, status, error, ...extra } = r; // eslint-disable-line no-unused-vars
    return { ok: false, status, error, ...(Object.keys(extra).length ? { extra } : {}) };
  };
}

module.exports = { ACTIONS, planAction, applyAction, accept: routeAction("accept"), ready: routeAction("ready"), reject: routeAction("reject") };

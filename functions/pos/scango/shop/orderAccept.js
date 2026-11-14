// pos/scango/shop/orderAccept — ร้านกด "รับออเดอร์" ใบ ScanGo ในแอป (สัญญา scango.orderAccept · auth 'shop' · DEV-0009 สเปกข้อ 6 · Pack ผ่าน 2026-11-14)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/orderOnUpdate.js` (ร้านรับ → ยิง OrderEvent v1 `accepted` ไป ScanGo ·
//   กันยิงซ้ำด้วยธงบนใบ · ยิงไม่ออกไม่ทำให้งานหน้าร้านพัง) · ท่ายิง = `../v1/eventOut.js`
//   ต่างจากต้นแบบ: ไม่ใช่ trigger (ใบอยู่ scangoOrder · ทางเดียวที่ร้านรับในแอปคือเส้นนี้) · ไม่มี outbox ⇒ ยิงไม่ออก = ยิงใหม่ตอนกดซ้ำ
//
// คำขอ {shopId, orderRef} · คำตอบ 200 {ok, orderRef, acceptedNow, order:{...เนื้อใบหลังรับ (รูปเดียวกับ order-list)}, scangoAck}
//   requested                          → state accepted + stateAt.accepted/acceptedAt = now · acceptedBy 'pos' · acceptedByUid → ยิง accepted → scangoAck
//   accepted (ร้านรับในแอปแล้ว · scangoAck.state ≠ 'sent') → ไม่แตะ state · ยิงซ้ำ (eventId เดิม `<orderRef>:accepted` · ScanGo กันซ้ำ) → scangoAck ใหม่
//   accepted (ยิงสำเร็จแล้ว หรือรับจากเว็บร้าน ScanGo) · ready · picked_up · delivering → 200 acceptedNow:false ไม่เขียน ไม่ยิง (idempotent)
//   cancelled · failed → 409 order_cancelled · delivered → 409 order_completed (ไม่เขียน ไม่ยิง · คำตอบมี state)
// scangoAck = {type:'accepted', eventId, state:'sent'|'failed'|'not_configured', status, error, at, attempts} · ยิงไม่ออก ≠ รับไม่สำเร็จ (ใบ accepted แล้วเสมอ)
// ด่าน: callerAccess (เขียน · watcher 403 watcher_read_only) → schema 400 → สิทธิ์ขาย '100' (เจ้าของผ่าน) 403 right_required
//   → ใบไม่มี / ใบร้านอื่น 404 order_not_found (ไม่บอกว่ามีใบ)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { readNow } = require("../../_shared/deps");
const { callerAccess, hasRight, adminFlag, adminTrail } = require("../../_shared/auth");
const E = require("../v1/eventOut");
const C = require("./_common");

const CANCELLED = Object.freeze(["cancelled", "failed"]);
const COMPLETED = Object.freeze(["delivered"]);
const MSG = Object.freeze({
  order_not_found: "ไม่พบออเดอร์นี้",
  order_cancelled: "ออเดอร์นี้ถูกยกเลิกแล้ว",
  order_completed: "ออเดอร์นี้ส่งสำเร็จแล้ว",
});

/** ตั้ง patch แบบช่องจุด ('stateAt.accepted') ลงสำเนาของใบ ⇒ คำตอบเห็นใบหลังรับโดยไม่ต้องอ่านซ้ำ */
function merged(data, patch) {
  const real = { ...data };
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split(".");
    let o = real;
    for (let i = 0; i < parts.length - 1; i++) {
      o[parts[i]] = C.isObj(o[parts[i]]) ? { ...o[parts[i]] } : {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
  return real;
}

function orderAccept(deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.OrderAcceptRequest, body, res);
      if (!input) return;
      if (!hasRight(access, C.RIGHTS.SALE)) return sendDeny(res, deny(403, "right_required", undefined, { right: C.RIGHTS.SALE }));
      const now = await readNow(deps);
      const ref = db.collection("scangoOrder").doc(input.orderRef);

      const r = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap && snap.exists ? snap.data() || {} : null;
        if (!data || data.shopId !== access.shopId) return { deny: deny(404, "order_not_found", MSG.order_not_found) };
        const st = String(data.state || "");
        if (CANCELLED.includes(st)) return { deny: deny(409, "order_cancelled", MSG.order_cancelled, { state: st }) };
        if (COMPLETED.includes(st)) return { deny: deny(409, "order_completed", MSG.order_completed, { state: st }) };
        if (st === "requested") {
          const patch = { state: "accepted", "stateAt.accepted": now, acceptedAt: now, acceptedBy: "pos", acceptedByUid: access.uid, updatedAt: now, ...adminTrail(access) };
          tx.update(ref, patch);
          return { data: merged(data, patch), acceptedNow: true, send: true };
        }
        const ack = C.isObj(data.scangoAck) ? data.scangoAck : null;
        const resend = st === "accepted" && data.acceptedBy === "pos" && !(ack && ack.state === "sent");
        return { data, acceptedNow: false, send: resend };
      });
      if (r.deny) return sendDeny(res, r.deny);

      let data = r.data;
      if (r.send) {
        const prev = C.isObj(data.scangoAck) ? data.scangoAck : {};
        const event = E.buildEvent({ orderRef: input.orderRef, type: "accepted", at: (data.acceptedAt && C.jsonSafe(data.acceptedAt)) || now });
        const out = await E.sendEvent(deps, event, now);
        const scangoAck = { type: "accepted", eventId: event.eventId, state: out.state, status: out.status, error: out.error, at: now, attempts: (Number(prev.attempts) || 0) + 1 };
        // บันทึกผลยิง (ใบ accepted ไปแล้วใน tx ข้างบน · เขียนตรงนี้ล้ม = ใบยังรับแล้ว · กดซ้ำยิงใหม่)
        try {
          await db.runTransaction(async (tx) => { tx.update(ref, { scangoAck }); });
          data = { ...data, scangoAck };
        } catch (e) {
          console.error("[scango:orderAccept] ack_write_failed", { orderRef: input.orderRef, error: e && e.message });
          data = { ...data, scangoAck };
        }
      }
      const order = C.orderOut(input.orderRef, data);
      return ok(res, { orderRef: input.orderRef, acceptedNow: r.acceptedNow, order, scangoAck: order.scangoAck || null, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { orderAccept };

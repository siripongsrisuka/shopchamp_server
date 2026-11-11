// pos/scango/orderCancel.js — POST /pos/scango/order/cancel {externalId, orderRef, by?, reason?, at?, eventId?} (auth 'partner')
//
// ลูกค้า/ระบบ ScanGo ยกเลิกได้เฉพาะใบที่ร้านยังไม่กดรับ (state requested)
//   ยกเลิกแล้ว = 200 {state:'cancelled', changed:false} · state อื่น (รับแล้ว · กำลังส่ง · จบแล้ว) = 409 cancel_window_closed {state}
//   ไม่มี/ใบร้านอื่น = 404 order_not_found · by ไม่ส่ง = customer
// เขียน (transaction): state cancelled · stateAt.cancelled · cancelledBy · cancelReason · ลบเบอร์ลูกค้า ·
//   notified.cancelled = true (ScanGo เป็นคนยกเลิกเอง ⇒ ตัวส่งสถานะกลับห้ามยิง cancelled กลับไป)
"use strict";

const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const C = require("./_core");

function orderCancel(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId", "orderRef", "by", "reason", "at", "eventId"]);
    const shopId = C.idOf(b.externalId, "externalId");
    const orderRef = C.idOf(b.orderRef, "orderRef");
    if (b.by !== undefined && b.by !== null && b.by !== "customer" && b.by !== "system") C.bad("by ต้องเป็น customer หรือ system");
    const by = b.by === "system" ? "system" : "customer";
    const reason = C.optText(b, "reason", 200);
    C.optText(b, "at", 64);
    C.optText(b, "eventId", 128);
    const now = await readNow(deps);

    const out = await C.runTx(async (tx) => {
      const { ref, data } = await C.loadShopOrder(shopId, orderRef, tx);
      const st = C.str(data.state);
      if (st === "cancelled") return { changed: false };
      if (st !== "requested") C.refuse(409, "cancel_window_closed", "ร้านรับออเดอร์แล้ว ยกเลิกทางนี้ไม่ได้", { state: st });
      tx.update(ref, {
        state: "cancelled",
        stateAt: { ...(C.isObj(data.stateAt) ? data.stateAt : {}), cancelled: now },
        cancelledBy: by,
        cancelReason: reason || (by === "system" ? "venue_unresponsive" : "customer_cancelled"),
        notified: { ...(C.isObj(data.notified) ? data.notified : {}), cancelled: true },
        ...C.redactPhonePatch(data),
        updatedAt: now,
      });
      return { changed: true };
    });
    return ok(res, { state: "cancelled", changed: out.changed });
  });
}

module.exports = { orderCancel };

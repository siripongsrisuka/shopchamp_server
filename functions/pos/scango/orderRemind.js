// pos/scango/orderRemind.js — POST /pos/scango/order/remind {externalId, orderRef, at?, eventId?} (auth 'partner')
//
// ร้านยังไม่กดรับ (ScanGo เตือนนาทีที่ 5) → ประทับ remindedAt + remindCount แล้ว push ถึงร้านอีกรอบ (kind shop · type scango_order)
//   ใบไม่ใช่ requested แล้ว = 200 {ignored:true} ไม่ push · eventId เดียวกับครั้งก่อน = 200 {duplicate:true} ไม่ push ซ้ำ (outbox ScanGo ลองซ้ำ)
//   ไม่มี/ใบร้านอื่น = 404 order_not_found
"use strict";

const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { notify } = require("../_shared/push/notify");
const C = require("./_core");

function orderRemind(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId", "orderRef", "at", "eventId"]);
    const shopId = C.idOf(b.externalId, "externalId");
    const orderRef = C.idOf(b.orderRef, "orderRef");
    C.optText(b, "at", 64);
    const eventId = C.optText(b, "eventId", 128);
    const now = await readNow(deps);

    const out = await C.runTx(async (tx) => {
      const { ref, data } = await C.loadShopOrder(shopId, orderRef, tx);
      if (C.str(data.state) !== "requested") return { ignored: true };
      if (eventId && data.remindEventId === eventId) return { duplicate: true };
      const count = (Number.isSafeInteger(data.remindCount) ? data.remindCount : 0) + 1;
      tx.update(ref, { remindedAt: now, remindCount: count, ...(eventId ? { remindEventId: eventId } : {}), updatedAt: now });
      return { code: C.str(data.code), count };
    });
    if (out.ignored) return ok(res, { ignored: true });
    if (out.duplicate) return ok(res, { duplicate: true });
    await notify(deps, {
      to: { kind: "shop", shopId },
      heading: "ลูกค้ารอร้านรับออเดอร์ ScanGo",
      content: `#${out.code || orderRef} ยังไม่ได้กดรับ`,
      data: { type: "scango_order", orderRef },
    });
    return ok(res, { remindCount: out.count });
  });
}

module.exports = { orderRemind };

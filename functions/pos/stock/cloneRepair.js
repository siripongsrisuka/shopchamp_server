// pos/stock/cloneRepair — ซ่อมร้าน clone ที่กลุ่มผูกสต๊อกยังชี้ doc ของร้านต้นทาง (#10 · ST-001) · ทีมงานเท่านั้น (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.cloneRepair.yaml · คำขอ StockCloneRepairRequest (mode: plan | apply)
// ⚠️ ซ่อมร้านลูกค้า = เขียนร้านลูกค้า ⇒ Pack อนุมัติรายร้าน (architecture-plan.md ก้อน 9a) · agent ไม่รันตัวนี้กับร้านจริง
//
// รากของปัญหา (✅ อ่านโค้ด `shopchamp_server/functions/apis/shop.js:127-276`):
//   /cloneShop คัด stock ทั้ง doc ไปร้านใหม่ด้วย doc id ใหม่ แต่ `linkDetail[].id` `linkId` และ field `id` ยังเป็นค่าของร้านต้นทาง
//     · `linkNext` ถูกแปลงเป็น barcode · stockLink ได้ doc id ใหม่ แต่ `stockLink[].id` ยังเป็นของร้านต้นทาง
//   /cloneShop2 แปลง linkNext และ stockLink[].id ด้วย barcode (ว่าง/ซ้ำ = ได้ id เดิมของร้านต้นทาง) · ไม่แตะ linkDetail linkId
//   ⇒ ร้าน clone ขาย/เบิกสินค้าผูก = ตัดสต๊อกร้านต้นทาง (แอปเก่า) · API ใหม่ปัด 409 stock_other_shop แทน
//
// ตัวจับคู่ id ร้านต้นทาง → doc ของร้าน clone (เรียงตามความเชื่อได้):
//   ① field `id` ใน doc ของร้าน clone = สำเนา doc id ร้านต้นทาง (schema/stock.md BUG-02) · ค่าเดียวต่อ 1 doc เท่านั้นจึงใช้
//   ② barcode ของแถวใน stockLink[] = barcode ของ doc ร้าน clone ที่ยังไม่ลบ ตัวเดียวพอดี
//   จับคู่ไม่ได้/กำกวม = ไม่ซ่อมตัวนั้น ใส่ unresolved (ทีมงานเลิกผูกตัวนั้นด้วยมือผ่านแอป)
//   ❌ ไม่อ่าน doc ร้านต้นทางเลย (ไม่แตะร้านลูกค้าอีกร้าน) · ❌ ไม่แก้ยอดคงเหลือ/ต้นทุน (ยอดร้านต้นทางที่ถูกตัดไปแล้วไม่ย้อน · บอก Pack)
//
// mode plan (อ่านอย่างเดียว): คืน {planHash, counts, stockFixes[], linkFixes[], unresolved[]} (รายการตัดที่ 200 แถว)
// mode apply: ต้องมี approvalRef + planHash ตรงกับ plan ที่คิดใหม่ตอนนี้ (ฐานเปลี่ยน = 409 plan_changed ให้ plan ใหม่)
//   เขียนทีละ batch ≤ 400 (ไม่ใช่ transaction เดียว · ร้านใหญ่เกิน 500 ตัว) · ซ้ำได้: รอบ 2 plan ว่าง = ไม่เขียน
//   stock {linkDetail, linkId, linkNext, updateTime, cloneRepair:{at, approvalRef, by}} · stockLink {stockLink, cloneRepair}
//   stockRepairLog/{auto} {shopId, approvalRef, adminUid, at, planHash, counts} (collection ใหม่ · server เขียนอย่างเดียว)
// ด่าน: callerAccess → schema → access.byAdmin (ทีมงาน Shopchamp) ไม่ใช่ = 403 admin_required
// route: pos_heavy (อ่านสินค้าทั้งร้าน) · ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, resolveShopRef } = require("../_shared/auth");
const S = require("./_shared");
const { buildPlan } = require("./cloneRepairPlan");

const LIST_CAP = 200;
const BATCH = 400;

async function loadShopDocs(coll, ref) {
  const keys = [...new Set([ref.id, ref.shopId].filter(Boolean))];
  const out = new Map();
  for (const k of keys) {
    const q = await db.collection(coll).where("shopId", "==", k).get();
    for (const d of q.docs || []) out.set(d.id, d.data() || {});
  }
  return out;
}

function cloneRepair(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockCloneRepairRequest"), body, res);
      if (!input) return;
      if (access.byAdmin !== true) return sendDeny(res, deny(403, "admin_required", "เฉพาะทีมงาน Shopchamp"));
      const now = await readNow(deps);

      const shopSnap = await db.collection("shop").doc(access.shopId).get();
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() || {} });
      const [stocks, links] = await Promise.all([loadShopDocs("stock", ref), loadShopDocs("stockLink", ref)]);
      const plan = buildPlan(stocks, links);
      const view = {
        planHash: plan.planHash,
        counts: plan.counts,
        stockFixes: plan.stockFixes.slice(0, LIST_CAP),
        linkFixes: plan.linkFixes.slice(0, LIST_CAP),
        unresolved: plan.unresolved.slice(0, LIST_CAP),
        byAdmin: true,
      };
      if (input.mode === "plan") return ok(res, { mode: "plan", ...view });

      if (input.planHash !== plan.planHash) return sendDeny(res, deny(409, "plan_changed", "ข้อมูลร้านเปลี่ยนหลังดูแผน กรุณาดูแผนใหม่", { planHash: plan.planHash }));
      const stamp = { at: now, approvalRef: input.approvalRef, by: access.uid };
      const writes = [
        ...plan.stockFixes.map((f) => ({ c: "stock", id: f.id, v: { linkDetail: f.linkDetail, linkId: f.linkId, linkNext: f.linkNext, updateTime: now, cloneRepair: stamp } })),
        ...plan.linkFixes.map((f) => ({ c: "stockLink", id: f.id, v: { stockLink: f.stockLink, cloneRepair: stamp } })),
      ];
      for (let i = 0; i < writes.length; i += BATCH) {
        const b = db.batch();
        for (const w of writes.slice(i, i + BATCH)) b.update(db.collection(w.c).doc(w.id), w.v);
        await b.commit();
      }
      await db.collection("stockRepairLog").add({
        shopId: ref.shopId || access.shopId,
        approvalRef: input.approvalRef,
        adminUid: access.uid,
        at: now,
        planHash: plan.planHash,
        counts: plan.counts,
      });
      return ok(res, { mode: "apply", ...view, written: writes.length });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { cloneRepair, buildPlan };

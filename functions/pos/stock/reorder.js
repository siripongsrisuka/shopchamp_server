// pos/stock/reorder — จัดเรียงสินค้าหน้าขาย: ตั้ง `stock.timestamp` ตามลำดับที่จอส่ง (ก้อน 9a · DEV-0001 · ผลตรวจ M4)
//
// สัญญา: shopchamp-center/api/stock.reorder.yaml · คำขอ StockReorderRequest
// ทางเดิม: `main3:src/screens/ReOrderProductScreen.js:98-110` submit → `hook/useLocalStock.js:74-90` updateMultipleProducts
//   แอปเดิมเขียนตรงเป็น batch ชุดละ 500 · ตัวที่ i: timestamp = minusDays(now, 1) + 30 วินาที × i · updateTime = serverTimestamp
//   ไม่ตรวจว่าสินค้าเป็นของร้านไหน (ร้าน clone #10 เขียน doc ร้านต้นทางได้)
//
// ด่าน: callerAccess → schema (ids ไม่ซ้ำ 1..5000) → สิทธิ์ '101' ตั้งค่า (เมนู `HomeScreen.js:55` → MainProductScreen → MainArrangeScreen)
// อ่านครบก่อนเขียน: shop · stock ทุกตัว (ชุดละ 300) · ไม่มี 404 stock_not_found · ร้านอื่น 409 stock_other_shop ⇒ ไม่เขียนสักตัว
//   ลบแล้ว = ข้าม (เครื่องอื่นลบระหว่างเปิดจอ) บอกใน skipped · ตำแหน่งของตัวอื่นคงเดิม (timestamp ตามตำแหน่งในลิสต์ที่ส่ง)
// เขียน: stock {timestamp, updateTime} รูปเดิม + ทีมงาน {byAdmin, adminUid} · batch ชุดละ 450
//   ❗ ไม่ใช่ transaction (สินค้าได้ถึง 5,000 ตัว เกินเพดาน transaction) · ทุกชุดเขียนค่าที่คิดจาก now เดียวกัน ⇒ ส่งซ้ำได้ผลเดิม
//   ชุดหลังล้มกลางทาง = ลำดับบางส่วนเปลี่ยน (ช่องเดียวกับแอปเดิม · ส่งใหม่ได้ผลครบ)
//   updateTime = serverTimestamp() เวลา commit ของแต่ละ batch (DEV-0007 · ../_shared/stockJournal.js ① · รูปเดียวกับแอปเดิม) · ไม่เปลี่ยนยอด ⇒ ไม่ลงสมุด
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop } = require("../_shared/auth");
const S = require("./_shared");
const { serverTime } = require("../_shared/stockJournal");

const READ_CHUNK = 300;
const WRITE_CHUNK = 450;
const DAY_MS = 24 * 3600 * 1000;
const STEP_MS = 30 * 1000;

/** timestamp ของตำแหน่ง i · สูตรเดิม `ReOrderProductScreen.js:102-103` */
const orderTime = (now, i) => new Date(now.getTime() - DAY_MS + STEP_MS * i);

function reorder(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockReorderRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.SETTING)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const trail = adminTrail(access);

      const shopSnap = await db.collection("shop").doc(access.shopId).get();
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() || {} });

      const skipped = [];
      const plan = [];
      for (let i = 0; i < input.ids.length; i += READ_CHUNK) {
        const ids = input.ids.slice(i, i + READ_CHUNK);
        const snaps = await Promise.all(ids.map((id) => db.collection("stock").doc(id).get()));
        ids.forEach((id, j) => {
          const s = snaps[j];
          const d = s && s.exists ? s.data() : undefined;
          if (d === undefined || d === null) S.refuse(404, "stock_not_found", "ไม่พบสินค้า", { productId: id });
          if (!belongsToShop(d.shopId, ref)) S.refuse(409, "stock_other_shop", "สินค้าชี้ไปร้านอื่น กรุณาติดต่อทีมงานเพื่อซ่อม", { productId: id });
          if (d.deleted === true) skipped.push({ id, why: "deleted" });
          else plan.push({ id, timestamp: orderTime(now, i + j) });
        });
      }

      for (let i = 0; i < plan.length; i += WRITE_CHUNK) {
        const batch = db.batch();
        for (const p of plan.slice(i, i + WRITE_CHUNK)) {
          batch.update(db.collection("stock").doc(p.id), { timestamp: p.timestamp, updateTime: serverTime(), ...trail });
        }
        await batch.commit();
      }

      const out = { updated: plan.length, ...adminFlag(access) };
      if (skipped.length) out.skipped = skipped;
      return ok(res, out);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { reorder, orderTime };

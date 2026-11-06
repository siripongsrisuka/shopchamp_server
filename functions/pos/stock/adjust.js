// pos/stock/adjust — แก้ค่าเดียวของสินค้า 1 ตัว: ราคา · คงเหลือ · ต้นทุน · ลบวันหมดอายุ 1 ล็อต (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.adjust.yaml · คำขอ StockAdjustRequest (op: price | stock | cost | expRemove)
// ทางเดิม:
//   price  `main3:src/Modal/Modal_ImportProduct.js:189-220` · `LowProfitScreen.js:100-132` (สิทธิ์ '127') · แจ้งเตือน categoryId 5
//   stock  `main3:src/Modal/Modal_ImportProduct.js:156-187` (สิทธิ์ '128') · แจ้งเตือน categoryId 6
//   cost   ฟอร์มสินค้า `ProductSetting.js:146` (สิทธิ์ '112') · เดิมเขียนทั้งก้อนผ่านฟอร์ม (ST-022) ⇒ แยกเป็น op นี้
//   expRemove `main3:src/Modal/Modal_Exp.js:36-60` (เมนูสินค้าใกล้หมดอายุ '121' premium:true)
//
// ลำดับ: callerAccess → schema (ว่างปัด ST-037) → สิทธิ์ตาม op → transaction
//   อ่าน shop · stock/{productId} · สมาชิกกลุ่มผูก (op stock cost expRemove ของสินค้าผูก)
//   ไม่มี 404 · ร้านอื่น 409 · ลบแล้ว 409 stock_deleted · คนแก้ไม่อยู่/ไม่ active 409 (B-11)
//   ค่าเท่าเดิม = 200 unchanged ไม่เขียน ไม่แจ้งเตือน (ST-091)
//   op stock: ฐาน = newStock แล้ว = 200 unchanged (ส่งซ้ำหลังสำเร็จ ไม่ขึ้นว่าเครื่องอื่นแก้)
//     คงเหลือในฐาน ≠ seenStock (จอเห็นค่าเก่า มีขายระหว่างเปิดหน้าต่าง) = 409 stock_changed {currentStock} (ST-086 · ไม่ทับยอดขาย)
//     สินค้าผูก: ค่าที่กรอกเป็นหน่วยของตัวนี้ ⇒ ยอดหน่วยเล็กสุด = newStock × ตัวคูณ เขียนทุกตัวในกลุ่ม (ST-132 · เดิมเขียนตัวเดียว กลุ่มเพี้ยน)
//   op cost: สินค้าผูก = ต้นทุนต่อหน่วยเล็กสุด × ตัวคูณของแต่ละตัว (รูปเดียวกับตอนผูก)
//   op expRemove: ลบ 1 ล็อตที่ตรงวัน (ST-110) ทุกตัวในกลุ่ม (ST-111) · ไม่มีล็อตวันนั้น = 200 unchanged · premium หมด 403
//   แจ้งเตือน (price/stock) รูปเดิม {heading, shopId, notificationContent, categoryId, timestamp} + ชื่อคนแก้ (ST-092)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const S = require("./_shared");

const RIGHT_OF = Object.freeze({ price: S.RIGHTS.EDIT_PRICE, stock: S.RIGHTS.EDIT_STOCK, cost: S.RIGHTS.EDIT_COST, expRemove: S.RIGHTS.EXP });
const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

function adjust(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockAdjustRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, RIGHT_OF[input.op])) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(db.collection("shop").doc(access.shopId));
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const docs = await S.readStockDocs(db, tx, [input.productId], ref);
        const p = docs.get(input.productId);
        const linked = Boolean(p.linkId) && input.op !== "price";
        if (linked) await S.readStockDocs(db, tx, S.linkIdsOf(p), ref, { into: docs });
        S.requireActiveStaff(shop, input.staffId, access);
        const shopField = ref.shopId || access.shopId;
        const noti = (heading, content, categoryId) =>
          tx.set(db.collection("notification").doc(), {
            heading, shopId: shopField, notificationContent: content, categoryId, timestamp: now, staffName: input.staffName, ...trail,
          });
        const name = str(p.name);
        const unit = str(p.unit);
        const mult = linked ? logic.readLinkMultiply(p.linkMultiply) : 1;
        if (linked && mult === null) S.refuse(409, "stock_link_broken", "ตัวคูณของสินค้าผูกเสีย กรุณาติดต่อทีมงาน", { productId: input.productId });
        const group = linked ? [...docs.keys()] : [input.productId];

        if (input.op === "price") {
          const prev = S.num(p.price);
          if (S.round(prev) === input.newPrice && typeof p.price === "number") return { unchanged: true };
          tx.update(db.collection("stock").doc(input.productId), { price: input.newPrice, updateTime: now, ...trail });
          noti(`อัปเดตราคา ${name} เป็น ${input.newPrice} บาท`, `ราคาเดิม : ${str(p.price)}\nราคาใหม่ : ${input.newPrice} \nโดย : ${input.staffName}`, 5);
          return { unchanged: false, price: input.newPrice };
        }

        if (input.op === "stock") {
          const current = S.round(S.num(p.stock) / mult);
          // ฐานเป็นค่าใหม่อยู่แล้ว = ปลายทางถึงแล้ว (ส่งซ้ำหลังรอบแรกสำเร็จ · ค่าเท่าเดิม) ⇒ unchanged ก่อนเทียบ seenStock (ผลตรวจ W4)
          if (current === S.round(input.newStock) && typeof p.stock === "number") return { unchanged: true };
          if (current !== S.round(input.seenStock)) S.refuse(409, "stock_changed", "คงเหลือเปลี่ยนไปแล้วระหว่างแก้ กรุณายืนยันอีกครั้ง", { currentStock: current });
          const base = S.round(input.newStock * mult);
          for (const id of group) tx.update(db.collection("stock").doc(id), { stock: base, updateTime: now, ...trail });
          noti(`อัปเดตจำนวน ${name} เป็น ${input.newStock} ${unit}`, `คงเหลือเดิม : ${current}\nคงเหลือใหม่ : ${input.newStock} \nโดย : ${input.staffName}`, 6);
          return { unchanged: false, stock: input.newStock, baseStock: base, updated: group };
        }

        if (input.op === "cost") {
          if (S.round(S.num(p.cost)) === input.newCost && typeof p.cost === "number") return { unchanged: true };
          const perBase = input.newCost / mult;
          const costs = [];
          for (const id of group) {
            const m = id === input.productId ? mult : logic.readLinkMultiply(docs.get(id).linkMultiply);
            if (m === null) S.refuse(409, "stock_link_broken", "ตัวคูณของสินค้าผูกเสีย กรุณาติดต่อทีมงาน", { productId: id });
            const c = S.round(perBase * m);
            tx.update(db.collection("stock").doc(id), { cost: c, updateTime: now, ...trail });
            costs.push({ id, cost: c });
          }
          return { unchanged: false, costs };
        }

        // expRemove
        if (!isPremiumActive(shop, now)) S.refuse(403, "premium_required");
        const day = S.thaiDayOf(input.exp);
        const changed = [];
        for (const id of group) {
          const x = S.removeOneExp(docs.get(id).expReport, day);
          if (!x.removed) continue;
          tx.update(db.collection("stock").doc(id), { expReport: x.list, updateTime: now, ...trail });
          changed.push(id);
        }
        if (!changed.length) return { unchanged: true };
        return { unchanged: false, updated: changed };
      });

      return ok(res, { productId: input.productId, op: input.op, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { adjust };

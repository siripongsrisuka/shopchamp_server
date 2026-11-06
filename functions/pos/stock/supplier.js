// pos/stock/supplier — คู่ค้า: เพิ่ม · แก้ · ลบ (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.supplier.yaml · คำขอ StockSupplierRequest (op: create | update | delete)
// ทางเดิม: `main3:src/redux/supplierSlice.js:52-82` (add · update ทั้งก้อน · delete ไม่ตรวจร้าน) · จอ `SupplierScreen.js` ในเมนูรับสินค้า
//
// ด่าน: callerAccess → schema (ชื่อผู้ขายว่างปัด) → สิทธิ์ '115' รับสินค้า (เมนูคู่ค้าอยู่ใต้รับสินค้า `MainImportScreen.js:21`)
// create: supplier/{supplierUUID} มีแล้วของร้านนี้ = 200 duplicate · ร้านอื่น 409 supplier_uuid_other_shop
//   เขียนรูปเดิม `config/initialSupplier.js` {vender_Name, sale_Name, tel, lineId, detail, shopId, dateTime} + {id}
// update: ไม่มี 404 · ร้านอื่น 409 · เขียนเฉพาะ 5 ช่องที่แก้ได้ (ไม่ทับ shopId/dateTime) · เท่าเดิม = unchanged
// delete: ไม่มี = 200 alreadyDeleted · ร้านอื่น 409 (เดิมลบ doc id ใดก็ได้)
//   ใบรับเดิมเก็บสำเนาคู่ค้า ⇒ ลบคู่ค้าไม่กระทบประวัติ (`schema/importProduct.md` §1.3)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const S = require("./_shared");

const EDITABLE = ["vender_Name", "sale_Name", "tel", "lineId", "detail"];

function supplier(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockSupplierRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.RECEIVE)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(db.collection("shop").doc(access.shopId));
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() || {} });
        const id = input.op === "create" ? input.supplierUUID : input.supplierId;
        const sRef = db.collection("supplier").doc(id);
        const snap = await tx.get(sRef);
        const cur = snap.exists ? snap.data() : undefined;
        const fields = {};
        for (const k of EDITABLE) if (input[k] !== undefined) fields[k] = input[k];

        if (input.op === "create") {
          if (cur) {
            if (!belongsToShop(cur.shopId, ref)) S.refuse(409, "supplier_uuid_other_shop", "รหัสคู่ค้านี้เป็นของร้านอื่น");
            return { supplierId: id, duplicate: true };
          }
          tx.set(sRef, { ...fields, shopId: ref.shopId || access.shopId, dateTime: now, id, ...trail });
          return { supplierId: id, duplicate: false };
        }
        if (input.op === "delete" && cur === undefined) return { supplierId: id, alreadyDeleted: true };
        const c = checkOwnedDoc("supplier", cur, ref);
        if (!c.ok) S.refuseWith(c);
        if (input.op === "delete") {
          tx.delete(sRef);
          return { supplierId: id, alreadyDeleted: false };
        }
        const patch = {};
        for (const k of EDITABLE) if (cur[k] !== fields[k]) patch[k] = fields[k];
        if (!Object.keys(patch).length) return { supplierId: id, unchanged: true };
        tx.update(sRef, { ...patch, updateTime: now, ...trail });
        return { supplierId: id, unchanged: false };
      });
      return ok(res, { op: input.op, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { supplier };

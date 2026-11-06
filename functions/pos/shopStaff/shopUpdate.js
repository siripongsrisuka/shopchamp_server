// pos/shopStaff/shopUpdate — แก้ตั้งค่าร้านทีละช่อง ทีละแถว ใน transaction (ก้อน 9c · DEV-0001 · ปิด #14 / DI-01 ฝั่งแอปใหม่)
//
// สัญญา: shopchamp-center/api/shop.update.yaml · คำขอ ShopUpdateRequest (@shopchamp/schema › requests/shopStaff.ts)
//
// ลำดับ:
//   1. callerAccess → 401 no_shop_access · 403 wrong_shop (ก่อนตรวจรูปคำขอ)
//   2. ShopUpdateRequest → 400 invalid_request
//   3. สิทธิ์ต่อ op (ทุก op ในคำขอต้องผ่าน) → 403 right_required · amendBill เจ้าของเท่านั้น → 403 owner_required
//        ทั่วไป '101' ตั้งค่า (แอปเก่าปัดที่เมนู `app:screens/HomeScreen.js:55,188`)
//        claimPos (ผูกเครื่องกับจุดขาย) '100' ขาย · '101' · '102' กะ — แอปเก่าเปิด `Modal_Pos` จากปุ่มระบบขายและกะ (`HomeScreen.js:587,612`)
//        แถว taxCustomer '100' · '101' — แอปเก่าเพิ่มลูกค้าภาษีได้จากหน้าประวัติบิล (`CashierScreen.js:638 → Modal_FindTax.js:95 → TaxCustomerScreen.js:91,107`)
//   4. transaction: อ่าน shop/{shopId} ใบเดียว → ร้านไม่มี 404 · ผู้เรียกไม่ active แล้ว 403 not_shop_member
//      ทำ op ตามลำดับบนสำเนา แล้วเขียน `tx.update` เฉพาะช่องที่เปลี่ยน (ช่องอื่นในฐานไม่ถูกแตะ = เครื่องอื่นแก้ช่องอื่นไม่หาย)
//        set        แทนทั้งค่า · ช่องรายการทั้งก้อน (SHOP_SET_FIELDS_NEED_BASE) ต้องส่ง base = ค่าที่เครื่องเห็น · ไม่เท่าฐาน = 409 shop_changed
//                   ยกเว้นค่าในฐานเท่าค่าที่ส่งอยู่แล้ว (ส่งซ้ำหลังสำเร็จ) = ผ่าน ไม่เขียน
//                   ช่องที่ยังไม่มีในฐาน = ไม่มีอะไรให้ทับ ⇒ ไม่เทียบ base (แอปเห็นค่าตั้งต้นจาก initialShop ไม่ใช่ค่าในฐาน)
//        merge      รวมทีละคีย์กับ object ในฐาน
//        upsertRow  แถว id เดียวกัน = รวมทับ (คีย์ที่ไม่รู้จักของแถวเดิมคงไว้) · ไม่มี = ต่อท้าย
//        patchRow   แถวไม่มี = 404 row_not_found
//        removeRow  แถวไม่มี = ไม่ทำอะไร (ส่งซ้ำได้) · ช่องจ่าย mortal = 409 row_protected · จุดขายตัวสุดท้าย = 409 last_pos
//        claimPos   ผูกเครื่องกับจุดขายที่ยังว่าง (แทน `app:Modal/Modal_Pos.js:80-96` ที่อ่านใน transaction แล้วปัดถ้ามี uniqueId)
//                   ไม่มีแถว 404 row_not_found · มีเครื่องอื่นผูกอยู่ 409 pos_in_use · เครื่องเดิม = ผ่าน ไม่เขียน (ส่งซ้ำได้)
//        ช่องจ่าย: mortal ของแถวเดิมคงไว้เสมอ (แอปส่งมาแก้ไม่ได้) · แถวใหม่ mortal:false เสมอ (รูปเดียวกับ `PaySettingScreen.js:24` · ลบได้)
//      ไม่มีอะไรเปลี่ยน = ไม่เขียน (changed:false)
//   5. เขียน (เพิ่มอย่างเดียว): ช่องที่เปลี่ยน + `settingsUpdate: {at, by, fields[], byAdmin?, adminUid?}` (DI-16 · แอปเก่าไม่อ่าน)
// แอปเก่า: ยังเขียนทั้งช่องจาก redux ต่อ (ทับของที่แอปใหม่แก้ได้) · อ่านรูปเดิมทุกช่อง (cutOff เป็น Timestamp เหมือนเดิม)
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ShopUpdateRequest, SHOP_SET_FIELDS_NEED_BASE } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, isOwner, adminFlag } = require("../_shared/auth");
const { isObj, Refusal, refuse, callerStillActive, sameValue, toIsoDeep } = require("./common");

const SETTINGS_RIGHT = "101";
// สิทธิ์ที่รับต่อ op (มีข้อใดข้อหนึ่งพอ) · ไม่อยู่ในนี้ = '101'
const CLAIM_POS_RIGHTS = Object.freeze(["100", "101", "102"]);
const TAX_CUSTOMER_RIGHTS = Object.freeze(["100", "101"]);
function rightsFor(op) {
  if (op.op === "claimPos") return CLAIM_POS_RIGHTS;
  if (op.field === "taxCustomer" && (op.op === "upsertRow" || op.op === "patchRow" || op.op === "removeRow")) return TAX_CUSTOMER_RIGHTS;
  return [SETTINGS_RIGHT];
}
const OWNER_ONLY_FIELDS = new Set(["amendBill"]);
const NEED_BASE = new Set(SHOP_SET_FIELDS_NEED_BASE || []);
const sameId = (a, b) => a !== undefined && a !== null && String(a) === String(b);

function rowsOf(v) { return Array.isArray(v) ? v.slice() : []; }

/** applyOp(state, op) — state = {current: shop data, next: {field: value}} · คืนค่าใหม่ของช่อง หรือ refuse */
function applyOp(get, op) {
  const field = op.field;
  const cur = get(field);
  switch (op.op) {
    case "set": {
      if (NEED_BASE.has(field) && cur !== undefined && !sameValue(cur, op.base) && !sameValue(cur, op.value)) {
        refuse(deny(409, "shop_changed", "ตั้งค่านี้ถูกแก้จากเครื่องอื่น กรุณาโหลดใหม่แล้วแก้อีกครั้ง", { field }));
      }
      return field === "cutOff" ? new Date(op.value) : op.value;
    }
    case "merge":
      return { ...(isObj(cur) ? cur : {}), ...op.value };
    case "upsertRow": {
      const rows = rowsOf(cur);
      const i = rows.findIndex((r) => isObj(r) && sameId(r.id, op.row.id));
      if (i < 0) return [...rows, field === "shopchampPayment" ? { ...op.row, mortal: false } : { ...op.row }];
      const merged = { ...rows[i], ...op.row };
      if (field === "shopchampPayment" && rows[i].mortal !== undefined) merged.mortal = rows[i].mortal;
      rows[i] = merged;
      return rows;
    }
    case "patchRow": {
      const rows = rowsOf(cur);
      const i = rows.findIndex((r) => isObj(r) && sameId(r.id, op.id));
      if (i < 0) refuse(deny(404, "row_not_found", "ไม่พบรายการที่จะแก้ อาจถูกลบจากเครื่องอื่น", { field, id: op.id }));
      const merged = { ...rows[i], ...op.patch };
      if (field === "shopchampPayment") { if (rows[i].mortal !== undefined) merged.mortal = rows[i].mortal; else delete merged.mortal; }
      rows[i] = merged;
      return rows;
    }
    case "claimPos": {
      const rows = rowsOf(cur);
      const i = rows.findIndex((r) => isObj(r) && sameId(r.id, op.id));
      if (i < 0) refuse(deny(404, "row_not_found", "ไม่พบจุดขายนี้ อาจถูกลบจากเครื่องอื่น", { field, id: op.id }));
      const holder = rows[i].uniqueId;
      if (typeof holder === "string" && holder !== "" && holder !== op.uniqueId) {
        refuse(deny(409, "pos_in_use", "จุดขายนี้มีเครื่องอื่นใช้งานอยู่แล้ว", { field, id: op.id, deviceName: typeof rows[i].deviceName === "string" ? rows[i].deviceName : "" }));
      }
      if (holder === op.uniqueId) return cur;
      rows[i] = { ...rows[i], uniqueId: op.uniqueId, deviceName: op.deviceName };
      return rows;
    }
    case "removeRow": {
      const rows = rowsOf(cur);
      const hits = rows.filter((r) => isObj(r) && sameId(r.id, op.id));
      if (!hits.length) return cur; // ไม่มีแล้ว = ส่งซ้ำได้
      if (field === "shopchampPayment" && hits.some((r) => r.mortal === true)) refuse(deny(409, "row_protected", "ช่องทางชำระนี้ลบไม่ได้", { field, id: op.id }));
      const left = rows.filter((r) => !(isObj(r) && sameId(r.id, op.id)));
      if (field === "POSs" && left.length === 0) refuse(deny(409, "last_pos", "ต้องมีจุดขายอย่างน้อย 1 จุด"));
      return left;
    }
    default:
      return refuse(deny(400, "invalid_request"));
  }
}

function shopUpdate(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(ShopUpdateRequest, body, res);
      if (!input) return;
      for (const o of input.ops) if (!rightsFor(o).some((r) => hasRight(access, r))) return sendDeny(res, deny(403, "right_required", undefined, { op: o.op, field: o.field }));
      if (input.ops.some((o) => OWNER_ONLY_FIELDS.has(o.field)) && !isOwner(access)) return sendDeny(res, deny(403, "owner_required"));

      const now = await readNow(deps);
      const shopRef = db.collection("shop").doc(access.shopId);

      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(shopRef);
        if (!snap.exists) refuse(deny(404, "shop_not_found"));
        const shop = snap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);

        const next = {};
        const get = (f) => (Object.prototype.hasOwnProperty.call(next, f) ? next[f] : shop[f]);
        for (const op of input.ops) next[op.field] = applyOp(get, op);

        const claim = input.ops.find((o) => o.op === "claimPos");
        const claimed = claim ? toIsoDeep(rowsOf(next.POSs).find((r) => isObj(r) && sameId(r.id, claim.id))) : undefined;
        const changed = Object.keys(next).filter((f) => !sameValue(next[f], shop[f]));
        if (!changed.length) return { changed: [], values: {}, claimed };
        const write = {};
        for (const f of changed) write[f] = next[f];
        const trail = { at: now, by: access.uid, fields: changed };
        if (access.byAdmin === true) { trail.byAdmin = true; trail.adminUid = access.uid; }
        write.settingsUpdate = trail;
        tx.update(shopRef, write);
        const values = {};
        for (const f of changed) values[f] = toIsoDeep(next[f]);
        return { changed, values, claimed };
      });

      const extra = out.claimed !== undefined ? { pos: out.claimed } : {};
      return ok(res, { changed: out.changed.length > 0, fields: out.changed, values: out.values, ...extra, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { shopUpdate, applyOp };

// pos/shopStaff/posManage — เพิ่ม · เปลี่ยนชื่อ · ลบ · ยกเลิกเครื่องที่ผูก · เติมโครงจุดขาย พร้อม doc shift ของจุดขายใน transaction เดียว
//   (ก้อน 10 รอบ 2a · DEV-0001 · แถว FN-011..FN-061 MP-26 SS-029 ของตาราง chunk10-compare-matrix)
//
// สัญญา: shopchamp-center/api/pos.manage.yaml · คำขอ PosManageRequest (@shopchamp/schema › requests/posManage.ts)
// แทน: `main3:src/screens/POSScreen.js:128-182` (เขียน POSs ทั้งก้อนจากสำเนาในเครื่อง + สร้าง/ลบ doc shift)
//      `main3:src/screens/PrinterPosScreen.js:43-83` (เติม id ให้แถวที่ไม่มี + สร้าง doc shift ให้แถวที่ไม่มี shiftId)
//
// ลำดับ:
//   1. callerAccess → 401 no_shop_access · 403 wrong_shop · 2. PosManageRequest → 400 · 3. สิทธิ์ '101' ตั้งค่า → 403 right_required
//      (แอปเก่าเข้าจอทั้ง 2 จากเมนูตั้งค่า `HomeScreen.js:57` → `AdvanceScreen.js:28` / `ShopSettingScreen.js:60`)
//   4. transaction: อ่าน shop → 404 · ผู้เรียกไม่ active แล้ว 403 not_shop_member · อ่าน doc shift ของแถวที่จะลบ (อ่านครบก่อนเขียน)
//      add        id มีอยู่แล้ว = ไม่ทำอะไร (ส่งซ้ำได้) · แถวใหม่ต้องมีแพ็กเกจพรีเมี่ยม (แอปเก่าปัดที่จอ `POSScreen.js:74-85`) → 403 premium_required
//                 แถว = initialPos + {id, name, shiftId} · doc shift ใหม่ = initialShift + {shopId, posId} (รูปเดิม `POSScreen.js:150`)
//      rename     ไม่มีแถว 404 row_not_found
//      remove     ไม่มีแถว = ไม่ทำอะไร · จุดขายแรก 409 first_pos (แอปเก่าไม่มีปุ่มลบแถวแรก `POSScreen.js:39`)
//                 doc shift ของแถว: ร้านอื่น 409 shift_other_shop (ไม่ลบของร้านอื่น) · กะยังเปิด 409 pos_shift_open (ใหม่ · แอปเก่าลบได้)
//                 ไม่มี doc = ลบแถวอย่างเดียว · แถวอื่นยังใช้ shiftId เดียวกัน = ไม่ลบ doc
//      disconnect ล้าง uniqueId deviceName (แบบ `POSScreen.js:210-214`) · ไม่มีแถว 404
//      repair     แถวไม่มี id = ตั้งให้ (deps.newId · ตัวจริง randomUUID แบบ uuid.v4 ของแอปเก่า) · ไม่มี shiftId = สร้าง doc shift · ลำดับแถวคงเดิม (P-85)
//   5. เขียน: shift/{auto} set · shift/{id} delete · shop update {POSs, settingsUpdate} เฉพาะเมื่อมีอะไรเปลี่ยน
//      คีย์ที่ไม่รู้จักของแถวเดิม (drawer printer*) คงไว้ · ทีมงาน (byAdmin) = doc shift ใหม่มี {byAdmin, adminUid}
// shopId ของ doc shift ใหม่ = field shopId ของร้านเมื่อพิสูจน์แล้วว่าเป็นของร้านนี้ (แอปเก่าเขียน field · `POSScreen.js:150`) ไม่งั้น doc id
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const { PosManageRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, resolveShopRef, belongsToShop } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { initialPos, initialShift } = require("../company/shopTemplate");
const { isObj, Refusal, refuse, callerStillActive, sameValue, toIsoDeep } = require("./common");

const SETTINGS_RIGHT = "101";
const MESSAGES = {
  row_not_found: "ไม่พบจุดชำระเงินนี้ อาจถูกลบจากเครื่องอื่น",
  first_pos: "จุดชำระเงินแรกลบไม่ได้",
  pos_shift_open: "จุดชำระเงินนี้ยังเปิดกะอยู่ กรุณาปิดกะก่อนลบ",
  shift_other_shop: "กะของจุดชำระเงินนี้ไม่ใช่ของร้านนี้ ลบไม่ได้ กรุณาติดต่อทีมงาน",
  premium_required: "มีจุดชำระเงินได้ 1 จุด อัปเกรดแพ็กเกจพรีเมี่ยมเพื่อเพิ่มจุดชำระเงิน",
};
const no = (status, error, extra) => refuse(deny(status, error, MESSAGES[error], extra));
const strOr = (v) => (typeof v === "string" ? v : "");
const nameOf = (r) => strOr(r && r.name);
const rowIndex = (rows, id) => rows.findIndex((r) => isObj(r) && r.id === id);
const newIdOf = (deps) => depOr(deps, "newId", () => crypto.randomUUID());
// id ของ doc shift ใหม่: ตัวจริง = auto id ของ Firestore (แบบ `POSScreen.js:149` db.collection('shift').doc()) · เทส/สัญญาส่ง deps.newShiftId ให้ได้ค่าคงที่
const shiftIdOf = (deps) => depOr(deps, "newShiftId", null);

function posManage(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(PosManageRequest, body, res);
      if (!input) return;
      if (!hasRight(access, SETTINGS_RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const newId = newIdOf(deps);
      const newShiftId = shiftIdOf(deps);
      const shopDocRef = db.collection("shop").doc(access.shopId);
      const trailOf = () => (access.byAdmin === true ? { byAdmin: true, adminUid: access.uid } : {});

      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(shopDocRef);
        if (!snap.exists) refuse(deny(404, "shop_not_found"));
        const shop = snap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);
        const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const shiftShopId = shopRef.shopId || access.shopId;

        const before = Array.isArray(shop.POSs) ? shop.POSs : [];
        let rows = before.slice();
        const firstId = isObj(rows[0]) ? rows[0].id : undefined;

        // อ่าน doc shift ของแถวที่จะลบให้ครบก่อนเขียน
        const removeOps = input.ops.filter((o) => o.op === "remove");
        const shiftDocs = {};
        for (const o of removeOps) {
          const i = rowIndex(rows, o.id);
          const sid = i >= 0 ? strOr(rows[i].shiftId) : "";
          if (sid && !(sid in shiftDocs) && !sid.includes("/")) {
            const s = await tx.get(db.collection("shift").doc(sid));
            shiftDocs[sid] = s.exists ? s.data() || {} : null;
          }
        }

        const createShifts = []; // {ref, data}
        const deleteShifts = [];
        const newShift = (posId) => {
          const ref = newShiftId ? db.collection("shift").doc(newShiftId()) : db.collection("shift").doc();
          createShifts.push({ ref, data: { ...initialShift(), shopId: shiftShopId, posId, ...trailOf() } });
          return ref.id;
        };

        for (const o of input.ops) {
          if (o.op === "add") {
            if (rowIndex(rows, o.id) >= 0) continue; // ส่งซ้ำหลังสำเร็จ
            if (!isPremiumActive(shop, now)) no(403, "premium_required");
            rows.push({ ...initialPos(), name: o.name, id: o.id, shiftId: newShift(o.id) });
          } else if (o.op === "rename") {
            const i = rowIndex(rows, o.id);
            if (i < 0) no(404, "row_not_found", { id: o.id });
            if (rows[i].name !== o.name) rows[i] = { ...rows[i], name: o.name };
          } else if (o.op === "disconnect") {
            const i = rowIndex(rows, o.id);
            if (i < 0) no(404, "row_not_found", { id: o.id });
            if (rows[i].uniqueId !== "" || rows[i].deviceName !== "") {
              rows[i] = { ...rows[i], uniqueId: "", deviceName: "" };
            }
          } else if (o.op === "remove") {
            const i = rowIndex(rows, o.id);
            if (i < 0) continue; // ไม่มีแล้ว = ส่งซ้ำได้
            if (o.id === firstId) no(409, "first_pos", { id: o.id });
            const row = rows[i];
            const sid = strOr(row.shiftId);
            const doc = sid ? shiftDocs[sid] : null;
            if (doc) {
              if (!belongsToShop(doc.shopId, shopRef)) no(409, "shift_other_shop", { id: o.id });
              if (doc.status === true) no(409, "pos_shift_open", { id: o.id, name: nameOf(row) });
            }
            rows = rows.filter((_, k) => k !== i);
            if (doc && !rows.some((r) => isObj(r) && r.shiftId === sid)) deleteShifts.push(sid);
          } else if (o.op === "repair") {
            rows = rows.map((r) => {
              if (!isObj(r)) return r;
              const id = r.id ? r.id : newId();
              return r.shiftId ? (id === r.id ? r : { ...r, id }) : { ...r, id, shiftId: newShift(id) };
            });
          }
        }

        const changed = !sameValue(rows, before);
        if (!changed) return { changed: false, rows, created: [], deleted: [] };
        for (const c of createShifts) tx.set(c.ref, c.data);
        for (const sid of deleteShifts) tx.delete(db.collection("shift").doc(sid));
        const trail = { at: now, by: access.uid, fields: ["POSs"], ...trailOf() };
        tx.update(shopDocRef, { POSs: rows, settingsUpdate: trail });
        return {
          changed: true,
          rows,
          created: createShifts.map((c) => ({ posId: c.data.posId, shiftId: c.ref.id })),
          deleted: deleteShifts,
        };
      });

      return ok(res, { changed: out.changed, POSs: toIsoDeep(out.rows), createdShifts: out.created, deletedShifts: out.deleted, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { posManage, MESSAGES };

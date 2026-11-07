// pos/shift/openList — จุดขายไหนเปิดกะอยู่ (DEV-0002 · Pack เคาะ 2026-11-07 รับชำระเงินเซ็นผ่านเว็บ)
//
// สัญญา: shopchamp-center/api/shift.openList.yaml · คำขอ ShiftOpenListRequest (@shopchamp/schema) · อ่านอย่างเดียว
// ใช้ที่: เว็บเจ้าของร้าน จอสมาชิก รับชำระเป็นเงินสดในร้านที่ใช้กะ ⇒ ให้เลือกลิ้นชัก (กะ) ที่เงินเข้า
//
// ลำดับด่าน = openReport ของรายงาน (401 → 400 → 403 wrong_shop → 403 right_required → 404 shop_not_found → 403 not_shop_member)
//   สิทธิ์พนักงาน: '124' จัดการเซ็น หรือ '102' เปิด-ปิดกะ · เจ้าของ/ทีมงานผ่าน
// อ่าน: shop/{shopId} · shift/{POSs[].shiftId} ทีละใบ (server อ่านรายชื่อจุดจาก doc ร้านเอง ไม่รับจากเว็บ)
//   นับว่าเปิด = doc มีอยู่ · shopId เป็นของร้านนี้ (belongsToShop) · status === true · กะร้านอื่น/ไม่มี doc = ไม่อยู่ในรายการ (ไม่บอกว่ามีอยู่)
// คำตอบ: {ok, usesShift (shop.shift === true), posQty, shifts:[{posId, posName, shiftId, openTime ISO|null, openName, shiftCount}]} เรียงตาม POSs
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { ShiftOpenListRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, internalError } = require("../_shared/respond");
const { adminFlag, belongsToShop } = require("../_shared/auth");
const { RIGHT, openReport } = require("../report/_reportShared");

const CREDIT_RIGHT = "124"; // จัดการเซ็น (main3 src/screens/StaffScreen.js:71)
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isoOf = (t) => {
  const ms = logic.toMillis(t);
  return ms === null ? null : new Date(ms).toISOString();
};

/** posRowsOf(shop) — แถวจุดขายที่มี shiftId เป็นข้อความไม่ว่าง · shiftId ซ้ำนับครั้งเดียว · ห้ามมี / */
function posRowsOf(shop) {
  const list = Array.isArray(shop && shop.POSs) ? shop.POSs : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!isObj(p) || typeof p.shiftId !== "string" || p.shiftId === "" || p.shiftId.includes("/")) continue;
    if (seen.has(p.shiftId)) continue;
    seen.add(p.shiftId);
    out.push({ posId: p.id === undefined ? null : p.id, posName: typeof p.name === "string" ? p.name : "", shiftId: p.shiftId });
  }
  return out;
}

function openList() {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ShiftOpenListRequest, { rights: [CREDIT_RIGHT, RIGHT.SHIFT] });
      if (!ctx) return res;
      const { access, shop, shopRef } = ctx;
      const rows = posRowsOf(shop);
      const snaps = await Promise.all(rows.map((r) => db.collection("shift").doc(r.shiftId).get()));
      const shifts = [];
      rows.forEach((r, i) => {
        const s = snaps[i];
        const d = s && s.exists ? s.data() : undefined;
        if (!isObj(d) || !belongsToShop(d.shopId, shopRef) || d.status !== true) return;
        shifts.push({
          ...r,
          openTime: isoOf(d.openTime),
          openName: typeof d.openName === "string" ? d.openName : "",
          shiftCount: Number.isInteger(d.shiftCount) ? d.shiftCount : null,
        });
      });
      return ok(res, { usesShift: shop.shift === true, posQty: rows.length, shifts, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { openList, posRowsOf };

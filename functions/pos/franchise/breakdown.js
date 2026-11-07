// pos/franchise/breakdown.js — ยอดขายของแฟรนไชส์ ต่อสาขา รายชั่วโมง รายสินค้า (DEV-0002 · Pack เคาะ 2026-11-07) · อ่านอย่างเดียว · function pos_heavy
//
// สัญญา: shopchamp-center/api/franchise.breakdown.yaml
// ผู้ใช้: เว็บแฟรนไชส์ Dashboard (100) · ยอดตามร้าน (103) · ยอดตามสินค้า (104) ⇒ ต้องมีสิทธิ์ตัวใดตัวหนึ่ง (ด่านเดียวกับ billList)
// Pack เคาะ 2026-11-07: ยอดแฟรนไชส์ใช้สูตรกลางตัวเดียวกับรายงานร้าน (9e report.breakdown)
//   ⇒ ไม่มีสูตรเงินในไฟล์นี้: แยกบิลตามสาขา แล้วส่ง logic.franchiseBreakdown (= logic.salesBreakdown ต่อสาขาด้วย cutOff ของสาขานั้น แล้วบวก)
//   ไม่นับใบยกเลิก (WR-04) · ส่วนลดท้ายบิลกระจายลงสินค้า (#23 WR-02) · วันธุรกิจตาม cutOff ของแต่ละสาขา (#24 WR-01)
// ค้นบิลชุดเดียวกับ billList (loadFranchiseBills: billDate fromDay-1..toDay+2 แล้วตัดสินด้วยเวลาขาย)
// สาขาตอนนี้ทุกสาขาอยู่ใน shops (ไม่มียอด = 0) · ร้านที่ออกไปแล้วแต่บิลยังถือ franchiseId นี้ = แถว inFranchise:false (WR-72 คงเดิม)
"use strict";

const logic = require("@shopchamp/logic");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");
const { loadFranchiseBills } = require("./billList");

const breakdown = F.makeHandler("FranchiseBillListRequest", async ({ uid, input }) => {
  const { branches, branchList, docs, cutOffOf } = await loadFranchiseBills(input, uid);
  const groups = new Map(); // shopId ที่รายงาน → {shopId, cutOff, entries, inFranchise}
  for (const b of branchList) {
    if (input.shopId === undefined || b.id === input.shopId) groups.set(b.id, { shopId: b.id, cutOff: b.cutOff, entries: [], inFranchise: true });
  }
  for (const d of docs) {
    const data = d.data() || {};
    const raw = F.str(data.shopId);
    const branch = branches.get(raw);
    if (input.shopId !== undefined && (!branch || branch.id !== input.shopId)) continue;
    const id = branch ? branch.id : raw;
    if (!groups.has(id)) groups.set(id, { shopId: id, cutOff: cutOffOf.get(raw), entries: [], inFranchise: false });
    groups.get(id).entries.push({ id: d.id, data });
  }
  const r = logic.franchiseBreakdown([...groups.values()], { fromDay: input.fromDay, toDay: input.toDay });
  if (!r.ok) F.refuse(deny(400, "range_invalid", "ช่วงวันไม่ถูกต้อง (ไม่เกิน 31 วัน)", { reason: r.reason }));
  // ร้านที่ออกไปแล้วและไม่มีบิลในช่วง ไม่ต้องมีแถว
  const shops = r.shops
    .map((s) => ({ ...s, inFranchise: groups.get(s.shopId).inFranchise }))
    .filter((s) => s.inFranchise || s.billQty > 0 || s.voidQty > 0);
  return {
    fromDay: r.fromDay, toDay: r.toDay,
    totals: { ...r.totals, shopQty: shops.filter((s) => s.inFranchise).length, shopWithSale: shops.filter((s) => s.billQty > 0).length },
    shops, hours: r.hours, items: r.items,
    ...(input.shopId ? { shopId: input.shopId } : {}),
  };
});

module.exports = { breakdown };

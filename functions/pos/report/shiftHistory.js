// pos/report/shiftHistory — ประวัติกะของช่วงวันธุรกิจ พร้อมยอดบิลมาช้า (ก้อน 9e · DEV-0001)
//
// สัญญา: shopchamp-center/api/report.shiftHistory.yaml · route POST /pos_heavy/report/shift-history · ผูก routes.js แล้ว
// รูป: factory (deps) => handler(req, res) · deps: now (ด่านแพ็กเกจ · ไม่ส่ง = new Date())
// แพ็กเกจ: ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วันไม่ได้ 403 premium_required (ด่านเดิมของเว็บ · freeWindowGate · ❓ 9e-reports.md คำถาม 7)
// ปิด: #18 SC-02 ฝั่งรายงาน: lateSales lateBillQty ที่ sale.create บวกเข้ารอบเดิม · totalNetWithLate = thisTotalNet + lateSales
//      WR-50 เวลา map {_seconds,_nanoseconds} อ่านได้ · WR-14 กะลงวันธุรกิจของเวลาปิด (❓ รอ Pack ยืนยัน chunk9/9e-reports.md คำถาม 1)
// อ่านทุกรุ่น (AnyShiftHistory): รุ่นปัจจุบันมีก้อนสรุป · รุ่นแรก (ShiftHistoryLegacy) ไม่มี ⇒ summary null (❓ คำถาม 2)
//   รุ่นแรก openBy closeBy เป็น id พนักงาน ⇒ ชื่อจาก shop.humanResource (ไม่เจอ = "") · id คืนใน openById closeById
// ⚠️ summary.totalNet = thisTotalNet ที่แอปเก่าเขียนไว้ ซึ่งนับบิลไม่มียอดเป็น 999 (BX-07 · WR-42) ⇒ รายงานกะยังติดค่านั้น (9e-reports.md ข้อที่ไม่ได้แก้)
// เดิม: เว็บ (own:redux/shiftSlice.js:34,108) และแอป (main3 ShiftHistoryScreen.js:74-76) ค้นด้วย lastShiftDate = วันเปิดกะ
// สิทธิ์: พนักงานต้องมี '102' เปิด-ปิดกะ หรือ '106' รายงาน (จอประวัติกะของแอปเปิดจาก ShiftScreen.js:356 · เมนู 102)
// ค้นด้วย closeTime (มีทุกรุ่นเป็น Timestamp · openTime บางใบเป็น map ค้นช่วงไม่ได้)
//   ⚠️ ต้องมี index shiftHistory(shopId ASC, closeTime DESC) · ยังไม่มีใน firestore.indexes.json = Pack สร้าง (9e-reports.md)
// dayBy 'open' (DEV-0002 · จอประวัติกะเว็บเดิมค้นวันเปิด own:redux/shiftSlice.js:34): ค้น openTime ในช่วงแทน · index shiftHistory(shopId, openTime) มีแล้ว
//   ⚠️ ประวัติกะรุ่นแรกที่ openTime เป็น map {_seconds} ค้นช่วงไม่เจอ (Firestore เทียบ map กับ Timestamp ไม่ได้) ⇒ ใช้ค้นตามวันปิดแทน
// แถวมีเงินเข้าออกระหว่างกะ duringShift cashIn cashOut · closeWithDraw · cashExpected · cashRemain · summary มีหมวด สินค้า แคชเชียร์ แคมเปญ (Modal_Shift ของเว็บ)
// Firestore อ่าน: shop/{shopId} · shiftHistory where shopId == key and closeTime (หรือ openTime) in (start, end] · เขียน: ไม่มี
"use strict";

const { ReportShiftHistoryRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, freeWindowGate, mergeSnaps } = require("./_reportShared");

function shiftHistory(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportShiftHistoryRequest, { rights: [RIGHT.SHIFT, RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const range = logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay, cutOff: shop.cutOff });
      if (!range.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: range.reason }] });
      if (!(await freeWindowGate(deps, shop, input.fromDay, res))) return res;
      const field = input.dayBy === "open" ? "openTime" : "closeTime";
      const snaps = await Promise.all(keys.map((k) => db.collection("shiftHistory")
        .where("shopId", "==", k).where(field, ">", range.start).where(field, "<=", range.end)
        .orderBy(field, "desc").get()));
      const r = logic.shiftReport(mergeSnaps(snaps, shopRef), { cutOff: shop.cutOff, fromDay: input.fromDay, toDay: input.toDay, humanResource: shop.humanResource, dayBy: input.dayBy });
      if (!r.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: r.reason }] });
      const { ok: _ok, ...report } = r; // eslint-disable-line no-unused-vars
      return ok(res, { ...adminFlag(access), ...report });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { shiftHistory };

// pos/report/salesTotals — ยอดขายของช่วงวันธุรกิจ (ก้อน 9e · DEV-0001)
//
// สัญญา: shopchamp-center/api/report.salesTotals.yaml · route POST /pos_heavy/report/sales-totals · ยังไม่ผูก routes.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now (ด่านแพ็กเกจ · ไม่ส่ง = new Date())
// แพ็กเกจ: ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วันไม่ได้ 403 premium_required (ด่านเดิมของเว็บ · freeWindowGate · ❓ 9e-reports.md คำถาม 7)
// แทน: server เดิม `/bill/summary` (shopchamp_server/functions/apis/bill.js:64-96) qty totalSale average · เดิมตัวเลขเป็นข้อความ toLocaleString
//   ใหม่เป็นตัวเลข + ยอดรายวัน รายช่องจ่าย แคชเชียร์ แคมเปญ หมวด รายสินค้าหลังกระจายส่วนลดท้ายบิล (#23) ให้เว็บ (DEV-0002) ใช้ชุดเดียว
//   สูตร: logic.summarizeSales (lanes/dev/source/compare/old-logic/report.js คือสูตรเดิมที่เทียบ)
// สิทธิ์: พนักงานต้องมี '117' หรือ '106' (ตัวเดียวกับ report.billList · ยอดบนจอประวัติบิลมาจากคู่นี้)
// วัน: ช่วงเวลาจาก shop.cutOff (#24 WR-01) · คืน cutOff ที่ใช้ให้จอแสดง
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and dateTime in (start, end] (ทั้งเอกสาร · ใช้ product payment campaign) · เขียน: ไม่มี
"use strict";

const { ReportSalesTotalsRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, freeWindowGate, billsByTime } = require("./_reportShared");

function salesTotals(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportSalesTotalsRequest, { rights: [RIGHT.BILL_HISTORY, RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const range = logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay, cutOff: shop.cutOff });
      if (!range.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: range.reason }] });
      if (!(await freeWindowGate(deps, shop, input.fromDay, res))) return res;
      const entries = await billsByTime({ keys, shopRef, after: range.start, upTo: range.end });
      const s = logic.summarizeSales(entries, { cutOff: shop.cutOff, fromDay: input.fromDay, toDay: input.toDay, smartCategory: shop.smartCategory });
      if (!s.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: s.reason }] });
      const { ok: _ok, ...summary } = s; // eslint-disable-line no-unused-vars
      return ok(res, { ...adminFlag(access), cutOff: logic.normalizeCutOff(shop.cutOff), ...summary });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { salesTotals };

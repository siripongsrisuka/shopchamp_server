// pos/report/breakdown — ยอดขายแยกมิติ ของช่วงวันธุรกิจ ทั้งช่วงหรือรายวัน (DEV-0002 · จอรายงานเว็บเจ้าของร้าน 1.1-1.6 2.1-2.6)
//
// สัญญา: shopchamp-center/api/report.breakdown.yaml · route POST /pos_heavy/report/breakdown
// รูป: factory (deps) => handler(req, res) · deps: now (ด่านแพ็กเกจ · ไม่ส่ง = new Date())
// แพ็กเกจ: ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วันไม่ได้ 403 premium_required (ด่านเดียวกับ report.salesTotals · freeWindowGate)
// แทน: เว็บเดิมโหลดบิลเต็มทุกใบลงเบราว์เซอร์ (own:redux/billSlice.js fetchBill) แล้วแต่ละจอคิดเอง 14 สูตร
//   ใหม่ server คิดด้วย logic.salesBreakdown ตัวเดียว (สูตรเดียวกับ salesTotals และรายงานกะของแอป)
//   ไม่นับใบยกเลิก · วันตาม cutOff ร้าน (#24 WR-01) · ส่วนลดท้ายบิลกระจายลงสินค้า/หมวด/ฝากขาย (#23 WR-02) · ช่องจ่ายสูตรรายงานกะ (SC-04)
//   สูตรเดิมของเว็บที่เทียบ: lanes/dev/source/compare/old-logic/report-web.js
// มิติ: total hour item consignment category payment discount · granularity total | day (เว็บรวมรายสัปดาห์/เดือนจากรายวันเอง)
// สิทธิ์: พนักงานต้องมี '117' หรือ '106' (ตัวเดียวกับ report.salesTotals)
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and dateTime in (start, end] (ทั้งเอกสาร) · เขียน: ไม่มี
"use strict";

const { ReportBreakdownRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, freeWindowGate, billsByTime } = require("./_reportShared");

function breakdown(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportBreakdownRequest, { rights: [RIGHT.BILL_HISTORY, RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const range = logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay, cutOff: shop.cutOff });
      if (!range.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: range.reason }] });
      if (!(await freeWindowGate(deps, shop, input.fromDay, res))) return res;
      const entries = await billsByTime({ keys, shopRef, after: range.start, upTo: range.end });
      const r = logic.salesBreakdown(entries, {
        cutOff: shop.cutOff, fromDay: input.fromDay, toDay: input.toDay,
        dimension: input.dimension, granularity: input.granularity, smartCategory: shop.smartCategory,
      });
      if (!r.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "dimension", message: r.reason }] });
      const { ok: _ok, ...report } = r; // eslint-disable-line no-unused-vars
      return ok(res, { ...adminFlag(access), cutOff: logic.normalizeCutOff(shop.cutOff), ...report });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { breakdown };

// pos/report/duplicateNumbers — เลขใบเสร็จ/ใบกำกับที่ซ้ำกันในร้าน ของเดือนตามเลขเอกสาร (ก้อน 9e · DEV-0001)
//
// สัญญา: shopchamp-center/api/report.duplicateNumbers.yaml · route POST /pos_heavy/report/duplicate-numbers · ยังไม่ผูก routes.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: ไม่มี
// ปิด: #19 RT-01 ฝั่งร้านเห็น · แอปใหม่ได้เลขจาก server (ก้อน 4) แต่แอปเก่ายังออกเลขเองตามนาฬิกาเครื่องต่อไป (decision 6.1 ทาง 3)
//   ⇒ เลขที่ซ้ำแล้วทำเป็นรายการให้ร้านรู้ · ❌ ไม่แก้เลขในบิล (เลขอยู่บนกระดาษที่ลูกค้าถือแล้ว · การแก้ = Pack/นักบัญชีเคาะ)
// เดือน: ตามเลขเอกสาร (ขึ้นต้น YYYYMM) ไม่ใช่เวลาขาย เพราะนาฬิกาเพี้ยนทำให้เลขกับเวลาขายคนละเดือนได้
// สิทธิ์: พนักงานต้องมี '106' รายงาน
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and receiptNumber ขึ้นต้น YYYYMM · bill where shopId == key and taxNumber ขึ้นต้น YYYYMM · เขียน: ไม่มี
"use strict";

const { ReportDuplicateNumbersRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, billsByPrefix } = require("./_reportShared");

const DUP_FIELDS = Object.freeze([
  "shopId", "dateTime", "soldAt", "receiptNumber", "orderId", "taxNumber", "moneyMustPaid", "totalPrice", "discount", "eyosDiscount",
  "void", "posId", "cashierName", "offlineSync",
]);

function duplicateNumbers(deps) { // eslint-disable-line no-unused-vars
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportDuplicateNumbersRequest, { rights: [RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const [byReceipt, byTax] = await Promise.all([
        billsByPrefix({ keys, shopRef, field: "receiptNumber", prefix: input.month, fields: DUP_FIELDS }),
        billsByPrefix({ keys, shopRef, field: "taxNumber", prefix: input.month, fields: DUP_FIELDS }),
      ]);
      // บิลที่ทั้งเลขใบเสร็จและเลขใบกำกับขึ้นต้นเดือนนี้มาจากทั้ง 2 ชุด ⇒ รวมด้วย doc id ครั้งเดียว
      const all = new Map();
      for (const e of [...byReceipt, ...byTax]) if (!all.has(e.id)) all.set(e.id, e);
      const r = logic.duplicateNumberReport([...all.values()], { month: input.month, cutOff: shop.cutOff });
      if (!r.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "month", message: r.reason }] });
      const { ok: _ok, ...report } = r; // eslint-disable-line no-unused-vars
      return ok(res, { ...adminFlag(access), ...report });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { duplicateNumbers, DUP_FIELDS };

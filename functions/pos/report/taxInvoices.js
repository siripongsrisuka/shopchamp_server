// pos/report/taxInvoices — รายงานภาษีขาย: ใบกำกับภาษีของเดือนภาษี รวมใบที่ยกเลิก (ก้อน 9e · DEV-0001)
//
// สัญญา: shopchamp-center/api/report.taxInvoices.yaml · route POST /pos_heavy/report/tax-invoices · ยังไม่ผูก routes.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now (นาฬิกา server ใช้ตัดสินแพ็กเกจพรีเมี่ยม · ไม่ส่ง = new Date())
// ปิด: #21 RT-05 ใบกำกับที่ยกเลิกไม่หายจากรายงาน (อยู่ในรายการพร้อม voided:true · ยอดแยก active/voided)
//      WR-09 มีเลขใบกำกับ taxNumber · ก่อนภาษี+ภาษี+ปัดเศษ+ยกเว้น = สุทธิ (logic.vatDocOf)
// เดิม: เว็บเจ้าของร้าน ReportVatScreen อ่าน Firestore ตรง ตัดบิล void ทิ้ง (own:redux/billSlice.js:151-152,160) · เมนู premium:true
// เดือน: ตามเลขใบกำกับ (taxNumber ขึ้นต้น YYYYMM · ออกตามเดือนที่ออกใบ) · ไม่ใช่เวลาขาย
// สิทธิ์: พนักงานต้องมี '106' รายงาน · แพ็กเกจพรีเมี่ยมยังไม่หมด (เมนูเว็บเดิม premium:true · Rpt-VatScreen.md VT-001/002) ไม่งั้น 403 premium_required
//   ทีมงาน Shopchamp ก็ติดด่านพรีเมี่ยมเหมือน sale.amend (เป็นสมบัติของร้าน ไม่ใช่ของคนเรียก)
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and taxNumber in [YYYYMM, YYYYMM] · เขียน: ไม่มี
"use strict";

const { ReportTaxInvoicesRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { readNow } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const { RIGHT, openReport, billsByPrefix } = require("./_reportShared");

const TAX_FIELDS = Object.freeze([
  "shopId", "dateTime", "soldAt", "receiptNumber", "orderId", "taxNumber", "taxCustomer", "moneyMustPaid", "vatAmount", "vatType",
  "rounding", "noVatAmount", "void", "voidStaff", "reason", "amendedBy",
]);

function taxInvoices(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportTaxInvoicesRequest, { rights: [RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const now = await readNow(deps);
      if (!isPremiumActive(shop, now)) return fail(res, 403, "premium_required");
      const entries = await billsByPrefix({ keys, shopRef, field: "taxNumber", prefix: input.month, fields: TAX_FIELDS });
      const r = logic.taxInvoiceReport(entries, { month: input.month, cutOff: shop.cutOff });
      if (!r.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "month", message: r.reason }] });
      const { ok: _ok, ...report } = r; // eslint-disable-line no-unused-vars
      return ok(res, { ...adminFlag(access), ...report });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { taxInvoices, TAX_FIELDS };

// pos/report/billList — รายการบิลของช่วงวันธุรกิจ ล่าสุดก่อน แบ่งหน้า (ก้อน 9e · DEV-0001)
//
// สัญญา: shopchamp-center/api/report.billList.yaml · route POST /pos_heavy/report/bill-list · ผูก routes.js แล้ว
// รูป: factory (deps) => handler(req, res) · deps: now (ด่านแพ็กเกจ · ไม่ส่ง = new Date())
// แพ็กเกจ: ร้านไม่พรีเมี่ยมเลือกวันเริ่มย้อนเกิน 62 วันไม่ได้ 403 premium_required (ด่านเดิมของเว็บ · freeWindowGate · ❓ 9e-reports.md คำถาม 7)
// แทน: server เดิม `/bill/test` (shopchamp_server/functions/apis/bill.js:18-62) ที่จอประวัติบิลของแอป main3 เรียก
//   เดิมช่วงวันมาจากเครื่อง (manageCutOff) · ใหม่ server คิดช่วงจาก shop.cutOff เอง (#24 WR-01)
//   เดิม select เฉพาะ field ของจอ · ใหม่คืนแถวรูปเดียวทุกรุ่นบิล (logic.reportBillRow) รวมบิลรุ่นแรก (เดิม .toDate ได้ แต่จอ payment.map ล้ม)
// สิทธิ์: พนักงานต้องมี '117' ดูประวัติใบเสร็จ หรือ '106' รายงาน (แอปเก่าปัดที่จอ CashierScreen.js:635 · เมนูรายงาน HomeScreen.js:59)
// แบ่งหน้า: เรียง dateTime ใหม่ก่อน (เวลาเท่ากันเรียง doc id มากก่อน · ตรงกับ orderBy dateTime desc ของ Firestore)
//   cursor = {at: dateTime ของแถวสุดท้าย, id} · หน้าถัดไปค้น dateTime <= at แล้วตัดแถวที่ไม่อยู่หลัง cursor
//   ค้นเผื่อ TIE_SLACK แถวต่อ key กันบิลเวลาเดียวกันเกินหน้า · ❓ เวลาเดียวกันเกิน slack ในมิลลิวินาทีเดียว = อาจข้ามแถว (ยังไม่เคยเห็นในข้อมูล)
// detail:true (DEV-0002 · จอ 4.1 ข้อมูลใบเสร็จ · 4.3 รายงานภาษี · 1.2 รายวันแบบรายบิล ของเว็บ): อ่านเอกสารเต็ม (ไม่ select)
//   แถวมี detail = logic.billDetailOf (ยอดสินค้า ส่วนลด ต้นทุน ภาษี ช่องจ่ายหลังทอน สมาชิก) และ bill = logic.plainDoc (เวลาเป็น ISO) ให้จอเปิดใบเสร็จ
//   เพดานต่อหน้าเท่าเดิม (pageSize ≤ 200) · เว็บไล่ cursor เอง
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and dateTime in (start, upTo] order by dateTime desc limit · เขียน: ไม่มี
"use strict";

const { ReportBillListRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, freeWindowGate, billsByTime } = require("./_reportShared");

const DEFAULT_PAGE = 50;
const TIE_SLACK = 50;
const LIST_FIELDS = Object.freeze([
  "shopId", "dateTime", "soldAt", "receiptNumber", "orderId", "moneyMustPaid", "totalPrice", "discount", "eyosDiscount",
  "cashierName", "posId", "payment", "paymentType", "void", "voidStaff", "reason", "taxNumber", "offlineSync",
  "shiftUnassigned", "amendOf", "amendedBy",
]);

const timeOf = (data) => {
  const m = logic.toMillis(data && data.dateTime);
  return m === null ? -Infinity : m;
};

function billList(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportBillListRequest, { rights: [RIGHT.BILL_HISTORY, RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef, keys } = ctx;
      const range = logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay, cutOff: shop.cutOff });
      if (!range.ok) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "toDay", message: range.reason }] });
      if (!(await freeWindowGate(deps, shop, input.fromDay, res))) return res;
      const pageSize = input.pageSize || DEFAULT_PAGE;
      const head = { ...adminFlag(access), fromDay: range.fromKey, toDay: range.toKey, start: range.start.toISOString(), end: range.end.toISOString() };

      let upTo = range.end;
      let cur = null;
      if (input.cursor) {
        cur = { ms: Date.parse(input.cursor.at), id: input.cursor.id };
        if (cur.ms <= range.start.getTime()) return ok(res, { ...head, rows: [], nextCursor: null });
        if (cur.ms < upTo.getTime()) upTo = new Date(cur.ms);
      }
      const detail = input.detail === true;
      const entries = await billsByTime({ keys, shopRef, after: range.start, upTo, fields: detail ? undefined : LIST_FIELDS, limit: pageSize + 1 + TIE_SLACK });
      let list = entries
        .map((e) => ({ e, t: timeOf(e.data) }))
        .sort((a, b) => (b.t - a.t) || (a.e.id < b.e.id ? 1 : a.e.id > b.e.id ? -1 : 0));
      if (cur) list = list.filter(({ e, t }) => t < cur.ms || (t === cur.ms && e.id < cur.id));
      const page = list.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor = list.length > pageSize && last && Number.isFinite(last.t) ? { at: new Date(last.t).toISOString(), id: last.e.id } : null;
      return ok(res, {
        ...head,
        rows: page.map(({ e }) => (detail
          ? { ...logic.reportBillRow(e.id, e.data, shop.cutOff), detail: logic.billDetailOf(e.data), bill: logic.plainDoc(e.data) }
          : logic.reportBillRow(e.id, e.data, shop.cutOff))),
        nextCursor,
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { billList, LIST_FIELDS };

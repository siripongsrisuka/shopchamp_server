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
//   cursor = {at: dateTime ของแถวสุดท้าย, id} (รูปเดิม · เว็บเจ้าของร้านส่งค่า nextCursor กลับมาตรง ๆ ไม่ต้องแก้)
//   DEV-0010 (Pack เคาะคิวข้อ 4 · 2026-11-14): เลิก TIE_SLACK · ค้น orderBy dateTime desc, __name__ desc + startAfter(at, id)
//     limit pageSize+1 ต่อ key (+1 = รู้ว่ามีหน้าต่อ) ⇒ บิลเวลาเท่ากันข้ามรอยต่อหน้าไม่หาย ไม่ซ้ำ ไม่ว่าจะชนกันกี่ใบ
//     ยังคง dateTime <= at ในคำค้น (ซ้ำกับ startAfter · ไม่เปลี่ยนผล) และตัดแถวที่ไม่อยู่หลัง cursor ในหน่วยความจำ (กันฐานปลอมที่ไม่ดู startAfter)
//     ❓ dateTime ละเอียดกว่ามิลลิวินาที (cursor เป็น ISO ระดับ ms) = เวลาในช่วงเศษ ms เดียวกันอาจข้ามได้ · บิลที่แอป/server เขียนเป็น Date ระดับ ms
// แถวมีเลขใบของลิงก์แก้บิล (DEV-0010 · จอประวัติบิลแสดง "แก้ไขจากใบ <เลข>" / "แก้ไข → ใบ <เลข>" · amendLinksOf ของแอป)
//   amendOfNumber = amend.ofReceiptNumber เมื่อมี amendOf · amendedByNumber = amend.newReceiptNumber เมื่อมี amendedBy · ไม่มี = null
//   select เฉพาะ 2 ช่องย่อยของ amend (ไม่ส่งก้อน amend ทั้งก้อน)
// detail:true (DEV-0002 · จอ 4.1 ข้อมูลใบเสร็จ · 4.3 รายงานภาษี · 1.2 รายวันแบบรายบิล ของเว็บ): อ่านเอกสารเต็ม (ไม่ select)
//   แถวมี detail = logic.billDetailOf (ยอดสินค้า ส่วนลด ต้นทุน ภาษี ช่องจ่ายหลังทอน สมาชิก) และ bill = logic.plainDoc (เวลาเป็น ISO) ให้จอเปิดใบเสร็จ
//   เพดานต่อหน้าเท่าเดิม (pageSize ≤ 200) · เว็บไล่ cursor เอง
// Firestore อ่าน: shop/{shopId} · bill where shopId == key and dateTime in (start, upTo] order by dateTime desc, __name__ desc [startAfter(at, id)] limit pageSize+1 · เขียน: ไม่มี
"use strict";

const { ReportBillListRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, freeWindowGate, billsByTime } = require("./_reportShared");

const DEFAULT_PAGE = 50;
const LIST_FIELDS = Object.freeze([
  "shopId", "dateTime", "soldAt", "receiptNumber", "orderId", "moneyMustPaid", "totalPrice", "discount", "eyosDiscount",
  "cashierName", "posId", "payment", "paymentType", "void", "voidStaff", "reason", "taxNumber", "offlineSync",
  "shiftUnassigned", "amendOf", "amendedBy", "amend.ofReceiptNumber", "amend.newReceiptNumber",
]);

const str = (v) => (typeof v === "string" && v !== "" ? v : null);
/** เลขใบของลิงก์แก้บิล 2 ทาง (ตามเงื่อนไขเดียวกับ amendLinksOf ของแอป) */
function amendNumbersOf(data) {
  const b = data && typeof data === "object" ? data : {};
  const a = b.amend && typeof b.amend === "object" ? b.amend : {};
  return {
    amendOfNumber: str(b.amendOf) ? str(a.ofReceiptNumber) : null,
    amendedByNumber: str(b.amendedBy) ? str(a.newReceiptNumber) : null,
  };
}

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
      const entries = await billsByTime({
        keys, shopRef, after: range.start, upTo, fields: detail ? undefined : LIST_FIELDS, limit: pageSize + 1,
        byId: true, startAfter: cur ? { at: new Date(cur.ms), id: cur.id } : undefined,
      });
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
          ? { ...logic.reportBillRow(e.id, e.data, shop.cutOff), ...amendNumbersOf(e.data), detail: logic.billDetailOf(e.data), bill: logic.plainDoc(e.data) }
          : { ...logic.reportBillRow(e.id, e.data, shop.cutOff), ...amendNumbersOf(e.data) })),
        nextCursor,
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { billList, LIST_FIELDS, amendNumbersOf };

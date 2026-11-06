// pos/shopStaff/expenseReportManage — เพิ่ม แก้ ลบ แถวค่าใช้จ่ายในรายงานเดือน ใน transaction (ก้อน 9c · DEV-0001)
//
// สัญญา: shopchamp-center/api/expenseReport.manage.yaml · คำขอ ExpenseReportManageRequest (@shopchamp/schema › requests/shopStaff.ts)
// แทน `app:screens/ExpenseReportScreen.js:107-131` (สร้าง doc เดือนตอนแค่กดดู · DI-18) + `app:screens/ExpenseReportDetail.js:117-172`
//
// ลำดับ: callerAccess → schema → สิทธิ์ '131' บันทึกค่าใช้จ่าย (`app:screens/HomeScreen.js:75,188`) → 403 right_required
//   เดือนต้องอยู่ในรายการที่จอเลือกได้ (เดือนนี้ + ย้อน 5 เดือน ตามนาฬิกาไทยของ server · logic.expenseMonthInWindow · F114) → 409 month_out_of_range
//   tx: shop · expenseReport/{field ร้าน + month} · expense/{expenseId} (op add) · profile/{uid} (ชื่อคนบันทึก)
//     ร้านไม่มี 404 · ผู้เรียกไม่ active 403 · พรีเมี่ยมหมด 403 premium_required (แอปเก่าปัดที่ `HomeScreen.js:82,532`)
//     doc เดือนเป็นของร้านอื่น 409 expense_report_other_shop · expenses ไม่ใช่ array 409 expense_report_invalid (DI-80 · ไม่เดาแทน)
//   add   : หัวข้อไม่มี 404 expense_not_found · ร้านอื่น 409 expense_other_shop
//           rowId เดิม หัวข้อและยอดเดิม = 200 duplicate · ต่างกัน = 409 row_id_conflict
//           แถวรูปเดิม {id: rowId, expenseId, expenseName, expenseCategory (แช่จากหัวข้อในฐาน), price, note, createdby: ชื่อจาก profile, timestamp: now}
//             + ใหม่ createdByUid · ไม่มี doc เดือน = สร้างตอนเพิ่มแถวแรก {id, shopId, month, name: ป้ายเดือนรูปเดิม, timestamp, expenses, totalExpense:0}
//   update: ไม่มี doc 404 expense_report_not_found · ไม่มีแถว 404 row_not_found · แก้ price/note + updatedAt updatedBy updatedByUid (B8)
//   delete: ไม่มี doc/แถว = 200 deleted:false · ลบแถวแล้วเก็บร่องรอยใน `deleted[]` {...แถว, deletedAt, deletedBy, deletedByUid} (B8 · แอปเก่าไม่อ่าน)
// คำตอบมีสรุปยอดรายหัวข้อของเดือน (logic.summarizeExpenses) ให้จอแสดงได้ทันที
"use strict";

const { db } = require("../../firebase");
const { ExpenseReportManageRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, checkOwnedDoc, belongsToShop } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { isObj, Refusal, refuse, callerStillActive, displayName } = require("./common");

const EXPENSE_RIGHT = "131";

function expenseReportManage(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(ExpenseReportManageRequest, body, res);
      if (!input) return;
      if (!hasRight(access, EXPENSE_RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      if (!logic.expenseMonthInWindow(input.month, now)) return sendDeny(res, deny(409, "month_out_of_range", "บันทึกได้เฉพาะเดือนนี้และย้อนหลัง 5 เดือน"));
      const shopDocId = access.shopId;
      const shopRef = db.collection("shop").doc(shopDocId);
      const profileRef = db.collection("profile").doc(access.uid);
      const expRef = input.op === "add" ? db.collection("expense").doc(input.expenseId) : null;
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(shopRef);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);
        if (!isPremiumActive(shop, now)) refuse(deny(403, "premium_required"));
        const ref = await resolveShopRef({ db, shopDocId, shop });
        const shopField = ref.shopId || shopDocId;
        const reportId = `${shopField}${input.month}`;
        const reportRef = db.collection("expenseReport").doc(reportId);
        const [reportSnap, expSnap, profileSnap] = await Promise.all([
          tx.get(reportRef),
          expRef ? tx.get(expRef) : Promise.resolve(null),
          tx.get(profileRef),
        ]);
        const report = reportSnap.exists ? reportSnap.data() || {} : null;
        if (report) {
          if (!belongsToShop(report.shopId, ref) || (report.month !== undefined && report.month !== input.month)) refuse(deny(409, "expense_report_other_shop"));
          if (!Array.isArray(report.expenses)) refuse(deny(409, "expense_report_invalid", "รายงานเดือนนี้ข้อมูลเสีย กรุณาติดต่อทีมงาน"));
        }
        const rows = report ? report.expenses : [];
        const who = displayName(profileSnap.exists ? profileSnap.data() : null, "");
        const idx = rows.findIndex((r) => isObj(r) && r.id === input.rowId);
        let nextRows = rows;

        if (input.op === "add") {
          if (idx >= 0) {
            const r = rows[idx];
            if (r.expenseId === input.expenseId && String(r.price) === input.price) return { reportId, duplicate: true, rows };
            refuse(deny(409, "row_id_conflict", "รหัสแถวนี้ถูกใช้กับรายการอื่นแล้ว"));
          }
          const exp = expSnap && expSnap.exists ? expSnap.data() : undefined;
          const c = checkOwnedDoc("expense", exp, ref);
          if (!c.ok) refuse(c);
          const row = {
            id: input.rowId,
            expenseId: input.expenseId,
            expenseName: typeof exp.name === "string" ? exp.name : "",
            expenseCategory: Array.isArray(exp.category) ? exp.category : [],
            price: input.price,
            note: input.note,
            createdby: who,
            timestamp: now,
            createdByUid: access.uid,
            ...trail,
          };
          nextRows = [...rows, row];
          if (report) tx.update(reportRef, { expenses: nextRows });
          else tx.set(reportRef, { id: reportId, shopId: shopField, month: input.month, name: logic.expenseMonthLabel(input.month), timestamp: now, expenses: nextRows, totalExpense: 0, ...trail });
          return { reportId, duplicate: false, created: !report, rows: nextRows };
        }
        if (input.op === "update") {
          if (!report) refuse(deny(404, "expense_report_not_found"));
          if (idx < 0) refuse(deny(404, "row_not_found", "ไม่พบรายการ อาจถูกลบจากเครื่องอื่น"));
          const patch = { updatedAt: now, updatedBy: who, updatedByUid: access.uid };
          if (input.price !== undefined) patch.price = input.price;
          if (input.note !== undefined) patch.note = input.note;
          nextRows = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
          tx.update(reportRef, { expenses: nextRows });
          return { reportId, rows: nextRows };
        }
        // delete
        if (!report || idx < 0) return { reportId, deleted: false, rows };
        nextRows = rows.filter((_, i) => i !== idx);
        const gone = { ...rows[idx], deletedAt: now, deletedBy: who, deletedByUid: access.uid, ...trail };
        tx.update(reportRef, { expenses: nextRows, deleted: [...(Array.isArray(report.deleted) ? report.deleted : []), gone] });
        return { reportId, deleted: true, rows: nextRows };
      });

      const { rows, ...rest } = out;
      return ok(res, { op: input.op, month: input.month, rowId: input.rowId, ...rest, summary: logic.summarizeExpenses(rows), ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { expenseReportManage };

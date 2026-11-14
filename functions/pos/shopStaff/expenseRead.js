// pos/shopStaff/expenseRead — อ่านหัวข้อค่าใช้จ่าย และรายงานค่าใช้จ่ายรายเดือน (DEV-0010 คลื่น 2 · อ่านอย่างเดียว)
//
// expenseList (expense.list · POST /pos/expense/list): แทน fetchExpense `shopchamp_app/src/redux/expenseSlice.js:31`
//   ของเดิม: expense where shopId == shop.shopId (ไม่มี orderBy/limit)
//   ใหม่:    expense where shopId == K select(name category price priceStatus timestamp) · เรียง doc id (ลำดับเดียวกับ Firestore คืนให้แอปเดิม)
//   คำตอบ {ok, items:[{id, name, category, price, priceStatus, timestamp(ISO)}], byAdmin?}
//   สิทธิ์ '101' (จอรายการค่าใช้จ่ายใต้ตั้งค่า → ขั้นสูง `AdvanceScreen.js:31`) หรือ '131' (จอบันทึกค่าใช้จ่ายเลือกหัวข้อ
//     `ExpenseReportDetail.js:119` · เมนู `HomeScreen.js:98`) → ไม่มีทั้งคู่ 403 right_required
//
// expenseReportList (expenseReport.list · POST /pos/expense-report/list): แทน fetchExpenseReport `expenseSlice.js:17` + `ExpenseReportScreen.js:112`
//   ของเดิม: expenseReport where shopId == shop.shopId orderBy month desc (ไม่มี limit = ทุกเดือนตั้งแต่เปิดร้าน · จอใช้ 6 เดือน `ExpenseReportScreen.js:24,79`)
//   ไม่ส่ง month: expenseReport where shopId == K and month >= <เดือนเก่าสุดของ 6> and month <= <เดือนนี้> orderBy month desc
//     (6 เดือน = logic.expenseMonthKeys ตามนาฬิกาไทยของ server ตัวเดียวกับเส้นเขียน · index shopId ASC, month DESC มีใน firestore.indexes.json)
//   ส่ง month: expenseReport/{K + month} doc เดียว (id รูปเดียวกับแอปเดิม `ExpenseReportScreen.js:95` และเส้นเขียน) · ช่อง shopId ≠ K = ไม่คืน
//   คำตอบ {ok, months:[YYYYMM 6 ตัว ใหม่ก่อน] (ไม่ส่ง month), reports:[{id, month, name, expenses[] (เวลาเป็น ISO)}] เรียงเดือนใหม่ก่อน, byAdmin?}
//     ตัด deleted[] updatedBy* totalExpense timestamp ระดับ doc (จอไม่อ่าน) · เดือนที่ยังไม่มี doc = ไม่อยู่ใน reports (จอเติมเดือนว่างเองแบบเดิม)
//   สิทธิ์ '131' บันทึกค่าใช้จ่าย (`HomeScreen.js:98`) → 403 right_required
//
// ทั้ง 2 เส้น: แพ็กเกจพรีเมี่ยมหมด = 403 premium_required (แอปปัดที่เมนู `HomeScreen.js:107,474` และ `AdvanceScreen.js:32,65` · Pack 2026-11-14 ข้อ 9)
// K = ช่อง shopId ของ doc ร้านที่ผู้เรียกผ่านด่านแล้ว (ไม่มี/ไม่ใช่สตริง = doc id) · แบบแอปเดิม (Pack 2026-11-14 ข้อ 8)
// ด่าน: middleware requireShopAccess (สมาชิกร้าน active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน · ได้ทุกสิทธิ์แบบเจ้าของ)
// ค่าอ่าน: shop 1 + doc ที่ได้ · expense เท่าเดิม · expenseReport ≤ 6 (เดิมทุกเดือน) / 1
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { isObj, toIsoDeep } = require("./common");

const SETTINGS_RIGHT = "101";
const EXPENSE_RIGHT = "131";
const EXPENSE_FIELDS = Object.freeze(["name", "category", "price", "priceStatus", "timestamp"]);
const REPORT_FIELDS = Object.freeze(["month", "name", "expenses", "shopId"]);

function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

/** shopKey(shopDocId, shop) — ค่าที่ใช้ค้น `<doc>.shopId` แบบแอปเดิม: ช่อง shopId ของร้าน · ไม่มี = doc id */
function shopKey(shopDocId, shop) {
  return typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : shopDocId;
}

/** gate + schema + อ่านร้าน + พรีเมี่ยม → {access, input, shop, now} · ไม่ผ่าน = ตอบไปแล้ว คืน null */
async function open(req, res, deps, schemaName, rightOk) {
  const body = isObj(req && req.body) ? req.body : {};
  const gate = callerAccess(req, body.shopId, { read: true });
  if (!gate.ok) { sendDeny(res, gate); return null; }
  const access = gate.access;
  const input = parseOr400(schemaOf(schemaName), body, res);
  if (!input) return null;
  if (!rightOk(access)) { sendDeny(res, deny(403, "right_required")); return null; }
  const now = await readNow(deps);
  const snap = await db.collection("shop").doc(access.shopId).get();
  if (!snap.exists) { sendDeny(res, deny(404, "shop_not_found")); return null; }
  const shop = snap.data() || {};
  if (!isPremiumActive(shop, now)) { sendDeny(res, deny(403, "premium_required", "ฟีเจอร์ สำหรับแพ็กเกจพรีเมี่ยม")); return null; }
  return { access, input, shop, now };
}

function expenseList(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, deps, "ExpenseListRequest", (a) => hasRight(a, SETTINGS_RIGHT) || hasRight(a, EXPENSE_RIGHT));
      if (!o) return;
      const key = shopKey(o.access.shopId, o.shop);
      const snap = await db.collection("expense").where("shopId", "==", key).select(...EXPENSE_FIELDS, "shopId").get();
      const items = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.shopId === key)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => {
          const it = { id: r.id };
          for (const k of EXPENSE_FIELDS) it[k] = r.d[k] === undefined ? null : toIsoDeep(r.d[k]);
          return it;
        });
      return ok(res, { ...adminFlag(o.access), items });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function reportOf(id, d) {
  return { id, month: d.month === undefined ? null : d.month, name: d.name === undefined ? null : d.name, expenses: Array.isArray(d.expenses) ? toIsoDeep(d.expenses) : [] };
}

function expenseReportList(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, deps, "ExpenseReportListRequest", (a) => hasRight(a, EXPENSE_RIGHT));
      if (!o) return;
      const key = shopKey(o.access.shopId, o.shop);

      if (o.input.month !== undefined) {
        const id = `${key}${o.input.month}`;
        const snap = await db.collection("expenseReport").doc(id).get();
        const d = snap.exists ? snap.data() || {} : null;
        const reports = d && d.shopId === key ? [reportOf(id, d)] : [];
        return ok(res, { ...adminFlag(o.access), reports });
      }

      const mk = logic.expenseMonthKeys(o.now, 6);
      if (!mk.ok) throw new Error(`expenseMonthKeys: ${mk.reason}`);
      const months = mk.keys;
      const newest = months[0];
      const oldest = months[months.length - 1];
      const snap = await db.collection("expenseReport").where("shopId", "==", key)
        .where("month", ">=", oldest).where("month", "<=", newest).orderBy("month", "desc").select(...REPORT_FIELDS).get();
      // กรองซ้ำในโค้ด: ฐานจริงกรอง/เรียงแล้ว (ไม่มีผล) · กันฐานที่ไม่กรองช่วง/ไม่เรียงให้ (harness)
      const want = new Set(months);
      const reports = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.shopId === key && want.has(r.d.month))
        .sort((a, b) => (a.d.month < b.d.month ? 1 : a.d.month > b.d.month ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((r) => reportOf(r.id, r.d));
      return ok(res, { ...adminFlag(o.access), months, reports });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { expenseList, expenseReportList, shopKey };

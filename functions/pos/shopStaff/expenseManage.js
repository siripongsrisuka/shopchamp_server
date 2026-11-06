// pos/shopStaff/expenseManage — สร้าง แก้ ลบ หัวข้อค่าใช้จ่ายของร้าน ใน transaction (ก้อน 9c · DEV-0001)
//
// สัญญา: shopchamp-center/api/expense.manage.yaml · คำขอ ExpenseManageRequest (@shopchamp/schema › requests/shopStaff.ts)
// แทน `app:redux/expenseSlice.js:44-72` + `app:screens/ExpenseScreen.js:92-135` (แก้ลบด้วย doc id ล้วน ไม่ดูร้าน B7 · เขียนทุกช่องจากสำเนาเก่า DI-50)
//
// ลำดับ: callerAccess → schema → สิทธิ์ '101' (จออยู่ใต้ตั้งค่า → ขั้นสูง `app:screens/AdvanceScreen.js:31`) → 403 right_required
//   tx: shop · expense/{expenseId} · ร้านไม่มี 404 · ผู้เรียกไม่ active 403 · แพ็กเกจพรีเมี่ยมหมด 403 premium_required (แอปเก่าปัดที่ `AdvanceScreen.js:62`)
//   create: doc id = expenseId จากแอป (กดซ้ำได้ใบเดิม · B13) · มีแล้วของร้านนี้ = 200 duplicate · ของร้านอื่น = 409 expense_other_shop
//           หมวดที่ไม่มีใน shop.categoryExpense = 409 category_not_found (B9)
//           เขียนรูปเดิม {id:'', name, timestamp: now, category, price, priceStatus, shopId: field ร้าน} · ปิดล็อคยอด = price '' (B14)
//   update: ไม่มี 404 expense_not_found · ร้านอื่น 409 · แก้เฉพาะช่องที่ส่ง (DI-50) + updatedAt updatedBy · ผลสุดท้ายปิดล็อค = price ''
//   delete: ไม่มี = 200 deleted:false (ส่งซ้ำได้) · ร้านอื่น 409 · ลบ doc (แถวในรายงานเดือนเก็บชื่อแช่ไว้แล้ว ไม่กระทบ)
// shopId ที่เขียน = field shop.shopId ที่พิสูจน์แล้ว (แอปเก่าค้นด้วยค่านี้ `expenseSlice.js:30`) · พิสูจน์ไม่ได้ = doc id
"use strict";

const { db } = require("../../firebase");
const { ExpenseManageRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, checkOwnedDoc, belongsToShop } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { isObj, Refusal, refuse, callerStillActive } = require("./common");

const SETTINGS_RIGHT = "101";

/** categoryIdsOf(shop) — id หมวดค่าใช้จ่ายทุกระดับ */
function categoryIdsOf(shop) {
  const ids = new Set();
  for (const lv of Array.isArray(shop.categoryExpense) ? shop.categoryExpense : []) {
    for (const it of isObj(lv) && Array.isArray(lv.value) ? lv.value : []) if (isObj(it) && typeof it.id === "string") ids.add(it.id);
  }
  return ids;
}

function expenseManage(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(ExpenseManageRequest, body, res);
      if (!input) return;
      if (!hasRight(access, SETTINGS_RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const shopDocId = access.shopId;
      const shopRef = db.collection("shop").doc(shopDocId);
      const expRef = db.collection("expense").doc(input.expenseId);
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, expSnap] = await Promise.all([tx.get(shopRef), tx.get(expRef)]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);
        if (!isPremiumActive(shop, now)) refuse(deny(403, "premium_required"));
        const ref = await resolveShopRef({ db, shopDocId, shop });
        const exp = expSnap.exists ? expSnap.data() : undefined;
        const checkCategory = (cat) => {
          if (cat === undefined) return;
          const ids = categoryIdsOf(shop);
          const missing = cat.filter((id) => !ids.has(id));
          if (missing.length) refuse(deny(409, "category_not_found", "ไม่พบหมวดค่าใช้จ่ายที่เลือก อาจถูกลบไปแล้ว", { missing }));
        };

        if (input.op === "create") {
          if (exp !== undefined) {
            if (!belongsToShop(exp.shopId, ref)) refuse(deny(409, "expense_other_shop"));
            return { duplicate: true };
          }
          checkCategory(input.category);
          tx.set(expRef, {
            id: "",
            name: input.name,
            timestamp: now,
            category: input.category,
            price: input.priceStatus ? input.price : "",
            priceStatus: input.priceStatus,
            shopId: ref.shopId || shopDocId,
            ...trail,
          });
          return { duplicate: false };
        }
        if (input.op === "update") {
          const c = checkOwnedDoc("expense", exp, ref);
          if (!c.ok) refuse(c);
          checkCategory(input.category);
          const patch = {};
          for (const k of ["name", "category", "priceStatus", "price"]) if (input[k] !== undefined) patch[k] = input[k];
          const finalStatus = patch.priceStatus !== undefined ? patch.priceStatus : exp.priceStatus === true;
          if (!finalStatus) patch.price = "";
          else if (patch.price === "" || (patch.price === undefined && (exp.price === undefined || exp.price === ""))) {
            refuse(deny(400, "invalid_request", "เปิดล็อคยอดต้องใส่ยอด", { issues: [{ path: "price", message: "เปิดล็อคยอดต้องใส่ยอด (B4)" }] }));
          }
          tx.update(expRef, { ...patch, updatedAt: now, updatedBy: access.uid, ...trail });
          return { updated: Object.keys(patch) };
        }
        // delete
        if (exp === undefined) return { deleted: false };
        if (!belongsToShop(exp.shopId, ref)) refuse(deny(409, "expense_other_shop"));
        tx.delete(expRef);
        return { deleted: true };
      });

      return ok(res, { op: input.op, expenseId: input.expenseId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { expenseManage };

// pos/sale/get — ดึงบิล 1 ใบ (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.get.yaml · ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: ไม่มี
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับ: ไม่มี req.shopAccess 401 → body ผิด schema 400 → body.shopId ≠ ร้านที่ผ่านด่าน 403
//        → อ่าน shop + bill พร้อมกัน (อ่านอย่างเดียว ไม่มีการเขียน) → 404 bill_not_found / 409 bill_other_shop
//        → 200 {bill:{id, ...field · เวลาเป็น ISO}, shape, canVoid}
// อ่าน shop ด้วยเพื่อรู้ field shop.shopId: ร้านเก่า doc id ≠ shopId ได้ (schema/shop.md S5) และบิลอาจเก็บค่าแบบใดแบบหนึ่ง
//   ⇒ resolveShopRef พิสูจน์ field ก่อน (ค่าต้องผูกกับร้านนี้ร้านเดียว) แล้ว belongsToShop รับทั้ง 2 ค่า · ไม่อ่าน shop = บิลของร้านเก่าจะได้ 409 ผิด
// shape: Bill → current · BillLegacyV1 → legacyV1 · ไม่ผ่านทั้งคู่ → unknown (log issues ไม่ปัด)
// canVoid: shape current และยังไม่ยกเลิก (logic.isVoidedBill) · บิลรุ่นแรกดูได้อย่างเดียว (decision 2026-11-06)
"use strict";

const { db } = require("../../firebase");
const { Bill, BillLegacyV1, SaleGetRequest } = require("@shopchamp/schema");
const { isVoidedBill } = require("@shopchamp/logic");
const { ok, fail, sendDeny, parseOr400, internalError, zodIssues } = require("../_shared/respond");
const { callerAccess, resolveShopRef, checkOwnedDoc, adminFlag } = require("../_shared/auth");
const { toClientJson } = require("./getSerialize");

/** shapeOf(data) → {shape, issues?} · ไม่ throw */
function shapeOf(data) {
  const cur = Bill.safeParse(data);
  if (cur.success) return { shape: "current" };
  const legacy = BillLegacyV1.safeParse(data);
  if (legacy.success) return { shape: "legacyV1" };
  return { shape: "unknown", issues: { current: zodIssues(cur.error), legacyV1: zodIssues(legacy.error) } };
}

function get(deps) { // eslint-disable-line no-unused-vars
  const log = console.warn;
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};
    const gate = callerAccess(req, body.shopId, { read: true }); // อ่านอย่างเดียว ⇒ watcher ผ่าน
    if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
    const input = parseOr400(SaleGetRequest, body, res);
    if (input === null) return res;
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;

    try {
      const [shopSnap, billSnap] = await Promise.all([
        db.collection("shop").doc(access.shopId).get(),
        db.collection("bill").doc(input.billId).get(),
      ]);
      if (!shopSnap.exists) return fail(res, 404, "shop_not_found");
      const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() });

      const data = billSnap.exists ? billSnap.data() : undefined;
      const owned = checkOwnedDoc("bill", data, shopRef);
      if (!owned.ok) return sendDeny(res, owned);

      const { shape, issues } = shapeOf(data);
      if (shape === "unknown") log("pos/sale/get: บิลไม่ตรงรูปที่รู้จัก", JSON.stringify({ billId: input.billId, issues }));
      const canVoid = shape === "current" && !isVoidedBill(data);

      return ok(res, {
        ...adminFlag(access),
        bill: { ...toClientJson(data), id: input.billId },
        shape,
        canVoid,
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { get, shapeOf };

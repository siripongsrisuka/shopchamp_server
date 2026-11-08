// pos/stock/requisition — เบิกสินค้าใช้ในร้าน: ใบ `requisition` + ตัดคงเหลือ + แจ้งเตือน (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.requisition.yaml · คำขอ StockRequisitionRequest
// ทางเดิม: `main3:src/screens/RequisitionScreen.js:126-200` submit
//
// ลำดับ:
//   1. callerAccess → schema (จำนวนว่าง/0 ปัด ST-044) → สิทธิ์ '132' (403 right_required)
//   2. transaction อ่านครบก่อนเขียน: shop · requisition/{requisitionUUID} · stock ทุกแถว · สมาชิกกลุ่มผูก
//      แพ็กเกจพรีเมี่ยมหมด 403 premium_required (เมนูเดิม premium:true · HomeScreen.js:76) · ตรวจที่ server ไม่เชื่อแอป
//      UUID เดิมของร้านนี้ = 200 duplicate ไม่ตัดซ้ำ (ST-055) · ร้านอื่น 409 requisition_uuid_other_shop
//      คนเบิกไม่อยู่/ไม่ active 409 (B-11) · สินค้าไม่มี 404 (ST-122 บอกตัวไหน) · ร้านอื่น 409 stock_other_shop (#10 ST-001) · ลบแล้ว 409 (ST-056)
//   3. แผนตัด = logic.planStockDeduction(แถวจากค่าในฐาน ST-105, {requirePositiveQty}) · ตัวคูณพังไม่ throw แจ้ง issues (ST-120)
//   4. เขียน: stock {stock, updateTime} (รูปเดิม `:177-182`) · เบิกเกินคงเหลือได้เหมือนเดิม (ST-140 คงเดิม)
//      requisition/{uuid}: รูปเดิม `:131-139` {shopId, timestamp, profileName, profileId, currentCarts:[{name,id,qty,cost,totalCost,unit}], billDate, reason}
//        cost/name/unit จากฐาน · totalCost = logic.requisitionLineCost (ไม่รู้ทุน = null · ST-118 ST-119)
//        + ใหม่ {requisitionUUID, moves:[{id, qty}]} = ตัวที่ถูกตัดจริง (ST-010 เตรียมไว้ให้ยกเลิกได้ภายหลัง · ยังไม่มี endpoint ยกเลิก)
//      notification: รูปเดิม `:185-191` {heading:'เบิกสินค้า', shopId, notificationContent, categoryId:7, timestamp}
//   push (DEV-0001 push): หลัง commit FCM หา shop.notiRequisition ในร้านนี้ (แทน pushByTwoFilter `APP/src/screens/RequisitionScreen.js:152`) · duplicate = ไม่ส่ง
//   stock updateTime = serverTimestamp() (DEV-0007 · ../_shared/stockJournal.js ①) · สมุด stockJournal kind 'requisition' ใน tx เดียวกัน (duplicate ไม่ถึงจุดเขียน)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { billDateOf } = require("../_shared/billClock");
const S = require("./_shared");
const { serverTime, makeJournal } = require("../_shared/stockJournal");
const { notify, idsOf } = require("../_shared/push/notify");

const NOTI_HEADING = "เบิกสินค้า";
const NOTI_CATEGORY = 7;

/** ข้อความแจ้งเตือนรูปเดิม `RequisitionScreen.js:150` */
function notificationContentOf(reason, carts) {
  return `เหตุผล ${reason}  \nรายการที่เบิก \n${carts.map((a, i) => `${i + 1}. ${a.name} x ${a.qty}`).join(`\n`)}  `;
}

function requisition(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockRequisitionRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.REQUISITION)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const shopRef = db.collection("shop").doc(access.shopId);
      const reqRef = db.collection("requisition").doc(input.requisitionUUID);
      const notiRef = db.collection("notification").doc();

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, reqSnap] = await Promise.all([tx.get(shopRef), tx.get(reqRef)]);
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        if (reqSnap.exists) {
          const prev = reqSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) S.refuse(409, "requisition_uuid_other_shop", "รหัสใบเบิกนี้เป็นของร้านอื่น");
          return { duplicate: true };
        }
        if (!isPremiumActive(shop, now)) S.refuse(403, "premium_required");
        S.requireActiveStaff(shop, input.staffId, access);

        const docs = await S.readStockDocs(db, tx, input.lines.map((l) => l.id), ref);
        const lines = input.lines.map((l) => {
          const d = docs.get(l.id);
          return { id: l.id, qty: l.qty, stockCountStatus: d.stockCountStatus, linkMultiply: d.linkMultiply, linkDetail: d.linkDetail };
        });
        const plan = logic.planStockDeduction(lines, { requirePositiveQty: true });
        await S.readStockDocs(db, tx, plan.moves.map((m) => m.id), ref, { into: docs });

        const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff });
        for (const mv of plan.moves) {
          const d = docs.get(mv.id);
          const next = logic.stockAfterMove(d.stock, -mv.qty);
          tx.update(db.collection("stock").doc(mv.id), { stock: next, updateTime: serverTime(), ...trail });
          journal.move("requisition", mv.id, d.stock, next);
        }
        journal.write(tx, db, trail);
        const currentCarts = input.lines.map((l) => {
          const d = docs.get(l.id);
          const cost = S.num(d.cost);
          return {
            name: typeof d.name === "string" ? d.name : String(d.name === undefined ? "" : d.name),
            id: l.id,
            qty: l.qty,
            cost,
            totalCost: logic.requisitionLineCost(l.qty, d.cost),
            unit: typeof d.unit === "string" ? d.unit : "",
          };
        });
        const shopField = ref.shopId || access.shopId;
        tx.set(reqRef, {
          shopId: shopField,
          timestamp: now,
          profileName: input.staffName,
          profileId: input.staffId,
          currentCarts,
          billDate: billDateOf(now),
          reason: input.reason,
          requisitionUUID: input.requisitionUUID,
          moves: plan.moves,
          ...trail,
        });
        const notiContent = notificationContentOf(input.reason, currentCarts);
        tx.set(notiRef, {
          heading: NOTI_HEADING,
          shopId: shopField,
          notificationContent: notiContent,
          categoryId: NOTI_CATEGORY,
          timestamp: now,
          staffName: input.staffName,
          ...trail,
        });
        const push = { to: { kind: "staff", shopId: access.shopId, ids: idsOf(shop.notiRequisition) }, heading: NOTI_HEADING, content: notiContent, data: { screen: "HomeScreen" } };
        return { duplicate: false, moves: plan.moves, issues: plan.issues, push };
      });

      if (out.duplicate) return ok(res, { requisitionId: input.requisitionUUID, duplicate: true, ...adminFlag(access) });
      await notify(deps, out.push);
      const resBody = { requisitionId: input.requisitionUUID, duplicate: false, moves: out.moves, ...adminFlag(access) };
      if (out.issues.length) resBody.issues = out.issues;
      return ok(res, resBody);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { requisition, notificationContentOf };

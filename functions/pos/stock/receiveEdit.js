// pos/stock/receiveEdit — แก้จำนวน/ต้นทุน 1 แถวของใบรับสินค้า แล้วปรับคงเหลือและต้นทุนเฉลี่ย (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.receiveEdit.yaml · คำขอ StockReceiveEditRequest
// ทางเดิม: `main3:src/screens/ImportProductDetail.js:228-327` submit · เว็บ `own:modal/Modal_Inbound.js` (ยังเขียนตรงต่อ)
//
// ลำดับ:
//   1. callerAccess → schema → สิทธิ์ '115' รับสินค้า
//   2. transaction อ่านครบก่อนเขียน: shop · importProduct/{importId} (อ่านในรอบเดียวกัน ST-025 · เดิมใช้ค่าจาก state)
//      ใบไม่มี 404 import_product_not_found · ร้านอื่น 409 import_product_other_shop
//      แถว lineIndex ไม่มี 409 receive_line_missing · ค่าแถวในฐานไม่ตรงที่จอเห็น (expect) 409 receive_line_changed {current}
//        (ST-026 ST-027 tempId สุ่มใหม่/ทับทั้งใบ ⇒ ใช้ตำแหน่ง + ค่าที่เห็น)
//      แถวในฐาน = ค่าใหม่แล้ว (ค่าเท่าเดิม ST-091 · ส่งซ้ำหลังสำเร็จ) = 200 unchanged ไม่เขียน · เช็คก่อน expect (ผลตรวจ W4)
//      stock ของแถว + สมาชิกกลุ่ม (อ่านสดทุกรอบ ST-024) · ไม่มี 404 stock_not_found (ST-138) · ร้านอื่น 409 (#10) · ลบแล้วยังแก้ได้ (allowDeleted)
//   3. สูตร logic.applyReceiveEdit (ก้อน 3 · #22 F16 ST-032: ของก่อนใบขายหมด ทุน = ทุนแถวใหม่ · ผลติดลบคงทุนเดิม)
//      ผล ok:false (ตัวคูณพัง · สมาชิกหาย) = 409 receive_edit_unsafe {reason} ไม่เขียนครึ่งใบ
//   4. เขียน: stock {stock, cost, updateTime} (รูปเดิม `:282,301`) · ลดเป็น 0 แถวที่มีวันหมดอายุ = ลบล็อตนั้น 1 ล็อตจาก expReport ทุกตัวที่รับ (ST-112)
//      nextExp (ใหม่ · ST-112 ครึ่งหลัง): ลบล็อตวันเดิม 1 ล็อต + ใส่วันใหม่ ทุกตัวในกลุ่ม · แถว exp = Date หรือ '' รูปเดิม · จำนวน/ทุนเท่าเดิม = ไม่แตะ stock cost
//      importProduct {product, totalQty, totalCost} (รูปเดิม `:309`) แถวที่แก้เป็นเลข (เดิมเป็นสตริง C3) + ใหม่ lastEdit {...}
//   push (DEV-0001 push · แอปใหม่ไม่มี OneSignal): หลัง commit FCM หา shop.notiImport ในร้านนี้ (แทน pushByTwoFilter
//     `APP/src/screens/ImportProductDetail.js:268`) · หัวข้อ 'ปรับแก้ไข รายการรับสินค้า' ข้อความรูปเดิม · unchanged = ไม่ส่ง
//   stock updateTime = serverTimestamp() (DEV-0007 · ../_shared/stockJournal.js ①) · สมุด stockJournal kind 'receiveEdit' (ผลต่างช่อง stock) ใน tx เดียวกัน
//     unchanged / ส่งซ้ำ ไม่ถึงจุดเขียน ⇒ ไม่นับซ้ำ
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, checkOwnedDoc } = require("../_shared/auth");
const S = require("./_shared");
const { serverTime, makeJournal } = require("../_shared/stockJournal");
const { notify, idsOf } = require("../_shared/push/notify");
const loc4 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : "");

const same = (a, b) => S.round(S.num(a)) === S.round(S.num(b));

function receiveEdit(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockReceiveEditRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.RECEIVE)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const shopRef = db.collection("shop").doc(access.shopId);
      const importRef = db.collection("importProduct").doc(input.importId);

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, importSnap] = await Promise.all([tx.get(shopRef), tx.get(importRef)]);
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const bill = importSnap.exists ? importSnap.data() : undefined;
        const bc = checkOwnedDoc("import_product", bill, ref);
        if (!bc.ok) S.refuseWith(bc);
        S.requireActiveStaff(shop, input.staffId, access);

        const rows = Array.isArray(bill.product) ? bill.product : [];
        const row = rows[input.lineIndex];
        if (!S.isObj(row)) S.refuse(409, "receive_line_missing", "ไม่พบรายการนี้ในใบรับ");
        const current = { id: row.id, qty: S.round(S.num(row.qty)), cost: S.round(S.num(row.cost)) };
        // วันหมดอายุใหม่ (ST-112 ครึ่งหลัง): undefined = ไม่แก้ · null = เอาออก · ลดเป็น 0 = ล็อตหายอยู่แล้ว ไม่ใส่ล็อตใหม่
        const prevDay = row.exp ? S.thaiDayOf(row.exp) : null;
        const expGiven = input.nextExp !== undefined && input.nextQty !== 0;
        const nextDay = expGiven && input.nextExp ? S.thaiDayOf(input.nextExp) : null;
        const expChange = expGiven && nextDay !== prevDay;
        const qtyCostSame = same(row.qty, input.nextQty) && same(row.cost, input.nextCost);
        // แถวในฐานเป็นค่าปลายทางแล้ว (ค่าเท่าเดิม ST-091 · หรือส่งซ้ำหลังรอบแรกสำเร็จ ผลตรวจ W4) ⇒ unchanged ก่อนเทียบ expect
        if (row.id === input.expect.id && qtyCostSame && !expChange) return { unchanged: true };
        if (row.id !== input.expect.id || !same(row.qty, input.expect.qty) || !same(row.cost, input.expect.cost)) {
          S.refuse(409, "receive_line_changed", "ใบรับนี้ถูกแก้จากเครื่องอื่นแล้ว กรุณาเปิดใหม่", { current });
        }

        const docs = await S.readStockDocs(db, tx, [row.id], ref, { allowDeleted: true });
        const edited = docs.get(row.id);
        if (edited.linkId) await S.readStockDocs(db, tx, S.linkIdsOf(edited), ref, { into: docs, allowDeleted: true });
        const groupDocs = Object.fromEntries(docs);
        let updates = [];
        let updateStock = null;
        if (!qtyCostSame) {
          const r = logic.applyReceiveEdit(edited, groupDocs, {
            id: row.id,
            prevQty: current.qty,
            prevCost: current.cost,
            nextQty: input.nextQty,
            nextCost: input.nextCost,
          });
          if (!r.ok) S.refuse(409, "receive_edit_unsafe", "แก้รายการนี้ไม่ได้ เพราะข้อมูลผูกสต๊อกของสินค้าเสีย", { reason: r.error });
          updates = r.updates;
          updateStock = r.updateStock;
        }

        // ST-112: ลดเป็น 0 = ล็อตของแถวนี้ไม่มีแล้ว ⇒ ลบวันหมดอายุ 1 ล็อตจากทุกตัวที่ถูกรับเข้า
        //         แก้วันหมดอายุ = ลบล็อตวันเดิม 1 ล็อต + ใส่วันใหม่ ทุกตัวในกลุ่ม (สินค้าผูกเก็บ expReport ชุดเดียวกัน)
        const dropDay = input.nextQty === 0 ? prevDay : expChange ? prevDay : null;
        const addExp = expChange && nextDay ? S.dateOf(input.nextExp) : null;
        const expIds = edited.linkId ? [...docs.keys()] : [row.id];
        const touch = new Map(updates.map((u) => [u.id, { stock: u.stock, cost: u.cost }]));
        if (dropDay || addExp) {
          for (const id of expIds) {
            let list = Array.isArray(docs.get(id).expReport) ? docs.get(id).expReport.slice() : [];
            let moved = false;
            if (dropDay) {
              const x = S.removeOneExp(list, dropDay);
              if (x.removed) { list = x.list; moved = true; }
            }
            if (addExp) { list.push(addExp); moved = true; }
            if (moved) touch.set(id, { ...(touch.get(id) || {}), expReport: list });
          }
        }
        if (!touch.size && qtyCostSame) return { unchanged: true };
        const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff });
        for (const [id, upd] of touch) {
          tx.update(db.collection("stock").doc(id), { ...upd, updateTime: serverTime(), ...trail });
          if (upd.stock !== undefined) journal.move("receiveEdit", id, docs.get(id).stock, upd.stock);
        }
        journal.write(tx, db, trail);
        if (updateStock === null) updateStock = S.round(S.num(edited.stock) / (edited.linkId ? logic.readLinkMultiply(edited.linkMultiply) || 1 : 1));

        const product = rows.map((p, i) => {
          if (i !== input.lineIndex) return p;
          const next = { ...p, qty: input.nextQty, cost: input.nextCost };
          if (expChange) next.exp = addExp || "";
          return next;
        });
        let totalQty = 0;
        let totalCost = 0;
        for (const p of product) {
          if (!S.isObj(p)) continue;
          totalQty += S.num(p.qty);
          totalCost += S.num(p.qty) * S.num(p.cost);
        }
        tx.update(importRef, {
          product,
          totalQty: S.round(totalQty),
          totalCost: S.round(totalCost),
          lastEdit: {
            at: now,
            staffId: input.staffId,
            staffName: input.staffName,
            lineIndex: input.lineIndex,
            prevQty: current.qty,
            prevCost: current.cost,
            nextQty: input.nextQty,
            nextCost: input.nextCost,
            ...(expChange ? { prevExp: row.exp || "", nextExp: addExp || "" } : {}),
          },
          ...trail,
        });
        const push = {
          to: { kind: "staff", shopId: access.shopId, ids: idsOf(shop.notiImport) }, heading: "ปรับแก้ไข รายการรับสินค้า",
          content: `เลขที่ใบสั่งซื้อ ${bill.billNumber === undefined ? "" : bill.billNumber}\nโดย ${input.staffName}\n${typeof row.name === "string" ? row.name : ""}\nจำนวน(${current.qty} => ${input.nextQty})\nต้นทุน(${loc4(current.cost)} => ${loc4(input.nextCost)})\nคงเหลือ ${updateStock === null || updateStock === undefined ? "-" : updateStock} `,
          data: { screen: "HomeScreen" },
        };
        return { unchanged: false, updates, updateStock, totalQty: S.round(totalQty), totalCost: S.round(totalCost), push };
      });

      if (out.unchanged) return ok(res, { importId: input.importId, unchanged: true, ...adminFlag(access) });
      await notify(deps, out.push);
      return ok(res, {
        importId: input.importId,
        unchanged: false,
        remainStock: out.updateStock,
        totalQty: out.totalQty,
        totalCost: out.totalCost,
        stocks: out.updates,
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { receiveEdit };

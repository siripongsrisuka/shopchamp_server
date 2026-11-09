// pos/stock/receive — รับสินค้าเข้า: สร้างใบรับ `importProduct` + เพิ่มคงเหลือ + ต้นทุนถัวเฉลี่ยถ่วงน้ำหนัก (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.receive.yaml · คำขอ StockReceiveRequest (@shopchamp/schema · requests/stock.ts)
// ทางเดิม: `main3:src/screens/ImportProductScreen.js:351-461` confirmBill (transaction ในเครื่อง)
//
// ลำดับ:
//   1. callerAccess (401/403) → schema (400) → สิทธิ์ '115' รับสินค้า (403 right_required · HomeScreen.js:58)
//   2. transaction อ่านครบก่อนเขียน: shop · importProduct/{receiveUUID} · supplier/{supplierId} · stock ทุกแถว · สมาชิกกลุ่มผูกที่ยังไม่ได้อ่าน
//      ร้านไม่มี 404 · receiveUUID เดิมของร้านนี้ = 200 duplicate (ไม่เพิ่มสต๊อกซ้ำ ST-055) · ของร้านอื่น 409 receive_uuid_other_shop
//      คู่ค้า 404/409 · คนรับไม่อยู่/ไม่ active 409 (B-11) · สินค้าไม่มี 404 · ร้านอื่น 409 stock_other_shop (#10) · ลบแล้ว 409 stock_deleted (ST-056)
//   3. สูตร = logic.mergeReceiveLines + logic.applyReceive (ก้อน 3 · #22 K05 ST-053: รับตัวเดิมซ้ำในใบ ถ่วงด้วยจำนวน ไม่ใช่ /2)
//      ค่าผูกสต๊อก (linkId linkDetail linkMultiply) อ่านจาก doc ในฐาน ไม่ใช่จากร่างในเครื่อง (ST-017)
//      ตัวคูณของตัวที่รับพัง / linkDetail ไม่มีตัวเอง = 409 receive_unsafe {productId, reason} ไม่เขียน (เดิมลงยอดตัวเดียว กลุ่มแยก)
//   4. เขียน:
//      stock/{id}: {stock, cost, expReport, updateTime} (รูปเดิม `ImportProductScreen.js:434,446`) · ทีมงาน + {byAdmin, adminUid}
//      importProduct/{receiveUUID}: รูปเดิม `ImportProductScreen.js:353-365`
//        {shopId, dateTime, supplier (สำเนาจากฐาน + id), billNumber, product:[{id,name,qty,cost,exp,lot}], createBy, createName, totalQty, totalCost, date}
//        + ใหม่ {receiveUUID, vatIncluded?} · ทีมงาน {byAdmin, adminUid}
//   push (DEV-0001 push · แอปใหม่ไม่มี OneSignal): หลัง commit FCM หา shop.notiImport ในร้านนี้ (แทน pushByTwoFilter
//     `APP/src/screens/ImportProductScreen.js:388`) · หัวข้อ 'รับสินค้า' ข้อความรูปเดิม · duplicate = ไม่ส่ง · ทางเดิมไม่เขียน notification doc (คงเดิม)
// ต่างจากเดิมโดยตั้งใจ: dateTime = นาฬิกา server · date = วันไทยของเวลา server (เดิมนาฬิกาเครื่อง)
//   stock updateTime = serverTimestamp() (DEV-0007 · ../_shared/stockJournal.js ①) · สมุด stockJournal kind 'receive' ใน tx เดียวกัน (duplicate ไม่ถึงจุดเขียน)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { thaiYmd } = require("../_shared/billClock");
const S = require("./_shared");
const { serverTime, makeJournal, moveContext } = require("../_shared/stockJournal");
const { notify, idsOf } = require("../_shared/push/notify");

// issue ของ logic.mergeReceiveLines ที่แปลว่ายอดจะลงไม่ครบกลุ่ม ⇒ 409 receive_unsafe
const UNSAFE_ISSUES = new Set(["bad_link_multiply", "missing_link_detail"]);

const SUPPLIER_FIELDS =["vender_Name", "sale_Name", "tel", "lineId", "detail", "shopId", "dateTime"];

function supplierSnapshot(doc, id) {
  const out = {};
  for (const k of SUPPLIER_FIELDS) if (doc[k] !== undefined) out[k] = doc[k];
  out.id = id;
  return out;
}

function receive(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockReceiveRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.RECEIVE)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const shopRef = db.collection("shop").doc(access.shopId);
      const importRef = db.collection("importProduct").doc(input.receiveUUID);
      const supplierRef = db.collection("supplier").doc(input.supplierId);

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, importSnap, supplierSnap] = await Promise.all([tx.get(shopRef), tx.get(importRef), tx.get(supplierRef)]);
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        if (importSnap.exists) {
          const prev = importSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) S.refuse(409, "receive_uuid_other_shop", "รหัสใบรับนี้เป็นของร้านอื่น");
          return { duplicate: true };
        }
        const supplier = supplierSnap.exists ? supplierSnap.data() : undefined;
        const sc = checkOwnedDoc("supplier", supplier, ref);
        if (!sc.ok) S.refuseWith(sc);
        S.requireActiveStaff(shop, input.staffId, access);

        const docs = await S.readStockDocs(db, tx, input.lines.map((l) => l.id), ref);
        const lines = input.lines.map((l) => {
          const d = docs.get(l.id);
          return { id: l.id, qty: l.qty, cost: l.cost, exp: l.exp || "", linkId: d.linkId, linkDetail: d.linkDetail, linkMultiply: d.linkMultiply };
        });
        const merged = logic.mergeReceiveLines(lines);
        // ตัวคูณของตัวที่รับอ่านไม่ได้ / linkDetail ไม่มีตัวเอง ⇒ logic ลงยอดตัวเดียว กลุ่มยอดแยกกันเงียบ ๆ (ผลตรวจ M3)
        //   ⇒ ปัดทั้งใบ รูปเดียวกับ receiveEdit (receive_edit_unsafe) · ไม่เขียนครึ่งกลุ่ม
        const broken = merged.issues.find((x) => UNSAFE_ISSUES.has(x.code));
        if (broken) S.refuse(409, "receive_unsafe", "รับสินค้านี้ไม่ได้ เพราะข้อมูลผูกสต๊อกของสินค้าเสีย กรุณาติดต่อทีมงาน", { productId: broken.id, reason: broken.code });
        await S.readStockDocs(db, tx, merged.rows.map((r) => r.id), ref, { into: docs });

        const stocks = [];
        const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff, moves: moveContext({ shop, access, now, staffName: input.staffName, refId: input.receiveUUID }) });
        for (const row of merged.rows) {
          const d = docs.get(row.id);
          const next = logic.applyReceive(d, row);
          const exps = row.exps.map(S.dateOf).filter(Boolean);
          const expReport = (Array.isArray(d.expReport) ? d.expReport : []).concat(exps);
          tx.update(db.collection("stock").doc(row.id), { stock: next.stock, cost: next.cost, expReport, updateTime: serverTime(), ...trail });
          journal.move("receive", row.id, d.stock, next.stock);
          stocks.push({ id: row.id, stock: next.stock, cost: next.cost });
        }
        journal.write(tx, db, trail);

        let totalQty = 0;
        let totalCost = 0;
        const product = input.lines.map((l) => {
          totalQty += l.qty;
          totalCost += l.qty * l.cost;
          const d = docs.get(l.id);
          return { id: l.id, name: typeof d.name === "string" ? d.name : String(d.name === undefined ? "" : d.name), qty: l.qty, cost: l.cost, exp: S.dateOf(l.exp) || "", lot: l.lot === undefined ? "" : l.lot };
        });
        totalQty = S.round(totalQty);
        totalCost = S.round(totalCost);
        const doc = {
          shopId: ref.shopId || access.shopId,
          dateTime: now,
          supplier: supplierSnapshot(supplier, input.supplierId),
          billNumber: input.billNumber,
          product,
          createBy: input.staffId,
          createName: input.staffName,
          totalQty,
          totalCost,
          date: String(thaiYmd(now)),
          receiveUUID: input.receiveUUID,
          ...trail,
        };
        if (input.vatIncluded !== undefined) doc.vatIncluded = input.vatIncluded;
        tx.set(importRef, doc);
        const push = {
          to: { kind: "staff", shopId: access.shopId, ids: idsOf(shop.notiImport) }, heading: "รับสินค้า",
          content: `สินค้า ${product.length} รายการ \nจำนวน ${totalQty} ชิ้น \nต้นทุน ${totalCost} บาท`, data: { screen: "HomeScreen" },
        };
        return { duplicate: false, totalQty, totalCost, stocks, issues: merged.issues, push };
      });

      if (out.duplicate) return ok(res, { importId: input.receiveUUID, duplicate: true, ...adminFlag(access) });
      await notify(deps, out.push);
      const body2 = { importId: input.receiveUUID, duplicate: false, totalQty: out.totalQty, totalCost: out.totalCost, stocks: out.stocks, ...adminFlag(access) };
      if (out.issues.length) body2.issues = out.issues;
      return ok(res, body2);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { receive, supplierSnapshot };

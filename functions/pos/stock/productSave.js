// pos/stock/productSave — เพิ่มสินค้าใหม่ / แก้สินค้าจากฟอร์ม (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.productSave.yaml · คำขอ StockProductSaveRequest (op: create | update)
// ทางเดิม: `main3:src/screens/ProductSetting.js:617-712` finalSubmit → `hook/useLocalStock.js:26-41` (add) · `redux/stockSlice.js:33-37` (update ทั้งก้อน)
//
// ด่าน: callerAccess → schema → สิทธิ์ create '110' · update '111' (+ '127' ถ้าเปลี่ยนราคา · ฟอร์มเดิมซ่อนช่องราคาเมื่อไม่มี 127 `ProductSetting.js:118`)
// create (ก่อน transaction นับสินค้าในร้าน · ST-014):
//   เพดานเดิม `StockWarehouseScreen.js:479-490`: เกิน 5,000 ต้องมีแพ็กเกจคลังใหญ่ (vip 'warehouse') · เกิน 50,000 ไม่ได้เลย
//   ⇒ มีอยู่แล้วเกินเพดาน (เดิม `stockLength>5000`) = 403 product_limit {limit, count} · นับ = สินค้าของร้าน − ที่ลบแล้ว (count query 2 ครั้ง · อ่านนอก transaction ⇒ ขอบพร้อมกันเกินได้ 1-2 ตัว)
//   transaction: shop · stock/{productUUID} (มีแล้วของร้านนี้ = 200 duplicate · ร้านอื่น 409 product_uuid_other_shop)
//     บาร์โค้ดซ้ำกับสินค้าที่ยังไม่ลบของร้าน = 409 barcode_taken {productId} (ST-013 ทางแรกของข้อเสนอ · ❓ เปิดคำถามใน 9a-stock.md)
//   เขียน stock/{productUUID} รูปเดิมของ addProduct: ค่าตั้งต้น initialProduct + ...ฟอร์ม + {shopId, timestamp, sku, stock, cost, updateTime} + ช่องว่างผูกสต๊อก
//     ช่องที่ไม่ส่ง = ค่าตั้งต้นรูปเดิม (productDefaults · ผลตรวจ M1) ⇒ จอเพิ่มสินค้าด่วนตอนสแกน (`CashierScreen.js:645` `BarcodeCartScreen.js:285`) ใช้ op create นี้ได้
//     stock เป็นเลขเสมอ (ST-135) · createdBy {staffId, staffName}
// update (transaction): stock/{productId} ไม่มี 404 · ร้านอื่น 409 · ลบแล้ว 409 stock_deleted (ST-056)
//   เขียนเฉพาะช่องที่เปลี่ยน (ST-022: ❌ stock cost link* ไม่มีในคำขอเลย) · ไม่มีอะไรเปลี่ยน = 200 unchanged (ST-091)
//   เปลี่ยนบาร์โค้ดเป็นของตัวอื่น = 409 barcode_taken · ราคาเปลี่ยน = แจ้งเตือน categoryId 5 พร้อมชื่อคนแก้ (ST-092)
// คลังบาร์โค้ดกลาง `product` (ProductSetting.js:672-689) ไม่อยู่ที่นี่ = โดเมน 9b
// updateTime = serverTimestamp() (DEV-0007 · ../_shared/stockJournal.js ①) · create ลงสมุด stockJournal kind 'create' = ยอดตั้งต้น (duplicate ไม่ถึงจุดเขียน)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { vipActive } = require("../_shared/premium");
const S = require("./_shared");
const { serverTime, makeJournal } = require("../_shared/stockJournal");

const BASE_LIMIT = 5000;
const MAX_LIMIT = 50000;

/** วันสุดท้ายของเดือน เวลา 00:00 ไทย · รูปเดิม `Utility/dateTime.js:37` lastDayOfMonth (นาฬิกาเครื่องไทย) */
function lastDayOfMonthTh(now) {
  const t = new Date(now.getTime() + 7 * 3600 * 1000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0) - 7 * 3600 * 1000);
}

/**
 * ค่าตั้งต้นของสินค้าใหม่ = `main3:src/config/initialProduct.js` (ฟอร์มเดิมส่งครบทุกช่องเสมอ)
 *   ⇒ คำขอที่ส่งแค่ชื่อ+ราคา ได้ doc รูปเดียวกับแอปเก่า (ผลตรวจ M1: ไม่มี category = `DashboardStockScreen.js:46` พัง ·
 *     ไม่มี stockCountStatus = แอปเก่าถือว่าไม่ตัดสต๊อก) · ❌ ไม่มี stock cost name price shopId sku updateTime (handler ใส่เอง)
 */
function productDefaults(now) {
  return {
    barcode: "",
    barcodeStatus: true,
    cashierShow: false,
    category: [],
    currentCategory: [],
    consignment: false,
    delivery: false,
    imageId: "",
    promotion: { status: false, qty: "", price: "", startDate: now, endDate: lastDayOfMonthTh(now) },
    rent: false,
    safetyStock: { status: false, qty: "" },
    unit: "ชิ้น",
    vatExemption: false,
    expReport: [],
    priceLevelStatus: false,
    priceLevel: [],
    pointStatus: true,
    stockCountStatus: true,
    customQtyStatus: false,
    customPriceStatus: false,
    selfImage: false,
  };
}

/** sku รูปเดิม `stringYMDHMS()` (YYYYMMDDHHmmss เวลาไทย) */
function skuOf(now) {
  const t = new Date(now.getTime() + 7 * 3600 * 1000).toISOString();
  return t.slice(0, 19).replace(/[-T:]/g, "");
}

/** ค่าช่องฟอร์มที่ต่างจากในฐาน · เทียบแบบ JSON (array/object ทั้งก้อน) · วันโปรเป็น Date */
function diffFields(doc, fields) {
  const patch = {};
  for (const [k, v] of Object.entries(fields)) {
    const next = k === "promotion" ? promotionOf(v) : v;
    if (JSON.stringify(normalize(doc[k])) !== JSON.stringify(normalize(next))) patch[k] = next;
  }
  return patch;
}
function normalize(v) {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  return v;
}
function promotionOf(p) {
  if (!S.isObj(p)) return p;
  const out = { status: p.status, qty: p.qty, price: p.price };
  if (p.startDate) out.startDate = S.dateOf(p.startDate);
  if (p.endDate) out.endDate = S.dateOf(p.endDate);
  return out;
}

async function barcodeOwner(tx, ref, barcode, selfId) {
  if (typeof barcode !== "string" || barcode === "") return null;
  const keys = [...new Set([ref.id, ref.shopId].filter(Boolean))];
  for (const k of keys) {
    const q = await tx.get(db.collection("stock").where("shopId", "==", k).where("barcode", "==", barcode).limit(5));
    const hit = (q.docs || []).find((d) => d.id !== selfId && (d.data() || {}).deleted !== true);
    if (hit) return hit.id;
  }
  return null;
}

async function countProducts(ref) {
  const keys = [...new Set([ref.id, ref.shopId].filter(Boolean))];
  let n = 0;
  for (const k of keys) {
    const all = await db.collection("stock").where("shopId", "==", k).count().get();
    const del = await db.collection("stock").where("shopId", "==", k).where("deleted", "==", true).count().get();
    n += (all.data().count || 0) - (del.data().count || 0);
  }
  return n;
}

function productSave(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockProductSaveRequest"), body, res);
      if (!input) return;
      const right = input.op === "create" ? S.RIGHTS.ADD_PRODUCT : S.RIGHTS.EDIT_PRODUCT;
      if (!hasRight(access, right)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const trail = adminTrail(access);
      const shopRef = db.collection("shop").doc(access.shopId);

      if (input.op === "create") {
        const pre = await shopRef.get();
        if (!pre.exists) return sendDeny(res, deny(404, "shop_not_found"));
        const preShop = pre.data() || {};
        const preRef = await resolveShopRef({ db, shopDocId: access.shopId, shop: preShop });
        const already = await db.collection("stock").doc(input.productUUID).get();
        if (!already.exists) {
          const count = await countProducts(preRef);
          const limit = vipActive(preShop, "warehouse", now) ? MAX_LIMIT : BASE_LIMIT;
          if (count > limit) return sendDeny(res, deny(403, "product_limit", "เพิ่มสินค้าถึงจำนวนสูงสุดของแพ็กเกจแล้ว", { limit, count }));
        }
      }

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(shopRef);
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const shopField = ref.shopId || access.shopId;

        if (input.op === "create") {
          const pRef = db.collection("stock").doc(input.productUUID);
          const pSnap = await tx.get(pRef);
          if (pSnap.exists) {
            if (!belongsToShop((pSnap.data() || {}).shopId, ref)) S.refuse(409, "product_uuid_other_shop", "รหัสสินค้านี้เป็นของร้านอื่น");
            return { productId: input.productUUID, duplicate: true };
          }
          const owner = await barcodeOwner(tx, ref, input.product.barcode, input.productUUID);
          S.requireActiveStaff(shop, input.staffId, access);
          if (owner) S.refuse(409, "barcode_taken", "บาร์โค้ดนี้มีสินค้าอื่นในร้านใช้อยู่แล้ว", { productId: owner });
          const doc = {
            ...productDefaults(now),
            ...input.product,
            shopId: shopField,
            timestamp: now,
            sku: skuOf(now),
            stock: input.stock,
            cost: input.cost,
            linkDetail: [],
            linkNext: "",
            linkMultiply: "",
            linkQty: 0,
            linkId: "",
            updateTime: serverTime(),
            createdBy: { staffId: input.staffId, staffName: input.staffName },
            ...trail,
          };
          if (input.product.promotion) doc.promotion = promotionOf(input.product.promotion);
          tx.set(pRef, doc);
          const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff });
          journal.move("create", input.productUUID, 0, input.stock);
          journal.write(tx, db, trail);
          return { productId: input.productUUID, duplicate: false };
        }

        const pRef = db.collection("stock").doc(input.productId);
        const pSnap = await tx.get(pRef);
        const cur = pSnap.exists ? pSnap.data() : undefined;
        const pc = checkOwnedDoc("stock", cur, ref);
        if (!pc.ok) S.refuseWith(pc);
        if (cur.deleted === true) S.refuse(409, "stock_deleted", "สินค้านี้ถูกลบแล้ว", { productId: input.productId });
        const patch = diffFields(cur, input.product);
        if (patch.price !== undefined && !hasRight(access, S.RIGHTS.EDIT_PRICE)) S.refuse(403, "right_required", "ไม่มีสิทธิ์แก้ราคาขาย");
        const owner = patch.barcode !== undefined ? await barcodeOwner(tx, ref, patch.barcode, input.productId) : null;
        S.requireActiveStaff(shop, input.staffId, access);
        if (owner) S.refuse(409, "barcode_taken", "บาร์โค้ดนี้มีสินค้าอื่นในร้านใช้อยู่แล้ว", { productId: owner });
        const changed = Object.keys(patch);
        if (!changed.length) return { productId: input.productId, unchanged: true };
        tx.update(pRef, { ...patch, updateTime: serverTime(), updatedBy: { staffId: input.staffId, staffName: input.staffName }, ...trail });
        if (patch.price !== undefined) {
          const name = typeof cur.name === "string" ? cur.name : String(cur.name === undefined ? "" : cur.name);
          tx.set(db.collection("notification").doc(), {
            heading: `อัปเดตราคา ${name} เป็น ${patch.price} บาท`,
            shopId: shopField,
            notificationContent: `ราคาเดิม : ${cur.price === undefined ? "" : cur.price}\nราคาใหม่ : ${patch.price} \nโดย : ${input.staffName}`,
            categoryId: 5,
            timestamp: now,
            staffName: input.staffName,
            ...trail,
          });
        }
        return { productId: input.productId, unchanged: false, changed };
      });

      return ok(res, { op: input.op, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { productSave, diffFields, skuOf, productDefaults, lastDayOfMonthTh };

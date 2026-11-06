// pos/franchise/warehouse.js — คลังสินค้าส่วนกลางของแฟรนไชส์: เพิ่ม · แก้ · ลบ (ก้อน 9f · DEV-0002) · สิทธิ์ 128
//
// สัญญา: shopchamp-center/api/franchise.{warehouseSave,warehouseDelete}.yaml
// แทน (census chunk6-log.md): 269 270 271 `fr:screens/WarehouseScreen.js:100-134`
//   เดิม: update ส่ง current ทั้งก้อน (รวม `no` `id` · WH-41) · category แก้แล้วเก็บเป็น object (ST-107) · ราคาเป็นสตริงจากช่องกรอก
//   ลบไม่ดูกลุ่มผูก (WH-51) · แก้ชื่อแล้วสำเนาในกลุ่มผูกไม่ตาม (ST-139)
// รูปยังอัปจากเว็บขึ้น Storage เหมือนเดิม แล้วส่ง URL มา (ลำดับอัป/ลบไฟล์เป็นงานจอ WH-38 WH-40)
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");

// ค่าตั้งต้นรูปเดิม (fr:configs/initialWarehouseItem.js · ไม่รวม timestamp updateTime ที่ server ใส่)
const DEFAULTS = Object.freeze({
  barcode: "", barcodeStatus: true, cashierShow: false, category: [], consignment: false, cost: "", imageId: "", name: "", price: "",
  safetyStock: { status: false, qty: "" }, shopId: "", sku: "", unit: "ชิ้น", vatExemption: false, priceLevelStatus: false, priceLevel: [],
  pointStatus: true, stockCountStatus: true, customQtyStatus: false, customPriceStatus: false, selfImage: false,
});
const FIELDS = ["name", "price", "barcode", "sku", "unit", "category", "imageId", "pointStatus", "stockCountStatus", "customQtyStatus", "customPriceStatus", "priceLevelStatus", "priceLevel"];
const COPY_FIELDS = ["name", "unit", "barcode", "imageId"]; // สำเนาใน stockLink[] (Modal_StockLink.js:71)

function checkCategory(ids, franchise) {
  const p = F.categoryPathProblem(ids, franchise.warehouseCategory);
  if (p) F.refuse(deny(409, p.reason === "not_found" ? "category_not_found" : "category_path_invalid", "หมวดหมู่ไม่ถูกต้อง เปิดใหม่แล้วเลือกอีกครั้ง", { categoryId: p.categoryId }));
}
function itemOf(snap, franchiseId) {
  if (!snap.exists) F.refuse(deny(404, "warehouse_item_not_found", "ไม่พบสินค้าในคลัง"));
  const d = snap.data() || {};
  if (d.franchiseId !== franchiseId) F.refuse(deny(409, "warehouse_item_other_franchise", "สินค้านี้เป็นของแฟรนไชส์อื่น"));
  return d;
}
const linksOf = (tx, franchiseId) => tx.get(db.collection("stockLink").where("franchiseId", "==", franchiseId));
const hasMember = (l, id) => F.arr(l.stockLink).some((m) => F.isObj(m) && m.id === id);

// ── franchise.warehouseSave ──
const warehouseSave = F.makeHandler("FranchiseWarehouseSaveRequest", async ({ uid, input, now }) => db.runTransaction(async (tx) => {
  const { franchise, access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const sent = {};
  for (const k of FIELDS) if (input[k] !== undefined) sent[k] = input[k];
  if (sent.category) checkCategory(sent.category, franchise);

  if (input.op === "create") {
    const ref = db.collection("warehouseItem").doc(input.itemUUID);
    const snap = await tx.get(ref);
    if (snap.exists) {
      if ((snap.data() || {}).franchiseId === input.franchiseId) return { op: "create", itemId: ref.id, duplicate: true, ...F.adminFlag(access) };
      F.refuse(deny(409, "warehouse_item_other_franchise", "รหัสนี้เป็นของแฟรนไชส์อื่น"));
    }
    const doc = {
      ...DEFAULTS, safetyStock: { ...DEFAULTS.safetyStock }, ...sent,
      franchiseId: input.franchiseId, stock: 0, timestamp: now, updateTime: now, createdBy: uid, ...F.adminTrail(access),
    };
    tx.set(ref, doc);
    return { op: "create", itemId: ref.id, duplicate: false, ...F.adminFlag(access) };
  }

  const ref = db.collection("warehouseItem").doc(input.itemId);
  const [snap, links] = await Promise.all([tx.get(ref), linksOf(tx, input.franchiseId)]);
  const cur = itemOf(snap, input.franchiseId);
  const patch = {};
  for (const [k, v] of Object.entries(sent)) if (!F.sameValue(cur[k], v)) patch[k] = v;
  // category รูป object ของเดิม (ST-107) ซ่อมเป็น id ตอนแก้ แม้ไม่ได้ส่ง category มา
  if (patch.category === undefined && F.isLegacyCategory(cur.category)) patch.category = F.categoryIdsOf(cur.category);
  if (!Object.keys(patch).length) return { op: "update", itemId: ref.id, unchanged: true, ...F.adminFlag(access) };
  tx.update(ref, { ...patch, updateTime: now, updatedBy: uid, ...F.adminTrail(access) });

  // สำเนาในกลุ่มผูกตามคลัง (ST-139)
  const copy = COPY_FIELDS.filter((k) => patch[k] !== undefined);
  let linksUpdated = 0;
  if (copy.length) {
    for (const d of links.docs) {
      const l = d.data() || {};
      if (F.str(l.shopId) !== "" || !hasMember(l, ref.id)) continue;
      const stockLink = F.arr(l.stockLink).map((m) => (F.isObj(m) && m.id === ref.id ? { ...m, ...Object.fromEntries(copy.map((k) => [k, patch[k]])) } : m));
      tx.update(db.collection("stockLink").doc(d.id), { stockLink });
      linksUpdated++;
    }
  }
  return { op: "update", itemId: ref.id, updated: Object.keys(patch), linksUpdated, ...F.adminFlag(access) };
}));

// ── franchise.warehouseDelete ──
const warehouseDelete = F.makeHandler("FranchiseWarehouseDeleteRequest", async ({ uid, input }) => db.runTransaction(async (tx) => {
  const { access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const ref = db.collection("warehouseItem").doc(input.itemId);
  const [snap, links] = await Promise.all([tx.get(ref), linksOf(tx, input.franchiseId)]);
  if (!snap.exists) return { itemId: ref.id, alreadyDeleted: true, ...F.adminFlag(access) };
  itemOf(snap, input.franchiseId);
  // อยู่ในกลุ่มผูก = ลบไม่ได้ (WH-51 · กลุ่มจะชี้ id ที่ไม่มี)
  const inLink = links.docs.find((d) => hasMember(d.data() || {}, ref.id));
  if (inLink) F.refuse(deny(409, "warehouse_item_linked", "สินค้านี้อยู่ในกลุ่มผูก เอาออกจากกลุ่มก่อน", { linkId: inLink.id }));
  tx.delete(ref);
  return { itemId: ref.id, deleted: true, ...F.adminFlag(access) };
}));

module.exports = { warehouseSave, warehouseDelete, DEFAULTS };

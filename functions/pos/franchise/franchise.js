// pos/franchise/franchise.js — สร้างแฟรนไชส์ · แก้โปรไฟล์แบรนด์ · บันทึกต้นหมวดคลัง (ก้อน 9f · DEV-0002)
//
// สัญญา: shopchamp-center/api/franchise.{create,profileUpdate,categorySave}.yaml
// แทน (census chunk6-log.md):
//   create        275 `fr:screens/FranchiseListScreen.js:165-174` (set doc ใหม่ humanResource ว่าง ⇒ ผู้สร้างหาแฟรนไชส์ตัวเองไม่เจอ DI-45)
//   profileUpdate (ProfileScreen.js:29-32 · update {name, imageId} จากค่าใน localStorage ทุกครั้ง PR-07)
//   categorySave  266 `fr:screens/WarehouseCategoryScreen.js:24` (เขียนทั้ง array จากร่างที่ตั้งจากค่า persist DI-37 WC-41)
// เขียนทุกตัวใน transaction ที่อ่าน franchise + admin/adminConfig สด (ด่านซ้ำตอนเขียน)
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");

// รูปเดิมของ doc ใหม่ (fr:configs/initialFranchise.js)
const SHOP_TYPES = Object.freeze([{ id: "1", name: "ทั่วไป", detail: "", product: [], category: [], right: [], payment: [] }]);

// ── franchise.create ──
const create = F.makeHandler("FranchiseCreateRequest", async ({ uid, input, now }) => {
  const ref = db.collection("franchise").doc(input.franchiseUUID);
  return db.runTransaction(async (tx) => {
    const [fSnap, cSnap, pSnap] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection("admin").doc("adminConfig")),
      tx.get(db.collection("profile").doc(uid)),
    ]);
    if (fSnap.exists) {
      const cur = fSnap.data() || {};
      if (cur.createdBy === uid) return { franchiseId: ref.id, duplicate: true };
      F.refuse(deny(409, "franchise_uuid_taken", "รหัสนี้ถูกใช้แล้ว"));
    }
    const access = F.franchiseAccessOf({ franchise: {}, uid, adminConfig: cSnap.exists ? cSnap.data() : null });
    const byAdmin = access.ok && access.access.byAdmin;
    // ผู้สร้างเป็นสมาชิกสิทธิ์ครบ (DI-45) · ทีมงานไม่ใส่ตัวเอง (เห็นทุกแฟรนไชส์อยู่แล้ว · เดิมก็ไม่ใส่)
    const p = pSnap.exists ? pSnap.data() || {} : {};
    const me = F.staffRow({ id: uid, name: p.name, tel: p.tel, email: p.email, imageId: p.imageId, rights: [...F.ALL_RIGHTS] });
    const doc = {
      warehouseCategory: [],
      shopTypes: SHOP_TYPES.map((t) => ({ ...t })),
      shopCategory: [],
      name: input.name,
      imageId: "",
      humanResource: byAdmin ? [] : [uid],
      humanRight: byAdmin ? [] : [me],
      customerTypes: [],
      timestamp: now,
      createdBy: uid,
      ...(byAdmin ? { byAdmin: true, adminUid: uid } : {}),
    };
    tx.set(ref, doc);
    return { franchiseId: ref.id, duplicate: false, ...(byAdmin ? { byAdmin: true } : {}) };
  });
});

// ── franchise.profileUpdate ──
const profileUpdate = F.makeHandler("FranchiseProfileUpdateRequest", async ({ uid, input, now }) => db.runTransaction(async (tx) => {
  const { ref, franchise, access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.PROFILE] });
  const patch = {};
  if (input.name !== undefined && input.name !== franchise.name) patch.name = input.name;
  if (input.imageId !== undefined && input.imageId !== franchise.imageId) patch.imageId = input.imageId;
  if (!Object.keys(patch).length) return { franchiseId: ref.id, unchanged: true, ...F.adminFlag(access) };
  tx.update(ref, { ...patch, updateTime: now, updatedBy: uid, ...F.adminTrail(access) });
  return { franchiseId: ref.id, updated: Object.keys(patch), ...F.adminFlag(access) };
}));

// ── franchise.categorySave ──

/** ตรวจต้นหมวด · คืน {tree (เรียงชั้น), problem} · problem = {reason, categoryId?} */
function checkTree(levels) {
  const sorted = [...levels].filter((lv) => lv.value.length > 0).sort((a, b) => a.level - b.level);
  const ids = new Set();
  const byId = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const lv = sorted[i];
    // ชั้นต้องไล่ 1, 2, 3 … ไม่มีชั้นลอย (WC-14 หมวดกำพร้า)
    if (lv.level !== i + 1) return { problem: { reason: "level_gap", level: lv.level } };
    const siblings = new Set();
    for (const n of lv.value) {
      if (n.level !== lv.level) return { problem: { reason: "level_mismatch", categoryId: n.id } };
      if (ids.has(n.id)) return { problem: { reason: "duplicate_id", categoryId: n.id } };
      if (n.aboveId.length !== lv.level - 1) return { problem: { reason: "bad_parent", categoryId: n.id } };
      if (lv.level > 1) {
        const parent = byId.get(n.aboveId[n.aboveId.length - 1]);
        const parentPath = parent ? [...parent.aboveId, parent.id] : null;
        if (!parentPath || parentPath.join("/") !== n.aboveId.join("/")) return { problem: { reason: "bad_parent", categoryId: n.id } };
      }
      // ชื่อซ้ำในแม่เดียวกัน (WC-31 · ไฟล์นำเข้าจับคู่ด้วยชื่อ)
      const key = `${n.aboveId.join("/")}|${n.name.toLowerCase()}`;
      if (siblings.has(key)) return { problem: { reason: "duplicate_name", categoryId: n.id } };
      siblings.add(key);
      ids.add(n.id);
      byId.set(n.id, n);
    }
  }
  return { tree: sorted.map((lv) => ({ level: lv.level, value: lv.value.map((n) => ({ id: n.id, name: n.name, level: n.level, aboveId: [...n.aboveId] })) })), ids };
}

const categorySave = F.makeHandler("FranchiseCategorySaveRequest", async ({ uid, input, now }) => db.runTransaction(async (tx) => {
  const { ref, franchise, access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const current = F.arr(franchise.warehouseCategory);
  // ต้นในฐานต้องเท่าที่จอเห็น ไม่งั้นทับของคนอื่น (DI-37 · WC-41 · WC-06)
  if (!F.sameValue(current, input.seenWarehouseCategory)) {
    F.refuse(deny(409, "category_changed", "มีคนแก้หมวดหมู่ไปก่อน กรุณาเปิดใหม่", { warehouseCategory: current }));
  }
  const { tree, ids, problem } = checkTree(input.warehouseCategory);
  if (problem) F.refuse(deny(400, "category_invalid", "โครงหมวดหมู่ไม่ถูกต้อง", problem));
  if (F.sameValue(current, tree)) return { franchiseId: ref.id, unchanged: true, ...F.adminFlag(access) };

  // ลบหมวดที่สินค้ายังใช้อยู่ไม่ได้ (ST-048 · WC-37) · ดูทั้ง 2 รูปของ category (id / object · ST-107)
  const removed = [...F.categoryNodes(current).keys()].filter((id) => !ids.has(id));
  if (removed.length) {
    const items = await tx.get(db.collection("warehouseItem").where("franchiseId", "==", input.franchiseId));
    const gone = new Set(removed);
    const counts = new Map();
    for (const d of items.docs) for (const c of F.categoryIdsOf((d.data() || {}).category)) if (gone.has(c)) counts.set(c, (counts.get(c) || 0) + 1);
    if (counts.size) {
      const [categoryId, itemCount] = [...counts.entries()][0];
      F.refuse(deny(409, "category_in_use", "ยังมีสินค้าใช้หมวดนี้ ย้ายสินค้าออกก่อน", { categoryId, itemCount }));
    }
  }
  tx.update(ref, { warehouseCategory: tree, updateTime: now, updatedBy: uid, ...F.adminTrail(access) });
  return { franchiseId: ref.id, warehouseCategory: tree, ...F.adminFlag(access) };
}));

module.exports = { create, profileUpdate, categorySave, checkTree };

// pos/franchise/link.js — กลุ่มผูกรายการสินค้าของแฟรนไชส์ (stockLink ตระกูลแฟรนไชส์) · สร้าง แก้ ลบ (ก้อน 9f · DEV-0002) · สิทธิ์ 128
//
// สัญญา: shopchamp-center/api/franchise.{linkSave,linkDelete}.yaml
// แทน (census chunk6-log.md): 263 264 265 `fr:screens/StockLinkScreen.js:58-100` (284-286 thunk ใน stockLinkSlice ไม่มีผู้เรียก SL-46)
// ST-012 ทางแรก (คงเมนู · entities/stockLink.ts): doc ตระกูลแฟรนไชส์ `shopId:''` + `franchiseId` · สมาชิกชี้ `warehouseItem`
//   ไม่มีผลกับสต๊อกสาขา (เหมือนเดิม · ไม่มีผู้อ่าน doc ตระกูลนี้ใน repo ไหน SL-45) ⇒ ไม่แตะ stock / warehouseItem
// ที่แก้: สมาชิกต้องเป็นสินค้าคลังของแฟรนไชส์นี้ · ไม่ซ้ำในกลุ่ม (ST-088) · ไม่อยู่กลุ่มอื่น (ST-087 · เดิม selector ชื่อผิด)
//   ตัวคูณเป็นตัวเลข (SL-35) · ตัวอ้างอิง 1 ตัวเดียว · สำเนาชื่อ/หน่วย/บาร์โค้ด/รูปอ่านจากคลังในฐาน (ST-139) · timestamp เวลา server (SL-20)
//   กดซ้ำได้กลุ่มเดิม (linkUUID · SL-42)
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");

function linkOf(snap, franchiseId) {
  if (!snap.exists) F.refuse(deny(404, "link_not_found", "ไม่พบกลุ่มผูก"));
  const l = snap.data() || {};
  if (l.franchiseId !== franchiseId || F.str(l.shopId) !== "") F.refuse(deny(409, "link_other_franchise", "กลุ่มนี้เป็นของแฟรนไชส์อื่น"));
  return l;
}

// ── franchise.linkSave ──
const linkSave = F.makeHandler("FranchiseLinkSaveRequest", async ({ uid, input, now }) => db.runTransaction(async (tx) => {
  const { access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const ids = input.members.map((m) => m.id);
  if (new Set(ids).size !== ids.length) F.refuse(deny(400, "link_invalid", "สินค้าซ้ำในกลุ่ม", { reason: "duplicate_member" }));
  const ones = input.members.filter((m) => m.linkMultiply === 1).length;
  if (ones !== 1) F.refuse(deny(400, "link_invalid", "ต้องมีสินค้าอ้างอิงตัวคูณ 1 หนึ่งรายการ", { reason: ones ? "many_reference" : "no_reference" }));

  const linkId = input.op === "create" ? input.linkUUID : input.linkId;
  const ref = db.collection("stockLink").doc(linkId);
  const [snap, groups, ...items] = await Promise.all([
    tx.get(ref),
    tx.get(db.collection("stockLink").where("franchiseId", "==", input.franchiseId)),
    ...ids.map((id) => tx.get(db.collection("warehouseItem").doc(id))),
  ]);
  let cur = null;
  if (input.op === "create") {
    if (snap.exists) {
      const l = snap.data() || {};
      if (l.franchiseId === input.franchiseId && F.str(l.shopId) === "") return { op: "create", linkId, duplicate: true, ...F.adminFlag(access) };
      F.refuse(deny(409, "link_other_franchise", "รหัสนี้เป็นของกลุ่มอื่น"));
    }
  } else {
    cur = linkOf(snap, input.franchiseId);
  }
  const members = input.members.map((m, i) => {
    const s = items[i];
    if (!s.exists) F.refuse(deny(404, "warehouse_item_not_found", "ไม่พบสินค้าในคลัง", { itemId: m.id }));
    const d = s.data() || {};
    if (d.franchiseId !== input.franchiseId) F.refuse(deny(409, "warehouse_item_other_franchise", "สินค้านี้เป็นของแฟรนไชส์อื่น", { itemId: m.id }));
    return {
      id: m.id, name: F.str(d.name), unit: typeof d.unit === "string" ? d.unit : "ชิ้น",
      imageId: F.str(d.imageId), barcode: d.barcode === undefined || d.barcode === null ? "" : String(d.barcode), linkMultiply: m.linkMultiply,
    };
  });
  // สินค้าเดียวอยู่ได้กลุ่มเดียว (ST-087 · Modal_StockLink.js:50 ตั้งใจกันแต่อ่าน state ผิดชื่อ)
  for (const g of groups.docs) {
    if (g.id === linkId) continue;
    const l = g.data() || {};
    if (F.str(l.shopId) !== "") continue;
    const hit = F.arr(l.stockLink).find((x) => F.isObj(x) && ids.includes(x.id));
    if (hit) F.refuse(deny(409, "item_in_other_link", "สินค้านี้อยู่ในกลุ่มอื่นแล้ว", { itemId: hit.id, linkId: g.id }));
  }
  const S = require("@shopchamp/schema");
  const doc = {
    shopId: "", franchiseId: input.franchiseId, stockGroupName: input.stockGroupName, stockLink: members,
    timestamp: cur && cur.timestamp ? cur.timestamp : now, upgrade: true, id: linkId,
  };
  const v = S.StockLinkWrite.safeParse(doc);
  if (!v.success) F.refuse(deny(400, "link_invalid", "กลุ่มผูกไม่ถูกต้อง", { reason: "schema" }));
  if (input.op === "create") tx.set(ref, { ...doc, createdBy: uid, ...F.adminTrail(access) });
  else tx.update(ref, { stockGroupName: doc.stockGroupName, stockLink: members, upgrade: true, updatedBy: uid, updateTime: now, ...F.adminTrail(access) });
  return { op: input.op, linkId, duplicate: false, stockLink: members, ...F.adminFlag(access) };
}));

// ── franchise.linkDelete ──
const linkDelete = F.makeHandler("FranchiseLinkDeleteRequest", async ({ uid, input }) => db.runTransaction(async (tx) => {
  const { access } = await F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const ref = db.collection("stockLink").doc(input.linkId);
  const snap = await tx.get(ref);
  if (!snap.exists) return { linkId: ref.id, alreadyDeleted: true, ...F.adminFlag(access) };
  linkOf(snap, input.franchiseId);
  tx.delete(ref);
  return { linkId: ref.id, deleted: true, ...F.adminFlag(access) };
}));

module.exports = { linkSave, linkDelete };

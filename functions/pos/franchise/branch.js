// pos/franchise/branch.js — ค้นร้านจากเบอร์ · ผูกร้านเป็นสาขา (ก้อน 9f · DEV-0002) · ทีมงาน Shopchamp เท่านั้น
//
// สัญญา: shopchamp-center/api/franchise.{branchFind,branchAttach}.yaml
// แทน (census chunk6-log.md): 281 `fr:modal/Modal_FindShop.js:46` (doc ร้านทั้งก้อนรวมรหัสพนักงาน FD-B2) · 268 `fr:screens/BranchScreen.js:59`
// สิทธิ์เดิม: ปุ่ม "+ เพิ่มสาขาใหม่" เห็นเฉพาะ initialAdmin (BranchScreen.js:93) แต่ฐานไม่กัน (BR-19) ⇒ server = ทีมงานเท่านั้น
// ผูกสาขาเขียน `shop.franchiseId` ช่องเดียว (ช่องเดียวกับที่ rules ให้แฟรนไชส์แก้ · แอปเก่าอ่านช่องนี้ใส่บิล main3 CheckoutScreen.js:143)
//   ร้านอยู่แฟรนไชส์อื่น = 409 ไม่ทับเงียบ (DI-13 · BR-28) · ตั้งใจย้ายส่ง moveFromFranchiseId ตรงค่าปัจจุบัน · อยู่แล้ว = 200 unchanged (BR-34)
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");

const plain = (ref) => ref.get();
const FIND_MAX = 20;

// ── franchise.branchFind ──
const branchFind = F.makeHandler("FranchiseBranchFindRequest", async ({ uid, input }) => {
  await F.readGate(plain, input.franchiseId, uid, { adminOnly: true });
  const snap = await db.collection("shop").where("tel", "==", input.tel).limit(FIND_MAX).get();
  // คืนแค่ช่องที่การ์ดใช้ · ไม่มี humanResource ⇒ รหัสพนักงานไม่ออกจาก server (FD-B2) · บอกสังกัดเดิม (DI-13 · FD-B1)
  const shops = snap.docs.map((d) => {
    const s = d.data() || {};
    const cur = F.str(s.franchiseId);
    return { id: d.id, name: F.str(s.name), tel: F.str(s.tel), franchiseId: cur, inThisFranchise: cur === input.franchiseId };
  });
  return { shops, count: shops.length };
});

// ── franchise.branchAttach ──
const branchAttach = F.makeHandler("FranchiseBranchAttachRequest", async ({ uid, input }) => db.runTransaction(async (tx) => {
  const shopRef = db.collection("shop").doc(input.shopId);
  const [{ access }, sSnap] = await Promise.all([
    F.readGate((r) => tx.get(r), input.franchiseId, uid, { adminOnly: true }),
    tx.get(shopRef),
  ]);
  if (!sSnap.exists) F.refuse(deny(404, "shop_not_found"));
  const cur = F.str((sSnap.data() || {}).franchiseId);
  if (cur === input.franchiseId) return { shopId: shopRef.id, franchiseId: input.franchiseId, unchanged: true, ...F.adminFlag(access) };
  if (cur !== "" && input.moveFromFranchiseId !== cur) {
    F.refuse(deny(409, "shop_in_other_franchise", "ร้านนี้เป็นสาขาของแฟรนไชส์อื่นอยู่", { currentFranchiseId: cur }));
  }
  if (cur === "" && input.moveFromFranchiseId !== undefined) {
    F.refuse(deny(409, "shop_in_other_franchise", "ร้านนี้ไม่ได้อยู่แฟรนไชส์ที่ระบุ", { currentFranchiseId: "" }));
  }
  tx.update(shopRef, { franchiseId: input.franchiseId });
  return { shopId: shopRef.id, franchiseId: input.franchiseId, ...(cur ? { movedFrom: cur } : {}), ...F.adminFlag(access) };
}));

module.exports = { branchFind, branchAttach };

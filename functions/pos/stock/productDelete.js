// pos/stock/productDelete — ลบสินค้าแบบ soft delete (`deleted:true`) · สินค้าผูกกลุ่ม = เลิกผูกทั้งกลุ่มแบบเดิม (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.productDelete.yaml · คำขอ StockProductDeleteRequest
// ทางเดิม: `main3:src/hook/useLocalStock.js:146-210` deleteProductById · ปุ่ม `ProductSetting.js:801` `StockWarehouseScreen.js:370`
//
// ลำดับ: callerAccess → schema → สิทธิ์ '113' ลบสินค้า → transaction
//   อ่าน shop · stock/{productId} · ถ้าผูกกลุ่ม: stockLink/{linkId} + สมาชิกที่ยังผูกกลุ่มนี้
//   ไม่มี 404 stock_not_found · ร้านอื่น 409 stock_other_shop · ลบไปแล้ว = 200 alreadyDeleted ไม่เขียน
//   คนลบไม่อยู่/ไม่ active 409 (B-11)
//   ผูกกลุ่ม: แตกกลุ่มทั้งหมดเหมือนเดิม แต่ยอดของตัวที่ลบย้ายไปหน่วยที่เหลือ (ST-009 ทางแรกของข้อเสนอ · logic.spreadLinkStock removeId)
//     กลุ่มไม่มีแล้ว (stockLink ถูกลบก่อน) = แตกจาก linkDetail ของสินค้าตัวนี้
//   เขียน: stock/{productId} {deleted:true, updateTime} (รูปเดิม) + {deletedBy, deletedAt}
//     สมาชิกที่เหลือ {stock, linkDetail:[], linkNext:'', linkMultiply:'', linkQty:0, linkId:'', updateTime} · ลบ stockLink
//   ลบรูปใน Storage ยังเป็นงานของแอปหลังได้ 200 (ST-098 · เดิมลบรูปก่อนแล้วไม่รอผลลบข้อมูล)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { unlinkWrites } = require("./link");
const S = require("./_shared");

function productDelete(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockProductDeleteRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.DELETE_PRODUCT)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(db.collection("shop").doc(access.shopId));
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const pSnap = await tx.get(db.collection("stock").doc(input.productId));
        const product = pSnap.exists ? pSnap.data() : undefined;
        const pc = checkOwnedDoc("stock", product, ref);
        if (!pc.ok) S.refuseWith(pc);
        if (product.deleted === true) return { alreadyDeleted: true };
        S.requireActiveStaff(shop, input.staffId, access);

        let live = [];
        let linkExists = false;
        if (product.linkId) {
          const linkRef = db.collection("stockLink").doc(String(product.linkId));
          const linkSnap = S.validDocId(product.linkId) ? await tx.get(linkRef) : { exists: false };
          const link = linkSnap.exists ? linkSnap.data() : undefined;
          if (link && !belongsToShop(link.shopId, ref)) S.refuse(409, "stock_link_other_shop");
          linkExists = Boolean(link);
          const ids = new Set(S.linkIdsOf(product));
          if (link) for (const m of Array.isArray(link.stockLink) ? link.stockLink : []) if (S.isObj(m) && S.validDocId(m.id)) ids.add(m.id);
          ids.delete(input.productId);
          const list = [...ids];
          const snaps = await Promise.all(list.map((id) => tx.get(db.collection("stock").doc(id))));
          list.forEach((id, i) => {
            const d = snaps[i] && snaps[i].exists ? snaps[i].data() : undefined;
            if (d === undefined) return;
            if (!belongsToShop(d.shopId, ref)) S.refuse(409, "stock_other_shop", "สมาชิกกลุ่มผูกชี้ไปร้านอื่น กรุณาติดต่อทีมงานเพื่อซ่อม", { productId: id });
            if (d.linkId === product.linkId) live.push({ id, doc: d });
          });
          // ตัวฐานของการแจก = ตัวที่ลบเอง (ยอดเดียวกันทั้งกลุ่ม · linkDetail ของตัวนี้มีตัวเองอยู่ ⇒ removeId ทำงาน)
          live = [{ id: input.productId, doc: product }, ...live];
        }
        const members = live.length ? unlinkWrites(tx, live, { now, trail, removeId: input.productId }) : [];
        if (linkExists) tx.delete(db.collection("stockLink").doc(String(product.linkId)));
        tx.update(db.collection("stock").doc(input.productId), {
          deleted: true,
          updateTime: now,
          deletedAt: now,
          deletedBy: { staffId: input.staffId, staffName: input.staffName },
          ...trail,
        });
        return { alreadyDeleted: false, members, linkDeleted: linkExists };
      });

      return ok(res, { productId: input.productId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { productDelete };

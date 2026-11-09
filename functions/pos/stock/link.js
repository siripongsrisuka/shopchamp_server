// pos/stock/link — กลุ่มผูกสต๊อก (ลัง แพ็ก ชิ้น): สร้าง · แก้ชื่อ/อัปหน่วย · เลิกผูก (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.linkCreate.yaml · stock.linkUpdate.yaml · stock.linkDelete.yaml
// ทางเดิม:
//   สร้าง  `main3:src/screens/StockLinkSettingScreen4.js:57-125` (batch ไม่ใช่ transaction · ค่าที่จำไว้ตอนเลือก ST-018)
//   แก้    `main3:src/screens/StockLinkEdit.js:63-101` (เขียน doc ทั้งก้อนจาก redux ST-062)
//   เลิกผูก `main3:src/screens/StockLinkScreen.js:115-150` (ไม่อ่าน stockLink สด ST-020)
// ด่านร่วม: callerAccess → schema → สิทธิ์ '114' ดูแลคลัง (เมนูผูกสต๊อกอยู่ในคลังสินค้า · MainProductScreen.js:44)
//   → แพ็กเกจพรีเมี่ยม (เมนูเดิม premium:true) ตรวจที่ server ใน transaction
//
// linkCreate (transaction):
//   อ่าน shop · stockLink/{linkUUID} · stock ทุกสมาชิก (สด · ST-018)
//   UUID เดิมของร้านนี้ = 200 duplicate (ST-060 กดซ้ำ) · ร้านอื่น 409 link_uuid_other_shop
//   สมาชิก: ไม่มี 404 · ร้านอื่น 409 stock_other_shop (#10) · ลบแล้ว 409 stock_deleted (ST-056)
//   logic.buildLinkGroup(doc สด + ตัวคูณจากคำขอ) ไม่ผ่าน = 409 link_invalid {errors:[{code,id}]}
//     already_linked (ST-019) · duplicate_id (ST-088) · mixed_stock_count (ST-061) · missing_base_unit/bad_link_multiply/duplicate_multiply (ST-040 ST-058)
//   เขียน stockLink/{linkUUID} รูปเดิม {shopId, stockGroupName, stockLink:[{id,name,unit,imageId,barcode,linkMultiply}], timestamp, upgrade} + {id}
//     stock ทุกสมาชิก รูปเดิม {stock, linkDetail, linkNext, linkQty, cost, linkMultiply, linkId, updateTime}
//     ทุนเฉลี่ยถ่วงเฉพาะตัวที่ยอด > 0 (#22 ST-059 · logic)
// linkUpdate (transaction): อ่าน stockLink (ร้านนี้) · สมาชิกที่ยังผูกกลุ่มนี้อยู่ (doc.linkId === linkId)
//   แก้เฉพาะ field ที่ส่ง ไม่เขียนทั้งก้อน (ST-062) · upgrade เปลี่ยน = คำนวณ linkNext/linkQty ใหม่จากตัวคูณในฐาน
//   ไม่มีอะไรเปลี่ยน = 200 unchanged ไม่เขียน (ST-091)
// linkDelete (transaction): อ่าน stockLink สด (ST-020) · ไม่มีแล้ว = 200 alreadyDeleted · สมาชิกที่ยังผูกกลุ่มนี้
//   แจกยอดรวมลงหน่วยใหญ่ไปเล็ก logic.spreadLinkStock (เศษและยอดติดลบไปหน่วยเล็กสุด ST-057)
//   เขียนสมาชิก {stock, linkDetail:[], linkNext:'', linkMultiply:'', linkQty:0, linkId:'', updateTime} (รูปเดิม) · ลบ stockLink
//   ทุนคงเดิม (ST-148 คงเดิม)
// DEV-0007: stock updateTime = serverTimestamp() (../_shared/stockJournal.js ①) · ยอดที่แปลงหน่วยตอนสร้าง/เลิกผูก ลงสมุด stockJournal kind 'link'
//   (ไม่ใช่ของเข้าออกจริง · ให้ ยอดต้นวัน + Σqty = ยอดปลายวัน ต่อ doc) · duplicate/alreadyDeleted ไม่ถึงจุดเขียน
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const S = require("./_shared");
const { serverTime, makeJournal, moveContext } = require("../_shared/stockJournal");

const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** linkNext/linkQty ของสมาชิกตัวคูณ m เมื่อเปิดอัปหน่วย · ปิด = '' และ 0 (รูปเดิม StockLinkEdit.js:72-80) */
function upgradeFieldsOf(m, rows, upgrade) {
  if (!upgrade) return { linkNext: "", linkQty: 0 };
  const next = rows.filter((a) => a.linkMultiply > m).sort((a, b) => a.linkMultiply - b.linkMultiply)[0];
  return next ? { linkNext: next.id, linkQty: S.round(next.linkMultiply / m) } : { linkNext: "", linkQty: 0 };
}

async function openShop(tx, access, now, { needPremium }) {
  const snap = await tx.get(db.collection("shop").doc(access.shopId));
  if (!snap.exists) S.refuse(404, "shop_not_found");
  const shop = snap.data() || {};
  const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
  return { shop, ref, premium: needPremium ? isPremiumActive(shop, now) : true };
}

function guarded(deps, schemaName, run) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf(schemaName), body, res);
      if (!input) return;
      if (!hasRight(access, S.RIGHTS.WAREHOUSE)) return sendDeny(res, deny(403, "right_required"));
      const now = await readNow(deps);
      const out = await run({ input, access, now, trail: adminTrail(access) });
      return ok(res, { ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

function linkCreate(deps) {
  return guarded(deps, "StockLinkCreateRequest", async ({ input, access, now, trail }) => {
    const linkRef = db.collection("stockLink").doc(input.linkUUID);
    return db.runTransaction(async (tx) => {
      const { shop, ref, premium } = await openShop(tx, access, now, { needPremium: true });
      const linkSnap = await tx.get(linkRef);
      if (linkSnap.exists) {
        if (!belongsToShop((linkSnap.data() || {}).shopId, ref)) S.refuse(409, "link_uuid_other_shop", "รหัสกลุ่มนี้เป็นของร้านอื่น");
        return { linkId: input.linkUUID, duplicate: true };
      }
      if (!premium) S.refuse(403, "premium_required");
      const docs = await S.readStockDocs(db, tx, input.members.map((m) => m.id), ref);
      const products = input.members.map((m) => {
        const d = docs.get(m.id);
        return { ...d, id: m.id, linkMultiply: m.linkMultiply };
      });
      const g = logic.buildLinkGroup(products, { upgrade: input.upgrade });
      if (!g.ok) S.refuse(409, "link_invalid", "ตั้งกลุ่มผูกสต๊อกไม่ได้", { errors: g.errors });
      const shopField = ref.shopId || access.shopId;
      tx.set(linkRef, {
        shopId: shopField,
        stockGroupName: input.stockGroupName,
        stockLink: input.members.map((m) => {
          const d = docs.get(m.id);
          return { id: m.id, name: str(d.name), unit: str(d.unit), imageId: str(d.imageId), barcode: str(d.barcode), linkMultiply: m.linkMultiply };
        }),
        timestamp: now,
        upgrade: input.upgrade,
        id: input.linkUUID,
        ...trail,
      });
      const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff, moves: moveContext({ shop, access, now, staffName: input.staffName, refId: input.linkUUID || input.linkId }) });
      for (const m of g.members) {
        journal.move("link", m.id, docs.get(m.id).stock, m.stock);
        tx.update(db.collection("stock").doc(m.id), {
          stock: m.stock,
          linkDetail: m.linkDetail,
          linkNext: m.linkNext,
          linkQty: m.linkQty,
          cost: m.cost,
          linkMultiply: m.linkMultiply,
          linkId: input.linkUUID,
          updateTime: serverTime(),
          ...trail,
        });
      }
      journal.write(tx, db, trail);
      return { linkId: input.linkUUID, duplicate: false, stock: g.stock, averageCost: g.averageCost, members: g.members.map(({ id, stock, cost }) => ({ id, stock, cost })) };
    });
  });
}

/** อ่าน stockLink ของร้านนี้ + สมาชิกที่ยังผูกกลุ่มนี้ · สมาชิกที่ไม่มี/ย้ายกลุ่ม/ร้านอื่น = ข้าม (บอกใน skipped) */
async function readGroup(tx, linkId, ref) {
  const linkSnap = await tx.get(db.collection("stockLink").doc(linkId));
  const link = linkSnap.exists ? linkSnap.data() : undefined;
  const ids = [];
  if (link) {
    const lc = checkOwnedDoc("stock_link", link, ref);
    if (!lc.ok) S.refuseWith(lc);
    for (const m of Array.isArray(link.stockLink) ? link.stockLink : []) if (S.isObj(m) && S.validDocId(m.id) && !ids.includes(m.id)) ids.push(m.id);
  }
  const snaps = await Promise.all(ids.map((id) => tx.get(db.collection("stock").doc(id))));
  const live = [];
  const skipped = [];
  ids.forEach((id, i) => {
    const d = snaps[i] && snaps[i].exists ? snaps[i].data() : undefined;
    if (d === undefined) skipped.push({ id, why: "not_found" });
    else if (!belongsToShop(d.shopId, ref)) S.refuse(409, "stock_other_shop", "สมาชิกกลุ่มผูกชี้ไปร้านอื่น กรุณาติดต่อทีมงานเพื่อซ่อม", { productId: id });
    else if (d.linkId !== linkId) skipped.push({ id, why: "not_in_group" });
    else live.push({ id, doc: d });
  });
  return { link, live, skipped };
}

function linkUpdate(deps) {
  return guarded(deps, "StockLinkUpdateRequest", async ({ input, access, now, trail }) => {
    return db.runTransaction(async (tx) => {
      const { ref, premium } = await openShop(tx, access, now, { needPremium: true });
      const { link, live, skipped } = await readGroup(tx, input.linkId, ref);
      if (!link) S.refuse(404, "stock_link_not_found");
      if (!premium) S.refuse(403, "premium_required");
      const patch = {};
      if (input.stockGroupName !== undefined && input.stockGroupName !== link.stockGroupName) patch.stockGroupName = input.stockGroupName;
      const upgradeChanged = input.upgrade !== undefined && input.upgrade !== link.upgrade;
      if (upgradeChanged) patch.upgrade = input.upgrade;
      if (!Object.keys(patch).length) return { linkId: input.linkId, unchanged: true };
      tx.update(db.collection("stockLink").doc(input.linkId), { ...patch, ...trail });
      if (upgradeChanged) {
        const rows = live
          .map(({ id, doc }) => ({ id, linkMultiply: logic.readLinkMultiply(doc.linkMultiply) }))
          .filter((r) => r.linkMultiply !== null);
        for (const r of rows) {
          tx.update(db.collection("stock").doc(r.id), { ...upgradeFieldsOf(r.linkMultiply, rows, input.upgrade), updateTime: serverTime(), ...trail });
        }
      }
      const out = { linkId: input.linkId, unchanged: false, changed: Object.keys(patch) };
      if (skipped.length) out.skipped = skipped;
      return out;
    });
  });
}

function linkDelete(deps) {
  return guarded(deps, "StockLinkDeleteRequest", async ({ input, access, now, trail }) => {
    return db.runTransaction(async (tx) => {
      const { shop, ref, premium } = await openShop(tx, access, now, { needPremium: true });
      const { link, live, skipped } = await readGroup(tx, input.linkId, ref);
      if (!link) return { linkId: input.linkId, alreadyDeleted: true };
      if (!premium) S.refuse(403, "premium_required");
      const journal = makeJournal({ shopDocId: access.shopId, now, cutOff: shop.cutOff, moves: moveContext({ shop, access, now, staffName: input.staffName, refId: input.linkUUID || input.linkId }) });
      const members = unlinkWrites(tx, live, { now, trail, journal, kind: "link" });
      journal.write(tx, db, trail);
      tx.delete(db.collection("stockLink").doc(input.linkId));
      const out = { linkId: input.linkId, alreadyDeleted: false, members };
      if (skipped.length) out.skipped = skipped;
      return out;
    });
  });
}

/**
 * unlinkWrites(tx, live, {now, trail, removeId, journal, kind}) — เขียนเลิกผูกให้สมาชิกที่ยังอยู่ · คืน [{id, stock}]
 *   journal (ไม่ส่งได้) = ลงผลต่างช่อง stock ของสมาชิกแต่ละตัวเป็นชนิด kind · ผู้เรียกเรียก journal.write เอง
 *   ยอดรวม = stock ของสมาชิกตัวแรกที่อ่านได้ (ทุกตัวเก็บยอดหน่วยเล็กสุดค่าเดียวกัน) · แจกด้วย linkDetail ในฐานของตัวนั้น
 *   removeId = ตัวที่กำลังถูกลบ (stock.productDelete · ST-009: ยอดของตัวนั้นย้ายไปหน่วยที่เหลือ ไม่หาย)
 */
function unlinkWrites(tx, live, { trail, removeId, journal, kind }) {
  if (!live.length) return [];
  const base = live.find((m) => Array.isArray(m.doc.linkDetail) && m.doc.linkDetail.length) || live[0];
  const spread = logic.spreadLinkStock(base.doc.stock, base.doc.linkDetail, removeId ? { removeId } : undefined);
  const byId = new Map(spread.map((x) => [x.id, x.stock]));
  const out = [];
  for (const { id, doc } of live) {
    if (id === removeId) continue;
    // สมาชิกที่ไม่อยู่ใน linkDetail ของตัวฐาน (ข้อมูลเพี้ยน) = แปลงยอดของตัวเองด้วยตัวคูณของตัวเอง
    const m = logic.readLinkMultiply(doc.linkMultiply) || 1;
    const stock = byId.has(id) ? byId.get(id) : S.round(S.num(doc.stock) / m);
    tx.update(db.collection("stock").doc(id), {
      stock,
      linkDetail: [],
      linkNext: "",
      linkMultiply: "",
      linkQty: 0,
      linkId: "",
      updateTime: serverTime(),
      ...trail,
    });
    if (journal) journal.move(kind, id, doc.stock, stock);
    out.push({ id, stock });
  }
  return out;
}

module.exports = { linkCreate, linkUpdate, linkDelete, unlinkWrites, readGroup, upgradeFieldsOf };

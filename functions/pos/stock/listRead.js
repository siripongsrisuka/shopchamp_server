// pos/stock/listRead.js — อ่านรายการเล็กของกลุ่มสต๊อกผ่าน API แทนการอ่าน Firestore ตรงจากแอป (DEV-0010 คลื่น 2 · ชุดตกหล่น)
//
// linkList (stock.linkList · POST /pos/stock/link-list): แทน fetchStockLink `shopchamp_app/src/redux/stockLinkSlice.js:19`
//   ของเดิม: stockLink where shopId == shop.shopId (ไม่มี limit) · ผู้เรียก StockLinkScreen.js:93
//   ใหม่:    stockLink where shopId == K (ไม่มี limit แบบเดิม) → {links:[{...doc, id}]} เรียง doc id (แอปเรียง timestamp เองแบบเดิม)
//   สิทธิ์ '101' (เมนูตั้งค่า HomeScreen.js:78 → ShopSettingScreen → MainProductScreen) + พรีเมี่ยม (เมนูผูกสต๊อก premium:true `MainProductScreen.js:44`)
//
// receiveList (stock.receiveList · POST /pos/stock/receive-list): แทน fetchImports `redux/supplierSlice.js:24`
//   ของเดิม: importProduct where shopId == shop.shopId orderBy dateTime desc limit 30 · ผู้เรียก ImportProductHistory.js:53
//   ใหม่:    importProduct where shopId == K orderBy dateTime desc, __name__ desc [startAfter(Timestamp, id)] limit n (ไม่ส่ง = 30)
//            index importProduct(shopId ASC, dateTime DESC, __name__ DESC) มีใน shopchamp_server/firestore.indexes.json และบน live (READY · ตรวจ 2026-11-14)
//   - อ่านแค่ n ใบ ไม่อ่านเผื่อ (+1) ⇒ หน้าแรกค่าอ่านเท่าแอปเดิมเป๊ะ · หน้าเต็ม = มี nextCursor (ใบสุดท้ายที่อ่าน) · ไม่เต็ม = null
//     หน้าเต็มพอดีกับใบสุดท้ายของร้าน → คำขอถัดไปได้หน้าว่าง (อ่าน 1) nextCursor null
//   - cursor = "1|<seconds>|<nanos>|<doc id>" (ตัวช่วยเดียวกับ stock.sync `_shared/syncCursor.js`) · เวลาละเอียดเท่าที่ Firestore เก็บ ไม่ปัด ms
//   - ใบที่ dateTime ไม่ใช่เวลา (สตริง/เลข) อยู่ในหน้าแรกได้แบบ query เดิม · ไม่คืนในหน้าที่ใช้ cursor · หน้าไม่มีใบที่เป็นเวลาเลย = nextCursor null
//   สิทธิ์ '101' (จอประวัติอยู่ใต้ ตั้งค่า → จัดการสินค้า → บัญชีรับสินค้า `MainImportScreen.js:20` · ไม่มีทางเข้าจากเมนู 115) · ไม่มีพรีเมี่ยม (เมนู premium:false `MainProductScreen.js:42`)
//
// supplierList (stock.supplierList · POST /pos/stock/supplier-list): แทน fetchSupplier `redux/supplierSlice.js:46`
//   ของเดิม: supplier where shopId == shop.shopId (ไม่มี limit) · ผู้เรียก SupplierScreen.js:50 (ใต้ตั้งค่า 101) · ImportProductScreen.js:232 (เมนูรับเข้าสินค้า 115)
//   ใหม่:    supplier where shopId == K → {suppliers:[{...doc, id}]} เรียง doc id
//   สิทธิ์ '101' หรือ '115' · ไม่มีพรีเมี่ยม
//
// ทุกเส้น: คืน doc เต็ม + id · เวลาทุกช่อง (ซ้อนในก้อนด้วย) เป็น ISO · ตัดเฉพาะรอยทีมงาน/ผู้แก้ (STRIP ตัวเดียวกับ stock.sync) · ไม่ทำระบบปกปิด (Pack 2026-11-14 ข้อ 7)
// K = ช่อง shopId ของ doc ร้านที่ผู้เรียกผ่านด่านแล้ว (ไม่มี/ไม่ใช่สตริง = doc id) · แบบแอปเดิม (Pack 2026-11-14 ข้อ 8)
// ด่าน: middleware requireShopAccess (สมาชิกร้าน active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน · ได้ทุกสิทธิ์แบบเจ้าของ)
//   เลขสิทธิ์/พรีเมี่ยม = เท่าที่แอปตรวจที่เมนูตอนนี้ (Pack 2026-11-14 ข้อ 9)
// ค่าอ่าน: shop 1 ครั้ง (ด่าน requireShopAccess · handler ใช้ doc ที่ด่านแนบ shopSnapOf ไม่อ่านซ้ำ) + doc ที่ได้ (ขั้นต่ำ 1) · เท่าแอปเดิม
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน · ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db, admin } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, shopSnapOf } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { toPlain, tsKey, cmpKey, toTimestamp, encodeCursor, parseCursor } = require("../_shared/syncCursor");
const S = require("./_shared");
const { STRIP } = require("./syncRead");

const RECEIVE_PAGE = 30; // เท่า limit(30) ของแอปเดิม `supplierSlice.js:28`

/** shopKey(shopDocId, shop) — ค่าที่ใช้ค้น `<doc>.shopId` แบบแอปเดิม: ช่อง shopId ของร้าน · ไม่มี = doc id */
function shopKey(shopDocId, shop) {
  return typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : shopDocId;
}

function itemOf(id, d) {
  const out = {};
  for (const k of Object.keys(d)) if (!STRIP.includes(k)) out[k] = toPlain(d[k]);
  out.id = id;
  return out;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** gate + schema + สิทธิ์ + อ่านร้าน (+ พรีเมี่ยม) → {access, input, shop, key} · ไม่ผ่าน = ตอบไปแล้ว คืน null */
async function open(req, res, deps, { schema, rightOk, premium }) {
  const body = S.isObj(req && req.body) ? req.body : {};
  const gate = callerAccess(req, body.shopId, { read: true });
  if (!gate.ok) { sendDeny(res, gate); return null; }
  const access = gate.access;
  const input = parseOr400(S.schemaOf(schema), body, res);
  if (!input) return null;
  if (!rightOk(access)) { sendDeny(res, deny(403, "right_required")); return null; }
  const snap = await shopSnapOf(db, access);
  if (!snap.exists) { sendDeny(res, deny(404, "shop_not_found")); return null; }
  const shop = snap.data() || {};
  if (premium) {
    const now = await readNow(deps);
    if (!isPremiumActive(shop, now)) { sendDeny(res, deny(403, "premium_required", "ฟีเจอร์ สำหรับแพ็กเกจพรีเมี่ยม")); return null; }
  }
  return { access, input, shop, key: shopKey(access.shopId, shop) };
}

/** ทั้งร้านแบบไม่มี limit (แบบแอปเดิม) · กรองร้านซ้ำในโค้ด · เรียง doc id */
async function listAll(coll, key) {
  const snap = await db.collection(coll).where("shopId", "==", key).get();
  return (snap.docs || [])
    .map((s) => ({ id: s.id, d: s.data() || {} }))
    .filter((r) => r.d.shopId === key)
    .sort(byId)
    .map((r) => itemOf(r.id, r.d));
}

function linkList(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, deps, { schema: "StockLinkListRequest", rightOk: (a) => hasRight(a, S.RIGHTS.SETTING), premium: true });
      if (!o) return;
      const links = await listAll("stockLink", o.key);
      return ok(res, { ...adminFlag(o.access), links });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function supplierList(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, deps, {
        schema: "StockSupplierListRequest",
        rightOk: (a) => hasRight(a, S.RIGHTS.SETTING) || hasRight(a, S.RIGHTS.RECEIVE),
        premium: false,
      });
      if (!o) return;
      const suppliers = await listAll("supplier", o.key);
      return ok(res, { ...adminFlag(o.access), suppliers });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function receiveList(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, deps, { schema: "StockReceiveListRequest", rightOk: (a) => hasRight(a, S.RIGHTS.SETTING), premium: false });
      if (!o) return;
      const cur = o.input.cursor === undefined ? null : parseCursor(o.input.cursor);
      if (o.input.cursor !== undefined && !cur) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "cursor", message: "cursor ไม่ถูกต้อง (ใช้ nextCursor จากคำตอบเท่านั้น)" }] });
      const limit = o.input.limit || RECEIVE_PAGE;

      let q = db.collection("importProduct").where("shopId", "==", o.key).orderBy("dateTime", "desc").orderBy("__name__", "desc");
      if (cur) q = q.startAfter(toTimestamp(cur, admin), cur.id);
      const snap = await q.limit(limit).get();
      // จำนวนที่อ่านจริง (ก่อนกรอง) ตัดสินว่าหน้าเต็มไหม · เรียง/ตัดตาม cursor ซ้ำในโค้ด (ฐานจริงทำมาแล้ว · กันฐานปลอมที่ไม่เรียง/ไม่ startAfter)
      const raw = (snap.docs || []).slice(0, limit).map((s) => ({ id: s.id, d: s.data() || {} }));
      const keyed = raw.map((r) => ({ ...r, k: (() => { const t = tsKey(r.d.dateTime); return t ? { ...t, id: r.id } : null; })() }));
      const rows = keyed
        .filter((r) => r.d.shopId === o.key)
        .filter((r) => !cur || (r.k !== null && cmpKey(r.k, cur) < 0))
        .sort((a, b) => (a.k && b.k ? cmpKey(b.k, a.k) : a.k ? 1 : b.k ? -1 : byId(b, a)));
      // cursor = ใบที่เวลาเก่าสุดในหน้า (= ใบสุดท้ายของ desc) · ใบที่ dateTime ไม่ใช่เวลาทำ cursor ไม่ได้ และไม่คืนในหน้าถัดไป (แอปเดิมไม่เคยเห็นเกิน 30 ใบ)
      const oldest = keyed.filter((r) => r.k !== null).reduce((m, r) => (!m || cmpKey(r.k, m.k) < 0 ? r : m), null);
      const nextCursor = raw.length >= limit && oldest ? encodeCursor(oldest.k) : null;
      const receipts = rows.map((r) => itemOf(r.id, r.d));
      return ok(res, { ...adminFlag(o.access), receipts, nextCursor });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { linkList, receiveList, supplierList, shopKey };

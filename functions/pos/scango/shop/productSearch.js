// pos/scango/shop/productSearch — หน้าละ ≤50 สินค้าของร้านสำหรับจอเลือกสินค้าขายบน ScanGo (สัญญา scango.productSearch · auth 'shop')
//
// คำขอ {shopId, q?, categoryId?, selectedOnly?, cursor?}
//   q          ชื่อมีคำนี้ (ไม่สนตัวพิมพ์) หรือบาร์โค้ดมีคำนี้ · ว่าง/ไม่ส่ง = ทุกตัว
//   categoryId หมวดอยู่ใน stock.category (เส้นทาง id หมวด · ตัวไหนในเส้นก็ได้ = หมวดแม่เจอลูกด้วย)
//   selectedOnly true = เฉพาะที่เลือกไว้ (เรียงตาม shop.scango.productIds) · ไม่ส่ง = ไล่ทั้งร้านเรียงตาม doc id
//   cursor     ค่า nextCursor จากหน้าก่อน (ห้ามสร้างเอง · ผิดรูป = 400 invalid_request)
// คำตอบ 200 {ok, items:[{productId, name, price, barcode, unit, imageId, category, stock, stockCountStatus, selected}],
//            nextCursor: string|null, selectedCount}
//   ⚠️ ได้น้อยกว่า 50 แต่ nextCursor ไม่ใช่ null ได้ (ไล่ครบเพดานอ่านก่อนเจอครบหน้า) ⇒ แอปเรียกต่อด้วย nextCursor จนเป็น null
// เพดานอ่าน: ไล่ทั้งร้าน ≤400 doc ต่อคำขอ (where shopId == · orderBy __name__ · startAfter · ไม่ต้องมี index ประกอบ)
//   ร้าน S5 (doc id ≠ field shopId ที่พิสูจน์แล้ว) ไล่ทีละกุญแจ: doc id ก่อน แล้ว field
//   selectedOnly อ่าน ≤50 doc ต่อคำขอ (ตาม id ที่เลือก)
// ด่าน: callerAccess (อ่าน) → schema → สิทธิ์ '111' (คนเดียวกับที่ตั้งรายการได้) · ข้ามตัวที่ลบแล้ว / เป็นของร้านอื่น
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny, fail } = require("../../_shared/respond");
const { callerAccess, hasRight, adminFlag, resolveShopRef, belongsToShop } = require("../../_shared/auth");
const C = require("./_common");

const PAGE_SIZE = 50;
const SCAN_LIMIT = 400;

const str = (v) => (v === undefined || v === null ? "" : String(v));
const numOrNull = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

function itemOf(id, d, selected) {
  return {
    productId: id,
    name: C.isObj(d.name) ? "" : str(d.name),
    price: numOrNull(d.price),
    barcode: str(d.barcode),
    unit: C.isObj(d.unit) ? "" : str(d.unit),
    imageId: typeof d.imageId === "string" ? d.imageId : "",
    category: Array.isArray(d.category) ? d.category.filter((x) => typeof x === "string") : typeof d.category === "string" && d.category ? [d.category] : [],
    stock: numOrNull(d.stock),
    stockCountStatus: d.stockCountStatus === true,
    selected,
  };
}

function matcher(input) {
  const q = (input.q || "").trim().toLowerCase();
  const cat = input.categoryId;
  return (item) => {
    if (cat && !item.category.includes(cat)) return false;
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.barcode.toLowerCase().includes(q);
  };
}

/** cursor: 's|<keyIdx>|<afterId>' (ไล่ทั้งร้าน) · 'i|<index>' (เฉพาะที่เลือก) · ผิดรูป = null */
function parseCursor(raw, selectedOnly) {
  if (raw === undefined) return selectedOnly ? { i: 0 } : { k: 0, after: "" };
  if (selectedOnly) {
    const m = /^i\|(\d{1,4})$/.exec(raw);
    return m ? { i: Number(m[1]) } : null;
  }
  const m = /^s\|([01])\|(.+)$/.exec(raw);
  return m ? { k: Number(m[1]), after: m[2] } : null;
}

async function scanShop(keys, cur, match, selectedSet) {
  const items = [];
  let budget = SCAN_LIMIT;
  let k = cur.k;
  let after = cur.after;
  while (k < keys.length && budget > 0) {
    let q = db.collection("stock").where("shopId", "==", keys[k]).orderBy("__name__");
    if (after) q = q.startAfter(after);
    const snap = await q.limit(budget).get();
    const docs = snap.docs || [];
    budget -= docs.length;
    for (const s of docs) {
      after = s.id;
      const d = s.data() || {};
      if (d.deleted === true) continue;
      const it = itemOf(s.id, d, selectedSet.has(s.id));
      if (match(it)) {
        items.push(it);
        if (items.length >= PAGE_SIZE) return { items, next: `s|${k}|${after}` };
      }
    }
    if (docs.length > 0 && budget <= 0) return { items, next: `s|${k}|${after}` };
    k += 1;
    after = "";
  }
  return { items, next: null };
}

async function scanSelected(ids, cur, match, shopRef) {
  const part = ids.slice(cur.i, cur.i + PAGE_SIZE);
  const snaps = await Promise.all(part.map((id) => db.collection("stock").doc(id).get()));
  const items = [];
  snaps.forEach((s, j) => {
    const d = s && s.exists ? s.data() : undefined;
    if (!C.isObj(d) || d.deleted === true || !belongsToShop(d.shopId, shopRef)) return;
    const it = itemOf(part[j], d, true);
    if (match(it)) items.push(it);
  });
  const end = cur.i + part.length;
  return { items, next: end < ids.length ? `i|${end}` : null };
}

function productSearch(_deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.ProductSearchRequest, body, res);
      if (!input) return;
      if (!hasRight(access, C.RIGHTS.EDIT_PRODUCT)) return sendDeny(res, deny(403, "right_required", undefined, { right: C.RIGHTS.EDIT_PRODUCT }));
      const cur = parseCursor(input.cursor, input.selectedOnly === true);
      if (!cur) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "cursor", message: "cursor ไม่ถูกต้อง" }] });

      const snap = await db.collection("shop").doc(access.shopId).get();
      if (!snap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = snap.data() || {};
      const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });
      const selectedIds = C.scangoOf(shop).productIds;
      const match = matcher(input);

      const out = input.selectedOnly === true
        ? await scanSelected(selectedIds, cur, match, shopRef)
        : await scanShop([...new Set([shopRef.id, shopRef.shopId].filter(Boolean))], cur, match, new Set(selectedIds));
      return ok(res, { items: out.items, nextCursor: out.next, selectedCount: selectedIds.length, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { productSearch, PAGE_SIZE, SCAN_LIMIT };

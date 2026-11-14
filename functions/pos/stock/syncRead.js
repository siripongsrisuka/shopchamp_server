// pos/stock/syncRead.js — อ่านสินค้าของร้านผ่าน API แทนการอ่าน Firestore ตรงจากแอป (DEV-0010 · คลื่น 2)
//
// sync (stock.sync · POST /pos/stock/sync): สินค้าของร้านทีละหน้า แทน fetchLastProduct (`shopchamp_app/src/hook/useLocalStock.js:546`)
//   ของเดิม: stock where shopId == shop.shopId and updateTime > watermark (ไม่มี limit · watermark = JS Date ละเอียดแค่ ms)
//   ใหม่:    stock where shopId == K and updateTime > FLOOR orderBy updateTime, __name__ startAfter(cursor) limit n+1
//            index stock(shopId ASC, updateTime ASC, __name__ ASC) มีใน shopchamp_server/firestore.indexes.json
//   - ไม่ส่ง cursor = โหลดทั้งร้านตั้งแต่ต้น · ส่ง cursor = เฉพาะตัวที่เปลี่ยนหลังจุดนั้น · query เดียวกันทั้ง 2 แบบ
//   - cursor = "1|<seconds>|<nanos>|<doc id>" ของ doc สุดท้ายที่**อ่าน** (รวมตัวที่ลบ) · server สร้าง แอปเก็บเฉย ๆ
//     ⇒ หลาย doc ที่เขียนใน transaction/batch เดียวได้ updateTime เดียวกันเป๊ะ ข้ามรอยต่อหน้าไม่หาย (เทียบคู่ เวลา+id)
//     ⇒ เวลาละเอียดเท่าที่ Firestore เก็บ (ไม่ปัดเป็น ms) · หน้าเต็มไปด้วย doc เวลาเดียวกันก็เดินต่อได้ ไม่วน
//   - FLOOR = new Date(2011,0,1) เวลาไทย (ค่าตั้งต้น watermark ของแอปเดิม · `>` แบบเดิม) ⇒ โหลดทั้งร้านได้ประชากรเท่าแอปเดิม
//     และกรองให้เหลือเฉพาะ doc ที่ updateTime เป็นเวลาจริง (orderBy อย่างเดียวจะพา doc ที่ช่องนี้เป็นสตริง/เลขมาด้วย)
//   - ตัวที่ลบ (deleted === true หรือ sku === 'delete' · แบบ splitSyncedProducts `shopchamp_app/src/domain/localStock.js:35`)
//     คืนแค่ id ใน deletedIds · ตัวอื่นคืน doc เต็ม + id · เวลาทุกช่อง (ซ้อนในก้อนด้วย) เป็น ISO
//   - ตัดเฉพาะรอยทีมงาน/ผู้แก้ที่แอปไม่อ่าน (STRIP · grep shopchamp_app/src แล้วไม่มีจอไหนอ่านจาก doc สินค้า) · ไม่ซ่อน cost (Pack 2026-11-14 ข้อ 6)
//   ค่าอ่าน: shop 1 + จำนวน doc ที่ได้ (+1 ตัวดูว่ามีหน้าต่อไหม) · ขั้นต่ำ 1 ต่อคำขอ · doc เท่าของเดิม (ของเดิมไม่ limit)
//
// findBarcode (stock.findBarcode · POST /pos/stock/find-barcode): แทน `.where('barcode','==',code)` 7 จอ + คลังกลาง 3 จอ
//   stock where shopId == K and barcode == code (ไม่ limit แบบเดิม) → ตัวที่ไม่ลบทั้งหมด เรียง doc id (แอปเดิมเอาตัวสุดท้าย)
//   catalog: true และไม่เจอในร้าน → product where barcode == code limit 1 (แอปเดิมใช้ docs[0]) → {id, barcode, imageId, name, unit}
//     ไม่ส่ง catalog = ไม่อ่านคลังกลาง (ค่าอ่านไม่เกินของเดิมของจอที่ไม่ใช้คลังกลาง)
//
// K = ช่อง shopId ของ doc ร้านที่ผู้เรียกผ่านด่านแล้ว (ไม่มี/ไม่ใช่สตริง = doc id) · แบบแอปเดิม (Pack 2026-11-14 ข้อ 8)
// ด่าน: middleware requireShopAccess (สมาชิกร้าน active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน)
//   ไม่มีเลขสิทธิ์ · เท่ากับแอปเดิม (จอขายโหลดสินค้าทั้งร้าน · สแกนได้ทุกคน · จอเช็ค 110/111 ฝั่งแอปต่อเหมือนเดิม · Pack ข้อ 9)
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน · ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db, admin } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { callerAccess, adminFlag } = require("../_shared/auth");
const S = require("./_shared");
// cursor เวลานาโนวินาที+id · FLOOR · การเรียง/กรองหน้า = ตัวช่วยกลางที่ member.indexSync ใช้ร่วม (ยกจากไฟล์นี้ ไม่เปลี่ยนพฤติกรรม)
const { toPlain, parseCursor, encodeCursor, readChangedPage, nextCursorOf } = require("../_shared/syncCursor");

const DEFAULT_LIMIT = 500;
// รอยทีมงาน/ผู้แก้ที่ server เขียนลง stock (productSave · productDelete · adminTrail) · แอปไม่อ่าน
const STRIP = Object.freeze(["createdBy", "updatedBy", "deletedBy", "deletedAt", "byAdmin", "adminUid"]);
const CATALOG_FIELDS = Object.freeze(["barcode", "imageId", "name", "unit"]);

const isDeleted = (d) => d.deleted === true || d.sku === "delete";

/** shopKey(shopDocId, shop) — ค่าที่ใช้ค้น `<doc>.shopId` แบบแอปเดิม: ช่อง shopId ของร้าน · ไม่มี = doc id */
function shopKey(shopDocId, shop) {
  return typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : shopDocId;
}

async function readShop(access, res) {
  const snap = await db.collection("shop").doc(access.shopId).get();
  if (!snap.exists) { sendDeny(res, deny(404, "shop_not_found")); return null; }
  return snap.data() || {};
}

function itemOf(id, d) {
  const out = {};
  for (const k of Object.keys(d)) if (!STRIP.includes(k)) out[k] = toPlain(d[k]);
  out.id = id;
  return out;
}

function sync(_deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockSyncRequest"), body, res);
      if (!input) return;
      const cur = input.cursor === undefined ? null : parseCursor(input.cursor);
      if (input.cursor !== undefined && !cur) return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "cursor", message: "cursor ไม่ถูกต้อง (ใช้ nextCursor จากคำตอบเท่านั้น)" }] });
      const shop = await readShop(access, res);
      if (!shop) return;
      const key = shopKey(access.shopId, shop);
      const limit = input.limit || DEFAULT_LIMIT;

      const { page, hasMore } = await readChangedPage({ db, admin, coll: "stock", keys: [key], cursor: cur, limit });
      const items = [];
      const deletedIds = [];
      for (const r of page) {
        if (isDeleted(r.d)) deletedIds.push(r.id);
        else items.push(itemOf(r.id, r.d));
      }
      const nextCursor = nextCursorOf(page, cur, input.cursor);
      return ok(res, { ...adminFlag(access), items, deletedIds, nextCursor, hasMore });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function findBarcode(_deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockFindBarcodeRequest"), body, res);
      if (!input) return;
      const shop = await readShop(access, res);
      if (!shop) return;
      const key = shopKey(access.shopId, shop);

      const snap = await db.collection("stock").where("shopId", "==", key).where("barcode", "==", input.barcode).get();
      const stock = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.shopId === key && r.d.barcode === input.barcode && !isDeleted(r.d))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => itemOf(r.id, r.d));

      const catalog = [];
      if (!stock.length && input.catalog === true) {
        const cs = await db.collection("product").where("barcode", "==", input.barcode).limit(1).get();
        for (const s of (cs.docs || []).slice(0, 1)) {
          const d = s.data() || {};
          if (d.barcode !== input.barcode) continue;
          const c = { id: s.id };
          for (const f of CATALOG_FIELDS) c[f] = d[f] === undefined ? null : toPlain(d[f]);
          catalog.push(c);
        }
      }
      return ok(res, { ...adminFlag(access), stock, catalog });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { sync, findBarcode, parseCursor, encodeCursor, STRIP };

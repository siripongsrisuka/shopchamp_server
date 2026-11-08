// pos/stock/_shared.js — ตัวช่วยร่วมของโดเมนสต๊อก (ก้อน 9a · DEV-0001)
//
// ใช้กับ handler ทุกตัวใน pos/stock/ · ไม่ใช่ไฟล์กลางของ pos (pos/_shared/ ไม่แตะ)
// ❌ ไม่ require SDK ตัวจริง · db มาจาก ../../firebase (harness แทนของปลอม)
//
// หลักร่วมของทุก handler (อ่าน lanes/dev/source/chunk9/9a-stock.md):
//   1. callerAccess → 401 no_shop_access · 403 wrong_shop (ก่อนตรวจรูปคำขอ)
//   2. schema (@shopchamp/schema) → 400 invalid_request
//   3. สิทธิ์ของแอปเก่า (rights) → 403 right_required · เจ้าของ/ทีมงานผ่านทุกสิทธิ์
//   4. transaction: อ่านครบก่อนเขียน · doc สินค้าทุกตัวต้องเป็นของร้านนี้ (ไม่มี 404 · ร้านอื่น 409 · ไม่คืนเนื้อ)
//      ⇒ ร้าน clone ที่กลุ่มผูกยังชี้ร้านต้นทาง (#10 ST-001) จะเขียนข้ามร้านไม่ได้เลยผ่าน API ใหม่
//   5. เขียนเพิ่ม field อย่างเดียว (แอปเก่าอ่านได้ตามเดิม) · เวลา = นาฬิกา server (deps.now) แทน serverTimestamp()
//      ยกเว้น stock updateTime = serverTimestamp() เวลา commit (DEV-0007 · ../_shared/stockJournal.js) + สมุด stockJournal ใน tx เดียวกัน
"use strict";

const logic = require("@shopchamp/logic");
const { deny } = require("../_shared/respond");
const { belongsToShop, staffStatusOf } = require("../_shared/auth");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v !== "";
const DOC_ID_MAX = 128;
const validDocId = (v) => isNonEmptyString(v) && v.length <= DOC_ID_MAX && !v.includes("/") && v !== "." && v !== "..";

// รหัสสิทธิ์ของแอปเก่า (`main3:src/screens/StaffScreen.js:46-76`)
const RIGHTS = Object.freeze({
  SETTING: "101",
  ADD_PRODUCT: "110",
  EDIT_PRODUCT: "111",
  EDIT_COST: "112",
  DELETE_PRODUCT: "113",
  WAREHOUSE: "114",
  RECEIVE: "115",
  EXP: "121",
  EDIT_PRICE: "127",
  EDIT_STOCK: "128",
  REQUISITION: "132",
});

class Refusal extends Error {
  constructor(d) {
    super(d.error);
    this.deny = d;
  }
}
const refuse = (status, error, message, extra) => {
  throw new Refusal(deny(status, error, message, extra));
};
const refuseWith = (d) => {
  throw new Refusal(d);
};

/** schemaOf(name) — คำขอจาก @shopchamp/schema · ไม่มี = throw (ตอบ 500 · ไม่ผ่านเงียบ) */
function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

/** คนทำรายการต้องอยู่ในร้านและ active (B-11) · ทีมงานใช้ uid ตัวเองได้ */
function requireActiveStaff(shop, staffId, access) {
  const st = staffStatusOf(shop, staffId, access);
  if (st === "not_in_shop") refuse(409, "staff_not_in_shop", "ไม่พบพนักงานที่ทำรายการในร้านนี้");
  if (st !== "active") refuse(409, "staff_inactive", "พนักงานที่ทำรายการไม่ได้อยู่ในสถานะใช้งาน");
}

/**
 * readStockDocs(tx, ids, shopRef, {allowDeleted}) → Map(id → data)
 *   ทุก id: ไม่มี = 404 stock_not_found {productId} · ร้านอื่น = 409 stock_other_shop {productId} · ลบแล้ว = 409 stock_deleted (ST-056)
 *   productId ที่ตอบกลับ = id ที่ร้านนี้ส่งมาหรือ id ที่อยู่ในกลุ่มผูกของร้านนี้ (ไม่คืนเนื้อเอกสารร้านอื่น)
 */
async function readStockDocs(db, tx, ids, shopRef, opts) {
  const o = opts || {};
  const out = o.into instanceof Map ? o.into : new Map();
  const todo = [...new Set(ids)].filter((id) => !out.has(id));
  for (const id of todo) if (!validDocId(id)) refuse(409, "stock_link_broken", "กลุ่มผูกสต๊อกของสินค้านี้เสีย กรุณาติดต่อทีมงาน", { productId: String(id) });
  const snaps = await Promise.all(todo.map((id) => tx.get(db.collection("stock").doc(id))));
  todo.forEach((id, i) => {
    const s = snaps[i];
    const d = s && s.exists ? s.data() : undefined;
    if (d === undefined || d === null) refuse(404, "stock_not_found", "ไม่พบสินค้า", { productId: id });
    if (!belongsToShop(d.shopId, shopRef)) {
      // สมาชิกกลุ่มผูกที่ชี้ร้านอื่น = ร่องรอยร้าน clone (#10) · บอกทางแก้ ไม่คืนข้อมูลร้านอื่น
      refuse(409, "stock_other_shop", "สินค้าหรือกลุ่มผูกสต๊อกชี้ไปร้านอื่น กรุณาติดต่อทีมงานเพื่อซ่อม", { productId: id });
    }
    if (d.deleted === true && !o.allowDeleted) refuse(409, "stock_deleted", "สินค้านี้ถูกลบแล้ว", { productId: id });
    out.set(id, d);
  });
  return out;
}

/** ids ของสมาชิกกลุ่มผูกจาก doc (รับตัวคูณสตริงเก่า · ไม่ทิ้งตัวที่ตัวคูณพัง) */
function linkIdsOf(doc) {
  const rows = isObj(doc) && Array.isArray(doc.linkDetail) ? doc.linkDetail : [];
  const out = [];
  for (const r of rows) if (isObj(r) && isNonEmptyString(r.id) && !out.includes(r.id)) out.push(r.id);
  return out;
}

/** วันที่จากคำขอ (ISO) → Date · อ่านไม่ได้ = null */
function dateOf(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** ค่าเวลาในฐาน (Timestamp · Date · map {seconds} · ISO) → ms · อ่านไม่ได้ = null */
function msOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (v && typeof v === "object") {
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v.toDate === "function") return v.toDate().getTime();
    if (typeof v.seconds === "number") return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    if (typeof v._seconds === "number") return v._seconds * 1000;
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** วันไทย YYYYMMDD ของค่าเวลาใดก็ได้ · อ่านไม่ได้ = null (กติกาเทียบวันของ Modal_Exp.js:44 `NumberYMD`) */
function thaiDayOf(v) {
  const ms = msOf(v);
  if (ms === null) return null;
  const p = logic.periodOf("day", ms, "Asia/Bangkok");
  return p.ok ? String(p.key) : null;
}

/**
 * removeOneExp(expReport, day) → {list, removed}
 *   ลบล็อตเดียวที่ตรงวัน (ST-110 · เดิมกรองทุกล็อตของวันนั้นทิ้ง) · ค่าอื่นในลิสต์คงรูปเดิม (ไม่แปลงชนิด)
 */
function removeOneExp(expReport, day) {
  const list = Array.isArray(expReport) ? expReport.slice() : [];
  const i = list.findIndex((x) => thaiDayOf(x) === day);
  if (i < 0) return { list, removed: false };
  list.splice(i, 1);
  return { list, removed: true };
}

const num = (v) => logic.toNumber(v);
const round = (v) => logic.roundStock(v);

module.exports = {
  RIGHTS,
  Refusal,
  refuse,
  refuseWith,
  schemaOf,
  requireActiveStaff,
  readStockDocs,
  linkIdsOf,
  dateOf,
  msOf,
  thaiDayOf,
  removeOneExp,
  isObj,
  isNonEmptyString,
  validDocId,
  num,
  round,
};

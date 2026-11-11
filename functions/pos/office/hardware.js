// pos/office/hardware — หน้า "อุปกรณ์ที่ขาย" ของ shopchampoffice: ตั้งค่าสินค้า · จัดเรียง · หมวด · ค่าส่ง (DEV-0003 0d · Pack สั่ง 2026-11-11)
//
// แบบ: lanes/dev/source/office-hardware-catalog-design.md · Pack เคาะ 1b (หมวด) · 2a (ไม่มีลบแถว ใช้ปิดขาย) · 3b (ตั้งค่าส่งได้)
// สัญญา (ร่าง รอ Pack เซ็น): shopchamp-center/api/office.hw*.yaml (7 ไฟล์) · ตัวสร้างสัญญา: lanes/dev/source/office-hardware-cases.js
//
// ที่เก็บ: doc เดียว admin/hardware (ที่เดิม · แอปเก่า 3.12 อ่านตรง)
//   value[]       แถวอุปกรณ์ {id, name, price:string, limit:string, detail, status:boolean, imageId, categoryId?:string|null} · ลำดับ array = ลำดับที่ร้านเห็น
//   categories[]  {id, name, active} · ลำดับ array = ลำดับหมวด
//   shipping      {fee:int บาท, freeFrom:int บาท | null} · ไม่มีช่อง = 100/4000 (logic.companyHardwareShipping)
//   admin[]       uid รับ push · ❌ ไม่แตะ (เขียนด้วย tx.update เฉพาะช่องที่เกี่ยว · ไม่ set ทั้ง doc)
//   updatedAt · updatedBy (email || uid) · updatedByUid
// รอย: hardwareCatalogLog/{เวลา_uid_การกระทำ} {action, by, byUid, at, before, after} ใน transaction เดียวกับการเขียน
//
// สิทธิ์ (S.gate จาก watcher/roster ทุกคำขอ): hwCatalog = ทีมงาน (watcher + root) คืน canEdit · ที่เหลือ = root · ไม่ใช้ passkey (ถอด 2026-11-11)
// คำขอ: ตรวจรูปใน handler (strict · field เกิน = 400 invalid_request) · doc หาย/value ไม่ใช่ array = 503 hardware_config_unavailable
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const S = require("./_officeStore");
const C = require("./_officeCore");

const LOG = "hardwareCatalogLog";
const IMAGE_PREFIX = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/equipment%2F";
const IMAGE_MAX = 1000;
const NAME_MAX = 200;
const DETAIL_MAX = 2000;
const CAT_NAME_MAX = 60;
const PRICE_MAX = 10000000;
const LIMIT_MAX = 9999;
const LIMIT_NONE = "999"; // limit เว้นว่าง = 999 (เดิม '' ทำให้แอปเก่าสั่งได้ชิ้นเดียว)
const SHIP_FEE_MAX = 100000;
const SHIP_FREE_MAX = 10000000;
const ID_MAX = 128;

const str = (v) => (typeof v === "string" ? v : "");
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const hwRef = () => db.collection("admin").doc("hardware");

// ── ตรวจรูปคำขอ (strict · field เกิน = 400) ─────────────────────────────────
function bad(message) { S.refuse(400, "invalid_request", message); }
function bodyOf(req) {
  const b = req ? req.body : undefined;
  if (b === undefined || b === null) return {};
  if (!isObj(b)) bad("คำขอต้องเป็น object");
  return b;
}
function onlyKeys(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`ไม่รับช่อง: ${extra.join(", ")}`);
}
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
function idOf(v, label) {
  if (typeof v !== "string" || v.trim() === "" || v.length > ID_MAX) bad(`${label} ต้องเป็นข้อความ 1-${ID_MAX} ตัว`);
  return v;
}
function textOf(v, label, min, max) {
  if (typeof v !== "string") bad(`${label} ต้องเป็นข้อความ`);
  const t = v.trim();
  if (t.length < min || t.length > max) bad(min ? `${label} ต้องยาว ${min}-${max} ตัว` : `${label} ยาวได้ไม่เกิน ${max} ตัว`);
  return t;
}
function boolOf(v, label) {
  if (typeof v !== "boolean") bad(`${label} ต้องเป็น true/false`);
  return v;
}
/** ราคา: ตัวเลข > 0 ≤ 1e7 ทศนิยมไม่เกิน 2 ตำแหน่ง → เก็บเป็น string ("1500" · "1500.5") */
function priceOf(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > PRICE_MAX) bad(`price ต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน ${PRICE_MAX}`);
  const satang = Math.round(v * 100);
  if (Math.abs(satang - v * 100) > 1e-6) bad("price ทศนิยมได้ไม่เกิน 2 ตำแหน่ง");
  return String(satang / 100);
}
/** limit: จำนวนเต็ม 1-9999 หรือ null (= ไม่จำกัด "999") → string */
function limitOf(v) {
  if (v === null) return LIMIT_NONE;
  if (!Number.isSafeInteger(v) || v < 1 || v > LIMIT_MAX) bad(`limit ต้องเป็นจำนวนเต็ม 1-${LIMIT_MAX} หรือ null`);
  return String(v);
}
function intIn(v, lo, hi, label) {
  if (!Number.isSafeInteger(v) || v < lo || v > hi) bad(`${label} ต้องเป็นจำนวนเต็ม ${lo}-${hi}`);
  return v;
}
function orderedIdsOf(v) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "" || x.length > ID_MAX)) bad("orderedIds ต้องเป็นรายการรหัส (ข้อความ)");
  if (new Set(v).size !== v.length) bad("orderedIds มีรหัสซ้ำ");
  return v;
}
/** รูป: '' หรือ URL ใน Storage equipment/ ของ shopcham-24b0b · แถวเดิมส่งค่าเดิมกลับมา = รับ (แถวเก่ามี URL รูปอื่น) */
const imageOk = (v) => v === "" || (v.length <= IMAGE_MAX && v.startsWith(IMAGE_PREFIX));

// ── ของร่วม ────────────────────────────────────────────────────────────────
function wrap(run) {
  return async function handler(req, res) {
    try {
      return await run(req, res);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}
function unavailable() { S.refuse(503, "hardware_config_unavailable", "ไม่พบการตั้งค่าอุปกรณ์ (admin/hardware) · ติดต่อผู้ดูแลระบบ"); }
/** snap → data · doc หาย หรือ value ไม่ใช่ array = 503 */
function liveOf(snap) {
  const d = snap && snap.exists ? snap.data() : null;
  if (!isObj(d) || !Array.isArray(d.value)) unavailable();
  return d;
}
const catsOf = (d) => (Array.isArray(d.categories) ? d.categories.filter(isObj) : []);
const logRef = (now, uid, action) => db.collection(LOG).doc(`${S.stamp(now)}_${uid}_${action}`);

/**
 * write(g, now, action, build) — transaction: อ่าน admin/hardware → build(live) คืน {patch, before, after, out}
 *   tx.update เฉพาะช่องใน patch + updatedAt/By · tx.create รอยใน hardwareCatalogLog · คืน out
 */
async function write(g, now, action, build) {
  const ref = hwRef();
  return db.runTransaction(async (tx) => {
    const live = liveOf(await tx.get(ref));
    const { patch, before, after, out } = build(live);
    const by = g.email || g.uid;
    tx.update(ref, { ...patch, updatedAt: now, updatedBy: by, updatedByUid: g.uid });
    tx.create(logRef(now, g.uid, action), { action, by, byUid: g.uid, at: now, before: before === undefined ? null : before, after: after === undefined ? null : after });
    return out;
  });
}
const sameSet = (ids, want) => ids.length === want.length && want.every((x) => ids.includes(x));
function mismatch() { S.refuse(409, "arrange_mismatch", "รายการที่ส่งมาไม่ตรงกับของในฐาน (มีคนแก้ระหว่างนี้?) · โหลดใหม่แล้วลองอีกครั้ง"); }

// ── รูปคำตอบ ────────────────────────────────────────────────────────────────
function itemView(r) {
  const priceText = r.price === undefined || r.price === null ? "" : String(r.price);
  const satang = typeof r.price === "number"
    ? (Number.isFinite(r.price) && r.price >= 0 ? logic.toSatang(r.price) : null)
    : /^\s*\d+(\.\d+)?\s*$/.test(priceText) ? logic.toSatang(priceText.trim()) : null;
  const limitText = r.limit === undefined || r.limit === null ? "" : String(r.limit);
  const ln = /^\s*\d+\s*$/.test(limitText) ? Number(limitText.trim()) : NaN;
  return {
    id: str(r.id),
    name: str(r.name),
    price: Number.isSafeInteger(satang) ? satang / 100 : null,
    priceText,
    limit: Number.isSafeInteger(ln) && ln >= 1 ? ln : logic.COMPANY_HARDWARE_LIMIT_DEFAULT,
    limitText,
    detail: str(r.detail),
    status: r.status === true,
    imageId: str(r.imageId),
    categoryId: typeof r.categoryId === "string" && r.categoryId !== "" ? r.categoryId : null,
  };
}
function catalogOf(d) {
  const items = d.value.filter(isObj).map(itemView);
  const categories = catsOf(d).map((c) => ({
    id: str(c.id), name: str(c.name), active: c.active === true, count: items.filter((it) => it.categoryId === c.id).length,
  }));
  return { items, categories, shipping: logic.companyHardwareShipping(d), updatedAt: C.isoOf(d.updatedAt), updatedBy: str(d.updatedBy) || null };
}

// ── handler ────────────────────────────────────────────────────────────────

function hwCatalog(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    onlyKeys(bodyOf(req), []);
    await readNow(deps);
    const g = await S.gate(req, "staff");
    const d = liveOf(await hwRef().get());
    return ok(res, { ...catalogOf(d), canEdit: g.role === WR.ROLE.ROOT });
  });
}

function hwItemSave(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id", "name", "price", "limit", "detail", "status", "imageId", "categoryId"]);
    const id = has(b, "id") ? idOf(b.id, "id") : null;
    for (const k of ["name", "price", "limit", "detail", "status", "imageId", "categoryId"]) if (!has(b, k)) bad(`ขาดช่อง ${k}`);
    const fields = {
      name: textOf(b.name, "name", 1, NAME_MAX),
      price: priceOf(b.price),
      limit: limitOf(b.limit),
      detail: textOf(b.detail, "detail", 0, DETAIL_MAX),
      status: boolOf(b.status, "status"),
    };
    if (typeof b.imageId !== "string") bad("imageId ต้องเป็นข้อความ");
    const imageId = b.imageId;
    const categoryId = b.categoryId === null ? null : idOf(b.categoryId, "categoryId");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");

    const out = await write(g, now, "itemSave", (live) => {
      if (categoryId !== null && !catsOf(live).some((c) => c.id === categoryId)) S.refuse(409, "hw_category_not_found", "ไม่พบหมวดนี้ (อาจถูกลบไปแล้ว) · โหลดใหม่แล้วลองอีกครั้ง");
      const value = live.value.slice();
      const at = id === null ? -1 : value.findIndex((r) => isObj(r) && r.id === id);
      if (id !== null && at < 0) S.refuse(404, "hw_item_not_found", "ไม่พบสินค้านี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const prev = at >= 0 ? value[at] : null;
      if (!imageOk(imageId) && !(prev && str(prev.imageId) === imageId && imageId !== "")) bad("imageId ต้องว่าง หรือเป็นรูปที่อัปขึ้น Storage โฟลเดอร์ equipment ของ Shopchamp");
      const row = prev
        ? { ...prev, ...fields, imageId, categoryId }
        : { id: crypto.randomUUID(), ...fields, imageId, categoryId };
      if (prev) value[at] = row; else value.push(row);
      return { patch: { value }, before: prev, after: row, out: { id: row.id, created: !prev } };
    });
    return ok(res, out);
  });
}

function hwArrange(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["orderedIds"]);
    const orderedIds = orderedIdsOf(b.orderedIds);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const out = await write(g, now, "arrange", (live) => {
      const rows = live.value;
      const ids = rows.map((r) => (isObj(r) ? r.id : undefined));
      if (ids.some((x) => typeof x !== "string") || new Set(ids).size !== ids.length || !sameSet(ids, orderedIds)) mismatch();
      const byId = new Map(rows.map((r) => [r.id, r]));
      return { patch: { value: orderedIds.map((x) => byId.get(x)) }, before: ids, after: orderedIds, out: { count: orderedIds.length } };
    });
    return ok(res, out);
  });
}

function hwCategorySave(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id", "name", "active"]);
    const id = has(b, "id") ? idOf(b.id, "id") : null;
    if (!has(b, "name") || !has(b, "active")) bad("ต้องมีช่อง name และ active");
    const name = textOf(b.name, "name", 1, CAT_NAME_MAX);
    const active = boolOf(b.active, "active");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const out = await write(g, now, "categorySave", (live) => {
      const categories = catsOf(live).slice();
      const at = id === null ? -1 : categories.findIndex((c) => c.id === id);
      if (id !== null && at < 0) S.refuse(404, "hw_category_not_found", "ไม่พบหมวดนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const prev = at >= 0 ? categories[at] : null;
      const row = prev ? { ...prev, name, active } : { id: crypto.randomUUID(), name, active };
      if (prev) categories[at] = row; else categories.push(row);
      return { patch: { categories }, before: prev, after: row, out: { id: row.id, created: !prev } };
    });
    return ok(res, out);
  });
}

function hwCategoryArrange(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["orderedIds"]);
    const orderedIds = orderedIdsOf(b.orderedIds);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const out = await write(g, now, "categoryArrange", (live) => {
      const cats = catsOf(live);
      const ids = cats.map((c) => c.id);
      if (ids.some((x) => typeof x !== "string") || new Set(ids).size !== ids.length || !sameSet(ids, orderedIds)) mismatch();
      const byId = new Map(cats.map((c) => [c.id, c]));
      return { patch: { categories: orderedIds.map((x) => byId.get(x)) }, before: ids, after: orderedIds, out: { count: orderedIds.length } };
    });
    return ok(res, out);
  });
}

function hwCategoryDelete(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id"]);
    const id = idOf(b.id, "id");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const out = await write(g, now, "categoryDelete", (live) => {
      const cats = catsOf(live);
      const prev = cats.find((c) => c.id === id);
      if (!prev) S.refuse(404, "hw_category_not_found", "ไม่พบหมวดนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const used = live.value.filter((r) => isObj(r) && r.categoryId === id).length;
      if (used) S.refuse(409, "category_in_use", `หมวดนี้ยังมีสินค้า ${used} รายการ · ย้ายสินค้าออกก่อนจึงลบได้`, { count: used });
      return { patch: { categories: cats.filter((c) => c.id !== id) }, before: prev, after: null, out: { id, deleted: true } };
    });
    return ok(res, out);
  });
}

function hwShippingSave(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["fee", "freeFrom"]);
    if (!has(b, "fee") || !has(b, "freeFrom")) bad("ต้องมีช่อง fee และ freeFrom (null = ไม่มีส่งฟรี)");
    const shipping = { fee: intIn(b.fee, 0, SHIP_FEE_MAX, "fee"), freeFrom: b.freeFrom === null ? null : intIn(b.freeFrom, 0, SHIP_FREE_MAX, "freeFrom") };
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const out = await write(g, now, "shippingSave", (live) => ({
      patch: { shipping },
      before: isObj(live.shipping) ? live.shipping : null,
      after: shipping,
      out: { shipping: logic.companyHardwareShipping({ shipping }) },
    }));
    return ok(res, out);
  });
}

module.exports = {
  LOG, IMAGE_PREFIX, catalogOf, itemView,
  hwCatalog, hwItemSave, hwArrange, hwCategorySave, hwCategoryArrange, hwCategoryDelete, hwShippingSave,
};

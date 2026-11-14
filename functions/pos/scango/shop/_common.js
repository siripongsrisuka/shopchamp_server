// pos/scango/shop/_common.js — ของร่วมของเส้นฝั่งแอปร้าน `scango.*` (auth 'shop') · ไม่ใช่ handler · ไม่มี route
//
// แบบ: lanes/dev/source/shopchamp-scango-design.md §"แอปร้าน → Shopchamp server"
// `shop.scango` = {enabled, location:{lat,lng}|null, hours:[{day,open,close}], minOrder, deliveryFee, freeDeliveryMin|null,
//                  maxKm, prepMinutes, paymentQr, pickupNote, productIds:[≤1000], deliveryFeeModel?}
//   DEV-0009 (Pack "ลุย" 2026-11-13): ค่าตั้งร้านทั้งหมดอยู่บนเว็บร้าน ScanGo · ฝั่งนี้เขียนแค่ productIds (relay สินค้า) และ enabled (/scango/link)
//   ช่องอื่นในฐานเป็นของรุ่นก่อน ไม่มีใครเขียนแล้ว · _deliveryFee ยังอ่านค่าส่งไปใส่เมนู (scango.menu)
//   ร้านที่ยังไม่เคยตั้ง = ไม่มีช่อง scango · ผู้อ่านเติมค่าตั้งต้น (DEFAULTS) เอง ไม่เขียนค่าตั้งต้นลงฐาน
// คำขอตรวจด้วย zod ในไฟล์นี้ (ยังไม่มีใน @shopchamp/schema · ❌ ไม่แก้ packages)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { z } = require("zod");
const { deny } = require("../../_shared/respond");

const PRODUCT_LIMIT = 1000;

// รหัสสิทธิ์ของแอปเก่า (`main3:src/screens/StaffScreen.js:46-76` · ชุดเดียวกับ stock/_shared.js RIGHTS)
const RIGHTS = Object.freeze({ SALE: "100", EDIT_PRODUCT: "111" });

const ORDER_STATES = Object.freeze(["requested", "accepted", "ready", "picked_up", "delivering", "delivered", "cancelled", "failed"]);
const DEFAULTS = Object.freeze({
  enabled: false,
  location: null,
  hours: [],
  minOrder: 0,
  deliveryFee: 0,
  freeDeliveryMin: null,
  maxKm: 5,
  prepMinutes: 15,
  paymentQr: "",
  pickupNote: "",
});
const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (status, error, message, extra) => { throw new Refusal(deny(status, error, message, extra)); };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const DOC_ID_MAX = 128;
const DocId = z.string().min(1).max(DOC_ID_MAX).refine((v) => !v.includes("/") && v !== "." && v !== "..", "รหัสเอกสารไม่ถูกต้อง");
/** อ่านค่าเวลาในฐาน (Timestamp · Date · {seconds} · ISO) → ISO · อ่านไม่ได้ = ค่าเดิม */
function isoOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (v && typeof v === "object") {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6)).toISOString();
    if (typeof v._seconds === "number") return new Date(v._seconds * 1000).toISOString();
  }
  return v;
}
/** แปลงเวลาทุกชั้นของเอกสารเป็น ISO (คำตอบเป็น JSON) */
function jsonSafe(v) {
  if (v instanceof Date || (v && typeof v === "object" && (typeof v.toDate === "function" || typeof v.seconds === "number" || typeof v._seconds === "number"))) return isoOf(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = jsonSafe(v[k]); return o; }
  return v;
}

/** scangoOf(shop) — ค่าตั้งของร้าน + ค่าตั้งต้น · productIds เฉพาะ string */
function scangoOf(shop) {
  const s = shop && isObj(shop.scango) ? shop.scango : {};
  const out = {};
  for (const k of SETTING_FIELDS) out[k] = s[k] === undefined ? DEFAULTS[k] : s[k];
  out.productIds = Array.isArray(s.productIds) ? s.productIds.filter((x) => typeof x === "string") : [];
  return out;
}

const SettingsGetRequest = z.object({ shopId: DocId }).strict();

// productIds ยาวเกินเพดานได้ถึง 5000 ตัว (ตอบ 409 too_many_products บอกจำนวน) · เกินนั้น = 400
const ProductsSetRequest = z.object({ shopId: DocId, productIds: z.array(DocId).max(5000) }).strict();

const ProductSearchRequest = z
  .object({
    shopId: DocId,
    q: z.string().max(100).optional(),
    categoryId: DocId.optional(),
    selectedOnly: z.boolean().optional(),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict();

const OrderListRequest = z.object({ shopId: DocId, states: z.array(z.enum(ORDER_STATES)).min(1).max(ORDER_STATES.length).optional() }).strict();

// DEV-0009 สเปกข้อ 6: ร้านกดรับใบในแอป (scango.orderAccept)
const OrderAcceptRequest = z.object({ shopId: DocId, orderRef: DocId }).strict();

/**
 * orderOut(orderRef, data) — เนื้อใบที่ส่งให้แอป (order-list · order-accept) · เวลาเป็น ISO
 *   items[].productRef = ซ้ำ productId (ใบเก็บ productRef ของ ScanGo ไว้ในช่อง productId · แอปเรียกตามสัญญา v1 ว่า productRef)
 */
function orderOut(orderRef, data) {
  const o = { ...jsonSafe(data || {}), orderRef };
  if (Array.isArray(o.items)) o.items = o.items.map((it) => (isObj(it) && it.productRef === undefined ? { ...it, productRef: it.productId === undefined ? null : it.productId } : it));
  return o;
}

/** uniq(list) — ตัดตัวซ้ำ คงลำดับแรกที่เจอ */
const uniq = (list) => [...new Set(list)];

module.exports = {
  PRODUCT_LIMIT,
  RIGHTS,
  ORDER_STATES,
  DEFAULTS,
  SETTING_FIELDS,
  Refusal,
  refuse,
  isObj,
  jsonSafe,
  scangoOf,
  uniq,
  SettingsGetRequest,
  ProductsSetRequest,
  ProductSearchRequest,
  OrderListRequest,
  OrderAcceptRequest,
  orderOut,
};

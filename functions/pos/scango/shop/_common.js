// pos/scango/shop/_common.js — ของร่วมของเส้นฝั่งแอปร้าน `scango.*` (auth 'shop') · ไม่ใช่ handler · ไม่มี route
//
// แบบ: lanes/dev/source/shopchamp-scango-design.md §"แอปร้าน → Shopchamp server"
// `shop.scango` = {enabled, location:{lat,lng}|null, hours:[{day,open,close}], minOrder, deliveryFee, freeDeliveryMin|null,
//                  maxKm, prepMinutes, paymentQr, pickupNote, productIds:[≤1000]}
//   ร้านที่ยังไม่เคยตั้ง = ไม่มีช่อง scango · ผู้อ่านเติมค่าตั้งต้น (DEFAULTS) เอง ไม่เขียนค่าตั้งต้นลงฐาน
// คำขอตรวจด้วย zod ในไฟล์นี้ (ยังไม่มีใน @shopchamp/schema · ❌ ไม่แก้ packages)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { z } = require("zod");
const { deny } = require("../../_shared/respond");

const PRODUCT_LIMIT = 1000;
const OWNER_REQUIRED = "เฉพาะเจ้าของร้าน";

// รหัสสิทธิ์ของแอปเก่า (`main3:src/screens/StaffScreen.js:46-76` · ชุดเดียวกับ stock/_shared.js RIGHTS)
const RIGHTS = Object.freeze({ SALE: "100", EDIT_PRODUCT: "111" });

const ORDER_STATES = Object.freeze(["requested", "accepted", "ready", "picked_up", "delivering", "delivered", "cancelled", "failed"]);
/** สถานะส่ง venue_ordering ที่ settingsSave รายงาน (คำเดียวกับ `../_outbound`.venueStatusOf) */
const VENUE_STATUSES = Object.freeze(["sent", "queued", "skipped", "failed"]);
/** เลขพร้อมเพย์ 10/13/15 หลัก (ช่องว่าง/ขีดได้) — รูปที่ ScanGo ใช้ให้ไรเดอร์สร้าง QR (`_outbound.paymentQrOf`) */
const PROMPTPAY_RE = /^[\d\s-]{10,19}$/;
const isPromptpayId = (v) => typeof v === "string" && PROMPTPAY_RE.test(v) && /^(\d{10}|\d{13}|\d{15})$/.test(v.replace(/[\s-]/g, ""));

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
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "เวลาต้องเป็น HH:mm");
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const money = (max) => z.number().finite().min(0).max(max);

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

/** missingForEnable(settings) — ของที่ขาดก่อนเปิดรับใบ: 'location' · 'hours' · 'products' */
function missingForEnable(s) {
  const miss = [];
  const loc = s && s.location;
  if (!isObj(loc) || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) miss.push("location");
  if (!Array.isArray(s && s.hours) || !s.hours.length) miss.push("hours");
  if (!Array.isArray(s && s.productIds) || !s.productIds.length) miss.push("products");
  return miss;
}

const Hour = z.object({ day: z.number().int().min(0).max(6), open: HHMM, close: HHMM }).strict();

const SettingsGetRequest = z.object({ shopId: DocId }).strict();

const SettingsSaveRequest = z
  .object({
    shopId: DocId,
    enabled: z.boolean(),
    location: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict().nullable(),
    hours: z.array(Hour).max(21),
    minOrder: money(1000000),
    deliveryFee: money(10000),
    freeDeliveryMin: money(1000000).nullable(),
    maxKm: z.number().finite().gt(0).max(50),
    prepMinutes: z.number().int().min(0).max(240),
    // '' = ไม่รับโอน · เลขพร้อมเพย์ 10/13/15 หลัก = ส่งให้ ScanGo ให้ไรเดอร์สร้าง QR ได้ · ลิงก์รูป https (แอป 5.00 รุ่นแรกอัปโหลดรูป QR)
    //   = เก็บได้แต่ ScanGo ใช้ไม่ได้ ⇒ บน ScanGo ร้านรับเงินสดอย่างเดียว (ดู `../_outbound`.paymentQrOf · ตัดสินเอง 2026-11-11 รายงาน Pack)
    paymentQr: z.union([
      z.literal(""),
      z.string().max(19).refine(isPromptpayId, "เลขพร้อมเพย์ต้องเป็นตัวเลข 10, 13 หรือ 15 หลัก"),
      z.string().max(2048).url().refine((u) => u.startsWith("https://"), "ต้องเป็น https"),
    ]),
    pickupNote: z.string().max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    // ช่วงเวลาต่อวัน: เปิดก่อนปิด (ข้ามเที่ยงคืน = แยก 2 แถว) · ไม่ทับกัน · ≤3 ช่วงต่อวัน
    const byDay = new Map();
    v.hours.forEach((h, i) => {
      const a = minutesOf(h.open), b = minutesOf(h.close);
      if (a >= b) ctx.addIssue({ code: "custom", path: ["hours", i], message: "เวลาเปิดต้องก่อนเวลาปิด" });
      if (!byDay.has(h.day)) byDay.set(h.day, []);
      byDay.get(h.day).push([a, b, i]);
    });
    for (const rows of byDay.values()) {
      if (rows.length > 3) ctx.addIssue({ code: "custom", path: ["hours", rows[3][2]], message: "ไม่เกิน 3 ช่วงต่อวัน" });
      rows.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < rows.length; i++) if (rows[i][0] < rows[i - 1][1]) ctx.addIssue({ code: "custom", path: ["hours", rows[i][2]], message: "ช่วงเวลาทับกัน" });
    }
  });

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

const OrderActionRequest = z
  .object({
    shopId: DocId,
    orderRef: DocId,
    action: z.enum(["accept", "ready", "reject"]),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.action !== "reject" || !!v.reason, { path: ["reason"], message: "ปฏิเสธต้องใส่เหตุผล" });

/** uniq(list) — ตัดตัวซ้ำ คงลำดับแรกที่เจอ */
const uniq = (list) => [...new Set(list)];

module.exports = {
  PRODUCT_LIMIT,
  OWNER_REQUIRED,
  RIGHTS,
  ORDER_STATES,
  VENUE_STATUSES,
  isPromptpayId,
  DEFAULTS,
  SETTING_FIELDS,
  Refusal,
  refuse,
  isObj,
  jsonSafe,
  scangoOf,
  missingForEnable,
  uniq,
  SettingsGetRequest,
  SettingsSaveRequest,
  ProductsSetRequest,
  ProductSearchRequest,
  OrderListRequest,
  OrderActionRequest,
};

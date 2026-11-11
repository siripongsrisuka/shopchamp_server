// pos/scango/_menu.js — สูตรล้วนของช่องทาง ScanGo (pure · ไม่แตะฐาน · ไม่อ่านนาฬิกาเอง)
//
// แบบ: lanes/dev/source/shopchamp-scango-design.md §เส้นเชื่อม · รูปเมนู/ค่าส่ง = สัญญา §b ของร้านพี่น้อง (ScanGo อ่านรูปเดียวกันทุกเจ้า)
//   ใช้ร่วม: menu · deliveryQuote · orderCreate ⇒ ราคา/ของหมด/ค่าส่ง เลขเดียวกันทุกเส้นโดยโครงสร้าง
//
// ค่าตั้งร้าน `shop.scango` = {enabled, location:{lat,lng}, hours:[{day,open,close}], minOrder, deliveryFee, freeDeliveryMin|null,
//   maxKm, prepMinutes, paymentQr, pickupNote, productIds:[≤1000]}
//   hours: day 0-6 (0 = อาทิตย์ · เวลาไทย UTC+7) · open/close 'HH:mm' · close ≤ open = ข้ามเที่ยงคืน (close == open = 24 ชม.)
//          ไม่มี/ว่าง = เปิดตลอด (ตัดสินเอง · รายงาน Pack) · แถวผิดรูป = ไม่นับ
// ราคา: `logic.linePrice(stock, 1, {now})` ต่อหน่วย · fullPrice มีเฉพาะเมื่อโปรลดจริง · ❌ ไม่ส่งโปรท้ายบิล/สมาชิก/ส่วนลดค่าส่ง/ส่วนลดกลุ่ม (D1)
// หมด: stockCountStatus === true และ stock ≤ 0 (อ่านไม่ออก = หมด · fail-closed)
// ค่าส่ง: เหมาเท่ากันทุกระยะใน maxKm · ส่งฟรีเมื่อค่าสินค้า ≥ freeDeliveryMin (ร้านออกแทน shopPays) · maxKm ไม่ตั้ง = นอกระยะทุกที่
"use strict";

const crypto = require("crypto");
const logic = require("@shopchamp/logic");

const PROVIDER_ID = "shopchamp";
const PRODUCT_MAX = 1000;
const TZ_OFFSET_MS = 7 * 3600 * 1000; // ไทยไม่มี DST
const DISABLED_DISCOUNT = Object.freeze({ enabled: false, tiers: Object.freeze([]) });

const str = (v) => (v == null ? "" : String(v).trim());
const num = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const round2 = (n) => logic.toSatang(n) / 100;

/** ค่าตั้งร้านที่อ่านแล้ว (ค่าแปลก = ค่าปลอดภัย) */
function configOf(shop) {
  const s = isObj(shop) && isObj(shop.scango) ? shop.scango : {};
  const nonNeg = (v) => { const n = num(v); return n !== null && n >= 0 ? n : null; };
  const free = nonNeg(s.freeDeliveryMin);
  const maxKm = nonNeg(s.maxKm);
  const prep = num(s.prepMinutes);
  return {
    enabled: s.enabled === true,
    hours: Array.isArray(s.hours) ? s.hours : [],
    minOrder: nonNeg(s.minOrder) || 0,
    deliveryFee: nonNeg(s.deliveryFee) || 0,
    freeDeliveryMin: free !== null && free > 0 ? free : null,
    maxKm: maxKm !== null && maxKm > 0 ? maxKm : null,
    prepMinutes: prep !== null && prep >= 1 && prep <= 240 ? Math.round(prep) : null,
    productIds: [...new Set((Array.isArray(s.productIds) ? s.productIds : []).filter((x) => typeof x === "string" && x !== "" && !x.includes("/")))].slice(0, PRODUCT_MAX),
  };
}

// ── เวลาเปิดปิด ──────────────────────────────────────────────────────────
const hm = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 24 && mi < 60 && h * 60 + mi <= 1440 ? h * 60 + mi : null;
};

/** isOpenAt(hours, now) → boolean · ไม่มีแถวที่ใช้ได้เลย = เปิดตลอด */
function isOpenAt(hours, now) {
  const rows = (Array.isArray(hours) ? hours : [])
    .filter(isObj)
    .map((r) => ({ day: Number(r.day), open: hm(r.open), close: hm(r.close) }))
    .filter((r) => Number.isInteger(r.day) && r.day >= 0 && r.day <= 6 && r.open !== null && r.close !== null);
  if (!rows.length) return true;
  const local = new Date(now.getTime() + TZ_OFFSET_MS);
  const day = local.getUTCDay();
  const t = local.getUTCHours() * 60 + local.getUTCMinutes();
  const yesterday = (day + 6) % 7;
  for (const r of rows) {
    if (r.open === r.close && r.day === day) return true;
    if (r.close > r.open) { if (r.day === day && t >= r.open && t < r.close) return true; continue; }
    if (r.day === day && t >= r.open) return true; // ข้ามเที่ยงคืน ส่วนของวันนี้
    if (r.day === yesterday && t < r.close) return true; // ข้ามเที่ยงคืน ส่วนที่ล้นมาจากเมื่อวาน
  }
  return false;
}

/** acceptingOf(shop, now) → {accepting, reason} · reason ศัพท์เดียวกับพี่น้อง: ordering_disabled | shop_closed */
function acceptingOf(shop, now) {
  const c = configOf(shop);
  if (!c.enabled) return { accepting: false, reason: "ordering_disabled" };
  if (!isOpenAt(c.hours, now)) return { accepting: false, reason: "shop_closed" };
  return { accepting: true, reason: null };
}

// ── สินค้า ───────────────────────────────────────────────────────────────
const isDeleted = (p) => !isObj(p) || p.deleted === true || p.sku === "delete";

/** isOut(stock) — ตัดสต๊อกและเหลือ ≤ 0 (อ่านไม่ออก = หมด) */
function isOut(p) {
  if (!isObj(p) || p.stockCountStatus !== true) return false;
  const n = num(p.stock);
  return !(n !== null && n > 0);
}

/** stockLeft(stock) → จำนวนที่เหลือ (ไม่ตัดสต๊อก = Infinity) */
function stockLeft(p) {
  if (!isObj(p) || p.stockCountStatus !== true) return Infinity;
  const n = num(p.stock);
  return n !== null && n > 0 ? n : 0;
}

/**
 * unitPriceOf(stock, now) → null (ขายบน ScanGo ไม่ได้) | {price, fullPrice?, priceType}
 *   ไม่ได้: ลบแล้ว · ราคากำหนดเองตอนขาย (customPriceStatus) · linePrice อ่านราคาไม่ออก
 */
function unitPriceOf(p, now) {
  if (isDeleted(p) || p.customPriceStatus === true) return null;
  const r = logic.linePrice(p, 1, { now });
  if (!r || r.ok !== true) return null;
  const price = round2(r.net);
  const full = round2(r.totalPrice);
  return full > price ? { price, fullPrice: full, priceType: r.priceType } : { price, priceType: r.priceType };
}

const categoryPathOf = (p) => (Array.isArray(p.category) ? p.category.map(str).filter(Boolean) : str(p.category) ? [str(p.category)] : []);

/** productView(stock, now) → Menu.Product | null */
function productView(p, now) {
  const priced = unitPriceOf(p, now);
  if (!priced) return null;
  return {
    productId: str(p.id),
    name: str(p.name),
    description: "",
    imageUrl: typeof p.imageId === "string" ? p.imageId : "",
    price: priced.price,
    ...(priced.fullPrice !== undefined ? { fullPrice: priced.fullPrice } : {}),
    status: isOut(p) ? "out" : "available",
    categoryPath: categoryPathOf(p),
    optionGroups: [],
  };
}

/** ต้นไม้หมวดจาก shop.smartCategory (group → value[] · parent = aboveId ตัวสุดท้าย) */
function categoryTreeOf(smartCategory) {
  const items = [];
  for (const g of Array.isArray(smartCategory) ? smartCategory : []) {
    for (const it of isObj(g) && Array.isArray(g.value) ? g.value : []) if (isObj(it) && str(it.id)) items.push(it);
  }
  const nodes = new Map();
  for (const it of items) if (!nodes.has(str(it.id))) nodes.set(str(it.id), { id: str(it.id), name: str(it.name), kind: "category", children: [], above: Array.isArray(it.aboveId) ? it.aboveId.map(str).filter(Boolean) : [] });
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.above.length ? nodes.get(n.above[n.above.length - 1]) : null;
    if (parent && parent !== n) parent.children.push(n); else roots.push(n);
  }
  const walk = (list) => list.map((n) => (n.children.length ? { id: n.id, name: n.name, kind: n.kind, children: walk(n.children) } : { id: n.id, name: n.name, kind: n.kind }));
  return walk(roots);
}

// ── ค่าส่ง ───────────────────────────────────────────────────────────────
/** ระยะปัดขึ้น 0.1 กม. (กันเศษลอย 3.2000000001) */
const ceilKm = (km) => Math.ceil(Number((km * 10).toFixed(6))) / 10;

/** กติกาส่งฟรีในรูปขั้นบันไดของสัญญา (ขั้นเดียว maxOff null = ส่งฟรี) · ScanGo คิดเลขเดียวกับร้านพี่น้องรุ่นที่ใช้ freeDeliveryMin */
function deliveryDiscountView(cfg) {
  return cfg.freeDeliveryMin ? { enabled: true, tiers: [{ minSubtotal: cfg.freeDeliveryMin, maxOff: null }] } : { ...DISABLED_DISCOUNT, tiers: [] };
}

/** สูตรค่าส่งในรูปของสัญญา (เหมาทุกระยะ · baseKm = ไกลสุด) */
function deliveryFeeModelOf(cfg) {
  return { distance: "road", baseKm: cfg.maxKm || 0, baseFee: cfg.deliveryFee, bands: [] };
}

/**
 * quoteDelivery(shop, {distanceKm, foodSubtotal}) — เลขเดียวกับที่ orderCreate คิด
 *   fee = ลูกค้าจ่าย · riderFee = ไรเดอร์ได้ (เต็มเสมอ) · shopPays = ร้านออกแทนเมื่อส่งฟรี
 *   foodSubtotal null = ไม่รู้ยอด = ไม่ฟรี (fail-closed)
 */
function quoteDelivery(shop, { distanceKm, foodSubtotal }) {
  const cfg = configOf(shop);
  const roundedKm = ceilKm(distanceKm);
  const outOfRange = cfg.maxKm === null || roundedKm > cfg.maxKm;
  const rule = deliveryDiscountView(cfg);
  const base = {
    distanceKm, roundedKm, outOfRange, maxKm: cfg.maxKm,
    freeDeliveryMin: cfg.freeDeliveryMin || 0, minOrder: cfg.minOrder, steps: [],
    deliveryFeeModel: deliveryFeeModelOf(cfg), deliveryFeeSource: "flat", deliveryDiscountRule: rule,
    deliveryDiscountTier: null, nextDeliveryTier: null,
  };
  if (outOfRange) {
    return { ...base, fee: null, riderFee: null, shopPays: 0, free: false, deliveryDiscount: 0, feeBeforeDiscount: null, feeAfterDiscount: null };
  }
  const riderFee = cfg.deliveryFee;
  const free = cfg.freeDeliveryMin !== null && foodSubtotal !== null && foodSubtotal !== undefined && foodSubtotal >= cfg.freeDeliveryMin;
  const fee = free ? 0 : riderFee;
  const shopPays = free ? riderFee : 0;
  const tier = free ? rule.tiers[0] : null;
  const next = !free && cfg.freeDeliveryMin !== null && riderFee > 0 && foodSubtotal !== null && foodSubtotal !== undefined
    ? { minSubtotal: cfg.freeDeliveryMin, maxOff: null, shortBy: round2(cfg.freeDeliveryMin - foodSubtotal), discount: riderFee, feeAfterDiscount: 0 }
    : null;
  return {
    ...base, fee, riderFee, shopPays, free, deliveryDiscount: shopPays, feeBeforeDiscount: riderFee, feeAfterDiscount: fee,
    deliveryDiscountTier: tier, nextDeliveryTier: next,
  };
}

// ── เมนู ─────────────────────────────────────────────────────────────────
function menuVersionOf(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * buildMenu({shop, products, now}) → Menu (รูป [C§1] · providerId shopchamp)
 *   products = stock docs `{id, ...data}` ที่ handler โหลดตาม productIds และเป็นของร้านนี้แล้ว · ลำดับ = ลำดับ productIds
 *   ❌ ไม่มี promos · loyalty · newCustomer · groupDiscount · rails (D1 · Pack ยังไม่ยืนยัน)
 */
function buildMenu({ shop, products, now }) {
  const s = isObj(shop) ? shop : {};
  const cfg = configOf(s);
  const list = (Array.isArray(products) ? products : []).map((p) => productView(p, now)).filter(Boolean);
  const categoryTree = categoryTreeOf(s.smartCategory);
  const acc = acceptingOf(s, now);
  const deliveryDiscount = deliveryDiscountView(cfg);
  const deliveryFeeModel = deliveryFeeModelOf(cfg);
  return {
    providerId: PROVIDER_ID,
    menuVersion: menuVersionOf({ products: list, categoryTree, minOrder: cfg.minOrder, deliveryFee: cfg.deliveryFee, freeDeliveryMin: cfg.freeDeliveryMin, maxKm: cfg.maxKm }),
    currency: "THB",
    acceptingOrders: acc.accepting,
    acceptingReason: acc.reason,
    ...(acc.reason ? { closedReason: acc.reason } : {}),
    minOrder: cfg.minOrder,
    deliveryFee: cfg.deliveryFee,
    deliveryFeeModel,
    deliveryFeeSource: "flat",
    freeDeliveryMin: cfg.freeDeliveryMin || 0,
    maxKm: cfg.maxKm,
    deliveryDiscount,
    ...(cfg.prepMinutes ? { prepMin: cfg.prepMinutes } : {}),
    categoryTree,
    rails: [],
    products: list,
  };
}

module.exports = {
  PROVIDER_ID, PRODUCT_MAX, configOf, isOpenAt, acceptingOf, isDeleted, isOut, stockLeft, unitPriceOf, productView,
  categoryTreeOf, ceilKm, quoteDelivery, deliveryDiscountView, buildMenu, menuVersionOf, round2,
};

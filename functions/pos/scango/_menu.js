// pos/scango/_menu.js — สูตรล้วนของช่องทาง ScanGo (pure · ไม่แตะฐาน · ไม่อ่านนาฬิกาเอง)
//
// แบบ: lanes/dev/source/shopchamp-scango-design.md §เส้นเชื่อม + §รอบ 5 · รูปเมนู/ค่าส่ง = สัญญา §b ของร้านพี่น้อง (ScanGo อ่านรูปเดียวกันทุกเจ้า)
//   ใช้: menu (DEV-0009 2026-11-13 ถอด deliveryQuote · orderCreate แล้ว · quoteDelivery เหลือไว้ให้เทสสูตร ไม่มีเส้นเรียก)
//
// ค่าตั้งร้าน `shop.scango` ที่ไฟล์นี้อ่าน = {enabled, minOrder, deliveryFeeModel?, productIds:[≤1000]}
//   + ค่าส่งแบบเดิม (deliveryFee · maxKm · freeDeliveryMin) อ่านเป็นสูตรให้ร้านที่ตั้งไว้แล้ว (`_deliveryFee.resolveDeliveryConfig`)
//   รอบ 5 (Pack เคาะ 2026-11-12 · ยึดแบบพี่น้อง): เวลาทำการ · เวลาเตรียม · พิกัด · โปร = ScanGo ถือเอง (ตั้งที่เว็บร้าน)
//     ⇒ ไฟล์นี้ **ไม่ปิดรับตามเวลาแล้ว** (ช่อง hours/prepMinutes ในฐานยังอยู่ แต่ไม่มีใครอ่าน) · เมนูไม่ปิดรับเลย: acceptingOrders true เสมอ (ScanGo ตัดสิน · Pack 2026-11-14)
// ราคา: `logic.linePrice(stock, 1, {now})` ต่อหน่วย · fullPrice มีเฉพาะเมื่อโปรลดจริง · ❌ ไม่ส่งโปรท้ายบิล/สมาชิก/ส่วนลดค่าส่ง/ส่วนลดกลุ่ม
// หมด: stockCountStatus === true และ stock ≤ 0 (อ่านไม่ออก = หมด · fail-closed)
// ค่าส่ง: สูตรแบบช่วง (`_deliveryFee` · คัดจากต้นแบบ) · เมนูส่งสูตร + ไกลสุด · ตัวเลขต่อระยะ = quoteDelivery
"use strict";

const crypto = require("crypto");
const logic = require("@shopchamp/logic");
const DF = require("./_deliveryFee");

const PROVIDER_ID = "shopchamp";
const PRODUCT_MAX = 1000;
const DISABLED_DISCOUNT = Object.freeze({ enabled: false, tiers: Object.freeze([]) });

const str = (v) => (v == null ? "" : String(v).trim());
const num = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const round2 = (n) => logic.toSatang(n) / 100;

/** ค่าตั้งร้านที่อ่านแล้ว (ค่าแปลก = ค่าปลอดภัย) · delivery = สูตรที่ใช้จริง (`_deliveryFee.resolveDeliveryConfig`) */
function configOf(shop) {
  const s = isObj(shop) && isObj(shop.scango) ? shop.scango : {};
  const nonNeg = (v) => { const n = num(v); return n !== null && n >= 0 ? n : null; };
  return {
    enabled: s.enabled === true,
    minOrder: nonNeg(s.minOrder) || 0,
    delivery: DF.resolveDeliveryConfig(s),
    productIds: [...new Set((Array.isArray(s.productIds) ? s.productIds : []).filter((x) => typeof x === "string" && x !== "" && !x.includes("/")))].slice(0, PRODUCT_MAX),
  };
}

/**
 * acceptingOf(shop, _now) → {accepting, reason} · reason ศัพท์เดียวกับพี่น้อง: ordering_disabled
 *   ต้นแบบ (`menu.js › acceptingOf`) = enabled && เครดิต && !temptClose · บ้านนี้ไม่มีเครดิต · เวลาทำการเป็นของ ScanGo (รอบ 5) ⇒ เหลือ enabled
 */
function acceptingOf(shop, _now) {
  const c = configOf(shop);
  if (!c.enabled) return { accepting: false, reason: "ordering_disabled" };
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
/** ระยะปัดขึ้น 0.1 กม. (สูตรเดียวกับ `_deliveryFee`) */
const ceilKm = (km) => DF._internals.roundKmUp(km);

/**
 * quoteDelivery(shop, {distanceKm, foodSubtotal}) — เลขเดียวกับที่ orderCreate คิด (สูตรแบบช่วง `_deliveryFee.calcDeliveryFee`)
 *   fee = ลูกค้าจ่าย · riderFee = ไรเดอร์ได้ (เต็มเสมอ) · shopPays = ร้านออกแทนเมื่อส่งฟรี (เฉพาะร้านที่ตั้ง freeDeliveryMin แบบเดิมไว้)
 *   foodSubtotal null = ไม่รู้ยอด = ไม่ฟรี (fail-closed)
 */
function quoteDelivery(shop, { distanceKm, foodSubtotal }) {
  const cfg = configOf(shop);
  const d = cfg.delivery;
  const q = DF.calcDeliveryFee({ model: d.model, distanceKm, foodSubtotal, freeDeliveryMin: d.freeDeliveryMin });
  return {
    distanceKm, roundedKm: q.roundedKm, outOfRange: q.outOfRange, maxKm: q.maxKm,
    freeDeliveryMin: d.freeDeliveryMin, minOrder: cfg.minOrder, steps: q.steps,
    deliveryFeeModel: d.model, deliveryFeeSource: d.source, deliveryDiscountRule: q.deliveryDiscountRule,
    deliveryDiscountTier: q.deliveryDiscountTier, nextDeliveryTier: q.nextDeliveryTier,
    fee: q.fee, riderFee: q.riderFee, shopPays: q.shopPays, free: q.free, deliveryDiscount: q.deliveryDiscount,
    feeBeforeDiscount: q.feeBeforeDiscount, feeAfterDiscount: q.feeAfterDiscount,
  };
}

// ── เมนู ─────────────────────────────────────────────────────────────────
function menuVersionOf(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * buildMenu({shop, products, now}) → Menu (รูป [C§1] · providerId shopchamp)
 *   products = stock docs `{id, ...data}` ที่ handler โหลดตาม productIds และเป็นของร้านนี้แล้ว · ลำดับ = ลำดับ productIds
 *   ค่าส่ง = สูตรแบบช่วง (deliveryFeeModel · source · maxKm = ขอบช่วงสุดท้าย · deliveryFee = baseFee ให้ ScanGo รุ่นก่อน ท่าเดียวกับต้นแบบ)
 *   รอบ 5: ❌ ไม่ส่ง freeDeliveryMin · ❌ ไม่ส่ง prepMin (ScanGo ถือ) · deliveryDiscount ปิดเสมอ (โปร/ส่วนลดค่าส่งเป็นของ ScanGo)
 *   ❌ ไม่มี promos · loyalty · newCustomer · groupDiscount · rails
 */
function buildMenu({ shop, products, now }) {
  const s = isObj(shop) ? shop : {};
  const cfg = configOf(s);
  const list = (Array.isArray(products) ? products : []).map((p) => productView(p, now)).filter(Boolean);
  const categoryTree = categoryTreeOf(s.smartCategory);
  const d = cfg.delivery;
  const deliveryFee = d.model.baseFee;
  return {
    providerId: PROVIDER_ID,
    menuVersion: menuVersionOf({ products: list, categoryTree, minOrder: cfg.minOrder, deliveryFee, deliveryFeeModel: d.model }),
    currency: "THB",
    // POS ไม่ตัดสินเปิด/ปิดรับ — ScanGo ตัดสินจากปุ่มเปิดรับของมันที่เดียว (แบบพี่น้อง menu.js `acceptingOrders: true` · Pack 2026-11-14)
    //   คงช่องไว้ให้ ScanGo รุ่นก่อน · acceptingOf() เหลือไว้ให้เทส/ที่อื่นอ้าง แต่ไม่ใช้ตัดสินเมนูแล้ว
    acceptingOrders: true,
    acceptingReason: null,
    minOrder: cfg.minOrder,
    deliveryFee,
    deliveryFeeModel: d.model,
    deliveryFeeSource: d.source,
    maxKm: d.maxKm,
    deliveryDiscount: { ...DISABLED_DISCOUNT, tiers: [] },
    categoryTree,
    rails: [],
    products: list,
  };
}

module.exports = {
  PROVIDER_ID, PRODUCT_MAX, configOf, acceptingOf, isDeleted, isOut, stockLeft, unitPriceOf, productView,
  categoryTreeOf, ceilKm, quoteDelivery, buildMenu, menuVersionOf, round2,
};

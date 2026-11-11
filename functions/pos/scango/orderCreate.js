// pos/scango/orderCreate.js — POST /pos/scango/order/create {externalId, order} (auth 'partner' · ลูกค้า ScanGo กดสั่ง)
//
// สัญญา §b ของร้านพี่น้อง (ScanGo ส่งรูปเดียวกันทุกเจ้า): order = ProviderOrder (orderId = orderRef · items[] · distanceKm บังคับ ·
//   deliveryFee? deliveryDiscount? ที่โชว์ลูกค้า · customer · dropPoint · payment.method)
//   ระดับบนสุด strict ({externalId, order}) · ใน order รับช่องเกินได้ (ScanGo ส่ง Order ทั้งก้อน · ตัดสินเอง รายงาน Pack)
//
// ลำดับ (ท่าเดียวกับพี่น้อง):
//   ① ใบ orderRef นี้มีแล้ว (ScanGo ส่งซ้ำ) = 200 duplicate:true คืนสถานะเดิม ไม่เขียนทับ · เป็นของร้านอื่น = 409 order_ref_conflict
//   ② ร้านปิดรับ = 409 venue_not_accepting {reason: ordering_disabled | shop_closed}
//   ③ server คิดราคาทุกบรรทัดเอง (_menu.unitPriceOf = linePrice qty 1) · ไม่ตรง unitPrice ที่ส่งมา / ไม่ขาย / หมด / ของไม่พอ / มีตัวเลือก
//      = 409 menu_changed {details:{issues}} (Issue ชนิดเมนู [C§1])
//   ④ ส่วนลดที่ฝั่งนี้ไม่มี (โปรร้าน · ลูกค้าประจำ/ใหม่ · ส่วนลดกลุ่ม · D1) ส่งมา > 0 = 409 รหัสเดียวกับพี่น้อง (ยอดใหม่ = 0)
//   ⑤ ค่าส่ง (_menu.quoteDelivery จากค่าสินค้าที่ server คิด) · เกินไกลสุด = 409 out_of_delivery_range · ส่วนลดค่าส่ง/ค่าส่งไม่ตรง
//      = 409 delivery_discount_changed / delivery_fee_changed
//   ⑥ transaction: อ่านใบอีกรอบ (ชนคำขอซ้ำที่แทรก = duplicate) → create scangoOrder/{orderRef} state requested
//   ⑦ หลัง commit (ไม่ใช่ duplicate): push ถึงทั้งร้าน kind shop data {type:'scango_order', orderRef}
// ❌ ไม่ตัดสต๊อก ไม่ออกบิล (ปิดบิลตอนส่งถึง = เส้น delivery ของอีกงาน) · ❌ ไม่ตรวจขั้นต่ำ (ScanGo ตรวจ · ท่าเดียวกับพี่น้อง)
"use strict";

const logic = require("@shopchamp/logic");
const { ok } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { notify } = require("../_shared/push/notify");
const C = require("./_core");
const M = require("./_menu");

const ITEMS_MAX = 200;
const QTY_MAX = 99;
const KM_MAX = 1000;
const BAHT_MAX = 10000000;
const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function textOr(v, label, max) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > max) C.bad(`${label} ต้องเป็นข้อความไม่เกิน ${max} ตัว`);
  return v.trim();
}
function moneyOpt(v, label) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > BAHT_MAX) C.bad(`${label} ต้องเป็นตัวเลข ≥ 0`);
  return v;
}

/** ตรวจรูป order (ช่องที่ใช้) → ค่าที่อ่านแล้ว */
function parseOrder(order) {
  if (!C.isObj(order)) C.bad("ต้องส่ง order");
  const orderRef = C.idOf(order.orderId, "order.orderId");
  if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > ITEMS_MAX) C.bad(`order.items ต้องมี 1-${ITEMS_MAX} รายการ`);
  const items = order.items.map((it, i) => {
    if (!C.isObj(it)) C.bad(`items[${i}] ต้องเป็น object`);
    if (typeof it.productId !== "string" || !C.ID_RE.test(it.productId)) C.bad(`items[${i}].productId ไม่ถูกรูป`);
    if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > QTY_MAX) C.bad(`items[${i}].qty ต้องเป็นจำนวนเต็ม 1-${QTY_MAX}`);
    if (it.unitPrice !== undefined && it.unitPrice !== null && (typeof it.unitPrice !== "number" || !Number.isFinite(it.unitPrice))) C.bad(`items[${i}].unitPrice ต้องเป็นตัวเลข`);
    if (it.options !== undefined && it.options !== null && !Array.isArray(it.options)) C.bad(`items[${i}].options ต้องเป็นรายการ`);
    return {
      productId: it.productId,
      qty: it.qty,
      unitPrice: num(it.unitPrice),
      options: Array.isArray(it.options) ? it.options : [],
      note: textOr(it.note, `items[${i}].note`, 300),
      memberId: textOr(it.memberId, `items[${i}].memberId`, 128),
    };
  });
  const km = order.distanceKm;
  if (typeof km !== "number" || !Number.isFinite(km) || km < 0 || km > KM_MAX) C.bad("ต้องส่ง order.distanceKm (ระยะถนน กม. · ตัวเลข ≥ 0)");
  if (order.distanceEstimated !== undefined && order.distanceEstimated !== null && typeof order.distanceEstimated !== "boolean") C.bad("order.distanceEstimated ต้องเป็น true/false");
  const pay = C.isObj(order.payment) ? order.payment.method : undefined;
  if (pay !== "cash" && pay !== "transfer") C.bad("order.payment.method ต้องเป็น cash หรือ transfer");
  if (order.customer !== undefined && order.customer !== null && !C.isObj(order.customer)) C.bad("order.customer ต้องเป็น object");
  if (order.dropPoint !== undefined && order.dropPoint !== null && !C.isObj(order.dropPoint)) C.bad("order.dropPoint ต้องเป็น object");
  const cu = C.isObj(order.customer) ? order.customer : {};
  const code = textOr(order.code, "order.code", 16).replace(/[^A-Za-z0-9-]/g, "") || orderRef.slice(-4).toUpperCase();
  const group = C.isObj(order.group) ? order.group : null;
  const groupSent = num(order.groupDiscount) !== null ? order.groupDiscount
    : group && C.isObj(group.discount) ? num(group.discount.amount) : group ? num(group.discount) : null;
  return {
    orderRef, code, items, distanceKm: km, distanceEstimated: order.distanceEstimated === true,
    deliveryFee: moneyOpt(order.deliveryFee, "order.deliveryFee"),
    deliveryDiscount: moneyOpt(order.deliveryDiscount, "order.deliveryDiscount"),
    method: pay,
    customer: { name: textOr(cu.name, "order.customer.name", 100), phone: textOr(cu.phone, "order.customer.phone", 30) || null },
    dropPoint: C.isObj(order.dropPoint) ? order.dropPoint : null,
    promotionId: typeof order.promotionId === "string" ? order.promotionId.trim() : "",
    loyaltyDiscount: num(order.loyaltyDiscount) || 0,
    newCustomerDiscount: num(order.newCustomerDiscount) || 0,
    groupDiscount: groupSent || 0,
  };
}

/**
 * priceLines({items, productsById, allowed, now}) → {issues, lines, subtotal} (pure)
 *   ราคาต่อหน่วย = unitPriceOf (linePrice qty 1) · ยอดบรรทัด = หน่วย × qty เป็นสตางค์ (ScanGo คิด unitPrice × qty แบบเดียวกัน)
 */
function priceLines({ items, productsById, allowed, now }) {
  const issues = [];
  const lines = [];
  items.forEach((it, i) => {
    const p = allowed.has(it.productId) ? productsById.get(it.productId) : null;
    const priced = p ? M.unitPriceOf(p, now) : null;
    if (!priced) { issues.push({ kind: "product_missing", productId: it.productId, message: "ไม่มีสินค้านี้บน ScanGo แล้ว" }); return; }
    for (const o of it.options) {
      issues.push({ kind: "choice_missing", productId: it.productId, choiceId: C.str(o && o.choiceId), message: "สินค้านี้ไม่มีตัวเลือก" });
    }
    const left = M.stockLeft(p);
    if (M.isOut(p)) issues.push({ kind: "product_out", productId: it.productId, message: `${C.str(p.name)} หมดแล้ว` });
    else if (left < it.qty) issues.push({ kind: "product_out", productId: it.productId, from: it.qty, to: left, message: `${C.str(p.name)} เหลือ ${left}` });
    if (it.unitPrice === null || M.round2(it.unitPrice) !== priced.price) {
      issues.push({ kind: "price_changed", productId: it.productId, from: it.unitPrice, to: priced.price, message: "ราคาเปลี่ยน" });
    }
    const lineTotal = (logic.toSatang(priced.price) * it.qty) / 100;
    lines.push({
      lineId: String(i + 1),
      productId: it.productId,
      name: C.str(p.name),
      qty: it.qty,
      unitPrice: priced.price,
      ...(priced.fullPrice !== undefined ? { fullUnitPrice: priced.fullPrice } : {}),
      lineTotal,
      priceType: priced.priceType,
      unit: C.str(p.unit),
      barcode: C.str(p.barcode),
      imageId: typeof p.imageId === "string" ? p.imageId : "",
      category: Array.isArray(p.category) ? p.category.map(C.str) : [],
      vatExemption: p.vatExemption === true,
      note: it.note,
      ...(it.memberId ? { memberId: it.memberId } : {}),
    });
  });
  const subtotal = lines.reduce((s, l) => s + logic.toSatang(l.lineTotal), 0) / 100;
  return { issues, lines, subtotal };
}

function dupOut(res, data) {
  return ok(res, { providerOrderRef: data.orderRef, state: C.str(data.state) || "requested", duplicate: true });
}

function orderCreate(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId", "order"]);
    const shopId = C.idOf(b.externalId, "externalId");
    const o = parseOrder(b.order);
    const now = await readNow(deps);
    const shop = await C.loadShop(shopId);

    // ① ส่งซ้ำ
    const ref = C.orderRefOf(o.orderRef);
    const pre = await ref.get();
    if (pre.exists) {
      const d = pre.data() || {};
      if (d.shopId !== shopId) C.refuse(409, "order_ref_conflict", "รหัสออเดอร์นี้ถูกใช้กับร้านอื่นแล้ว");
      return dupOut(res, d);
    }

    // ② ประตูรับ
    const acc = M.acceptingOf(shop, now);
    if (!acc.accepting) C.refuse(409, "venue_not_accepting", "ร้านปิดรับออเดอร์ ScanGo อยู่", { reason: acc.reason });

    // ③ ราคาทุกบรรทัด
    const cfg = M.configOf(shop);
    const productsById = await C.loadProducts(shopId, o.items.map((it) => it.productId));
    const priced = priceLines({ items: o.items, productsById, allowed: new Set(cfg.productIds), now });
    if (priced.issues.length) C.refuse(409, "menu_changed", "สินค้า/ราคาเปลี่ยน", { details: { issues: priced.issues } });

    // ④ ส่วนลดที่ฝั่งนี้ยังไม่มี
    if (o.promotionId) C.refuse(409, "promotion_unavailable", "ร้านนี้ยังไม่มีโปรบน ScanGo — เลือกใหม่", { promotionId: o.promotionId, reason: "not_supported" });
    if (o.loyaltyDiscount > 0) C.refuse(409, "customer_discount_changed", "ส่วนลดลูกค้าประจำเปลี่ยน — ยืนยันยอดใหม่", { kind: "loyalty", from: o.loyaltyDiscount, to: 0 });
    if (o.newCustomerDiscount > 0) C.refuse(409, "customer_discount_changed", "ส่วนลดลูกค้าใหม่เปลี่ยน — ยืนยันยอดใหม่", { kind: "newCustomer", from: o.newCustomerDiscount, to: 0 });
    if (o.groupDiscount > 0) C.refuse(409, "group_discount_changed", "ส่วนลดกลุ่มเปลี่ยน — ยืนยันยอดใหม่", { from: o.groupDiscount, to: 0, eligible: false, reason: "not_supported" });

    // ⑤ ค่าส่ง
    const fee = M.quoteDelivery(shop, { distanceKm: o.distanceKm, foodSubtotal: priced.subtotal });
    if (fee.outOfRange) {
      C.refuse(409, "out_of_delivery_range", fee.maxKm === null ? "ร้านยังไม่ได้ตั้งระยะส่งไกลสุด" : `ร้านส่งไกลสุด ${fee.maxKm} กม. — ปลายทางอยู่ ${fee.roundedKm} กม.`, { maxKm: fee.maxKm, distanceKm: fee.roundedKm });
    }
    if (o.deliveryDiscount !== null && !sameMoney(o.deliveryDiscount, fee.deliveryDiscount)) {
      C.refuse(409, "delivery_discount_changed", "ส่วนลดค่าส่งเปลี่ยน — ยืนยันยอดใหม่", { from: o.deliveryDiscount, to: fee.deliveryDiscount, fee: fee.fee, riderFee: fee.riderFee, free: fee.free, tier: fee.deliveryDiscountTier, nextTier: fee.nextDeliveryTier });
    }
    if (o.deliveryFee !== null && !sameMoney(o.deliveryFee, fee.fee)) {
      C.refuse(409, "delivery_fee_changed", "ค่าส่งเปลี่ยน — ยืนยันยอดใหม่", { from: o.deliveryFee, to: fee.fee, riderFee: fee.riderFee, free: fee.free, deliveryDiscount: fee.deliveryDiscount });
    }

    const total = (logic.toSatang(priced.subtotal) + logic.toSatang(fee.fee)) / 100;
    const doc = {
      shopId,
      orderRef: o.orderRef,
      code: o.code,
      source: "scango",
      state: "requested",
      stateAt: { requested: now },
      items: priced.lines,
      subtotal: priced.subtotal,
      deliveryFee: fee.fee,
      total,
      feeBreakdown: {
        customerFee: fee.fee, riderFee: fee.riderFee, shopPays: fee.shopPays, free: fee.free,
        distanceKm: o.distanceKm, roundedKm: fee.roundedKm, estimated: o.distanceEstimated, maxKm: fee.maxKm, source: "flat",
      },
      customer: o.customer,
      dropPoint: o.dropPoint,
      payment: { method: o.method },
      rider: null,
      remindedAt: null,
      remindCount: 0,
      cancelledBy: null,
      cancelReason: null,
      billId: null,
      notified: {},
      createdAt: now,
      updatedAt: now,
    };

    // ⑥ เขียน (กันคำขอซ้ำที่แทรกระหว่างทาง)
    const out = await C.runTx(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return { dup: snap.data() || {} };
      tx.create(ref, doc);
      return { dup: null };
    });
    if (out.dup) {
      if (out.dup.shopId !== shopId) C.refuse(409, "order_ref_conflict", "รหัสออเดอร์นี้ถูกใช้กับร้านอื่นแล้ว");
      return dupOut(res, out.dup);
    }

    // ⑦ แจ้งร้าน (หลัง commit · ล้ม/ช้าไม่กระทบคำตอบ)
    await notify(deps, {
      to: { kind: "shop", shopId },
      heading: "ออเดอร์ ScanGo ใหม่",
      content: `#${o.code} · ${priced.lines.length} รายการ · ฿${total}`,
      data: { type: "scango_order", orderRef: o.orderRef },
    });
    return ok(res, { providerOrderRef: o.orderRef, state: "requested" });
  });
}

module.exports = { orderCreate, parseOrder, priceLines };

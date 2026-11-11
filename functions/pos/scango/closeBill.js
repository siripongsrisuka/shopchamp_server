// pos/scango/closeBill — ไรเดอร์ส่งถึงแล้ว = server ออกบิลขายให้ร้านเอง (แบบงาน shopchamp-scango-design.md §ข้อมูล Shopchamp)
//
// 🔑 แกนเดียวกับ sale.create ทุกไบต์: เรียก handler `sale/create.js › create(deps)` ในโปรเซส (ท่าเดียวกับ sale.amend `inProcess`)
//   ⇒ เลขบิล (nextBillNumber + floorRun) · ตัดสต็อก (planStockDeduction · ตามค่าตั้งใน stock doc) · สมุด stockJournal ·
//     กะ (ไม่ส่ง shiftId = ร้านไม่ใช้กะ 'off' / ร้านใช้กะ 'unassigned' ตาม readShiftRound) · receiptGuard · push สต๊อกวิกฤต
//     ทั้งหมดมาจาก create.js ตัวเดิม · ❌ ไม่แก้ create.js สักบรรทัด · ❌ ไม่มีสูตรเงิน/สต็อกชุดที่ 2
//   ผู้เรียกในนาม: shopAccess {shopId, uid:'scango', role:'owner'} (สร้างในโปรเซสเท่านั้น · ผ่าน HTTP ไม่ได้ · express ไม่เติม field นี้)
//
// ใบที่ส่งให้ sale.create (ประกอบจาก scangoOrder ที่ server คิดราคาแล้วตอนรับใบ · ไม่คิดราคาใหม่):
//   receiptUUID = `scango-<orderRef>` (คงที่ต่อใบ ⇒ เรียกซ้ำ = sale.create ตอบ duplicate + billId เดิม · บิลไม่ซ้ำแม้ประทับ billId ล้ม)
//   product[]   = แถวของใบ {id, qty, name, net: lineTotal, totalPrice: fullLineTotal|lineTotal, totalCost: cost×qty จาก stock doc, category, barcode}
//   payment     = 1 แถว · cash → id 1 · transfer → id 2 · amount = moneyMustPaid · ชื่อจาก shop.shopchampPayment (ไม่มี = เงินสด/พร้อมเพย์)
//   moneyMustPaid = Σ lineTotal · ❌ ไม่รวมค่าส่ง (ค่าส่งเป็นของไรเดอร์) · ❌ ไม่มี VAT/ส่วนลดท้ายบิล/สมาชิก
//   note = `ScanGo #<code>` · cashierName = 'ScanGo'
//
// ผล (เขียนบน scangoOrder/{orderRef} · ไม่โยน):
//   สำเร็จ (ใหม่หรือ duplicate) = {billId, receiptNumber, billClosedAt, billPending:null, billNextAttemptAt:null} + bill.scango {orderRef, code}
//   ล้ม = billPending {reason, status, message, at, attempts} + billNextAttemptAt (backoff) · ครบ MAX_ATTEMPTS = null (หยุดลอง · ร้านปิดมือ)
//   ใบมี billId แล้ว = ไม่เรียก sale.create อีก (alreadyClosed)
//
// รูปใบ scangoOrder ที่อ่าน (order/create เป็นคนเขียน):
//   shopId · code · state ('delivered' เท่านั้นที่ปิดบิล) · payment.method ('cash'|'transfer') ·
//   items[] (orderCreate.js · หรือ lines[]) {productId|id, name, qty, lineTotal|net, fullUnitPrice?|fullLineTotal?, priceType?, category?, barcode?}
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { belongsToShop } = require("../_shared/auth");

const PAYMENT_ROW = Object.freeze({ cash: 1, transfer: 2 });
const PAYMENT_NAME = Object.freeze({ 1: "เงินสด", 2: "พร้อมเพย์" });
const STAFF_NAME = "ScanGo";
const SYSTEM_UID = "scango";
const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= 128 && !v.includes("/");

const receiptUUIDOf = (orderRef) => `scango-${orderRef}`;

/** ระยะรอรอบถัดไปหลังล้มครั้งที่ attempts (1 นาที ×2 · เพดาน 60 นาที) */
function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (n - 1));
}

/**
 * saleBodyOf({shopId, orderRef, order, shop, stockDocs}) — body ของ sale.create (pure)
 * @returns {{ok:true, body:object} | {ok:false, reason:string}}
 */
function saleBodyOf({ shopId, orderRef, order, shop, stockDocs }) {
  const raw = Array.isArray(order.lines) ? order.lines : Array.isArray(order.items) ? order.items : [];
  if (!raw.length) return { ok: false, reason: "no_lines" };
  const product = [];
  for (const l of raw) {
    if (!isObj(l)) return { ok: false, reason: "bad_line" };
    const id = str(l.id || l.productId);
    const qty = finite(l.qty);
    const net = finite(l.lineTotal !== undefined ? l.lineTotal : l.net);
    if (!validDocId(id) || qty === null || qty <= 0 || net === null || net < 0) return { ok: false, reason: "bad_line" };
    // ราคาก่อนโปร: fullLineTotal (ทั้งบรรทัด) · หรือ fullUnitPrice × qty (orderCreate.js เขียนต่อหน่วย) · ไม่มี = เท่ายอดบรรทัด
    const fullUnit = finite(l.fullUnitPrice);
    const full = finite(l.fullLineTotal !== undefined ? l.fullLineTotal : l.totalPrice) ?? (fullUnit !== null ? (logic.toSatang(fullUnit) * qty) / 100 : null);
    const d = (stockDocs && stockDocs.get(id)) || {};
    const cost = finite(d.cost);
    const row = {
      id, qty,
      name: str(l.name || d.name).slice(0, 300),
      net: logic.roundMoney(net),
      totalPrice: logic.roundMoney(full !== null && full >= net ? full : net),
      totalCost: cost !== null && cost > 0 ? logic.roundMoney(cost * qty) : 0,
    };
    if (str(l.priceType)) row.priceType = str(l.priceType).slice(0, 100);
    const cat = Array.isArray(d.category) ? d.category : Array.isArray(l.category) ? l.category : null;
    if (cat) row.category = cat.filter((c) => typeof c === "string");
    const barcode = typeof d.barcode === "string" && d.barcode ? d.barcode : str(l.barcode);
    if (barcode) row.barcode = barcode.slice(0, 100);
    product.push(row);
  }
  const moneyMustPaid = logic.roundMoney(product.reduce((s, r) => s + r.net, 0));
  const totalPrice = logic.roundMoney(product.reduce((s, r) => s + r.totalPrice, 0));
  const method = str(order.payment && order.payment.method) === "transfer" ? "transfer" : "cash";
  const payId = PAYMENT_ROW[method];
  const channels = shop && Array.isArray(shop.shopchampPayment) ? shop.shopchampPayment : [];
  const ch = channels.find((c) => isObj(c) && String(c.id) === String(payId));
  const payName = ch && typeof ch.name === "string" && ch.name ? ch.name.slice(0, 100) : PAYMENT_NAME[payId];
  const code = str(order.code) || orderRef;
  return {
    ok: true,
    body: {
      shopId,
      receiptUUID: receiptUUIDOf(orderRef),
      product,
      payment: [{ id: payId, amount: moneyMustPaid, name: payName, change: 0 }],
      moneyMustPaid,
      productDiscount: logic.roundMoney(Math.max(0, totalPrice - moneyMustPaid)),
      change: 0,
      note: `ScanGo #${code}`.slice(0, 500),
      cashierName: STAFF_NAME,
    },
  };
}

/** เรียก sale.create ในโปรเซส · คืน {status, ...body} (ท่าเดียวกับ sale/amend.js › inProcess) */
async function callSaleCreate(deps, body, access) {
  const handler = require("../sale/create").create(deps);
  const res = {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
  await handler({ body, shopAccess: access }, res);
  const b = res.body && typeof res.body === "object" ? res.body : {};
  return { ...b, status: res.statusCode };
}

/** stock doc ของแถว (ใช้แค่ต้นทุน/หมวด/บาร์โค้ด) · ของร้านอื่น = ไม่ใช้ (ไม่รั่วข้อมูลข้ามร้านลงบิล · การตัดสต็อกให้ sale.create ตัดสินเอง) */
async function readStockDocs(lines, shopRef) {
  const ids = [...new Set(lines.map((l) => str(isObj(l) ? l.id || l.productId : "")).filter(validDocId))];
  const snaps = await Promise.all(ids.map((id) => db.collection("stock").doc(id).get()));
  const out = new Map();
  snaps.forEach((s, i) => {
    const d = s && s.exists ? s.data() || {} : null;
    if (d && belongsToShop(d.shopId, shopRef)) out.set(ids[i], d);
  });
  return out;
}

/**
 * closeBill({orderRef}, deps) — ปิดบิล 1 ใบ · ไม่โยน
 *   deps: now() · createSale(body, access) (ฉีดในเทส · ไม่ส่ง = sale.create ในโปรเซส) · ที่เหลือส่งต่อ sale.create (push ฯลฯ)
 * @returns {Promise<{ok:true, billId, receiptNumber, alreadyClosed:boolean, duplicate?:boolean}
 *                 | {ok:false, reason:string, status?:number, pending:boolean}>}
 */
async function closeBill({ orderRef }, deps) {
  const log = (deps && deps.log) || console;
  const ref = str(orderRef);
  if (!validDocId(ref)) return { ok: false, reason: "bad_order_ref", pending: false };
  const orderDoc = db.collection("scangoOrder").doc(ref);
  let now;
  try {
    now = deps && typeof deps.now === "function" ? await deps.now() : new Date();
    if (!(now instanceof Date)) now = new Date();
  } catch (_) { now = new Date(); }

  let order;
  try {
    const snap = await orderDoc.get();
    order = snap && snap.exists ? snap.data() || {} : null;
  } catch (e) {
    log.error("pos/scango/closeBill read_failed", ref, e && e.message);
    return { ok: false, reason: "read_failed", pending: false };
  }
  if (!order) return { ok: false, reason: "order_not_found", pending: false };
  if (validDocId(order.billId)) return { ok: true, billId: order.billId, receiptNumber: order.receiptNumber || null, alreadyClosed: true };
  if (str(order.state) !== "delivered") return { ok: false, reason: "not_delivered", pending: false };

  const markPending = async (reason, status, message) => {
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(orderDoc);
        const cur = s && s.exists ? s.data() || {} : {};
        if (validDocId(cur.billId)) return;
        const prev = isObj(cur.billPending) ? Number(cur.billPending.attempts) || 0 : 0;
        const attempts = prev + 1;
        tx.update(orderDoc, {
          billPending: { reason, status: status === undefined ? null : status, message: str(message).slice(0, 300) || null, at: now, attempts },
          billNextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + backoffMs(attempts)),
        });
      });
    } catch (e) {
      log.error("pos/scango/closeBill mark_pending_failed", ref, e && e.message);
    }
    log.error("pos/scango/closeBill pending", ref, reason, status);
    return { ok: false, reason, status, pending: true };
  };

  try {
    const shopId = str(order.shopId);
    if (!validDocId(shopId)) return await markPending("bad_order", undefined, "ใบไม่มี shopId");
    const shopSnap = await db.collection("shop").doc(shopId).get();
    const shop = shopSnap && shopSnap.exists ? shopSnap.data() || {} : null;
    if (!shop) return await markPending("shop_not_found");
    const lines = Array.isArray(order.lines) ? order.lines : Array.isArray(order.items) ? order.items : [];
    const stockDocs = await readStockDocs(lines, { id: shopId, shopId: typeof shop.shopId === "string" ? shop.shopId : null });
    const built = saleBodyOf({ shopId, orderRef: ref, order, shop, stockDocs });
    if (!built.ok) return await markPending(built.reason);

    const access = { shopId, uid: SYSTEM_UID, role: "owner", rights: [] };
    const innerDeps = { ...(deps || {}), now: () => now };
    delete innerDeps.createSale;
    const call = deps && typeof deps.createSale === "function"
      ? (b, a) => deps.createSale(b, a)
      : (b, a) => callSaleCreate(innerDeps, b, a);
    const out = await call(built.body, access);
    if (!out || out.ok !== true || !validDocId(out.billId)) {
      return await markPending("sale_create_failed", out && out.status, out && (out.error || out.message));
    }
    await db.runTransaction(async (tx) => {
      const billRef = db.collection("bill").doc(out.billId);
      const billSnap = await tx.get(billRef);
      tx.update(orderDoc, {
        billId: out.billId,
        receiptNumber: typeof out.receiptNumber === "string" ? out.receiptNumber : null,
        billClosedAt: now,
        billPending: null,
        billNextAttemptAt: null,
      });
      // ป้ายช่องทางบนบิล (field เพิ่มอย่างเดียว · แอปเก่าไม่อ่าน)
      if (billSnap && billSnap.exists) tx.update(billRef, { scango: { orderRef: ref, code: str(order.code) || null } });
    });
    return { ok: true, billId: out.billId, receiptNumber: out.receiptNumber || null, alreadyClosed: false, duplicate: out.duplicate === true };
  } catch (e) {
    return markPending("error", undefined, e && e.message);
  }
}

/**
 * retryPending({now, limit}, deps) — ใบที่ billNextAttemptAt ถึงเวลา → closeBill อีกรอบ (ตัวกวาดเรียกทุก 1 นาที)
 * @returns {Promise<{picked:number, closed:number, failed:number}>}
 */
async function retryPending({ now, limit = 50 } = {}, deps) {
  const at = now instanceof Date ? now : new Date();
  const snap = await db.collection("scangoOrder").where("billNextAttemptAt", "<=", at).orderBy("billNextAttemptAt", "asc").limit(limit).get();
  const docs = snap && Array.isArray(snap.docs) ? snap.docs : [];
  const stats = { picked: docs.length, closed: 0, failed: 0 };
  for (const d of docs) {
    const r = await closeBill({ orderRef: d.id }, { ...(deps || {}), now: () => at });
    if (r.ok) stats.closed++;
    else stats.failed++;
  }
  return stats;
}

module.exports = { closeBill, retryPending, saleBodyOf, backoffMs, receiptUUIDOf, PAYMENT_ROW, MAX_ATTEMPTS };

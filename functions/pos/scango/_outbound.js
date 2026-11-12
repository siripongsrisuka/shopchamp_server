// pos/scango/_outbound — ท่อยิงข่าว Shopchamp → ScanGo (ร้าน Shopchamp บน ScanGo · แบบงาน lanes/dev/source/shopchamp-scango-design.md §เส้นเชื่อม)
//
// 2 เส้น (header `x-scango-platform-key` = secret SCANGO_SHOPCHAMP_KEY · base = env SCANGO_BASE_URL):
//   POST {base}/provider/shopchamp/order/event  {orderRef, type: accepted|ready|cancelled, reason?, at, eventId}
//   POST {base}/provider/shopchamp/event        {type:'venue_ordering', externalId, name, geo, phone, enabled, acceptingOrders, ...}
//
// 🔒 กติกา:
//   ① ไม่โยน error ออกไปเลยสักทาง · ผลเป็น {sent, queued, reason, status?} เสมอ (งานหน้าร้านเดินต่อได้แม้ ScanGo ล่ม)
//   ② timeout 5 วิ ต่อการยิง 1 ครั้ง · ยิงสดครั้งเดียว (ไม่วนลองในคำขอ · ตัวกวาด outboxSweep.js ลองซ้ำทุก 1 นาที)
//   ③ ยิงไม่ออกแบบลองใหม่มีหวัง (ไม่มีคำตอบ/timeout · 5xx · 408 · 429) = ลง `scangoOutbox/{eventId}` state 'pending'
//      ScanGo ปฏิเสธชัด (4xx อื่น) = ลง outbox state 'dead' (ไม่ลองซ้ำ · เก็บไว้ให้คนไล่ดู) · queued ยังเป็น false
//      env ไม่ครบ = ไม่ลง outbox (ลงไปก็ค้างตลอด) + log warn · ผลเป็น reason 'not_configured'
//   ④ eventId คงที่ต่อข่าว (ออเดอร์ = `<orderRef>:<type>`) = doc id ของ outbox ⇒ ยิงซ้ำ/ลงซ้ำ = แถวเดิม · ScanGo กันซ้ำด้วยตัวนี้
//   ⑤ `at` = เวลาเกิดเหตุที่ต้นทาง · ยิงซ้ำจาก outbox ใช้ค่าเดิมทุกไบต์
//   ⑥ ข่าวออเดอร์กันยิงซ้ำด้วยธง `scangoOrder.notified.<type> === true` (เขียนเมื่อยิงออก หรือ ลง outbox pending แล้ว)
//
// ❌ ไม่ require SDK ตัวจริง · db จาก ../../firebase (เทสแทนใน require.cache) · http ฉีดได้ทาง deps.http
"use strict";

const { db } = require("../../firebase");
const DF = require("./_deliveryFee");

const ORDER_EVENT_PATH = "/provider/shopchamp/order/event";
const VENUE_EVENT_PATH = "/provider/shopchamp/event";
const HEADER = "x-scango-platform-key";
const OUTBOX = "scangoOutbox";
const TIMEOUT_MS = 5000;
const ORDER_EVENT_TYPES = Object.freeze(["accepted", "ready", "cancelled"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const logOf = (deps) => (deps && deps.log) || console;

/** env ที่ใช้ยิง · deps.env แทน process.env ได้ (เทส) */
function configOf(deps) {
  const env = deps && isObj(deps.env) ? deps.env : process.env;
  const base = str(env.SCANGO_BASE_URL).replace(/\/+$/, "");
  const key = str(env.SCANGO_SHOPCHAMP_KEY);
  return { base, key, ready: !!base && !!key };
}

/** ลองใหม่แล้วมีหวังไหม — ไม่มี status (เน็ต/timeout) · 5xx · 408 · 429 */
function isRetryable(status) {
  if (status === undefined || status === null) return true;
  const st = Number(status);
  return st >= 500 || st === 408 || st === 429;
}

/** http ตัวจริง = axios (โหลดช้า) · deps.http(url, body, {timeout, headers}) → {status, data} หรือโยนแบบ axios */
function httpOf(deps) {
  if (deps && typeof deps.http === "function") return deps.http;
  return (url, body, opts) => require("axios").post(url, body, opts);
}

/**
 * postRaw(path, payload, deps) — ยิง 1 ครั้ง · ไม่โยน
 * @returns {Promise<{sent:true, status?, data?} | {sent:false, reason:'not_configured'|'failed', status?, error?, data?}>}
 */
async function postRaw(path, payload, deps) {
  const cfg = configOf(deps);
  if (!cfg.ready) return { sent: false, reason: "not_configured" };
  try {
    const r = await httpOf(deps)(cfg.base + path, payload, { timeout: TIMEOUT_MS, headers: { [HEADER]: cfg.key } });
    return { sent: true, status: r && r.status, data: r && r.data };
  } catch (e) {
    const out = { sent: false, reason: "failed" };
    const st = e && e.response && e.response.status;
    if (st !== undefined) out.status = st;
    if (e && e.response && e.response.data !== undefined) out.data = e.response.data;
    if (e && e.message) out.error = String(e.message).slice(0, 300);
    return out;
  }
}

/**
 * enqueue({eventId, path, payload, state, lastError}, now) — เขียน `scangoOutbox/{eventId}` · ไม่โยน · คืน true เมื่อเขียนได้
 *   แถวที่มีอยู่แล้ว = ไม่ทับ (กันนับ attempts ใหม่ · ตัวกวาดถืออยู่) · คืน true เพราะข่าวอยู่ในคิวแล้ว
 */
async function enqueue({ eventId, path, payload, state = "pending", lastError = null }, now, deps) {
  try {
    const ref = db.collection(OUTBOX).doc(eventId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap && snap.exists) return true;
      tx.set(ref, {
        eventId, path, payload, state,
        orderRef: str(payload && payload.orderRef) || null,
        attempts: 1,
        lastError,
        createdAt: now,
        nextAttemptAt: state === "pending" ? now : null,
        ...(state === "dead" ? { deadAt: now } : {}),
      });
      return true;
    });
  } catch (e) {
    logOf(deps).error("pos/scango/_outbound outbox_write_failed", eventId, e && e.message);
    return false;
  }
}

/**
 * sendEvent({path, payload, eventId}, deps) — ยิงสด 1 ครั้ง · ไม่ออก = ลง outbox ตามข้อ ③ · ไม่โยน
 * @returns {Promise<{sent:boolean, queued:boolean, reason?:string, status?:number}>}
 */
async function sendEvent({ path, payload, eventId }, deps) {
  try {
    const now = deps && typeof deps.now === "function" ? deps.now() : new Date();
    const out = await postRaw(path, payload, deps);
    if (out.sent) return { sent: true, queued: false };
    if (out.reason === "not_configured") {
      logOf(deps).warn("pos/scango/_outbound not_configured", eventId);
      return { sent: false, queued: false, reason: "not_configured" };
    }
    const retry = isRetryable(out.status);
    const lastError = out.error || (out.status !== undefined ? String(out.status) : "failed");
    logOf(deps).error("pos/scango/_outbound send_failed", eventId, out.status, lastError);
    const wrote = await enqueue({ eventId, path, payload, state: retry ? "pending" : "dead", lastError }, now, deps);
    const r = { sent: false, queued: retry && wrote, reason: retry ? "failed" : "rejected" };
    if (out.status !== undefined) r.status = out.status;
    return r;
  } catch (e) {
    logOf(deps).error("pos/scango/_outbound unexpected", eventId, e && e.message);
    return { sent: false, queued: false, reason: "error" };
  }
}

/** eventId ของข่าวออเดอร์ — คงที่ต่อ (ใบ, ชนิด) */
const orderEventIdOf = (orderRef, type) => `${orderRef}:${type}`;

/** body ของข่าวออเดอร์ (pure) */
function orderEventPayloadOf({ orderRef, type, reason, at }) {
  const body = { orderRef, type, at: at instanceof Date ? at.toISOString() : str(at), eventId: orderEventIdOf(orderRef, type) };
  if (type === "cancelled") body.reason = str(reason) || "shop_cancelled";
  return body;
}

/**
 * notifyOrder({orderRef, type, reason?, at?}, deps) — ยิงข่าวออเดอร์ 1 ตัว พร้อมกันซ้ำด้วยธง notified · ไม่โยน
 *   ธง true อยู่แล้ว = ไม่ยิง (reason 'already_notified') · ยิงออก/ลง outbox pending = เขียนธง (merge ทั้ง map ใน tx)
 * @returns {Promise<{sent:boolean, queued:boolean, reason?:string}>}
 */
async function notifyOrder({ orderRef, type, reason, at }, deps) {
  try {
    if (!ORDER_EVENT_TYPES.includes(type) || !str(orderRef)) return { sent: false, queued: false, reason: "bad_event" };
    const ref = db.collection("scangoOrder").doc(orderRef);
    const snap = await ref.get();
    const order = snap && snap.exists ? snap.data() || {} : null;
    if (!order) return { sent: false, queued: false, reason: "order_not_found" };
    if (isObj(order.notified) && order.notified[type] === true) return { sent: false, queued: false, reason: "already_notified" };
    const when = at || (deps && typeof deps.now === "function" ? deps.now() : new Date());
    const payload = orderEventPayloadOf({ orderRef, type, reason, at: when });
    const out = await sendEvent({ path: ORDER_EVENT_PATH, payload, eventId: payload.eventId }, deps);
    if (out.sent || out.queued) {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const cur = s && s.exists ? s.data() || {} : {};
        const notified = { ...(isObj(cur.notified) ? cur.notified : {}), [type]: true };
        tx.update(ref, { notified });
      });
    }
    return out;
  } catch (e) {
    logOf(deps).error("pos/scango/_outbound notifyOrder", orderRef, type, e && e.message);
    return { sent: false, queued: false, reason: "error" };
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * เลขพร้อมเพย์ → ตัวเลขล้วนที่ใช้ได้ | null — กฎเดียวกับต้นแบบ (server แอปพี่น้อง origin/main `functions/claude/scango/venuePickup.js:20-27`)
 *   เบอร์ 10 หลักขึ้นต้น 0 · เลขผู้เสียภาษี/บัตร 13 หลัก · e-Wallet 15 หลัก · รับที่มีช่องว่าง/ขีด
 */
function promptpayIdOf(v) {
  const d = str(v).replace(/[\s-]/g, "");
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 10 && d.startsWith("0")) return d;
  if (d.length === 13 || d.length === 15) return d;
  return null;
}

/**
 * paymentQrOf(shop) → {type:'promptpay', id, name} | null — รูปที่ ScanGo รับ (`routes/provider.routes.js` venue_ordering › normalizePaymentQr)
 *   รอบ 5 ยึดแบบพี่น้อง (`venuePickup.js:29-41`): เลขเดียวกับที่ POS โชว์ QR ตอนคิดเงิน = **`shop.receipt.promptpayId` + `promptpayStatus === true`**
 *   (แอป Shopchamp `src/screens/CheckoutScreen.js:134-148`) ⇒ เงินโอนไปบัญชีเดียวกับที่หน้าร้านใช้
 *   ถอยไปที่ `shop.scango.paymentQr` เดิม (ค่าตั้งของแอป 5.00 รุ่นแรก · เฉพาะที่เป็นเลขพร้อมเพย์) · ไม่มีทั้งคู่ = null (ScanGo ซ่อนตัวเลือกโอน)
 *   ชื่อบนป้าย = ชื่อร้าน
 */
function paymentQrOf(shop) {
  const s = isObj(shop) ? shop : {};
  const rc = isObj(s.receipt) ? s.receipt : {};
  const primary = rc.promptpayStatus === true ? promptpayIdOf(rc.promptpayId) : null;
  const sg = isObj(s.scango) ? s.scango : {};
  const id = primary || promptpayIdOf(sg.paymentQr);
  if (!id) return null;
  return { type: "promptpay", id, name: str(s.name).slice(0, 100) };
}

/**
 * venuePayloadOf(shopId, shop, now) — body ของ `venue_ordering` จาก `shop.scango` (pure)
 *   ยึดแบบพี่น้อง (`ordering.js › orderingView` + `venuePickup.venueOrderingExtrasOf`) ตัดส่วนที่บ้านนี้ไม่มี (เครดิต · ส่วนลดกลุ่ม · รอบ · LINE · amenities)
 *     enabled (บังคับ) · name · phone · address · geo {lat,lng} (มีเฉพาะร้านที่ตั้งพิกัดไว้แบบเดิม · ไม่รู้ = ไม่ส่งช่อง ❌ ไม่ส่ง 0,0) ·
 *     minOrder · deliveryFee (= baseFee ให้ ScanGo รุ่นก่อน) · deliveryFeeModel · deliveryFeeSource · maxKm (= ขอบช่วงสุดท้าย) ·
 *     paymentQr {type:'promptpay',id,name}|null (ส่งช่องนี้เสมอ ⇒ ScanGo ตั้ง transferEnabled ตามจริง) · pickup {name,address,lat,lng,phone,note}
 *     vertical ฝั่งรับบังคับ 'retail' เองจากโปรไฟล์ (ส่งไปเพื่ออ่านง่าย) · at = เวลาเกิดเหตุ (ข่าวเก่ากว่าถูกทิ้ง)
 *   รอบ 5 (Pack เคาะ 2026-11-12): ❌ ไม่ส่ง businessHours · prepMinutes · freeDeliveryMin (ScanGo ถือ/ตั้งที่เว็บร้าน)
 *   acceptingOrders = เปิด + มีสินค้าที่เลือกขายอย่างน้อย 1 ตัว (ไม่ผูกพิกัดแล้ว · ฝั่งรับไม่อ่านช่องนี้ ใช้ enabled · เมนู /scango/menu ตัดสินจริง)
 *   eventId = `venue:<shopId>:<ms>` (ข่าวร้านแต่ละครั้งคนละตัว · doc id ของ outbox)
 */
function venuePayloadOf(shopId, shop, now) {
  const s = shop && isObj(shop.scango) ? shop.scango : {};
  const loc = isObj(s.location) ? s.location : {};
  const geo = num(loc.lat) !== null && num(loc.lng) !== null ? { lat: loc.lat, lng: loc.lng } : null;
  const enabled = s.enabled === true;
  const products = Array.isArray(s.productIds) ? s.productIds.length : 0;
  const paymentQr = paymentQrOf(shop);
  const d = DF.resolveDeliveryConfig(s);
  const name = str(shop && shop.name);
  const phone = str(shop && shop.tel) || null;
  const address = str(shop && shop.address) || null;
  return {
    type: "venue_ordering",
    externalId: shopId,
    name,
    ...(geo ? { geo } : {}),
    phone,
    address,
    enabled,
    acceptingOrders: enabled && products > 0,
    minOrder: num(s.minOrder) !== null && s.minOrder >= 0 ? s.minOrder : 0,
    deliveryFee: d.model.baseFee,
    deliveryFeeModel: d.model,
    deliveryFeeSource: d.source,
    maxKm: d.maxKm,
    transferEnabled: paymentQr !== null,
    paymentQr,
    vertical: "retail",
    pickup: { name, address: address || "", lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, phone: phone || "", note: str(s.pickupNote) || null },
    at: now.toISOString(),
    eventId: `venue:${shopId}:${now.getTime()}`,
  };
}

/**
 * notifyVenue(shopId, shop, deps) — ยิง venue_ordering (หลังร้านบันทึกตั้งค่า / เลือกสินค้า) · ไม่โยน
 *   shop ไม่ส่ง = อ่าน `shop/{shopId}` เอง
 */
async function notifyVenue(shopId, shop, deps) {
  try {
    let data = shop;
    if (!isObj(data)) {
      const snap = await db.collection("shop").doc(shopId).get();
      data = snap && snap.exists ? snap.data() || {} : null;
      if (!data) return { sent: false, queued: false, reason: "shop_not_found" };
    }
    const now = deps && typeof deps.now === "function" ? deps.now() : new Date();
    const payload = venuePayloadOf(shopId, data, now);
    return await sendEvent({ path: VENUE_EVENT_PATH, payload, eventId: payload.eventId }, deps);
  } catch (e) {
    logOf(deps).error("pos/scango/_outbound notifyVenue", shopId, e && e.message);
    return { sent: false, queued: false, reason: "error" };
  }
}

/** ผล sendEvent/notifyVenue → สถานะคำเดียวที่จอร้านอ่าน: sent (ถึง ScanGo แล้ว) · queued (ลง outbox รอยิงซ้ำ) · skipped (ไม่ได้ตั้ง env · ไม่ยิง) · failed (ScanGo ปฏิเสธ/พัง · ไม่มีคิว) */
function venueStatusOf(r) {
  if (!isObj(r)) return "failed";
  if (r.sent === true) return "sent";
  if (r.queued === true) return "queued";
  if (r.reason === "not_configured") return "skipped";
  return "failed";
}

/**
 * sendVenue(deps, {shopId}) — รูปที่ shop/settingsSave.js เรียก (หลัง commit) · อ่าน shop doc ล่าสุดเอง (ค่าที่เพิ่งบันทึก) แล้ว notifyVenue
 *   ไม่โยน · คืน {status: 'sent'|'queued'|'skipped'|'failed', ...ผล notifyVenue (sent · queued · reason? · status code?)}
 *   (เดิมคืนแค่ผล notifyVenue และไม่เคยโยน ⇒ settingsSave รายงาน 'sent' ทุกครั้งแม้ไม่ได้ยิง — แก้ 2026-11-11)
 */
async function sendVenue(deps, { shopId } = {}) {
  const r = await notifyVenue(shopId, null, deps);
  const { status: httpStatus, ...rest } = isObj(r) ? r : {};
  return { status: venueStatusOf(r), ...rest, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

module.exports = {
  ORDER_EVENT_PATH, VENUE_EVENT_PATH, HEADER, OUTBOX, TIMEOUT_MS, ORDER_EVENT_TYPES,
  configOf, isRetryable, postRaw, enqueue, sendEvent,
  orderEventIdOf, orderEventPayloadOf, notifyOrder, promptpayIdOf, paymentQrOf, venuePayloadOf, notifyVenue, venueStatusOf, sendVenue,
};

// pos/scango/v1/orderV1.js — รับใบจาก ScanGo ตามสัญญา ScanGo Order API v1 (route auth 'partnerSigned' · DEV-0009 · Pack "ลุย" 2026-11-13)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/v1/orderV1.js` (createOrder · orderEvent · orderState)
//   ตัวส่ง = scango_server origin/main `providers/partnerApi/client.js` (placeOrder · sendEvent · getState) + `mapOrder.js` (orderV1Of · eventV1Of)
//   ส่วนที่ยกจากของเดิมของบ้านนี้: ที่เก็บ scangoOrder/{orderRef} + push `{type:'scango_order', orderRef}` (orderCreate.js รุ่นก่อน · ถอด 2026-11-13)
//
//   POST /pos/scango/v1/orders                   body Order v1 → scangoOrder/{orderId} state 'requested' + push ถึงทั้งร้าน
//                                                ตอบ 200 {ok, partnerOrderRef, duplicate?} · 409 order_invalid | venue_unknown
//   POST /pos/scango/v1/orders/:orderId/events   body OrderEvent v1 → ขยับ state · ตอบ 200 {ok, applied, ignored?} · 400 order_invalid · 404 order_unknown
//   POST /pos/scango/v1/orders/:orderId/state    → 200 {ok, state, partnerOrderRef, at} · 404 order_unknown
//
// 🔴 Pack เคาะ A (2026-11-12): Shopchamp **ห้ามปัดใบเองทุกกรณี** (ราคา · สต็อก · ส่วนลด · สินค้าหาย · ร้านปิดรับ)
//   ⇒ ต่างจากต้นแบบ: ❌ ไม่ตอบ 409 item_unavailable · ❌ ไม่อ่าน stock/เมนูเลย · เก็บรายการ/ราคา/ส่วนลดตามที่ ScanGo ส่ง (ข้อมูลให้ร้านดู)
//   ปัดได้แค่: รูปข้อมูลผิด (409 order_invalid) · ไม่มีร้านนี้ในระบบ (409 venue_unknown · ไม่มีที่ให้ใบไปอยู่) · orderId ซ้ำ = 200 duplicate (ไม่เขียนทับ)
//   ลายเซ็นผิด/หมดอายุ = ยามหน้าเส้น (v1/partnerSign.js) ไม่ถึงไฟล์นี้
// ต่างจากต้นแบบอีก: ใบอยู่ scangoOrder (ไม่ใช่ใบ POS) ⇒ state ใช้ศัพท์ของ scangoOrder (requested · accepted · ready · cancelled) ·
//   ร้านจัดการใบบนเว็บร้าน ScanGo (Pack ตอบ "1" 2026-11-12) ⇒ ฝั่งนี้มีหน้าที่ ①นับใบใหม่ (scango.orderList) ②ป๊อปอัปในแอป (push)
//   rider.* = ข้อมูล (deliveryState · rider) · ยกเว้น rider.delivered = ปิดใบ state delivered (Pack 2026-11-14 · ต่างจากต้นแบบ: ใบที่ส่งถึงแล้วไม่ค้างแท็บ "กำลังทำ" บนหน้าขาย)
// 🔁 idempotent: สร้าง = orderId (doc id) · เหตุการณ์ = eventId (เก็บ eventIds ล่าสุด 20 · ซ้ำ = applied:false ignored:'duplicate_event')
// 🔑 เบอร์ลูกค้าถูกลบเมื่อใบยกเลิก (C.redactPhonePatch)
"use strict";

const { db } = require("../../../firebase");
const { ok } = require("../../_shared/respond");
const { readNow } = require("../../_shared/deps");
const { notify } = require("../../_shared/push/notify");
const C = require("../_core");

const SCHEMA_ORDER = "scango.order.v1";
const SCHEMA_EVENT = "scango.order-event.v1";
const SEEN_EVENTS_MAX = 20;
const ORDER_ID_MAX = 128;
const FULFILLMENT_MODES = ["delivery", "pickup"];
const TIMINGS = ["asap", "round", "scheduled"];
const RIDER_STATES = { "rider.assigned": "assigned", "rider.picked_up": "picked_up", "rider.delivering": "delivering", "rider.delivered": "delivered", "rider.failed": "failed" };
const EVENT_TYPES = ["venue.accepted", "venue.rejected", "venue.ready", "venue.cancelled", "customer.cancelled", "platform.reminder", ...Object.keys(RIDER_STATES)];
const CLOSED = ["cancelled", "delivered", "failed"];

const str = (v) => (v == null ? "" : String(v).trim());
const isObj = C.isObj;
const num0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v, max) => str(v).slice(0, max);
const textOrNull = (v, max) => text(v, max) || null;
/** ปัดแบบสัญญา v1 (ซองบ้านนี้ + code ซ้ำ error) */
const refuseV1 = (status, code, message, details) => C.refuse(status, code, message, { code, ...(details ? { details } : {}) });

/** orderId ใช้เป็น doc id ได้ไหม (ไม่ว่าง · ไม่มี / · ไม่ใช่ . .. · ไม่ใช่ __x__ · ≤128) */
function goodOrderId(v) {
  const s = str(v);
  return !!s && s.length <= ORDER_ID_MAX && !s.includes("/") && s !== "." && s !== ".." && !/^__.*__$/.test(s);
}

/** `at` ISO ที่ส่งมา → Date · อ่านไม่ออก/ล้ำอนาคตเกิน 5 นาที = ตอนนี้ (ต้นแบบ atOf) */
function atOf(raw, now) {
  if (typeof raw !== "string" || !raw) return now;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime()) || d.getTime() > now.getTime() + 5 * 60 * 1000) return now;
  return d;
}

// ── validate Order v1 (§5) — คืน {field, message} หรือ null · ตรวจรูปเท่านั้น ไม่ตรวจว่ามีสินค้า/ราคาตรง ─────────
function orderInvalid(o) {
  const bad = (field, message) => ({ field, message });
  if (!isObj(o)) return bad("body", "ต้องส่ง Order v1 เป็น JSON object");
  if (str(o.schema) !== SCHEMA_ORDER) return bad("schema", `schema ต้องเป็น ${SCHEMA_ORDER}`);
  if (!goodOrderId(o.orderId)) return bad("orderId", `orderId ต้องเป็นข้อความไม่ว่าง ไม่มี / ยาวไม่เกิน ${ORDER_ID_MAX} ตัว`);
  if (!str(o.venueRef) || !C.ID_RE.test(str(o.venueRef))) return bad("venueRef", "venueRef ต้องเป็นรหัสร้าน (A-Z a-z 0-9 _ -)");
  if (!Array.isArray(o.items) || o.items.length === 0) return bad("items", "items ต้องมีอย่างน้อย 1 รายการ");
  const lineIds = new Set();
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i];
    if (!isObj(it) || !str(it.productRef)) return bad(`items[${i}].productRef`, "productRef ต้องมี");
    if (!Number.isInteger(Number(it.qty)) || Number(it.qty) < 1) return bad(`items[${i}].qty`, "qty ต้องเป็นจำนวนเต็ม ≥ 1");
    const lid = str(it.lineId);
    if (lid && lineIds.has(lid)) return bad(`items[${i}].lineId`, "lineId ซ้ำในใบ");
    if (lid) lineIds.add(lid);
    if (it.options !== undefined && it.options !== null && !Array.isArray(it.options)) return bad(`items[${i}].options`, "options ต้องเป็นรายการ");
  }
  if (o.fulfillment !== undefined && o.fulfillment !== null) {
    const f = o.fulfillment;
    if (!isObj(f)) return bad("fulfillment", "fulfillment ต้องเป็น object");
    if (str(f.mode) && !FULFILLMENT_MODES.includes(str(f.mode))) return bad("fulfillment.mode", `mode ต้องเป็น ${FULFILLMENT_MODES.join("|")}`);
    if (str(f.timing) && !TIMINGS.includes(str(f.timing))) return bad("fulfillment.timing", `timing ต้องเป็น ${TIMINGS.join("|")}`);
  }
  for (const k of ["customer", "dropPoint", "bill", "group"]) {
    if (o[k] !== undefined && o[k] !== null && !isObj(o[k])) return bad(k, `${k} ต้องเป็น object`);
  }
  return null;
}

/** บรรทัดสินค้าตามที่ ScanGo ส่ง (ข้อมูลให้ร้านดู · ไม่คิดราคาใหม่) */
function linesOf(items) {
  return items.map((it, i) => {
    const qty = Number(it.qty);
    const unitPrice = num0(it.unitPrice);
    return {
      lineId: text(it.lineId, 64) || `L${i + 1}`,
      productId: text(it.productRef, 128),
      name: text(it.name, 200),
      qty,
      unitPrice,
      lineTotal: typeof it.lineTotal === "number" && Number.isFinite(it.lineTotal) ? it.lineTotal : Math.round(unitPrice * qty * 100) / 100,
      note: text(it.note, 300),
      options: (Array.isArray(it.options) ? it.options : []).filter(isObj).map((op) => ({
        groupRef: textOrNull(op.groupRef, 128), groupName: textOrNull(op.groupName, 200), choiceRef: textOrNull(op.choiceRef, 128), name: text(op.name, 200), qty: num0(op.qty) || 1,
      })),
    };
  });
}

/** Order v1 → เนื้อ scangoOrder (ช่องเดิมที่ order-list/แอปอ่าน + ก้อน v1 ที่ส่งมา) */
function docOf({ shopId, order, now }) {
  const bill = isObj(order.bill) ? order.bill : null;
  const cu = isObj(order.customer) ? order.customer : {};
  const items = linesOf(order.items);
  const subtotal = bill && typeof bill.subtotal === "number" ? bill.subtotal : items.reduce((s, l) => s + l.lineTotal, 0);
  const payment = bill && isObj(bill.payment) ? bill.payment : null;
  return {
    shopId,
    orderRef: str(order.orderId),
    code: text(order.code, 16) || str(order.orderId).slice(-4).toUpperCase(),
    source: "scango",
    schema: SCHEMA_ORDER,
    test: order.test === true,
    state: "requested",
    stateAt: { requested: now },
    placedAt: textOrNull(order.placedAt, 40),
    fulfillment: isObj(order.fulfillment) ? order.fulfillment : null,
    items,
    subtotal,
    deliveryFee: bill ? num0(bill.deliveryFee) : 0,
    total: bill ? num0(bill.total) : subtotal,
    bill,
    customer: { name: text(cu.name, 100), phone: textOrNull(cu.phone, 30), note: textOrNull(cu.note, 300) },
    dropPoint: isObj(order.dropPoint) ? order.dropPoint : null,
    payment: payment ? { method: textOrNull(payment.method, 20), state: textOrNull(payment.state, 20), collectedBy: textOrNull(payment.collectedBy, 20) } : null,
    group: isObj(order.group) ? order.group : null,
    rider: null,
    deliveryState: null,
    remindedAt: null,
    remindCount: 0,
    cancelledBy: null,
    cancelReason: null,
    eventIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── POST /scango/v1/orders ─────────────────────────────────────────────────────────────
function v1OrderCreate(deps) {
  return C.wrap(async (req, res) => {
    const order = req ? req.body : undefined;
    const inv = orderInvalid(order);
    if (inv) refuseV1(409, "order_invalid", inv.message, { field: inv.field });
    const shopId = str(order.venueRef);
    const orderId = str(order.orderId);
    const ref = C.orderRefOf(orderId);
    // ส่งซ้ำ (ScanGo retry) = คืนของเดิม ไม่เขียนทับ
    const pre = await ref.get();
    if (pre.exists) return ok(res, { partnerOrderRef: orderId, duplicate: true });

    const shopSnap = await db.collection("shop").doc(shopId).get();
    if (!shopSnap.exists) refuseV1(409, "venue_unknown", "ไม่พบร้านนี้ในระบบ", { venueRef: shopId });
    // 🔴 Pack A: ไม่ดู shop.scango.enabled · ไม่ตรวจสินค้า/ราคา/สต็อก/ส่วนลด — ใบที่มาถึง = ScanGo ตัดสินแล้วว่าร้านรับ

    const now = await readNow(deps);
    const doc = docOf({ shopId, order, now });
    const out = await C.runTx(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return { dup: true };
      tx.create(ref, doc);
      return { dup: false };
    });
    if (out.dup) return ok(res, { partnerOrderRef: orderId, duplicate: true });

    // แจ้งร้าน (หลัง commit · ล้ม/ช้าไม่กระทบคำตอบ) · รูป data ห้ามเปลี่ยน — ป๊อปอัปในแอปอ่าน {type:'scango_order', orderRef}
    await notify(deps, {
      to: { kind: "shop", shopId },
      heading: "ออเดอร์ ScanGo ใหม่",
      content: `#${doc.code} · ${doc.items.length} รายการ · ฿${doc.total}`,
      data: { type: "scango_order", orderRef: orderId },
    });
    return ok(res, { partnerOrderRef: orderId });
  });
}

// ── เหตุการณ์ (§3.2) — pure ตัดสิน patch ────────────────────────────────────────────────
/**
 * applyEvent(data, ev, now) → {applied, ignored?, patch}
 *   requested --venue.accepted--> accepted --venue.ready--> ready · requested --venue.ready--> ready
 *   venue.rejected/venue.cancelled (ยังไม่จบ) · customer.cancelled (เฉพาะ requested) → cancelled + ลบเบอร์
 *   platform.reminder (เฉพาะ requested) → remindedAt · remindCount+1 · rider.* → deliveryState/rider
 *   rider.delivered (ใบยังไม่จบ) → + state delivered · stateAt.delivered (ใบยกเลิก/จบแล้ว = แค่ deliveryState)
 */
function applyEvent(data, ev, now) {
  const type = str(ev.type);
  const at = atOf(ev.at, now);
  const st = str(data.state);
  const closed = CLOSED.includes(st);
  const base = { updatedAt: now };
  const ignore = (why) => ({ applied: false, ignored: why, patch: base });
  const rider = isObj(ev.rider) && str(ev.rider.name) ? { name: text(ev.rider.name, 100), phone: textOrNull(ev.rider.phone, 30), plate: textOrNull(ev.rider.plate, 30) } : null;

  if (RIDER_STATES[type]) {
    const ds = RIDER_STATES[type];
    const patch = { ...base, deliveryState: ds, [`deliveryStateAt.${ds}`]: at };
    if (rider) patch.rider = rider;
    if (ds === "failed") patch.deliveryFailReason = textOrNull(ev.reason, 200);
    if (ds === "delivered" && !closed) {
      patch.state = "delivered";
      patch["stateAt.delivered"] = at;
    }
    return { applied: true, patch };
  }
  if (type === "platform.reminder") {
    if (st !== "requested") return ignore("already_in_state");
    return { applied: true, patch: { ...base, remindedAt: at, remindCount: (Number(data.remindCount) || 0) + 1 } };
  }
  if (type === "venue.accepted") {
    if (st !== "requested") return ignore("already_in_state");
    return { applied: true, patch: { ...base, state: "accepted", "stateAt.accepted": at, acceptedBy: "scango-web" } };
  }
  if (type === "venue.ready") {
    if (!["requested", "accepted"].includes(st)) return ignore("already_in_state");
    return { applied: true, patch: { ...base, state: "ready", "stateAt.ready": at } };
  }
  if (["venue.rejected", "venue.cancelled", "customer.cancelled"].includes(type)) {
    if (closed) return ignore("already_in_state");
    if (type === "customer.cancelled" && st !== "requested") return ignore("already_in_state"); // ลูกค้ายกเลิกได้เฉพาะก่อนร้านรับ (ต้นแบบ)
    const by = type === "customer.cancelled" ? "customer" : "venue";
    return {
      applied: true,
      patch: {
        ...base,
        state: "cancelled",
        "stateAt.cancelled": at,
        cancelledBy: by,
        cancelReason: textOrNull(ev.reason, 200) || (by === "customer" ? "customer_request" : "other"),
        cancelNote: textOrNull(ev.note, 300),
        ...C.redactPhonePatch(data),
      },
    };
  }
  return ignore("already_in_state");
}

/** ตรวจรูป OrderEvent v1 (§6) — ข้อความ หรือ null */
function eventInvalid(ev, orderId) {
  if (!isObj(ev)) return "ต้องส่ง OrderEvent v1 เป็น JSON object";
  if (str(ev.schema) !== SCHEMA_EVENT) return `schema ต้องเป็น ${SCHEMA_EVENT}`;
  if (!str(ev.eventId)) return "eventId ต้องมี";
  if (!EVENT_TYPES.includes(str(ev.type))) return `type ต้องเป็น ${EVENT_TYPES.join("|")}`;
  if (str(ev.orderId) && str(ev.orderId) !== orderId) return "orderId ใน body ไม่ตรง path";
  return null;
}

/** ใบ scango ของ orderId (ไม่มี/รูป id ผิด/ไม่ใช่ใบ scango = 404 order_unknown) */
async function loadV1Order(orderId, tx) {
  if (!goodOrderId(orderId)) refuseV1(404, "order_unknown", "ไม่พบออเดอร์นี้");
  const ref = C.orderRefOf(orderId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  const data = snap && snap.exists ? snap.data() || {} : null;
  if (!data || data.source !== "scango") refuseV1(404, "order_unknown", "ไม่พบออเดอร์นี้");
  return { ref, data };
}

// ── POST /scango/v1/orders/:orderId/events ────────────────────────────────────────────────
function v1OrderEvent(deps) {
  return C.wrap(async (req, res) => {
    const orderId = str(req && req.params && req.params.orderId);
    const ev = req ? req.body : undefined;
    const inv = eventInvalid(ev, orderId);
    if (inv) refuseV1(400, "order_invalid", inv, { field: "event" });
    const eventId = str(ev.eventId).slice(0, 200);
    const now = await readNow(deps);
    const r = await C.runTx(async (tx) => {
      const { ref, data } = await loadV1Order(orderId, tx);
      const seen = Array.isArray(data.eventIds) ? data.eventIds : [];
      if (seen.includes(eventId)) return { applied: false, ignored: "duplicate_event" };
      const a = applyEvent(data, ev, now);
      tx.update(ref, { ...a.patch, eventIds: [...seen, eventId].slice(-SEEN_EVENTS_MAX) });
      return { applied: a.applied, ignored: a.ignored };
    });
    return ok(res, { applied: r.applied, ...(r.ignored ? { ignored: r.ignored } : {}) });
  });
}

// ── POST /scango/v1/orders/:orderId/state (§3.3) ──────────────────────────────────────────
/** PartnerState — pending · accepted · ready · completed · rejected · cancelled */
function partnerStateOf(data) {
  const d = data || {};
  const st = str(d.state);
  if (st === "cancelled" || st === "failed") {
    const everAccepted = !!(isObj(d.stateAt) && d.stateAt.accepted);
    return str(d.cancelledBy) === "venue" && !everAccepted ? "rejected" : "cancelled";
  }
  if (st === "delivered") return "completed";
  if (st === "requested") return "pending";
  if (["ready", "picked_up", "delivering"].includes(st)) return "ready";
  return "accepted";
}
const isoOrNull = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : typeof v.toDate === "function" ? v.toDate() : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function v1OrderState(deps) {
  return C.wrap(async (req, res) => {
    const orderId = str(req && req.params && req.params.orderId);
    const { data } = await loadV1Order(orderId);
    const now = await readNow(deps);
    return ok(res, { state: partnerStateOf(data), partnerOrderRef: orderId, at: isoOrNull(data.updatedAt) || now.toISOString() });
  });
}

module.exports = {
  v1OrderCreate, v1OrderEvent, v1OrderState,
  orderInvalid, eventInvalid, applyEvent, partnerStateOf, docOf, goodOrderId,
  SCHEMA_ORDER, SCHEMA_EVENT, EVENT_TYPES, SEEN_EVENTS_MAX,
};

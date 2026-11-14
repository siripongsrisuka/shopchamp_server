// pos/scango/v1/eventOut.js — ขาออก Shopchamp → ScanGo: OrderEvent v1 ตามสัญญา ScanGo Order API v1 §4/§6 (DEV-0009 สเปกข้อ 6 · Pack ผ่าน 2026-11-14)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/orderOnUpdate.js` (buildEvent · ชนิดข่าว accepted)
//   + `functions/claude/que/scangoOutbound.js` › postProvider (`sign:'partner'`: serialize body เอง 1 ครั้ง → เซ็นบนไบต์นั้น → ส่งไบต์นั้นตรง ๆ ·
//   header X-ScanGo-Partner/Timestamp/Signature + Idempotency-Key = eventId · ❌ ไม่แนบ x-scango-platform-key · ไม่โยน error)
// ปลายทาง (scango_server origin/main): `POST <base>/v1/partners/shopchamp/order-events` (`functions/routes/partner.v1.routes.js`)
//   ScanGo ตรวจลายเซ็นด้วยกุญแจของ partnerId ใน path = env `SHOPCHAMP_PLATFORM_KEY` (`functions/providers/profiles.js`)
//   = ค่าเดียวกับ secret `SCANGO_SHOPCHAMP_KEY` ฝั่งนี้ (กุญแจเดียวทั้ง 2 ทิศ · ตัวเดียวกับที่ v1/partnerSign.js ใช้ตรวจขาเข้า) ⇒ ไม่ต้องมี secret ใหม่
//   ScanGo ตอบ 200 {ok, orderId, state, applied, ignored?} · ซ้ำ eventId = applied:false duplicate_event · ใบรับแล้ว = applied:false already_in_state
//   ⇒ 2xx ทุกแบบ = ScanGo รู้แล้ว ('sent') · 4xx/5xx/เน็ตหลุด/timeout = 'failed' · env ไม่ครบ = 'not_configured' (ไม่ยิง)
// base = env `SCANGO_BASE_URL` · ไม่ตั้ง = DEFAULT_BASE (function `scango` ของ project scango-53aeb · ค่าเดียวกับที่แอปพี่น้องตั้ง)
//
// ต่างจากต้นแบบ: ❌ ไม่มี outbox/ตัวกวาด (Pack ถอดท่อยิงออกของบ้านนี้ 2026-11-13) ⇒ ยิงสดครั้งเดียว timeout 5 วิ ·
//   ยิงไม่ออก = ผู้เรียกบันทึก scangoAck แล้วยิงใหม่ตอนร้านกดรับซ้ำ (scango.orderAccept) · eventId คงที่ `<orderRef>:accepted` ⇒ ScanGo กันซ้ำเอง
//   ต้นแบบใช้ trigger ของใบ POS · บ้านนี้ใบอยู่ scangoOrder และมีทางเดียวที่ร้านรับในแอป (scango.orderAccept) ⇒ ผู้เรียกยิงเองหลัง commit
// ส่งผ่าน deps.scangoSend({url, raw, headers, timeoutMs, event}) → {status, data} (เทส/harness ฉีด) · ไม่ส่ง = axios ตัวจริง (โหลดตอนใช้)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { depOr } = require("../../_shared/deps");
const { sign, PARTNER_ID, ENV_KEY, H_PARTNER, H_TIMESTAMP, H_SIGNATURE } = require("./partnerSign");

const SCHEMA_EVENT = "scango.order-event.v1";
const EVENT_PATH = `/v1/partners/${PARTNER_ID}/order-events`;
const BASE_ENV = "SCANGO_BASE_URL";
const DEFAULT_BASE = "https://asia-southeast1-scango-53aeb.cloudfunctions.net/scango";
const TIMEOUT_MS = 5000;
const H_IDEMPOTENCY = "idempotency-key";

const str = (v) => (v == null ? "" : String(v).trim());
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** env ที่ใช้ยิง (deps.env แทน process.env ได้) */
function configOf(deps) {
  const env = deps && isObj(deps.env) ? deps.env : process.env;
  const base = (str(env[BASE_ENV]) || DEFAULT_BASE).replace(/\/+$/, "");
  const key = str(env[ENV_KEY]);
  return { url: base + EVENT_PATH, key, ready: !!key };
}

/** OrderEvent v1 §6 ที่ร้านส่ง (actor venue · รูปเดียวกับ scango_server mapOrder.eventV1Of) */
function buildEvent({ orderRef, type, at }) {
  const iso = at instanceof Date ? at.toISOString() : str(at);
  return {
    schema: SCHEMA_EVENT,
    eventId: `${orderRef}:${type}`,
    orderId: orderRef,
    partnerOrderRef: orderRef,
    type,
    at: iso,
    actor: "venue",
    reason: null,
    note: null,
    rider: null,
  };
}

/** header ครบชุดของคำขอขาออก 1 ครั้ง */
function headersFor(raw, { now, key, idempotencyKey }) {
  const ts = String(now.getTime());
  return {
    "content-type": "application/json; charset=utf-8",
    [H_PARTNER]: PARTNER_ID,
    [H_TIMESTAMP]: ts,
    [H_SIGNATURE]: sign({ timestamp: ts, rawBody: raw, secret: key }),
    ...(idempotencyKey ? { [H_IDEMPOTENCY]: String(idempotencyKey) } : {}),
  };
}

const axiosSend = async ({ url, raw, headers, timeoutMs }) => {
  const r = await require("axios").post(url, raw, { headers, timeout: timeoutMs, transformRequest: [(d) => d], validateStatus: () => true });
  return { status: r && r.status, data: r && r.data };
};

/**
 * sendEvent(deps, event, now) → {state:'sent'|'failed'|'not_configured', status:number|null, error:string|null} · ไม่โยนเลยสักทาง
 */
async function sendEvent(deps, event, now) {
  const cfg = configOf(deps);
  if (!cfg.ready) {
    console.warn("[scango:eventOut] not_configured", { hasKey: false, eventId: event.eventId });
    return { state: "not_configured", status: null, error: `${ENV_KEY} ไม่ได้ตั้ง` };
  }
  try {
    const raw = JSON.stringify(event);
    const headers = headersFor(raw, { now, key: cfg.key, idempotencyKey: event.eventId });
    const send = depOr(deps, "scangoSend", axiosSend);
    const r = (await send({ url: cfg.url, raw, headers, timeoutMs: TIMEOUT_MS, event })) || {};
    const status = Number.isInteger(r.status) ? r.status : null;
    if (status !== null && status >= 200 && status < 300) return { state: "sent", status, error: null };
    const d = isObj(r.data) ? r.data : {};
    const error = str(d.code || d.error).slice(0, 100) || (status === null ? "no_status" : `http_${status}`);
    console.error("[scango:eventOut] failed", { eventId: event.eventId, status, error });
    return { state: "failed", status, error };
  } catch (e) {
    const error = str(e && (e.code || e.message)).slice(0, 200) || "network_error";
    console.error("[scango:eventOut] failed", { eventId: event.eventId, error });
    return { state: "failed", status: null, error };
  }
}

module.exports = { SCHEMA_EVENT, EVENT_PATH, BASE_ENV, DEFAULT_BASE, TIMEOUT_MS, H_IDEMPOTENCY, configOf, buildEvent, headersFor, sendEvent };

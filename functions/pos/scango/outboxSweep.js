// pos/scango/outboxSweep — งานตั้งเวลาทุก 1 นาที: ยิงข่าวที่ค้างใน `scangoOutbox` ซ้ำ + ปิดบิลที่ค้าง (billPending) อีกรอบ
//
// ต้นทาง: _outbound.sendEvent ยิงสดไม่ออก ⇒ `scangoOutbox/{eventId}` state 'pending' · closeBill ล้ม ⇒ scangoOrder.billNextAttemptAt
//
// 🔒 กติกา outbox:
//   ① query `nextAttemptAt <= now` orderBy asc limit BATCH (ช่องเดียว · index อัตโนมัติ · แถว dead มี nextAttemptAt null ⇒ ไม่ถูกหยิบ)
//   ② จองก่อนยิง: batch เลื่อน nextAttemptAt ไป +LEASE_MS (รอบซ้อน/instance ซ้อนไม่หยิบแถวเดิม) · function ตั้ง maxInstances 1 อีกชั้น
//   ③ ข่าวของใบเดียวกัน (orderRef) ยิงทีละตัวเรียงตาม `at` เก่า→ใหม่ · ข้ามใบยิงขนาน
//   ④ ยิงสำเร็จ = ลบแถว · ลองใหม่มีหวัง (เน็ต/5xx/408/429/env ไม่ตั้ง) = attempts+1 · backoff 30 วิ ×2 เพดาน 30 นาที
//      ScanGo ปฏิเสธชัด (4xx อื่น) / ครบ MAX_ATTEMPTS / อายุเกิน MAX_AGE_MS = state 'dead' · nextAttemptAt null (ไม่ลบ · เก็บไว้ไล่)
//   ⑤ payload ยิงซ้ำตามเดิมทุกไบต์ (รวม at · eventId)
// บิลค้าง: closeBill.retryPending (ใบที่ billNextAttemptAt ถึงเวลา · closeBill เลื่อน/หยุดเอง)
// ประกาศ function: pos/functions.js › scangoOutboxSweep (onSchedule v2 · ทุก 1 นาที Asia/Bangkok · region เดียวกับ pos · config = workloads.SCANGO_SWEEP_CONFIG
//   secret SCANGO_SHOPCHAMP_KEY + ONESIGNAL_REST_API_KEY) · index.js ต่อท้าย · SCANGO_BASE_URL จาก functions/.env.shopcham-24b0b (ดู workloads.js)
"use strict";

const { db } = require("../../firebase");
const { postRaw, isRetryable, OUTBOX } = require("./_outbound");

const BATCH = 200;
const PARALLEL = 20;
const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 15;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const tsMs = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
};

/** pure — ระยะเลื่อนหลังพังครั้งที่ attempts */
function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (n - 1));
}

/** pure — ผลยิง 1 แถว → patch (null = ลบแถว) */
function nextStateOf(row, out, nowMs) {
  if (out && out.sent) return null;
  const attempts = (Number(row.attempts) || 0) + 1;
  const created = tsMs(row.createdAt);
  const tooOld = created !== null && nowMs - created > MAX_AGE_MS;
  const retryable = (out && out.reason === "not_configured") || isRetryable(out && out.status);
  const lastError = String((out && (out.error || (out.status !== undefined ? out.status : out.reason))) || "unknown").slice(0, 300);
  if (!retryable || attempts >= MAX_ATTEMPTS || tooOld) {
    return { state: "dead", attempts, lastError, nextAttemptAt: null, deadAt: new Date(nowMs) };
  }
  return { state: "pending", attempts, lastError, nextAttemptAt: new Date(nowMs + backoffMs(attempts)) };
}

/** pure — กลุ่มตาม orderRef (ไม่มี = แถวเดี่ยว) · ในกลุ่มเรียงตาม at (ไม่มี = createdAt) */
function groupByOrder(rows) {
  const groups = new Map();
  for (const r of rows) {
    const p = (r.data && r.data.payload) || {};
    const key = p.orderRef ? `o:${p.orderRef}` : `r:${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keyOf = (r) => {
    const at = Date.parse(((r.data && r.data.payload) || {}).at);
    return Number.isFinite(at) ? at : tsMs(r.data && r.data.createdAt) || 0;
  };
  return [...groups.values()].map((g) => g.sort((a, b) => keyOf(a) - keyOf(b)));
}

/**
 * sweepOutbox({now, post}, deps) — กวาด 1 หน้า
 *   post(path, payload) → ผลรูป postRaw (ฉีดในเทส · ไม่ส่ง = postRaw ด้วย deps)
 * @returns {Promise<{picked, sent, retry, dead}>}
 */
async function sweepOutbox({ now, post } = {}, deps) {
  const at = now instanceof Date ? now : new Date();
  const nowMs = at.getTime();
  const send = typeof post === "function" ? post : (path, payload) => postRaw(path, payload, deps);
  const qs = await db.collection(OUTBOX).where("nextAttemptAt", "<=", at).orderBy("nextAttemptAt", "asc").limit(BATCH).get();
  const rows = (qs && qs.docs ? qs.docs : []).map((d) => ({ id: d.id, ref: db.collection(OUTBOX).doc(d.id), data: d.data() || {} }));
  const stats = { picked: rows.length, sent: 0, retry: 0, dead: 0 };
  if (!rows.length) return stats;

  const lease = db.batch();
  for (const r of rows) lease.update(r.ref, { nextAttemptAt: new Date(nowMs + LEASE_MS) });
  await lease.commit();

  const results = [];
  const groups = groupByOrder(rows);
  for (let i = 0; i < groups.length; i += PARALLEL) {
    await Promise.all(groups.slice(i, i + PARALLEL).map(async (g) => {
      for (const r of g) {
        let out;
        try {
          out = await send(r.data.path, r.data.payload);
        } catch (e) {
          out = { sent: false, reason: "failed", error: e && e.message };
        }
        results.push({ ref: r.ref, patch: nextStateOf(r.data, out, nowMs) });
      }
    }));
  }
  const write = db.batch();
  for (const { ref, patch } of results) {
    if (patch === null) { write.delete(ref); stats.sent++; }
    else { write.update(ref, patch); if (patch.state === "dead") stats.dead++; else stats.retry++; }
  }
  await write.commit();
  return stats;
}

/**
 * runSweep({now}, deps) — 1 รอบ: outbox + บิลค้าง · แต่ละส่วนพังไม่หยุดอีกส่วน · log สรุป 1 บรรทัดเสมอ (แม้เป็น 0)
 */
async function runSweep({ now } = {}, deps) {
  const at = now instanceof Date ? now : new Date();
  const log = (deps && deps.log) || console;
  const summary = { outbox: null, bills: null, errors: [] };
  try { summary.outbox = await sweepOutbox({ now: at, post: deps && deps.post }, deps); } catch (e) { summary.errors.push(`outbox:${e && e.message}`); }
  try {
    summary.bills = await require("./closeBill").retryPending({ now: at }, deps);
  } catch (e) { summary.errors.push(`bills:${e && e.message}`); }
  (summary.errors.length ? log.error : log.info).call(log, "pos/scango/outboxSweep", JSON.stringify(summary));
  return summary;
}

/** ตัวที่ onSchedule เรียก · env = process.env (secret ผูกที่ config ของ function) */
function runScheduled() {
  return runSweep({ now: new Date() }, {});
}

module.exports = { sweepOutbox, runSweep, runScheduled, nextStateOf, backoffMs, groupByOrder, BATCH, MAX_ATTEMPTS, MAX_AGE_MS, LEASE_MS };

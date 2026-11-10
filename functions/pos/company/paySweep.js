// pos/company/paySweep — งานตั้งเวลา companyPaySweep ทุก 5 นาที (Asia/Bangkok): กวาดใบจ่ายที่ยังรอ < 24 ชม. แล้วถาม posxpay (DEV-0003 U3)
//
// ทำไมต้องมี: ไม่มี webhook (separate-home ข้อยกเว้น 2026-11-10) ⇒ ลูกค้าปิดจอก่อนเงินเข้า = ไม่มีใคร poll · ตัวนี้เก็บตกให้เปิดของเอง
// ตัวทำงานจริง = _payCheck.checkCompanyPay ตัวเดียวกับ payStatus (ไม่มีตรรกะเปิดของในไฟล์นี้)
//
// ลำดับต่อรอบ (sweepCompanyPay):
//   ① secret ไม่มี = log ดัง + คืน unconfigured:true (ไม่แตะฐาน ไม่ยิงเน็ต)
//   ② query companyPay where createdAt >= now-24h orderBy createdAt limit 500 (ช่องเดียว · ไม่ต้องสร้าง composite index)
//      แล้วคัด status ∈ OPEN_STATES (request · expired) ในโค้ด · 🔴 บทเรียน 2 ของพี่น้อง: poller เลือกช่องผิดแล้วเงียบ 3 วัน
//      ⇒ log จำนวน scanned/candidates ทุกรอบ แม้เป็น 0 · เทส companyPay.test.js พิสูจน์ว่า query ใช้ช่อง `createdAt` ที่ payRequest เขียนจริง
//   ③ ต่อใบ: จองด้วย lease ใน tx (leaseUntil = now+10 นาที · leaseBy) · ใบที่ lease ยังไม่หมด = ข้าม (รอบซ้อน/instance ซ้อน)
//      → checkCompanyPay → push ที่ fulfill คืน (เฉพาะเปิดของจริง) → ปลด lease เสมอ (finally) · ใบหนึ่งพังไม่หยุดใบอื่น (นับ errors)
//   ④ log 1 บรรทัดสรุปทุกรอบ: {scanned, candidates, checked, paid, closed, expired, problem, waiting, transient, leased, errors, pushes, ms}
// ประกาศ function: pos/functions.js › companyPaySweep (onSchedule v2 · region เดียวกับ pos · secrets ตาม workloads.SWEEP_CONFIG) · index.js ต่อท้าย
// ❌ ไม่ require SDK ตัวจริง · db จาก ../../firebase · เทส: deps.inquiry/deps.push stub · ไม่ออกเน็ต
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const { notify } = require("../_shared/push/notify");
const { str } = require("./_orders");
const PC = require("./_payCheck");

/** หน้าต่างที่ยังเฝ้าใบ (นับจาก createdAt ของ QR ปัจจุบัน) */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** lease ต่อใบ · รอบถัดไป (5 นาที) ที่ยังเห็น lease = ใบนั้นยังถูกตัวอื่นถืออยู่ */
const LEASE_MS = 10 * 60 * 1000;
const SCAN_LIMIT = 500;
/** ช่องที่ query ใช้ · ต้องเป็นช่องที่ payRequest เขียน (เทสตรวจ) */
const QUERY_FIELD = "createdAt";

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

/** เลือกใบที่ยังต้องถาม: ทั้งหมดใน 24 ชม. → คัดสถานะเปิดในโค้ด */
async function candidatesOf(now) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const snap = await db.collection(PC.COLLECTION).where(QUERY_FIELD, ">=", since).orderBy(QUERY_FIELD, "asc").limit(SCAN_LIMIT).get();
  const docs = snap && Array.isArray(snap.docs) ? snap.docs : [];
  const open = docs.filter((d) => PC.OPEN_STATES.includes(str((d.data() || {}).status)));
  return { scanned: docs.length, open };
}

/** จองใบใน tx · 'ok' = จองได้ · 'leased' = อีกตัวถืออยู่ · 'skip' = สถานะไม่เปิดแล้ว */
async function acquireLease(ref, now, leaseBy) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap && snap.exists ? snap.data() || {} : {};
    if (!PC.OPEN_STATES.includes(str(doc.status))) return "skip";
    const until = PC.msOf(doc.leaseUntil);
    if (until !== null && until > now.getTime()) return "leased";
    tx.update(ref, { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseBy });
    return "ok";
  });
}

/**
 * sweepCompanyPay({now, env, deps?, log?, leaseBy?}) → สรุปรอบ (object เดียวกับที่ log)
 *   now = Date ของ server (ผู้เรียกอ่านครั้งเดียว) · env = process.env หรือ object แทน · deps = {inquiry, push} (เทส)
 */
async function sweepCompanyPay({ now, env, deps, log, leaseBy } = {}) {
  const logger = typeof log === "function" ? log : console.log;
  const t0 = Date.now();
  const out = { ok: true, unconfigured: false, scanned: 0, candidates: 0, checked: 0, paid: 0, closed: 0, expired: 0, problem: 0, waiting: 0, transient: 0, leased: 0, skipped: 0, errors: 0, pushes: 0, ms: 0 };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("sweepCompanyPay ต้องส่ง now เป็น Date");
  const cfg = PC.companyPayConfig(env);
  if (!cfg.ok) {
    out.ok = false; out.unconfigured = true; out.ms = Date.now() - t0;
    logger(`companyPaySweep 🔴 unconfigured missing=${(cfg.extra && cfg.extra.missing || []).join(",")} ${JSON.stringify(out)}`);
    return out;
  }
  const by = str(leaseBy) || `sweep-${crypto.randomBytes(4).toString("hex")}`;
  const { scanned, open } = await candidatesOf(now);
  out.scanned = scanned;
  out.candidates = open.length;
  for (const d of open) {
    const doc = d.data() || {};
    const ref = db.collection(PC.COLLECTION).doc(d.id);
    let got;
    try { got = await acquireLease(ref, now, by); } catch (e) { out.errors++; logger(`companyPaySweep ${d.id} lease ล้ม ${(e && e.message) || e}`); continue; }
    if (got === "leased") { out.leased++; continue; }
    if (got !== "ok") { out.skipped++; continue; }
    try {
      const r = await PC.checkCompanyPay({ kind: doc.kind, orderUUID: doc.orderUUID, now, env, deps });
      out.checked++;
      if (r.transient) out.transient++;
      else if (r.state === "paid") out.paid++;
      else if (r.state === "closed") out.closed++;
      else if (r.state === "expired") out.expired++;
      else if (r.state === "problem") out.problem++;
      else out.waiting++;
      if (r.push) { await notify(deps, r.push); out.pushes++; }
    } catch (e) {
      out.errors++;
      const why = e && e.deny ? `${e.deny.status} ${e.deny.error}` : (e && e.message) || String(e);
      logger(`companyPaySweep ${d.id} ล้ม ${why}`);
    } finally {
      try { await ref.update({ leaseUntil: null }); } catch (e) { logger(`companyPaySweep ${d.id} ปลด lease ล้ม ${(e && e.message) || e}`); }
    }
  }
  out.ms = Date.now() - t0;
  // บรรทัดสรุปทุกรอบ (0 ก็พิมพ์ · เงียบ = สัญญาณว่า function ไม่วิ่ง ไม่ใช่ว่าไม่มีงาน)
  logger(`companyPaySweep ${JSON.stringify(out)}`);
  return out;
}

/** ตัวที่ onSchedule เรียก · อ่านนาฬิกาครั้งเดียว · env = process.env (secret ผูกที่ workloads.SWEEP_CONFIG) */
async function runScheduled() {
  return sweepCompanyPay({ now: new Date(), env: process.env });
}

module.exports = { sweepCompanyPay, runScheduled, candidatesOf, acquireLease, WINDOW_MS, LEASE_MS, SCAN_LIMIT, QUERY_FIELD };

// pos/company/_payCheck.js — ตัวกลางของการจ่ายอัตโนมัติด้วย posxpay ของใบสั่งซื้อบริษัท 4 ชนิด (DEV-0003 U2/U3 · แบบ lanes/dev/source/office-autopay-design.md)
//
// ใครเรียก: payStatus.js (แอป poll ทุก 2-3 วิ) · paySweep.js (งานตั้งเวลา ทุก 5 นาที) · office (U4) ปุ่ม "ตรวจกับ posxpay" — ทุกทางเข้าตัวเดียวกัน
// ❌ ไม่เชื่อ webhook · server ถาม inquire เองเสมอ (separate-home ข้อยกเว้น 2026-11-10: merchant ร่วมกับบ้านพี่น้อง · ถามสถานะเองอย่างเดียว)
// ❌ ไม่รับยอดจากจอ · ยอดที่เทียบ = `amountSatang` ของ doc จ่าย ซึ่ง payRequest อ่านจากใบ (net · ใบชุดสินค้าใช้ price) ตอนสร้าง
//
// doc `companyPay/{kind}-{orderUUID}` (payRequest เขียน · ไฟล์นี้ขยับสถานะ):
//   {kind, orderUUID, shopId (doc id ร้านที่ขอ), orderShopId, amountSatang, amount (บาท), providerRef (orderId ของ posxpay), qrPayload, qrKind,
//    ref1 '<kind>:<orderUUID>', ref2 'shopchamp', status, createdAt, updatedAt, expireAt (+15 นาที), attempts (จำนวนครั้งที่ถาม inquire),
//    priorRefs[] (QR รุ่นก่อนของใบเดียวกัน · posxpay ไม่มีคำสั่งปิด QR ⇒ เงินเข้าใบเก่าได้ · ยังถามต่อ · บทเรียน 15), requestCount, requestedBy,
//    leaseUntil/leaseBy (sweep จอง), lastCheckedAt, lastError, paidAt, paidSatang, providerRefPaid, fulfilled{duplicate,status,at}, problem{code,message,at}}
//
// ตารางสถานะ (status ของ doc · = `state` ที่คืน):
//   request  ขอ QR แล้ว ยังไม่หมดอายุ · ถาม inquire ได้ → waiting/paid/closed/expired/problem      (ไม่จบ)
//   expired  เกิน expireAt และ posxpay ยัง pending · แอปขอ QR ใหม่ได้ (payRequest ย้าย ref เดิมไป priorRefs) · sweep ยังถามต่อ 24 ชม. (ไม่จบ)
//   paid     posxpay success + ยอดตรงสตางค์ + fulfill(auto) ผ่าน (รวม duplicate = ใบเปิดไว้ก่อนแล้ว)                                      (จบ)
//   closed   posxpay fail/cancel ของ QR ปัจจุบัน · แอปขอ QR ใหม่ได้                                                                      (จบ · ขอใหม่ = doc ใหม่ทับ)
//   problem  เงินเข้าแต่ไม่ได้ของ: ยอดไม่ตรง (amount_mismatch) หรือ fulfill ปัด (ใบถูกยกเลิก/สถานะแปลก/ร้านหาไม่เจอ ฯลฯ) · 🔴 ห้ามเงียบ → office (U4) ตัดสิน (จบ)
//   คืนค่า: {state, kind, orderUUID, docId, amountSatang, amount, expireAt, final, transient?, reason?, fulfilled?, push?}
//     transient:true = posxpay ล่ม/ตอบค่าที่ไม่รู้จัก ⇒ state = สถานะเดิมของ doc · ❌ ไม่แปลเป็น paid/closed (fail-closed)
//     push = ข้อความแจ้งผู้ซื้อที่ fulfill คืน (เฉพาะครั้งที่เปิดของจริง) · ผู้เรียกส่งเองด้วย notify(deps, push)
//
// กันซ้ำ: fulfill อ่านสถานะใบสดใน tx (เปิดแล้ว = duplicate ไม่เขียนซ้ำ) · การขยับสถานะ doc ทำใน tx และไม่ทับสถานะที่จบแล้ว (paid/closed/problem)
//   ⇒ payStatus 2 เครื่อง + sweep ชนกัน = เปิดของครั้งเดียว · push ครั้งเดียว (เฉพาะตัวที่ duplicate:false)
// 🔐 token/serial ของบริษัทมาจาก secret COMPANY_POSXPAY_TOKEN / COMPANY_POSXPAY_SERIAL (อ่านผ่าน env ที่ส่งมา · ไม่มี = 503 company_pay_unconfigured ❌ ไม่ยิงเน็ต)
// ❌ ไม่ require SDK ตัวจริง · db จาก ../../firebase · ยิงเน็ตผ่าน providers/posxpay.js เท่านั้น (deps.inquiry/deps.createQR แทนได้ · harness/เทสไม่ออกเน็ต)
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { deny } = require("../_shared/respond");
const { depOr } = require("../_shared/deps");
const { Refusal, refuse, sat, str } = require("./_orders");
const { fulfill, KINDS } = require("./_fulfill");

const COLLECTION = "companyPay";
/** QR ใบบริษัทอายุ 15 นาที (เท่าหน้าต่างกันกดซ้ำของเกตเวย์ร้าน) */
const EXPIRE_MS = 15 * 60 * 1000;
/** ref2 ของทุกรายการของบ้านนี้ · ❌ ห้าม 'auto' (ป้ายเปิดของของบ้านพี่น้องที่ใช้ merchant ร่วมกัน) */
const REF2 = "shopchamp";
/** เก็บ QR รุ่นก่อนไว้ถามต่อไม่เกินกี่รุ่น */
const PRIOR_REFS_MAX = 5;
const SECRET_TOKEN = "COMPANY_POSXPAY_TOKEN";
const SECRET_SERIAL = "COMPANY_POSXPAY_SERIAL";
const SECRETS = Object.freeze([SECRET_TOKEN, SECRET_SERIAL]);

const STATES = Object.freeze(["request", "paid", "closed", "expired", "problem"]);
/** สถานะที่ยังต้องถาม posxpay ต่อ */
const OPEN_STATES = Object.freeze(["request", "expired"]);
/** สถานะที่จบแล้ว · ห้ามทับ */
const FINAL_STATES = Object.freeze(["paid", "closed", "problem"]);

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isNonEmptyString = (v) => typeof v === "string" && v !== "";
const validDocId = (v) => isNonEmptyString(v) && v.length <= 1500 && !v.includes("/") && v !== "." && v !== "..";
const isDate = (d) => d instanceof Date && Number.isFinite(d.getTime());

/** ms ของค่าเวลาที่อ่านจากฐาน (Date · Timestamp ปลอม/จริง) · อ่านไม่ได้ = null */
function msOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (v && typeof v.toMillis === "function") { const n = Number(v.toMillis()); return Number.isFinite(n) ? n : null; }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
const dateOf = (v) => { const ms = msOf(v); return ms === null ? null : new Date(ms); };
/** ISO string สำหรับคำตอบ (คืนให้จอเป็นข้อความเสมอ · ไม่ปล่อย Date/Timestamp ออกทางซอง) */
/** สถานะ doc → state ที่คืน: request = waiting (ยังรอ) · อื่นเท่าเดิม */
const stateOf = (status) => (status === "request" ? "waiting" : status);
const isoOf = (v) => { const d = dateOf(v); return d ? d.toISOString() : null; };

/** doc id ของใบจ่าย = `<kind>-<orderUUID>` (ใบละ doc เดียว · กันขอ QR ซ้อนต่อใบ) */
const payDocId = (kind, orderUUID) => `${kind}-${orderUUID}`;
const payRef = (kind, orderUUID) => db.collection(COLLECTION).doc(payDocId(kind, orderUUID));

/**
 * companyPayConfig(env) → {ok:true, serial, token} | deny 503 company_pay_unconfigured {missing:[ชื่อ secret]}
 *   env = object (process.env หรือ deps.env) · อ่านอย่างเดียว ไม่ยิงเน็ต · ❌ ไม่ log ค่า
 */
function companyPayConfig(env) {
  const e = isObj(env) ? env : {};
  const token = str(e[SECRET_TOKEN]).trim();
  const serial = str(e[SECRET_SERIAL]).trim();
  const missing = [];
  if (!token) missing.push(SECRET_TOKEN);
  if (!serial) missing.push(SECRET_SERIAL);
  if (missing.length) return deny(503, "company_pay_unconfigured", "ระบบชำระเงินอัตโนมัติยังไม่ได้ตั้งค่า กรุณาติดต่อทีมงาน", { missing });
  return { ok: true, serial, token };
}

/** ชนิดใบ → ยอดของใบเป็นสตางค์ (ช่องตาม KINDS.amountField) · อ่านไม่ได้ = null */
function orderAmountSatang(kind, order) {
  const spec = KINDS[kind];
  if (!spec || !isObj(order)) return null;
  const n = sat(order[spec.amountField]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** env ที่ handler/sweep อ่าน: deps.env (ทั้งก้อน · harness/เทส) หรือ process.env */
function envOf(deps) {
  return deps && isObj(deps.env) ? deps.env : process.env;
}

/**
 * ฟังก์ชันของ posxpay: deps.createQR / deps.inquiry ชนะ (harness/เทส · ไม่ออกเน็ต) · ไม่มี = provider ตัวจริง (โหลดตอนเรียก)
 *   channel = แถวพร้อมเพย์ของ spec · env ส่งต่อให้ provider ทุกครั้ง
 */
function providerOf(deps, env) {
  const PXP = require("../gateway/providers/posxpay");
  const channel = PXP.spec.channels[0];
  const wrap = (name) => {
    const fn = depOr(deps, name, null) || ((args) => PXP[name](args));
    return (args) => fn({ channel, env, ...args });
  };
  return { channel, createQR: wrap("createQR"), inquiry: wrap("inquiry") };
}

/** สรุปที่คืนให้ผู้เรียกจาก doc (ไม่คืน providerRef/qr ของจริงจากทางนี้ · payRequest เป็นคนคืน QR) */
function summaryOf(docId, doc, state, extra) {
  return {
    state,
    kind: str(doc.kind),
    orderUUID: str(doc.orderUUID),
    docId,
    amountSatang: Number.isSafeInteger(doc.amountSatang) ? doc.amountSatang : null,
    amount: Number.isSafeInteger(doc.amountSatang) ? logic.fromSatang(doc.amountSatang) : null,
    expireAt: isoOf(doc.expireAt),
    final: FINAL_STATES.includes(state),
    ...(extra || {}),
  };
}

/**
 * ขยับสถานะ doc ใน tx · ไม่ทับสถานะที่จบแล้ว (อีกตัวที่วิ่งขนานอาจปิดไปก่อน) · คืน {applied, status}
 *   patch ไม่มี status = เขียน trail อย่างเดียว (attempts/lastError) ก็ไม่ทับของที่จบแล้ว
 */
async function transition(ref, now, patch) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap && snap.exists ? snap.data() || {} : {};
    const status = str(cur.status);
    if (FINAL_STATES.includes(status)) return { applied: false, status };
    tx.update(ref, { ...patch, updatedAt: now, leaseUntil: null });
    return { applied: true, status: patch.status || status };
  });
}

/** ชื่อ ref ทั้งหมดที่ต้องถาม: ปัจจุบันก่อน แล้ว QR รุ่นก่อน (ตัดซ้ำ/ว่าง) */
function refsOf(doc) {
  const out = [];
  const cur = str(doc.providerRef);
  if (cur) out.push(cur);
  for (const p of Array.isArray(doc.priorRefs) ? doc.priorRefs : []) {
    const r = isObj(p) ? str(p.providerRef) : "";
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

function normalizeCheckInput(p) {
  const bad = (m) => refuse(deny(400, "invalid_request", m));
  if (!isObj(p)) bad("ต้องส่ง {kind, orderUUID, now, env}");
  const { kind, orderUUID, now } = p;
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) bad("kind ต้องเป็น package | hardware | image | stock");
  if (!validDocId(orderUUID)) bad("orderUUID ต้องเป็นข้อความที่ใช้เป็น doc id ได้");
  if (!isDate(now)) bad("now ต้องเป็น Date ที่ใช้ได้");
  return { kind, orderUUID, now: new Date(now.getTime()) };
}

/**
 * checkCompanyPay({kind, orderUUID, now, env, deps?, shopId?}) → Promise<result>  (ดูตารางสถานะที่หัวไฟล์)
 *   env    object ที่มี COMPANY_POSXPAY_TOKEN/SERIAL (handler ส่ง envOf(deps) · sweep ส่ง process.env)
 *   deps   ไม่บังคับ: inquiry (แทน provider · harness/เทส)
 *   shopId ไม่บังคับ: ส่งมา = doc.shopId ต้องตรง ไม่งั้น 409 company_pay_other_shop (payStatus ใช้ · sweep ไม่ส่ง)
 *   ปัด = throw Refusal: 400 invalid_request · 404 company_pay_not_found · 409 company_pay_other_shop · 409 company_pay_status_unexpected
 *         · 503 company_pay_unconfigured (เฉพาะเมื่อยังต้องถาม posxpay · ❌ ไม่ยิงเน็ต) · 409 company_pay_amount_invalid
 *   ลำดับ: อ่าน doc → จบแล้ว = คืนสถานะเดิม (ไม่ต้องมี secret ไม่ยิงเน็ต) → config → inquire ref ปัจจุบัน (+รุ่นก่อน) → ตัดสิน → เขียนใน tx
 */
async function checkCompanyPay(p) {
  const { kind, orderUUID, now } = normalizeCheckInput(p);
  const deps = p.deps;
  const docId = payDocId(kind, orderUUID);
  const ref = payRef(kind, orderUUID);
  const snap = await ref.get();
  if (!snap || !snap.exists) refuse(deny(404, "company_pay_not_found", "ยังไม่ได้ขอ QR ของใบนี้", { kind, orderUUID }));
  const doc = snap.data() || {};
  if (p.shopId !== undefined && p.shopId !== null && str(doc.shopId) !== p.shopId) {
    refuse(deny(409, "company_pay_other_shop", "รายการจ่ายนี้เป็นของร้านอื่น"));
  }
  const status = str(doc.status);
  if (FINAL_STATES.includes(status)) {
    return summaryOf(docId, doc, status, {
      ...(status === "paid" ? { fulfilled: isObj(doc.fulfilled) ? { duplicate: doc.fulfilled.duplicate === true, status: str(doc.fulfilled.status) } : null } : {}),
      ...(status === "problem" ? { reason: isObj(doc.problem) ? str(doc.problem.code) : "" } : {}),
    });
  }
  if (!OPEN_STATES.includes(status)) refuse(deny(409, "company_pay_status_unexpected", "สถานะรายการจ่ายนี้ไม่รู้จัก", { status }));

  const cfg = companyPayConfig(p.env);
  if (!cfg.ok) refuse(cfg);
  const amountSatang = Number.isSafeInteger(doc.amountSatang) && doc.amountSatang > 0 ? doc.amountSatang : null;
  if (amountSatang === null) refuse(deny(409, "company_pay_amount_invalid", "ยอดของรายการจ่ายนี้อ่านไม่ได้"));
  const refs = refsOf(doc);
  if (!refs.length) refuse(deny(409, "company_pay_amount_invalid", "รายการจ่ายนี้ไม่มีเลขรายการของผู้ให้บริการ"));

  const px = providerOf(deps, p.env);
  const expectedAmount = logic.fromSatang(amountSatang);
  const attempts = (Number.isSafeInteger(doc.attempts) ? doc.attempts : 0) + 1;
  const trail = { attempts, lastCheckedAt: now };
  const log = (to, more) => console.log(`companyPay ${docId} ${status} → ${to}${more ? " " + more : ""}`);

  for (let i = 0; i < refs.length; i++) {
    const providerRef = refs[i];
    const isCurrent = i === 0;
    const r = await px.inquiry({ config: { serial: cfg.serial, token: cfg.token }, providerRef, expectedAmount });
    if (!r || r.ok !== true) {
      // posxpay ล่ม/ปฏิเสธคำขอ = ชั่วคราว · state เดิม · ❌ ไม่แปลเป็น paid/closed
      const code = (r && r.error && r.error.code) || "provider_error";
      await transition(ref, now, { ...trail, lastError: { code, message: str(r && r.error && r.error.message).slice(0, 300), at: now } });
      return summaryOf(docId, doc, stateOf(status), { transient: true, reason: code });
    }
    const state = r.data && r.data.state;
    if (state === "paid") {
      const paidSatang = sat(r.data.amountPaid);
      let f;
      try {
        f = await fulfill({ kind, orderUUID, via: "auto", payment: { provider: "posxpay", providerRef, paidSatang }, now });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        // เงินเข้าแต่เปิดของไม่ได้ (ยอดไม่ตรง · ใบถูกยกเลิก · ร้านหาไม่เจอ ฯลฯ) = problem · ห้ามเงียบ
        const problem = { code: e.deny.error, message: str(e.deny.message), extra: e.deny.extra || null, providerRef, paidSatang, at: now };
        const t = await transition(ref, now, { ...trail, status: "problem", problem, paidAt: now, paidSatang, providerRefPaid: providerRef });
        log("problem", problem.code);
        return summaryOf(docId, doc, t.applied ? "problem" : t.status, { reason: problem.code, paidSatang });
      }
      const fulfilled = { duplicate: f.duplicate === true, status: str(f.status), at: now };
      const t = await transition(ref, now, { ...trail, status: "paid", paidAt: now, paidSatang, providerRefPaid: providerRef, fulfilled });
      log("paid", `${fulfilled.duplicate ? "duplicate" : "fulfilled"} ${paidSatang} สตางค์${isCurrent ? "" : " (QR รุ่นก่อน)"}`);
      return summaryOf(docId, doc, "paid", { fulfilled: { duplicate: fulfilled.duplicate, status: fulfilled.status }, paidSatang, push: f.duplicate ? null : f.push || null });
    }
    if (state === "amount_mismatch") {
      const paidSatang = sat(r.data.amountPaid);
      const problem = { code: "amount_mismatch", message: "ยอดที่จ่ายไม่เท่ายอดของใบ", extra: { expectedSatang: amountSatang, paidSatang }, providerRef, paidSatang, at: now };
      const t = await transition(ref, now, { ...trail, status: "problem", problem, paidAt: now, paidSatang, providerRefPaid: providerRef });
      log("problem", `amount_mismatch expected ${amountSatang} paid ${paidSatang}`);
      return summaryOf(docId, doc, t.applied ? "problem" : t.status, { reason: "amount_mismatch", paidSatang });
    }
    if (state === "closed") {
      // QR ปัจจุบันถูก fail/cancel ที่ posxpay = closed (ขอใหม่ได้) · QR รุ่นก่อนที่ closed = ไม่มีผล ถามตัวถัดไป
      if (!isCurrent) continue;
      const t = await transition(ref, now, { ...trail, status: "closed", closedAt: now });
      log("closed");
      return summaryOf(docId, doc, t.applied ? "closed" : t.status);
    }
    if (state !== "waiting") {
      // ค่าที่ provider ไม่รู้จัก (mapStatus → error) = fail-closed · ชั่วคราว · state เดิม
      await transition(ref, now, { ...trail, lastError: { code: "provider_unknown_state", message: str(state), at: now } });
      return summaryOf(docId, doc, stateOf(status), { transient: true, reason: "provider_unknown_state" });
    }
  }

  // ทุก ref ยัง pending
  const expireMs = msOf(doc.expireAt);
  if (status === "request" && expireMs !== null && now.getTime() > expireMs) {
    const t = await transition(ref, now, { ...trail, status: "expired", expiredAt: now });
    log("expired");
    return summaryOf(docId, doc, t.applied ? "expired" : t.status);
  }
  await transition(ref, now, trail);
  return summaryOf(docId, doc, stateOf(status));
}

module.exports = {
  companyPayConfig, checkCompanyPay,
  COLLECTION, EXPIRE_MS, REF2, PRIOR_REFS_MAX, SECRETS, SECRET_TOKEN, SECRET_SERIAL, STATES, OPEN_STATES, FINAL_STATES,
  payDocId, payRef, orderAmountSatang, envOf, providerOf, msOf, dateOf, isoOf, stateOf, Refusal,
};

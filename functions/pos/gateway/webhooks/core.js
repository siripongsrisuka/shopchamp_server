// pos/gateway/webhooks/core.js — แกนร่วมของ webhook ทุกเจ้า: ถามผู้ให้บริการซ้ำ → settle.confirmPaid (ก้อน 7 · DEV-0001)
//
// ผู้เรียก: webhooks/ntt.js · webhooks/kbank.js · webhooks/beam.js (หาใบ pgWebhook เองตามแบบของเจ้า แล้วส่งใบมาที่นี่)
// หลัก (ยกจากพี่น้อง webhook.js / ntt-close.js / webhook-kbank.js / webhook-beam.js · เหลือเฉพาะส่วนยืนยันเงิน):
//   ① ไม่เชื่อ payload สักช่อง — payload ใช้แค่ "ชี้ใบ" · ยอด/สถานะที่มากับ payload ไม่ถูกอ่านเลย
//   ② ถามผู้ให้บริการซ้ำทุกครั้ง (provider.inquiry หรือ deps.inquiry) ด้วย providerRef **จากใบของเรา** ไม่ใช่จาก payload
//   ③ mark ผ่าน settle.confirmPaid ที่เดียว (ยอดตรงถึงสตางค์ · ไม่ตรง = verifyMismatch ไม่ mark · success แล้ว = ไม่เขียนซ้ำ)
//   ④ ใบที่ success แล้ว = ตอบ already ทันที ไม่ถามซ้ำ ไม่เขียน (เจ้ายิงซ้ำ at-least-once)
//   ⑤ ตอบ 200 กับของที่ไม่ใช่ของเรา / ทำไปแล้ว / ยังไม่จ่าย / ยอดไม่ตรง (หยุดการยิงซ้ำ) · 5xx เฉพาะพังชั่วคราว (ถามเจ้าไม่ได้ · ระบบไม่พร้อม)
//   ❌ ไม่ปิดบิล (แอปสร้างบิลเองหลังรู้ผล · decision 3-2) · ❌ ไม่มี autoCheckout / remotePay / scango
// ซองคำตอบ: 200 {ok:true, result:<kind>, referenceId?} · 5xx {ok:false, error, message} · ❌ ไม่ echo payload · ❌ ไม่ log ค่าลับ
"use strict";

const { ok, fail } = require("../../_shared/respond");
const { readNow, depOr } = require("../../_shared/deps");
const { confirmPaid, sameSatang } = require("../settle");
const C = require("../connections")._internal;

const COLLECTION = "pgWebhook";

/** ตอบ 200 ผลที่จบแล้ว (เจ้าไม่ต้องยิงซ้ำ) */
function done(res, result, extra) {
  return ok(res, { result, ...(extra || {}) });
}

/** log สั้น ไม่มีค่าลับ/payload */
function warn(tag, ...parts) {
  try { console.warn(`gateway webhook ${tag}:`, ...parts); } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
}

/**
 * หาใบจาก providerRef (NTT out_trade_no · Beam intent id) · คืนใบแรกที่ providerId ตรง
 *   ไม่มีใบเลย = {kind:'not_ours'} · มีแต่เป็นของเจ้าอื่น = {kind:'wrong_provider'}
 *   ใช้ index เดียวของ providerRef (equality) · กรอง providerId ในหน่วยความจำ (กันใบของเจ้าอื่นที่รหัสบังเอิญชน)
 */
async function findByProviderRef(db, providerRef, providerId) {
  const q = await db.collection(COLLECTION).where("providerRef", "==", providerRef).limit(5).get();
  const docs = (q && q.docs) || [];
  if (!docs.length) return { kind: "not_ours" };
  const hit = docs.find((d) => (d.data() || {}).providerId === providerId);
  if (!hit) return { kind: "wrong_provider" };
  return { kind: "found", referenceId: hit.id, doc: hit.data() || {} };
}

/**
 * verifyAndSettle({req,res,deps,db,referenceId,doc,providerId,expectShopId?,verifiedBy,tag}) → ส่งคำตอบแล้ว
 *   doc = ใบที่ผู้เรียกอ่านมาแล้ว (ใช้หา channel · providerRef · ยอดที่ขอ) · การตัดสิน mark อ่านใบซ้ำใน transaction ของ settle
 */
async function verifyAndSettle({ res, deps, db, referenceId, doc, providerId, expectShopId, verifiedBy, tag }) {
  if (doc.providerId !== providerId) return done(res, "wrong_provider");
  if (expectShopId !== undefined && doc.shopId !== expectShopId) {
    warn(tag, "ใบเป็นของร้านอื่นจากที่ลายเซ็นบอก", referenceId);
    return done(res, "wrong_shop");
  }
  // ④ ทำไปแล้ว = ไม่ถามซ้ำ ไม่เขียน
  if (doc.process === "success") return done(res, "already", { referenceId });
  if (typeof doc.shopId !== "string" || !doc.shopId || typeof doc.channelId !== "string" || !doc.channelId) {
    warn(tag, "ใบไม่มี shopId/channelId — ยืนยันไม่ได้", referenceId);
    return done(res, "incomplete", { referenceId });
  }
  const providerRef = typeof doc.providerRef === "string" ? doc.providerRef : "";
  if (!providerRef) {
    warn(tag, "ใบไม่มี providerRef — ยืนยันไม่ได้", referenceId);
    return done(res, "incomplete", { referenceId });
  }

  const reg = C.registryOf(deps);
  const hit = reg.findChannel(doc.channelId);
  if (!hit || !hit.provider || !hit.provider.spec || hit.provider.spec.id !== providerId) {
    // ช่องทางในใบไม่ใช่ของเจ้านี้ (ข้อมูลขัดกันเอง) — เส้นนี้ไม่มีสิทธิ์ตัดรายการของเจ้าอื่น
    warn(tag, "ช่องทางของใบไม่ใช่ของเจ้านี้", referenceId);
    return done(res, "wrong_provider", { referenceId });
  }
  const spec = hit.provider.spec;

  // ค่าการเชื่อมต่อของร้าน (shopId จากใบ ไม่ใช่จาก payload)
  const cfg = await C.loadConfig({ db, deps, spec, shopId: doc.shopId });
  if (!cfg.ok) {
    if (cfg.code === "gateway_cred_key_missing" || cfg.code === "gateway_cred_key_invalid") {
      // ระบบเราไม่พร้อม (ไม่ใช่ของเจ้า) ⇒ 503 ให้เจ้ายิงซ้ำหลังแก้
      return fail(res, 503, cfg.code, "ระบบยังไม่พร้อมอ่านค่าการเชื่อมต่อ");
    }
    warn(tag, "อ่านค่าการเชื่อมต่อของร้านไม่ได้", referenceId, cfg.code);
    return done(res, "not_configured", { referenceId });
  }
  if (cfg.missing.length) {
    warn(tag, "ร้านตั้งค่าไม่ครบ", referenceId, cfg.missing.join(","));
    return done(res, "not_configured", { referenceId });
  }

  // ② ถามผู้ให้บริการซ้ำ — หัวใจของเส้นนี้ ห้ามถอด (เทส webhooks/*.test.js กลายพันธุ์ถอดบรรทัดนี้ต้องแดง)
  const inquiryFn = depOr(deps, "inquiry", typeof hit.provider.inquiry === "function" ? hit.provider.inquiry.bind(hit.provider) : null);
  if (!inquiryFn) return fail(res, 500, "provider_unavailable", "ผู้ให้บริการไม่มีทางถามสถานะ");
  const args = { channel: hit.channel, config: cfg.values, providerRef, expectedAmount: doc.amount, shopId: doc.shopId, ...C.extrasOf(deps) };
  let verified;
  try {
    verified = await inquiryFn(args);
  } catch (e) {
    warn(tag, "ถามผู้ให้บริการแล้วพัง", referenceId, e && e.name);
    return fail(res, 502, "verify_failed", "ยืนยันกับผู้ให้บริการไม่สำเร็จ");
  }
  if (!verified || verified.ok !== true || !verified.data) {
    const code = verified && verified.error && verified.error.code;
    warn(tag, "ถามผู้ให้บริการไม่สำเร็จ", referenceId, typeof code === "string" ? code : "unknown");
    return fail(res, 502, "verify_failed", "ยืนยันกับผู้ให้บริการไม่สำเร็จ");
  }
  const data = verified.data;
  let state = typeof data.state === "string" ? data.state : "unknown";
  // เจ้าที่เทียบยอดเอง (beam-bolt) ตอบ amount_mismatch ⇒ ส่งให้ settle ประทับ verifyMismatch (ยอดต่างจริงเท่านั้น)
  if (state === "amount_mismatch") state = sameSatang(data.amountPaid, doc.amount) ? "unknown" : "paid";

  const now = await readNow(deps);
  const r = await confirmPaid({
    db, referenceId, verified: { state, amountPaid: data.amountPaid }, verifiedBy, now,
    expectProviderId: providerId, ...(expectShopId !== undefined ? { expectShopId } : {}),
  });
  switch (r.kind) {
    case "marked":
      return done(res, "marked", { referenceId, ...(r.paidAfterCancel ? { paidAfterCancel: true } : {}) });
    case "already":
      return done(res, "already", { referenceId });
    case "not_paid":
      return done(res, "not_paid", { referenceId, state: r.state });
    case "mismatch":
      warn(tag, "ยอดที่ผู้ให้บริการตอบไม่ตรงใบ — ไม่ mark", referenceId);
      return done(res, "mismatch", { referenceId });
    case "not_found":
      return done(res, "not_ours");
    case "wrong_shop":
      return done(res, "wrong_shop");
    case "wrong_provider":
      return done(res, "wrong_provider");
    default:
      throw new Error(`webhook core: ผลที่ไม่รู้จัก ${r && r.kind}`);
  }
}

/** ครอบ handler ของ webhook: error ที่ไม่คาด = 500 (เจ้ายิงซ้ำ · idempotent) · ไม่ echo payload */
function guarded(tag, fn) {
  return async function handler(req, res) {
    try {
      return await fn(req, res);
    } catch (e) {
      try { console.error(`gateway webhook ${tag} error`, e && e.name, e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
  };
}

module.exports = { COLLECTION, verifyAndSettle, findByProviderRef, done, warn, guarded };

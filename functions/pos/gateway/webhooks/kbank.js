// pos/gateway/webhooks/kbank.js — KBank Thai QR แจ้งผลผ่านเครื่องกลาง mTLS (ก้อน 7 · DEV-0001 · ยกท่าจากบ้านพี่น้อง)
//
// สัญญา: shopchamp-center/api/gateway.webhookKbank.yaml · route สาธารณะ POST /pos_gateway/webhook/kbank (ไม่มี token ผู้ใช้)
// รูป: factory (deps) => handler(req, res) · deps: now credKey env registry inquiry
// ทางเดินของ callback: ธนาคาร → เครื่องกลาง mTLS (ใช้ร่วมกับบ้านพี่น้อง · Pack เลือก 4-2 วันที่ 2026-11-06) ตอบธนาคารเอง → ส่งต่อ body มาที่นี่
// ยามของเส้นนี้ (ลงทะเบียนที่ gateway/routes.js › PUBLIC_ROUTES):
//   callback ไม่มีลายเซ็น และผ่านมือตัวกลาง ⇒ ถือเป็นสัญญาณให้ไปถามเท่านั้น
//   ตัวชี้ใบ = reference1 (= ref1 ที่ส่งตอน createQR = doc id ของ pgWebhook) · ใบต้องเป็น providerId 'kbank-qr' ไม่งั้นไม่แตะ
//   ⇒ ถามธนาคารซ้ำ (provider.inquiry ของ kbank-qr) ด้วย providerRef **จากใบ** (❌ ไม่ใช้ partnerTxnUid ของ payload)
//   ⇒ mark ผ่าน settle.confirmPaid เท่านั้น · ❌ ห้ามใช้ยอด/สถานะใน payload
// คำตอบ: 200 {ok:true, result} ทุกกรณีที่จบแล้ว · 502 verify_failed (ถามธนาคารไม่ได้) · เครื่องกลางตอบธนาคารไปแล้ว ⇒ ไม่มีรูปคำตอบที่ธนาคารบังคับ
// ตัดจากพี่น้อง: scango / company-kbank / autoCheckout / ส่งคู่กับเส้นเก่า (บ้านนี้ไม่มีเส้นเก่าของ kbank-qr)
"use strict";

const core = require("./core");

const PROVIDER_ID = "kbank-qr";
// ยามที่ PUBLIC_ROUTES ตรวจว่ายังอยู่ในไฟล์
const VERIFY_METHOD = "KBANK_INQUIRY";
// รูป referenceId ที่ server ออก (เหมือน GatewayReferenceId ใน schema) · นอกรูป = ไม่แตะฐาน
const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseOf(deps) {
  const reg = require("../connections")._internal.registryOf(deps);
  const mod = reg.getProvider(PROVIDER_ID);
  if (mod && typeof mod.parseCallback === "function") return (b) => mod.parseCallback(b);
  return (b) => {
    const v = b && typeof b === "object" ? b.reference1 : undefined;
    const s = v === undefined || v === null ? "" : String(v).trim();
    return s && !s.includes("/") ? { ok: true, referenceId: s } : { ok: false };
  };
}

function webhookKbank(deps) {
  return core.guarded("kbank", async (req, res) => {
    const parsed = parseOf(deps)(req && req.body);
    const referenceId = parsed && parsed.ok === true && typeof parsed.referenceId === "string" ? parsed.referenceId : "";
    if (!referenceId || !REFERENCE_ID.test(referenceId)) {
      core.warn("kbank", "callback ไม่มี reference1 ที่ใช้ได้ — ไม่ทำอะไร");
      return core.done(res, "no_reference");
    }
    const { db } = require("../../../firebase");
    const snap = await db.collection(core.COLLECTION).doc(referenceId).get();
    if (!snap || !snap.exists) return core.done(res, "not_ours");
    const doc = snap.data() || {};
    if (doc.providerId !== PROVIDER_ID) return core.done(res, "not_ours");
    return core.verifyAndSettle({
      res, deps, db, referenceId, doc,
      providerId: PROVIDER_ID, verifiedBy: VERIFY_METHOD, tag: "kbank",
    });
  });
}

module.exports = { webhookKbank, PROVIDER_ID, VERIFY_METHOD };

// pos/gateway/cancelQr — ปิดจอ QR แล้วยกเลิกที่ผู้ให้บริการ หรือประทับว่าร้านเลิกรอแล้ว (ก้อน 7 · DEV-0001)
//
// สัญญา: shopchamp-center/api/payment.cancelQr.yaml · route POST /pos_gateway/payment/cancel-qr (ยังไม่ผูก index.js · ยังไม่ deploy)
// ยกจากพี่น้อง (`claude/payment/cancel-qr.js`) · ปิดบั๊ก #2 ส่วน "ปิดจอแล้ว QR เก่ายังจ่ายได้":
//   · เจ้าที่มี cancelQR (kbank-qr · beam-bolt · เกณฑ์ = registry.canCancelOf) → ยิงยกเลิก · สำเร็จแล้วเท่านั้นจึง process:'cancelled'
//     ยิงไม่สำเร็จ = 502 provider_error · ไม่แตะใบ (QR อาจยังจ่ายได้ที่เจ้า)
//   · เจ้าที่ไม่มี (ntt-h2h · posxpay) → ประทับ `cancelRequestedAt` · คง process:'request' (กันกดซ้ำยังเห็นใบที่ QR ยังสด)
//     เงินเข้าทีหลัง = settle mark success + paidAfterCancel:true ⇒ แอปที่ปิดจอแล้วไม่สร้างบิล · ร้านคืนเงินนอกระบบ
//   · ใบไม่มี providerRef (ยิงเจ้าไม่สำเร็จ) → ประทับ cancelRequestedAt เหมือนกัน (ต่างจากพี่น้องที่ไม่แตะ · ยิงอาจถึงเจ้าแล้วแต่คำตอบหาย)
//   · ใบไม่มี channelId (ใบรุ่นเก่า) → cancelled ฝั่งเราเลย
// เขียนใน transaction ที่อ่าน process ซ้ำก่อน ⇒ webhook mark success ระหว่างทาง = ไม่ทับเป็น cancelled (409 already_paid)
// รูป: factory (deps) => handler(req, res) · deps: now · credKey · env · cancelQR (แทนฟังก์ชันของเจ้า) · registry (เทส)
//
// คำตอบ: 200 {referenceId, cancelled:true}                       ยกเลิกที่เจ้าแล้ว / ใบรุ่นเก่ายกเลิกฝั่งเรา (local:true)
//        200 {referenceId, cancelled:false, localExpired:true}   เจ้ายกเลิกไม่ได้ · ประทับ cancelRequestedAt
//        200 {referenceId, cancelled:true, already:true}         ยกเลิกไปแล้ว (ไม่เขียนซ้ำ)
//        409 already_paid · 404 pgwebhook_not_found · 409 pgwebhook_other_shop · 409 unknown_channel · 409/500 ค่าเชื่อมต่อ · 502 provider_error
"use strict";

const { PaymentCancelQrRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag } = require("../_shared/auth");
const { COLLECTION } = require("./settle");
const { _internal: G } = require("./requestQr");

/** เขียน patch เมื่อใบยังไม่ success (อ่านซ้ำใน transaction) · คืน 'written' | 'paid' | 'gone' */
async function patchUnlessPaid(db, referenceId, patch) {
  const ref = db.collection(COLLECTION).doc(referenceId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s || !s.exists) return "gone";
    if ((s.data() || {}).process === "success") return "paid";
    tx.update(ref, patch);
    return "written";
  });
}

function cancelQr(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(PaymentCancelQrRequest, body, res);
    if (!input) return undefined;

    let config = {};
    try {
      const { db } = require("../../firebase");
      const referenceId = input.referenceId;
      const snap = await db.collection(COLLECTION).doc(referenceId).get();
      if (!snap.exists) return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
      const doc = snap.data() || {};
      if (doc.shopId !== access.shopId) return fail(res, 409, "pgwebhook_other_shop");

      const paid = () => fail(res, 409, "already_paid", "รายการนี้ชำระเงินแล้ว ยกเลิกไม่ได้", { referenceId });
      if (doc.process === "success") return paid();
      if (doc.process === "cancelled") return ok(res, { referenceId, cancelled: true, already: true, ...adminFlag(access) });

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const finish = async (patch, body2) => {
        const w = await patchUnlessPaid(db, referenceId, { ...patch, ...trail });
        if (w === "paid") return paid();
        if (w === "gone") return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
        return ok(res, { referenceId, ...body2, ...adminFlag(access) });
      };

      if (!doc.channelId) return finish({ process: "cancelled", cancelledAt: now }, { cancelled: true, local: true });

      const registry = G.registryOf(deps);
      const hit = registry.findChannel(doc.channelId);
      if (!hit) return fail(res, 409, "unknown_channel", "ช่องทางของรายการนี้ไม่อยู่ในทะเบียนแล้ว");
      const { provider, channel } = hit;

      // เจ้ายกเลิกไม่ได้ หรือยังไม่มี QR ที่เจ้ารู้จัก = ประทับอายุฝั่งเรา (คง process:'request')
      if (!registry.canCancelOf(provider) || !doc.providerRef) {
        return finish({ cancelRequestedAt: now }, { cancelled: false, localExpired: true });
      }

      const loaded = await G.loadConfig({ db, deps, shopId: access.shopId, spec: provider.spec });
      if (!loaded.ok) return fail(res, loaded.status, loaded.error, loaded.message, loaded.extra);
      config = loaded.config;

      const cancel = G.providerFn(deps, provider, "cancelQR");
      let r;
      try {
        r = await cancel({ channel, config, providerRef: doc.providerRef, shopId: access.shopId });
      } catch (e) {
        console.error("pos gateway cancelQr provider_threw", provider.spec.id, referenceId, G.redact(e && e.message, config));
        return fail(res, 502, "provider_error", "ยกเลิกรายการไม่สำเร็จ");
      }
      if (!r || r.ok !== true) {
        const e = (r && r.error) || {};
        const code = typeof e.code === "string" && e.code ? e.code : "unknown";
        return fail(res, 502, "provider_error", G.redact(e.message, config) || "ยกเลิกรายการไม่สำเร็จ", { code });
      }
      return finish({ process: "cancelled", cancelledAt: now }, { cancelled: true });
    } catch (e) {
      return internalError(res, { name: e && e.name, message: G.redact(e && e.message, config) });
    }
  };
}

module.exports = { cancelQr };

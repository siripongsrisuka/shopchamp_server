// pos/gateway/settle.js — ที่เดียวที่เปลี่ยน `pgWebhook/{referenceId}` เป็น `process:'success'` (ก้อน 7 · DEV-0001)
//
// ผู้เรียก: webhook ทุกเจ้า · payment.inquire (ผู้ให้บริการตอบจ่ายแล้ว) · payment.simulate (ร้านทดสอบ)
// กติกา (แบบพี่น้อง §1.4 + decision ก้อน 7):
//   ① ผู้เรียกต้อง **ถามผู้ให้บริการซ้ำเอง** แล้วส่งผล `verified = {state, amountPaid}` มา · ไฟล์นี้ไม่เชื่อ payload ของ webhook
//   ② state ต้องเป็น 'paid' · ยอดที่ผู้ให้บริการตอบต้องเท่ายอดที่ขอ **ถึงสตางค์** (จำนวนเต็มสตางค์ · B-08)
//      ไม่ตรง = ไม่ mark · ประทับ `verifyMismatch` ให้ทีมงานไล่ (ไม่ทับ process)
//   ③ ร้านปิดจอไปแล้ว (`process:'cancelled'` หรือมี `cancelRequestedAt`) แต่เงินเข้า = mark success + `paidAfterCancel:true`
//      ⇒ แอปที่ปิดจอแล้วไม่สร้างบิล (decision 3-2 · บั๊ก #2 ส่วน "QR เก่ายังจ่ายได้") · ร้านคืนเงินนอกระบบ
//   ④ success แล้ว = ไม่เขียนซ้ำ (webhook ยิงซ้ำ · inquire กับ webhook มาพร้อมกัน)
//   ⑤ อ่านก่อนเขียนใน transaction เดียว · ❌ ไม่สร้างบิล (แอปสร้างผ่าน sale.create · decision 3-2)
"use strict";

const COLLECTION = "pgWebhook";

/** toSatang(บาท) → จำนวนเต็มสตางค์ | null (ไม่ใช่ตัวเลขจริง / ติดลบ) · ปัดครั้งเดียวที่นี่ */
function toSatang(baht) {
  const n = typeof baht === "string" && baht.trim() !== "" ? Number(baht) : baht;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** sameSatang(a, b) — ทั้งคู่เป็นยอดที่ใช้ได้และเท่ากันถึงสตางค์ */
function sameSatang(a, b) {
  const x = toSatang(a);
  const y = toSatang(b);
  return x !== null && y !== null && x === y;
}

/**
 * confirmPaid({db, referenceId, verified, verifiedBy, now, simulated?, expectShopId?, expectProviderId?})
 *   → {kind:'marked'|'already'|'not_found'|'not_paid'|'mismatch'|'wrong_shop'|'wrong_provider', doc?, paidAfterCancel?}
 *   expectShopId / expectProviderId = ผู้เรียกรู้ร้านหรือเจ้าจากทางอื่น (webhook Beam รู้ร้านจาก merchantId) · ไม่ตรง = ไม่แตะ
 */
async function confirmPaid({ db, referenceId, verified, verifiedBy, now, simulated, expectShopId, expectProviderId }) {
  const ref = db.collection(COLLECTION).doc(referenceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) return { kind: "not_found" };
    const doc = snap.data() || {};
    if (expectShopId !== undefined && doc.shopId !== expectShopId) return { kind: "wrong_shop" };
    if (expectProviderId !== undefined && doc.providerId !== expectProviderId) return { kind: "wrong_provider" };
    if (doc.process === "success") return { kind: "already", doc };
    const v = verified && typeof verified === "object" ? verified : {};
    if (v.state !== "paid") return { kind: "not_paid", state: typeof v.state === "string" ? v.state : "unknown", doc };
    if (!sameSatang(v.amountPaid, doc.amount)) {
      const paid = toSatang(v.amountPaid);
      tx.update(ref, {
        verifyMismatch: { at: now, expected: Number(doc.amount) || 0, paid: paid === null ? null : paid / 100, verifiedBy },
      });
      return { kind: "mismatch", doc };
    }
    const paidAfterCancel = doc.process === "cancelled" || !!doc.cancelRequestedAt;
    const patch = { process: "success", paidAt: now, verifiedBy, verifiedAmount: toSatang(v.amountPaid) / 100 };
    if (paidAfterCancel) { patch.paidAfterCancel = true; patch.paidAfterCancelAt = now; }
    if (simulated === true) patch.simulated = true;
    tx.update(ref, patch);
    return { kind: "marked", doc: { ...doc, ...patch }, paidAfterCancel };
  });
}

module.exports = { COLLECTION, toSatang, sameSatang, confirmPaid };

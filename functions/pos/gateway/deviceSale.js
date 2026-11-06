// pos/gateway/deviceSale — แอปบันทึกผลที่เครื่อง NTT EDC อนุมัติแล้ว ก่อนสร้างบิล (ก้อน 7 · DEV-0001)
//
// สัญญา: shopchamp-center/api/payment.deviceSaleRecord.yaml · route POST /pos_gateway/payment/device-sale-record (ยังไม่ผูก index.js)
// ยกจากพี่น้อง (`claude/payment/device-sale.js`) · ต่างจากพี่น้อง: รับเฉพาะเจ้า `ntt-edc` (Pack 2026-11-06: EDC = NTT รายจุดคิดเงิน · ไม่มี kbank-edc)
//   + `stationId` (จุดคิดเงินที่เครื่องผูกอยู่) · ยอดปัดสตางค์ครั้งเดียว · ยอดต่างเทียบเป็นสตางค์ (พี่น้องเทียบ Number ตรง)
// เหตุที่ต้องมี: เงินผ่านเครื่องในร้าน server ไม่อยู่ในวงจร ⇒ ไม่บันทึก = ไม่มีร่องรอยให้เทียบยอดเลย
// รูป: factory (deps) => handler(req, res) · deps: now · registry (เทส)
//
// ลำดับ:
//   ① callerAccess → 401/403 · สิทธิ์ = สมาชิก active ทุกคน   ② Zod PaymentDeviceSaleRecordRequest (ต้องมี invoiceNo หรือ posRefNo) → 400
//   ③ channelId ไม่อยู่ในทะเบียน = 400 unknown_channel · ไม่ใช่เจ้า ntt-edc = 400 channel_not_device_runtime
//      (เจ้า server ปิดรายการผ่าน webhook/inquire ที่ยืนยันกับเจ้าได้ · รับที่นี่ = ใครก็ประกาศจ่ายแทนธนาคารได้)
//   ④ referenceId = `edcsale-` + sha256(shopId|invoiceNo|posRefNo) 32 hex ⇒ ยิงซ้ำชนใบเดิมโดยโครงสร้าง
//      transaction: ไม่มี = set ใบ process:'success' verifiedBy:'edc-device' → 200 duplicate:false
//      มีแล้วยอดเท่ากัน (สตางค์) = 200 duplicate:true ไม่เขียน · ยอดต่าง = 409 edc_ref_amount_mismatch ไม่เขียนทับ
"use strict";

const crypto = require("crypto");
const { PaymentDeviceSaleRecordRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag } = require("../_shared/auth");
const { COLLECTION, toSatang, sameSatang } = require("./settle");
const { _internal: G } = require("./requestQr");

const EDC_PROVIDER_ID = "ntt-edc";

/** เลขใบจากกุญแจ idempotency (ช่องที่ไม่ส่ง = สตริงว่าง) */
function referenceIdOf({ shopId, invoiceNo, posRefNo }) {
  const key = `${shopId}|${invoiceNo || ""}|${posRefNo || ""}`;
  return `edcsale-${crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function deviceSaleRecord(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(PaymentDeviceSaleRecordRequest, body, res);
    if (!input) return undefined;

    try {
      const registry = G.registryOf(deps);
      const hit = registry.findChannel(input.channelId);
      if (!hit) return fail(res, 400, "unknown_channel", "ไม่รู้จักช่องทางนี้");
      if (hit.provider.spec.id !== EDC_PROVIDER_ID || hit.provider.spec.runtime !== "device") {
        return fail(res, 400, "channel_not_device_runtime", "ช่องทางนี้ทำงานผ่านเซิร์ฟเวอร์ ผลจ่ายต้องมาจากผู้ให้บริการ ไม่ใช่จากเครื่องในร้าน");
      }

      const now = await readNow(deps);
      const { db } = require("../../firebase");
      const shopId = access.shopId;
      const amount = toSatang(input.amount) / 100;
      const invoiceNo = cleanStr(input.invoiceNo);
      const posRefNo = cleanStr(input.posRefNo);
      const referenceId = referenceIdOf({ shopId, invoiceNo, posRefNo });
      const ref = db.collection(COLLECTION).doc(referenceId);

      const payload = {
        referenceId, shopId, channelId: input.channelId, providerId: EDC_PROVIDER_ID, amount, timestamp: now,
        process: "success", paidAt: now, verifiedBy: "edc-device", createdBy: access.uid,
        stationId: cleanStr(input.stationId), invoiceNo, posRefNo, tradeType: cleanStr(input.tradeType),
        ...adminTrail(access),
      };
      for (const k of ["approvalCode", "terminalId", "merchantId"]) {
        const v = cleanStr(input[k]);
        if (v) payload[k] = v;
      }

      const out = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (cur && cur.exists) return { duplicate: true, existing: cur.data() || {} };
        tx.set(ref, payload);
        return { duplicate: false };
      });

      if (out.duplicate) {
        if (!sameSatang(out.existing.amount, amount)) {
          console.error("pos gateway deviceSaleRecord edc_ref_amount_mismatch", referenceId);
          return fail(res, 409, "edc_ref_amount_mismatch", "เลขอ้างอิงจากเครื่องนี้ถูกบันทึกไว้แล้วด้วยยอดอื่น ตรวจรายการที่เครื่องก่อน", {
            referenceId, existingAmount: Number(out.existing.amount) || 0, amount,
          });
        }
        return ok(res, { referenceId, duplicate: true, ...adminFlag(access) });
      }
      return ok(res, { referenceId, duplicate: false, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { deviceSaleRecord, referenceIdOf, EDC_PROVIDER_ID };

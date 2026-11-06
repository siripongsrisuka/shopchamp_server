// pos/gateway/webhooks/ntt.js — NTT DATA (NDPS H2H) แจ้งว่าลูกค้าจ่ายแล้ว (ก้อน 7 · DEV-0001 · ยกท่าจากบ้านพี่น้อง)
//
// สัญญา: shopchamp-center/api/gateway.webhookNtt.yaml · route สาธารณะ POST /pos_gateway/webhook/ntt (ไม่มี token ผู้ใช้)
// รูป: factory (deps) => handler(req, res) · deps: now credKey env registry inquiry
// ยามของเส้นนี้ (ลงทะเบียนที่ gateway/routes.js › PUBLIC_ROUTES):
//   NTT ไม่มีลายเซ็น/secret ใน notification เลยสักชั้น ⇒ ใครเดา URL ได้ก็ POST ว่า "จ่ายแล้ว" ได้
//   ⇒ notification = แค่สัญญาณให้ไปถาม · หาใบด้วย pgWebhook.providerRef == out_trade_no (NTT ไม่ echo referenceId ของเรา)
//   ⇒ ถาม NTT ซ้ำด้วย ALL_ORDERQUERY (provider.inquiry ของ ntt-h2h) แล้ว mark ผ่าน settle.confirmPaid เท่านั้น
//   ❌ ห้ามใช้ tran_amount / transaction_status ของ payload ตัดสินอะไร
// คำตอบ: 200 {ok:true, result} ทุกกรณีที่จบแล้ว (ไม่ใช่ของเรา · ทำแล้ว · ยังไม่จ่าย · ยอดไม่ตรง) · 502 verify_failed (ถาม NTT ไม่ได้ ยิงซ้ำได้)
// ตัดจากพี่น้อง: remotePay / autoCheckout / close-bill (แอปสร้างบิลเอง · decision 3-2)
"use strict";

const core = require("./core");

const PROVIDER_ID = "ntt-h2h";
// ยามที่ PUBLIC_ROUTES ตรวจว่ายังอยู่ในไฟล์ (ถอดการถามซ้ำ = เทส routes.test.js แดง)
const VERIFY_METHOD = "ALL_ORDERQUERY";

/** ตัวแกะ notify: ของผู้ให้บริการ (providers/ntt.js parseNotify) · ไม่มี = แกะเองแบบพี่น้อง */
function parseOf(deps) {
  const reg = require("../connections")._internal.registryOf(deps);
  const mod = reg.getProvider(PROVIDER_ID);
  if (mod && typeof mod.parseNotify === "function") return (b) => mod.parseNotify(b);
  return (b) => {
    const v = b && typeof b === "object" ? (b.out_trade_no !== undefined ? b.out_trade_no : b.outTradeNo) : undefined;
    const s = v === undefined || v === null ? "" : String(v).trim();
    return s ? { ok: true, outTradeNo: s } : { ok: false };
  };
}

function webhookNtt(deps) {
  return core.guarded("ntt", async (req, res) => {
    const parsed = parseOf(deps)(req && req.body);
    if (!parsed || parsed.ok !== true || typeof parsed.outTradeNo !== "string" || !parsed.outTradeNo) {
      core.warn("ntt", "notify ไม่มี out_trade_no — ไม่ทำอะไร");
      return core.done(res, "no_reference");
    }
    const { db } = require("../../../firebase");
    const found = await core.findByProviderRef(db, parsed.outTradeNo, PROVIDER_ID);
    if (found.kind !== "found") {
      core.warn("ntt", "หาใบจาก out_trade_no ไม่เจอ", found.kind);
      return core.done(res, found.kind);
    }
    return core.verifyAndSettle({
      res, deps, db, referenceId: found.referenceId, doc: found.doc,
      providerId: PROVIDER_ID, verifiedBy: VERIFY_METHOD, tag: "ntt",
    });
  });
}

module.exports = { webhookNtt, PROVIDER_ID, VERIFY_METHOD };

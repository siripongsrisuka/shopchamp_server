// pos/gateway/webhooks/beam.js — Beam (Bolt+ · โหมด partner) แจ้ง event ของ merchant (= ร้าน) (ก้อน 7 · DEV-0001 · ยกท่าจากบ้านพี่น้อง)
//
// สัญญา: shopchamp-center/api/gateway.webhookBeam.yaml · route สาธารณะ POST /pos_gateway/webhook/beam (ไม่มี token ผู้ใช้)
// รูป: factory (deps) => handler(req, res) · deps: now credKey env registry inquiry
// event ที่ติ๊กใน Beam Bridge ต่อ merchant: bolt_intent.paid · bolt_intent.canceled · bolt_intent.expired · charge.failed
// ยาม 2 ชั้น (ลงทะเบียนที่ gateway/routes.js › PUBLIC_ROUTES):
//   ① ลายเซ็นก่อนอย่างอื่น: X-Beam-Signature = base64(HMAC-SHA256(req.rawBody, base64decode(กุญแจของร้าน)))
//      merchantId ใน payload ใช้แค่เลือกกุญแจ: beamMerchantIndex/{merchantId} → ร้าน → beamMerchantCreds/{shopId}.webhookHmacKey (กล่อง secretBox)
//      ไม่มี merchantId / ไม่มีร้าน / ไม่มีกุญแจ / ลายเซ็นผิด = 401 bad_signature (รหัสเดียว ไม่บอกว่าตกชั้นไหน)
//      ก่อนลายเซ็นผ่าน อ่านแค่ดัชนีกับกุญแจ ❌ ไม่แตะ pgWebhook · ❌ ไม่มีกุญแจกลางสำรอง
//   ② ไม่เชื่อ payload: ลายเซ็นพิสูจน์ว่า Beam ส่งมาจริง ไม่ได้พิสูจน์ว่าจ่ายครบ ⇒ ถาม Beam ซ้ำ (provider.inquiry ของ beam-bolt)
//      แล้ว mark ผ่าน settle.confirmPaid (ยอดถึงสตางค์) · ใบต้องเป็นของร้านที่เซ็นมา (ร้านอื่น = 200 wrong_shop ไม่แตะ)
// event ที่ไม่ใช่ "จ่ายแล้ว" = ไม่เขียนอะไร (Beam บอกเองว่าลูกค้าจ่ายได้แม้ intent หมดอายุ · ยกเลิกฝั่งเรามีเส้น payment.cancelQr)
// คำตอบ: 2xx เมื่อจบแล้ว (Beam หยุดยิงซ้ำ) · 401 ลายเซ็น · 502/503 พังชั่วคราว (Beam ยิงซ้ำ 10 ครั้ง)
// ตัดจากพี่น้อง: autoCheckout / close-bill (แอปสร้างบิลเอง · decision 3-2)
"use strict";

const core = require("./core");
const { fail } = require("../../_shared/respond");

const PROVIDER_ID = "beam-bolt";
// ยามที่ PUBLIC_ROUTES ตรวจว่ายังอยู่ในไฟล์
const VERIFY_METHOD = "BEAM_INQUIRY";
const SIGNATURE_HEADER = "x-beam-signature";
const EVENT_HEADER = "x-beam-event";

function header(req, name) {
  if (req && typeof req.get === "function") {
    const v = req.get(name);
    if (typeof v === "string") return v;
  }
  const h = (req && req.headers) || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return typeof h[k] === "string" ? h[k] : "";
  return "";
}

const unauthorized = (res) => fail(res, 401, "bad_signature", "ยืนยันผู้ส่งไม่ผ่าน");

function webhookBeam(deps) {
  return core.guarded("beam", async (req, res) => {
    const reg = require("../connections")._internal.registryOf(deps);
    const mod = reg.getProvider(PROVIDER_ID);
    if (!mod || typeof mod.verifyBeamSignature !== "function" || typeof mod.parseBeamEvent !== "function") {
      return fail(res, 500, "provider_unavailable", "ไม่มีตัวตรวจลายเซ็นของ Beam");
    }
    const body = req && req.body;
    const mid = mod.pickMerchantId ? mod.pickMerchantId(body) : "";
    if (!mid) return unauthorized(res);

    // ① ลายเซ็นก่อนอย่างอื่น
    const creds = require("../beam/beamMerchantCreds");
    const { db } = require("../../../firebase");
    const shopId = await creds.getShopIdByMerchantId(db, mid);
    if (!shopId) return unauthorized(res);
    const keyOpts = { deps: typeof (deps && deps.credKey) === "string" ? { credKey: deps.credKey } : undefined, env: deps && deps.env && typeof deps.env === "object" ? deps.env : undefined };
    const c = await creds.getShopBeamCreds(db, shopId, keyOpts);
    if (!c || c.ok !== true) {
      // กุญแจระบบไม่พร้อม = ของเรา ⇒ 503 ให้ Beam ยิงซ้ำหลังแก้ · อย่างอื่น (ร้านยังไม่ตั้ง/กล่องเสีย) = 401
      if (c && (c.code === "gateway_cred_key_missing" || c.code === "gateway_cred_key_invalid")) return fail(res, 503, c.code, "ระบบยังไม่พร้อมตรวจลายเซ็น");
      return unauthorized(res);
    }
    const signed = mod.verifyBeamSignature({
      rawBody: req && req.rawBody,
      signatureHeader: header(req, SIGNATURE_HEADER),
      hmacKey: typeof c.webhookHmacKey === "string" ? c.webhookHmacKey : "",
    });
    if (signed !== true) {
      core.warn("beam", "ลายเซ็นไม่ผ่าน", shopId);
      return unauthorized(res);
    }

    // ② แกะ event (ลายเซ็นผ่านแล้ว)
    const ev = mod.parseBeamEvent(body, header(req, EVENT_HEADER));
    if (!ev || ev.ok !== true) return core.done(res, "ignored_event", { reason: ev && typeof ev.error === "string" ? ev.error : "bad_body" });
    if (!ev.paid) return core.done(res, "ignored_event", { event: ev.eventType });

    const found = await core.findByProviderRef(db, ev.providerRef, PROVIDER_ID);
    if (found.kind !== "found") return core.done(res, found.kind);
    return core.verifyAndSettle({
      res, deps, db, referenceId: found.referenceId, doc: found.doc,
      providerId: PROVIDER_ID, expectShopId: shopId, verifiedBy: VERIFY_METHOD, tag: "beam",
    });
  });
}

module.exports = { webhookBeam, PROVIDER_ID, VERIFY_METHOD, SIGNATURE_HEADER, EVENT_HEADER };

// pos/gateway/inquire — ถามผู้ให้บริการว่าใบ pgWebhook จ่ายแล้วหรือยัง แล้ว mark ผ่าน settle (ก้อน 7 · DEV-0001)
//
// สัญญา: shopchamp-center/api/payment.inquire.yaml · route POST /pos_gateway/payment/inquire (ยังไม่ผูก index.js · ยังไม่ deploy)
// ยกจาก inquire ของพี่น้อง (`claude/payment/acquirer.js`) · ต่างจากพี่น้อง: ผู้ให้บริการตอบ paid = mark ใบผ่าน `settle.confirmPaid`
//   (verifiedBy 'inquire' · เทียบยอดถึงสตางค์ที่ settle ที่เดียว) ⇒ webhook ไม่มา/มาช้า แอปที่ poll ก็ปิดรายการได้
// รูป: factory (deps) => handler(req, res) · deps: now · credKey · env · inquiry (แทนฟังก์ชันของเจ้า) · registry (เทส)
//
// ลำดับ:
//   ① callerAccess → 401/403   ② Zod PaymentInquireRequest → 400
//   ③ pgWebhook/{referenceId}: ไม่มี = 404 pgwebhook_not_found · ร้านอื่น = 409 pgwebhook_other_shop (ไม่คืนเนื้อ)
//   ④ ใบ success (รวมใบ EDC) = ตอบจากใบ ไม่ถามใคร
//   ⑤ ช่องทางไม่อยู่ในทะเบียน = 409 unknown_channel · เจ้าที่ไม่มี inquiry/ไม่ใช่ server = 409 channel_not_server_runtime
//      ยังไม่มี providerRef (ยิงผู้ให้บริการไม่สำเร็จ) = 200 state waiting (ไม่เดาว่าจ่าย)
//   ⑥ ถอด config → inquiry({channel, config, providerRef, expectedAmount: doc.amount, shopId}) · ล้ม = 502 provider_error
//   ⑦ paid → confirmPaid → marked/already = state paid · ยอดไม่ตรง = state amount_mismatch (settle ประทับ verifyMismatch · ไม่ mark)
//   คำตอบ 200 {referenceId, state, process, paidAfterCancel?} · ❌ ไม่คืน raw ของผู้ให้บริการ · ❌ ไม่คืน config
"use strict";

const { PaymentInquireRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { COLLECTION, confirmPaid } = require("./settle");
const { _internal: G } = require("./requestQr");

const KNOWN_STATES = new Set(["waiting", "paid", "closed", "error", "amount_mismatch"]);

function inquire(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(PaymentInquireRequest, body, res);
    if (!input) return undefined;

    let config = {};
    try {
      const { db } = require("../../firebase");
      const referenceId = input.referenceId;
      const snap = await db.collection(COLLECTION).doc(referenceId).get();
      if (!snap.exists) return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
      const doc = snap.data() || {};
      if (doc.shopId !== access.shopId) return fail(res, 409, "pgwebhook_other_shop");

      const reply = (state, process, extra) => ok(res, { referenceId, state, process: process || null, ...(extra || {}), ...adminFlag(access) });
      if (doc.process === "success") return reply("paid", "success", doc.paidAfterCancel ? { paidAfterCancel: true } : undefined);

      const registry = G.registryOf(deps);
      const hit = doc.channelId ? registry.findChannel(doc.channelId) : null;
      if (!hit) return fail(res, 409, "unknown_channel", "ช่องทางของรายการนี้ไม่อยู่ในทะเบียนแล้ว");
      const { provider, channel } = hit;
      const inquiry = G.providerFn(deps, provider, "inquiry");
      if (provider.spec.runtime !== "server" || !inquiry) {
        return fail(res, 409, "channel_not_server_runtime", "ช่องทางนี้เช็คสถานะที่เครื่องในร้าน ไม่ได้ผ่านเซิร์ฟเวอร์");
      }
      if (!doc.providerRef) return reply("waiting", doc.process);

      const loaded = await G.loadConfig({ db, deps, shopId: access.shopId, spec: provider.spec });
      if (!loaded.ok) return fail(res, loaded.status, loaded.error, loaded.message, loaded.extra);
      config = loaded.config;

      let r;
      try {
        r = await inquiry({ channel, config, providerRef: doc.providerRef, expectedAmount: doc.amount, shopId: access.shopId });
      } catch (e) {
        console.error("pos gateway inquire provider_threw", provider.spec.id, referenceId, G.redact(e && e.message, config));
        return fail(res, 502, "provider_error", "เช็คสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
      if (!r || r.ok !== true || !r.data) {
        const e = (r && r.error) || {};
        const code = typeof e.code === "string" && e.code ? e.code : "unknown";
        return fail(res, 502, "provider_error", G.redact(e.message, config) || "เช็คสถานะไม่สำเร็จ", { code });
      }
      const state = KNOWN_STATES.has(r.data.state) ? r.data.state : "error";
      if (state === "error") console.warn("pos gateway inquire unknown_state", provider.spec.id, referenceId);
      if (state !== "paid") {
        if (state === "amount_mismatch") console.error("pos gateway inquire amount_mismatch", provider.spec.id, referenceId);
        return reply(state, doc.process);
      }

      const now = await readNow(deps);
      const m = await confirmPaid({
        db, referenceId, verified: { state: "paid", amountPaid: r.data.amountPaid }, verifiedBy: "inquire", now, expectShopId: access.shopId,
      });
      if (m.kind === "marked" || m.kind === "already") {
        const pac = m.kind === "marked" ? m.paidAfterCancel : !!(m.doc && m.doc.paidAfterCancel);
        return reply("paid", "success", pac ? { paidAfterCancel: true } : undefined);
      }
      if (m.kind === "mismatch") {
        console.error("pos gateway inquire paid_amount_mismatch", provider.spec.id, referenceId);
        return reply("amount_mismatch", doc.process);
      }
      if (m.kind === "not_found") return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
      if (m.kind === "wrong_shop") return fail(res, 409, "pgwebhook_other_shop");
      return reply("waiting", doc.process);
    } catch (e) {
      return internalError(res, { name: e && e.name, message: G.redact(e && e.message, config) });
    }
  };
}

module.exports = { inquire };

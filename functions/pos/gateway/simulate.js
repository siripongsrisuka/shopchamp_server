// pos/gateway/simulate — จำลองเงินเข้าให้ใบ pgWebhook บนร้านทดสอบเท่านั้น (ก้อน 7 · DEV-0001)
//
// สัญญา: shopchamp-center/api/payment.simulate.yaml · route POST /pos_gateway/payment/simulate (ยังไม่ผูก index.js)
// แนวคิดยกจากพี่น้อง (`claude/payment/paymentSimulate.js`: แทนแค่ขั้น "ถามผู้ให้บริการ" แล้วให้เส้นจริงตัดสิน)
//   ต่างจากพี่น้อง: พี่น้องขับ webhook KBank + ปิดบิล autoCheckout · บ้านนี้แอปสร้างบิลเอง (decision 3-2)
//   ⇒ ตัวนี้เรียก `settle.confirmPaid` ตัวจริง (ที่เดียวที่ mark success) ด้วยคำตอบปลอม {state:'paid', amountPaid: ยอดบนใบ}
//   ยอดอ่านจากใบ ❌ ไม่รับจากผู้เรียก · outcome amount_mismatch = ยอดขาด 1 สตางค์ ⇒ พิสูจน์ว่าด่านเทียบยอดของ settle ยังยืน
// ใช้ทำอะไร: เทสจอคิดเงินของแอปให้เห็น "จ่ายแล้ว" โดยไม่ต้องมีเงินจริง (ร้านทดสอบ `TEST Shopchamp`)
// รูป: factory (deps) => handler(req, res) · deps: now · env (GATEWAY_SIMULATE_SHOPS)
//
// ลำดับ:
//   ① callerAccess → 401/403
//   ② ต้องเป็นเจ้าของ **และ** ร้านอยู่ในรายชื่อ env `GATEWAY_SIMULATE_SHOPS` (คั่นด้วย , · ไม่ตั้ง = `wJNgra1ik0pzRQFlZNOD`) ไม่งั้น 403 simulate_not_allowed
//   ③ Zod PaymentSimulateRequest → 400
//   ③' ร้านไม่มีแพ็กเกจ Payment Gateway = 403 package_required (packageGate.js · หลังด่านร้านทดสอบ ⇒ ร้านลูกค้ายังได้ simulate_not_allowed ก่อน)
//   ④ pgWebhook/{referenceId}: ไม่มี = 404 · ร้านอื่น = 409 pgwebhook_other_shop · success แล้ว = 409 already_paid · ไม่ใช่ request = 409 pgwebhook_not_waiting
//   ⑤ confirmPaid(verifiedBy:'simulate', simulated:true) → marked = 200 state paid · mismatch = 200 state amount_mismatch (settle ประทับ verifyMismatch)
"use strict";

const { PaymentSimulateRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, isOwner, adminFlag } = require("../_shared/auth");
const { COLLECTION, toSatang, confirmPaid } = require("./settle");
const { _internal: G } = require("./requestQr");
const PG = require("./packageGate");

const SIMULATE_ENV = "GATEWAY_SIMULATE_SHOPS";
const DEFAULT_SIMULATE_SHOPS = "wJNgra1ik0pzRQFlZNOD"; // ร้านทดสอบ (.claude/rules/test-accounts.md)

function simulateShops(env) {
  const raw = env && typeof env[SIMULATE_ENV] === "string" ? env[SIMULATE_ENV] : DEFAULT_SIMULATE_SHOPS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function simulate(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!isOwner(access) || !simulateShops(G.envOf(deps)).includes(access.shopId)) {
      return fail(res, 403, "simulate_not_allowed", "จำลองการจ่ายได้เฉพาะเจ้าของร้านทดสอบ");
    }
    const input = parseOr400(PaymentSimulateRequest, body, res);
    if (!input) return undefined;

    try {
      const { db } = require("../../firebase");
      const now = await readNow(deps);
      if (!(await PG.passesPackage({ db, access, now, res }))) return undefined;
      const referenceId = input.referenceId;
      const snap = await db.collection(COLLECTION).doc(referenceId).get();
      if (!snap.exists) return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
      const doc = snap.data() || {};
      if (doc.shopId !== access.shopId) return fail(res, 409, "pgwebhook_other_shop");
      if (doc.process === "success") return fail(res, 409, "already_paid", "รายการนี้ชำระเงินแล้ว", { referenceId });
      if (doc.process !== "request") return fail(res, 409, "pgwebhook_not_waiting", "รายการนี้ไม่ได้รอจ่ายแล้ว", { process: doc.process || null });

      const sat = toSatang(doc.amount);
      if (sat === null) return internalError(res, new Error("simulate: ยอดบนใบอ่านไม่ได้"));
      const outcome = input.outcome || "paid";
      const amountPaid = outcome === "amount_mismatch" ? Math.max(sat - 1, 0) / 100 : sat / 100;

      const m = await confirmPaid({
        db, referenceId, verified: { state: "paid", amountPaid }, verifiedBy: "simulate", now, simulated: true, expectShopId: access.shopId,
      });
      const base = { referenceId, simulated: true, outcome, ...adminFlag(access) };
      if (m.kind === "marked") return ok(res, { ...base, state: "paid", process: "success", ...(m.paidAfterCancel ? { paidAfterCancel: true } : {}) });
      if (m.kind === "mismatch") return ok(res, { ...base, state: "amount_mismatch", process: doc.process });
      if (m.kind === "already") return fail(res, 409, "already_paid", "รายการนี้ชำระเงินแล้ว", { referenceId });
      if (m.kind === "not_found") return fail(res, 404, "pgwebhook_not_found", "ไม่พบรายการชำระเงินนี้");
      if (m.kind === "wrong_shop") return fail(res, 409, "pgwebhook_other_shop");
      return internalError(res, new Error(`simulate: ผลที่ไม่รู้จัก ${m.kind}`));
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { simulate, simulateShops, SIMULATE_ENV, DEFAULT_SIMULATE_SHOPS };

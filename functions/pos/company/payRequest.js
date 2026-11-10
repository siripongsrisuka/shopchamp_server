// pos/company/payRequest — แอปขอ QR (posxpay) จ่ายใบสั่งซื้อบริษัท 4 ชนิด · ยอดจากใบ ไม่รับจากจอ (DEV-0003 U2)
//
// สัญญา: shopchamp-center/api/company.payRequest.yaml · คำขอ CompanyPayRequestRequest (@shopchamp/schema 0.1.22) = {shopId, kind, orderUUID}
// แบบ: lanes/dev/source/office-autopay-design.md §หลัก 2-4 · บทเรียน lanes/dev/source/posxpay-pattern-from-sibling.md §5 (ข้อ 1 referenceId ตัวเลข · 11 token อยู่ secret · 12 ห้ามทดสอบด้วย requestpay)
// รูป: factory (deps) => handler(req, res) · deps: now · env (แทน process.env ทั้งก้อน) · createQR (แทน provider · harness/เทส ไม่ออกเน็ต)
//
// ลำดับ:
//   ① callerAccess → 401 no_shop_access / 403 wrong_shop / 403 watcher_read_only   ② Zod → 400 invalid_request
//   ③ secret COMPANY_POSXPAY_TOKEN/SERIAL ไม่มี → 503 company_pay_unconfigured (ก่อนแตะฐาน · ไม่ยิงเน็ต)
//   ④ tx อ่าน: shop/{shopId} (404 shop_not_found) · ใบ <collection ตาม kind>/{orderUUID} (404 order_not_found · ร้านอื่น 409 order_other_shop)
//      ใบต้อง status 'order' (cancel 409 order_cancelled · เปิดแล้ว 409 order_already_fulfilled · อื่น 409 order_status_unexpected) · ยอดอ่านไม่ได้ 409 order_amount_invalid
//      doc companyPay/{kind}-{orderUUID}: request ยังไม่หมดอายุ = คืน QR เดิม (reused:true · ไม่ยิงซ้ำ ไม่เขียน) · paid 409 already_paid · problem 409 company_pay_problem
//        expired/closed/request ที่หมดอายุ = ขอใหม่ (QR เดิมย้ายไป priorRefs · _payCheck ยังถามต่อ)
//   ⑤ createQR (นอก tx · ref1 `<kind>:<orderUUID>` · ref2 'shopchamp' · amount = ยอดใบเป็นบาท) → ล้ม 502 provider_error {code}
//   ⑥ set doc companyPay/{kind}-{orderUUID} {..., status:'request', createdAt, expireAt(+15 นาที), attempts:0} → 200 {qrPayload, qrKind, amount, amountSatang, expireAt, reused:false}
// ❌ ไม่แตะใบ ไม่แตะร้าน (ตัวเปิดของ = _fulfill ผ่าน _payCheck เมื่อเงินเข้า) · ไม่ส่ง push (ใบยังไม่จ่าย)
"use strict";

const { CompanyPayRequestRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag, resolveShopRef, belongsToShop } = require("../_shared/auth");
const { Refusal, refuse, str } = require("./_orders");
const { KINDS } = require("./_fulfill");
const PC = require("./_payCheck");

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

/** QR เดิมยังใช้ได้ไหม: status request และ expireAt > now */
function reusable(doc, now) {
  if (!isObj(doc) || str(doc.status) !== "request") return false;
  const ms = PC.msOf(doc.expireAt);
  return ms !== null && ms > now.getTime() && !!str(doc.providerRef) && !!str(doc.qrPayload);
}

/** QR รุ่นก่อนของใบเดียวกัน (doc เดิมที่กำลังถูกทับ) → แถวใน priorRefs · ตัดที่ PRIOR_REFS_MAX */
function priorRefsOf(prev) {
  if (!isObj(prev)) return [];
  const list = Array.isArray(prev.priorRefs) ? prev.priorRefs.filter(isObj) : [];
  const cur = str(prev.providerRef);
  const head = cur ? [{ providerRef: cur, status: str(prev.status), createdAt: prev.createdAt || null, expireAt: prev.expireAt || null }] : [];
  return [...head, ...list].slice(0, PC.PRIOR_REFS_MAX);
}

function payRequest(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(CompanyPayRequestRequest, body, res);
      if (!input) return undefined;
      const now = await readNow(deps);
      const env = PC.envOf(deps);
      const cfg = PC.companyPayConfig(env);
      if (!cfg.ok) return sendDeny(res, cfg);

      const { kind, orderUUID } = input;
      const spec = KINDS[kind];
      const docId = PC.payDocId(kind, orderUUID);
      const payRef = PC.payRef(kind, orderUUID);
      const orderRef = db.collection(spec.collection).doc(orderUUID);
      const shopRef = db.collection("shop").doc(access.shopId);

      // ④ อ่านครบใน tx เดียว · ไม่เขียน (เขียนหลังรู้ผลผู้ให้บริการ)
      const decided = await db.runTransaction(async (tx) => {
        const [shopSnap, orderSnap, paySnap] = await Promise.all([tx.get(shopRef), tx.get(orderRef), tx.get(payRef)]);
        if (!shopSnap || !shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        if (!orderSnap || !orderSnap.exists) refuse(deny(404, "order_not_found", "ไม่พบใบสั่งซื้อ", { kind, orderUUID }));
        const order = orderSnap.data() || {};
        if (!belongsToShop(str(order.shopId), ref)) refuse(deny(409, "order_other_shop", "ใบสั่งซื้อนี้เป็นของร้านอื่น"));
        const status = str(order.status);
        if (status === "cancel") refuse(deny(409, "order_cancelled", "ใบนี้ถูกยกเลิกแล้ว"));
        if (spec.opened.includes(status)) refuse(deny(409, "order_already_fulfilled", "ใบนี้ชำระและเปิดใช้งานแล้ว", { status }));
        if (status !== "order") refuse(deny(409, "order_status_unexpected", "สถานะใบนี้ไม่ใช่รอชำระ", { status }));
        const amountSatang = PC.orderAmountSatang(kind, order);
        if (amountSatang === null) refuse(deny(409, "order_amount_invalid", "ยอดของใบนี้อ่านไม่ได้"));

        const prev = paySnap && paySnap.exists ? paySnap.data() || {} : null;
        if (prev) {
          if (str(prev.shopId) !== access.shopId) refuse(deny(409, "company_pay_other_shop", "รายการจ่ายนี้เป็นของร้านอื่น"));
          const ps = str(prev.status);
          if (ps === "paid") refuse(deny(409, "already_paid", "ใบนี้ชำระแล้ว"));
          if (ps === "problem") refuse(deny(409, "company_pay_problem", "รายการจ่ายนี้ต้องให้ทีมงานตรวจสอบ กรุณาติดต่อทีมงาน", { reason: isObj(prev.problem) ? str(prev.problem.code) : "" }));
          if (reusable(prev, now)) return { reuse: true, prev, amountSatang };
          // ยอดใบเปลี่ยนระหว่างทาง (ไม่ควรเกิด: ใบ status order แก้ไม่ได้) = ไม่ใช้ QR เดิมแน่ ๆ · ออกใหม่
        }
        return { reuse: false, prev, amountSatang, orderShopId: str(order.shopId) };
      });

      if (decided.reuse) {
        const d = decided.prev;
        return ok(res, { kind, orderUUID, qrPayload: str(d.qrPayload), qrKind: str(d.qrKind) || "text", amount: logic.fromSatang(d.amountSatang), amountSatang: d.amountSatang, expireAt: PC.isoOf(d.expireAt), reused: true, ...adminFlag(access) });
      }

      // ⑤ ยิง posxpay นอก tx · ref1 = `<kind>:<orderUUID>` (ผูกกลับใบได้จากฝั่งผู้ให้บริการ) · ref2 = shopchamp
      const px = PC.providerOf(deps, env);
      const amount = logic.fromSatang(decided.amountSatang);
      const r = await px.createQR({ config: { serial: cfg.serial, token: cfg.token }, amount, referenceId: docId, ref1: `${kind}:${orderUUID}`, ref2: PC.REF2 });
      if (!r || r.ok !== true) {
        const code = (r && r.error && r.error.code) || "provider_error";
        return fail(res, 502, "provider_error", "ขอ QR จากผู้ให้บริการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", { code, detail: str(r && r.error && r.error.message).slice(0, 300) });
      }
      const expireAt = new Date(now.getTime() + PC.EXPIRE_MS);
      const prev = decided.prev;
      const doc = {
        kind, orderUUID, shopId: access.shopId, orderShopId: decided.orderShopId,
        amountSatang: decided.amountSatang, amount,
        providerRef: str(r.data.providerRef), qrPayload: str(r.data.qrPayload), qrKind: str(r.data.qrKind) || "text",
        ref1: `${kind}:${orderUUID}`, ref2: PC.REF2, provider: "posxpay",
        status: "request", createdAt: now, updatedAt: now, expireAt, attempts: 0,
        priorRefs: priorRefsOf(prev), requestCount: (prev && Number.isSafeInteger(prev.requestCount) ? prev.requestCount : 0) + 1,
        requestedBy: access.uid, leaseUntil: null,
        ...adminTrail(access),
      };
      // ⑥ set ทับทั้ง doc (ใบละ doc เดียว · QR รุ่นก่อนอยู่ใน priorRefs)
      await payRef.set(doc);
      console.log(`companyPay ${docId} request ${decided.amountSatang} สตางค์${prev ? ` (รุ่นที่ ${doc.requestCount} · เดิม ${str(prev.status)})` : ""}`);
      return ok(res, { kind, orderUUID, qrPayload: doc.qrPayload, qrKind: doc.qrKind, amount, amountSatang: decided.amountSatang, expireAt: expireAt.toISOString(), reused: false, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { payRequest, _internal: { reusable, priorRefsOf } };

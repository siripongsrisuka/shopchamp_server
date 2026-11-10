// pos/company/payStatus — แอปถามสถานะการจ่ายใบสั่งซื้อบริษัท (poll ทุก 2-3 วิ) · server ถาม posxpay เองแล้วเปิดของเมื่อยอดตรง (DEV-0003 U2)
//
// สัญญา: shopchamp-center/api/company.payStatus.yaml · คำขอ CompanyPayStatusRequest (@shopchamp/schema 0.1.22) = {shopId, kind, orderUUID}
// ตัวทำงานจริง = _payCheck.checkCompanyPay (ตัวเดียวกับ sweep และ office) · ไฟล์นี้แค่ด่าน + ส่ง push ที่ fulfill คืน
// รูป: factory (deps) => handler(req, res) · deps: now · env · inquiry (แทน provider · harness/เทส) · push (ตัวส่งแจ้งเตือน · stub ใน case)
//
// ลำดับ: ① callerAccess (เส้นนี้ไม่ใช่อ่านอย่างเดียว: อาจเปิดของ ⇒ watcher 403 watcher_read_only) ② Zod 400
//   ③ checkCompanyPay({kind, orderUUID, now, env, deps, shopId}) → 404 company_pay_not_found · 409 company_pay_other_shop · 503 company_pay_unconfigured
//   ④ paid ครั้งแรก (duplicate:false) = ส่ง push ผู้ซื้อ (ข้อความเท่า care) ก่อนตอบ · ครั้งถัดไป/duplicate = ไม่ส่งซ้ำ
//   200 {state, kind, orderUUID, amount, amountSatang, expireAt, final, transient?, reason?, fulfilled?} · ❌ ไม่คืน providerRef/raw ของผู้ให้บริการ
"use strict";

const { CompanyPayStatusRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { notify } = require("../_shared/push/notify");
const PC = require("./_payCheck");

function payStatus(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(CompanyPayStatusRequest, body, res);
      if (!input) return undefined;
      const now = await readNow(deps);
      const env = PC.envOf(deps);

      const r = await PC.checkCompanyPay({ kind: input.kind, orderUUID: input.orderUUID, now, env, deps, shopId: access.shopId });
      if (r.push) await notify(deps, r.push);
      const { push, docId, ...out } = r;
      return ok(res, { ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof PC.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { payStatus };

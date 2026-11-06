// pos/_shared/respond.js — ซองคำตอบเดียวของทุก route ใน pos (ก้อน 4 · DEV-0001)
//
// ที่มา: architecture-plan.md ก้อน 4 "ซองรูป response เดียว" · หัวไฟล์สัญญา shopchamp-center/api/*.yaml
//   สำเร็จ   = 2xx {ok:true, ...}
//   ไม่สำเร็จ = non-2xx เสมอ {ok:false, error:<code ตัวเล็ก>, message:<ไทย>, ...ช่องเสริม}
//   บิลซ้ำ   = 200 {ok:true, duplicate:true, ...} (เป็นผลสำเร็จ ไม่ใช่ error)
//   ❌ ไม่มี 200 + ok:false (แบบพี่น้องที่ทำให้จอขึ้นสำเร็จปลอม · api-pattern-from-sibling.md §7 "ไม่ควรยก")
//
// ผลตรวจแบบ pure ใน _shared คืน "deny" รูปเดียว: {ok:false, status, error, message?, extra?}
//   ⇒ handler ส่งต่อด้วย sendDeny(res, d) ไม่ต้องรู้ว่าเลข status คืออะไร
"use strict";

const MESSAGES = {
  no_auth: "กรุณาเข้าสู่ระบบใหม่",
  no_shop_access: "ไม่มีสิทธิ์เข้าร้าน",
  missing_shop_id: "ไม่ได้ระบุร้าน",
  wrong_shop: "ไม่ใช่ร้านที่เข้าใช้งานอยู่",
  not_shop_member: "คุณไม่ได้รับสิทธิ์เข้าถึงร้านนี้ หรือแพ็กเกจพนักงานหมดอายุ",
  shop_not_found: "ไม่พบร้าน",
  invalid_request: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
  invalid_receipt_uuid: "ไม่มีรหัสกันบิลซ้ำ",
  right_required: "ไม่มีสิทธิ์ทำรายการนี้",
  owner_required: "เฉพาะเจ้าของร้าน",
  premium_required: "ใช้ได้เฉพาะแพ็กเกจพรีเมี่ยม",
  feature_disabled: "ร้านยังไม่เปิดใช้ความสามารถนี้",
  receipt_uuid_other_shop: "รหัสบิลนี้เป็นของร้านอื่น",
  internal_error: "ระบบขัดข้อง",
};
const DEFAULT_MESSAGE = "ทำรายการไม่สำเร็จ";
const RESERVED = new Set(["ok", "error", "message"]);

/** ข้อความไทยตั้งต้นของรหัส · `<doc>_other_shop` / `<doc>_not_found` ได้ข้อความกลาง */
function messageOf(error) {
  if (MESSAGES[error]) return MESSAGES[error];
  if (/_other_shop$/.test(error)) return "เอกสารนี้เป็นของร้านอื่น";
  if (/_not_found$/.test(error)) return "ไม่พบข้อมูล";
  return DEFAULT_MESSAGE;
}

// ช่องเสริมห้ามทับ ok/error/message (กันคำตอบ error กลายเป็น ok:true เพราะ extra)
function cleanExtra(extra) {
  const out = {};
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return out;
  for (const k of Object.keys(extra)) if (!RESERVED.has(k) && extra[k] !== undefined) out[k] = extra[k];
  return out;
}

/**
 * ok(res, body?, status=200) → res.status(status).json({ok:true, ...body})
 * status ต้องเป็น 2xx · ไม่ใช่ = throw (บั๊กของผู้เรียก ไม่ส่งคำตอบผิดซองออกไป)
 */
function ok(res, body, status) {
  const code = status === undefined ? 200 : status;
  if (!Number.isInteger(code) || code < 200 || code > 299) throw new Error(`respond.ok: status ต้องเป็น 2xx · ได้ ${code}`);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = { ...b, ok: true };
  delete out.error;
  return res.status(code).json(out);
}

/**
 * fail(res, status, error, message?, extra?) → res.status(status).json({ok:false, error, message, ...extra})
 * status ต้องเป็น 4xx/5xx · error ต้องเป็นรหัสตัวเล็ก [a-z0-9_] · ผิด = ส่ง 500 internal_error แทน (ไม่ส่งซองผิดรูป)
 */
function fail(res, status, error, message, extra) {
  const goodStatus = Number.isInteger(status) && status >= 400 && status <= 599;
  const goodCode = typeof error === "string" && /^[a-z0-9_]+$/.test(error);
  if (!goodStatus || !goodCode) {
    return res.status(500).json({ ok: false, error: "internal_error", message: MESSAGES.internal_error });
  }
  return res.status(status).json({
    ...cleanExtra(extra),
    ok: false,
    error,
    message: typeof message === "string" && message ? message : messageOf(error),
  });
}

/** deny(status, error, message?, extra?) — ผลตรวจ pure รูปเดียว · ส่งด้วย sendDeny */
function deny(status, error, message, extra) {
  const d = { ok: false, status, error };
  if (message) d.message = message;
  if (extra) d.extra = extra;
  return d;
}

/** sendDeny(res, d) — ส่ง deny ที่ได้จากตัวตรวจใน _shared */
function sendDeny(res, d) {
  return fail(res, d && d.status, d && d.error, d && d.message, d && d.extra);
}

/** issues ของ Zod → [{path:"product.0.qty", message}] (ไม่คืน input ดิบ) */
function zodIssues(error) {
  const list = error && Array.isArray(error.issues) ? error.issues : [];
  return list.slice(0, 50).map((i) => ({
    path: Array.isArray(i.path) ? i.path.map(String).join(".") : "",
    message: typeof i.message === "string" ? i.message : "ไม่ถูกต้อง",
  }));
}

/** invalidRequest(res, zodError) → 400 {ok:false, error:"invalid_request", message, issues[]} */
function invalidRequest(res, zodError) {
  return fail(res, 400, "invalid_request", undefined, { issues: zodIssues(zodError) });
}

/**
 * parseOr400(schema, body, res) — safeParse · ผ่าน = คืน data · ไม่ผ่าน = ส่ง 400 แล้วคืน null
 *   ใช้: const input = parseOr400(SaleCreateRequest, req.body, res); if (!input) return;
 */
function parseOr400(schema, body, res) {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  invalidRequest(res, r.error);
  return null;
}

/** internalError(res, err?, log?) → 500 internal_error · log แค่ชื่อและข้อความ ไม่ log body/token */
function internalError(res, err, log) {
  const logger = typeof log === "function" ? log : console.error;
  try { logger("pos internal_error", err && err.name, err && err.message); } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
  return fail(res, 500, "internal_error");
}

module.exports = { ok, fail, deny, sendDeny, invalidRequest, parseOr400, zodIssues, internalError, messageOf, MESSAGES };

// pos/_shared/deps.js — รูป deps ที่ handler แบบ factory รับ (ก้อน 4 · DEV-0001)
//
// รูป handler ทุกตัวใน pos (สัญญา display.factory: true):
//   function create(deps) { return async function handler(req, res) { ... } }
//   module.exports = { create };
// harness (shopchamp-center/gate/api-harness.js) เรียก exported(deps) ต่อ case แล้วเรียก handler({body, ...case.req}, res)
//   · deps จาก case: now = stub sync คืน Date (`{__fn__:{returns:{__date__:…}, sync:true}}`) · amend: createSale voidSale
//   · db ไม่มาทาง deps: harness แทน `functions/firebase` ใน require.cache ⇒ handler ใช้ `require("../../firebase").db`
//   · req.shopAccess / req.auth มาจาก case.req (harness ไม่รัน middleware)
// ❌ handler ห้ามอ่าน `new Date()` เอง · อ่านนาฬิกาครั้งเดียวต่อคำขอด้วย readNow(deps) แล้วส่งตัวแปรนั้นต่อ (RT-12)
"use strict";

/**
 * readNow(deps) → Promise<Date>
 *   deps.now ไม่ส่ง = new Date() · ส่งมา = เรียกครั้งเดียว (sync หรือ async ก็ได้) และต้องได้ Date ที่ใช้ได้
 *   ได้ค่าอื่น = throw (นาฬิกาเพี้ยน = ไม่ออกเลขบิล · handler ตอบ 500 internal_error)
 */
async function readNow(deps) {
  const fn = deps && deps.now;
  if (fn === undefined || fn === null) return new Date();
  if (typeof fn !== "function") throw new TypeError("deps.now ต้องเป็นฟังก์ชัน");
  const v = await fn();
  if (v instanceof Date && Number.isFinite(v.getTime())) return new Date(v.getTime());
  throw new TypeError("deps.now ต้องคืน Date ที่ใช้ได้");
}

/**
 * depOr(deps, name, fallback) — dep ตัวอื่น (createSale voidSale ฯลฯ) · ไม่ส่ง = fallback (ตัวจริง)
 *   ส่งมาแต่ไม่ใช่ฟังก์ชัน = throw (case ผิดรูปต้องดัง ไม่ใช่ใช้ตัวจริงเงียบ ๆ)
 *   fallback เป็นฟังก์ชันที่คืนตัวจริง (โหลดช้า) ได้ ⇒ ไม่ require ของหนักตอนโหลดไฟล์
 */
function depOr(deps, name, fallback) {
  const v = deps ? deps[name] : undefined;
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "function") throw new TypeError(`deps.${name} ต้องเป็นฟังก์ชัน`);
  return v;
}

module.exports = { readNow, depOr };

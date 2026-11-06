// pos/workloads.js — แยก API ใหม่เป็น function ตามภาระงาน (ก้อน 4 · DEV-0001 · ยกท่า workloads.js ของพี่น้อง)
//
// หลัก: ทุก function ใช้ app ตัวเดียวกัน (app.js) · ตัวแยก = segment แรกของ path → function ที่รับ
//   segment ของ function อื่น = 404 wrong_function + serve:<ชื่อที่ถูก> (ชี้ผิดที่จะเห็นทันที ไม่เงียบ)
//   segment ที่ไม่รู้จัก = 404 not_found
//   segment ที่ route ตั้ง fn '*' (system) = ทุก function รับ (ใช้ ping ยืนยันว่า function ขึ้นแล้ว)
// แยกตั้งแต่วันแรก: pos = เงินและหน้าร้าน · pos_heavy = รายงานและนำเข้า (route รายงาน 9e + ซ่อมร้าน clone 9a · ก้อน 9) · pos_gateway (ก้อน 7) เป็น app แยก ดูท้ายไฟล์
// ❌ ไม่ยก DUAL_SERVE ของพี่น้อง
//
// config ต่อ function (gen2 · Cloud Run):
//   pos        1GiB · concurrency 40 · maxInstances 100 · timeout 60 วิ (เท่าเพดานฝั่งแอปตามแผนก้อน 5) · ไม่ตั้ง minInstances = ไม่มีค่าเครื่องค้าง
//   pos_heavy  2GiB · concurrency 1 · maxInstances 30 · timeout 300 วิ (งานหนักได้แรมเต็มเครื่องคนเดียว · ท่าเดียวกับพี่น้อง)
"use strict";

const { ROUTES } = require("./routes");
const { fail } = require("./_shared/respond");

const REGION = "asia-southeast2";
const FN = Object.freeze({ POS: "pos", HEAVY: "pos_heavy" });
const ALL = "*";

const FUNCTION_CONFIG = Object.freeze({
  // pos ผูก GATEWAY_CRED_ENC_KEY (Pack สร้าง secret 2026-11-07 · ใช้กับที่ลับ token LINE `shop.lineSettings`)
  [FN.POS]: Object.freeze({ memory: "1GiB", concurrency: 40, maxInstances: 100, timeoutSeconds: 60, secrets: Object.freeze(["GATEWAY_CRED_ENC_KEY"]) }),
  [FN.HEAVY]: Object.freeze({ memory: "2GiB", concurrency: 1, maxInstances: 30, timeoutSeconds: 300 }),
});

const segmentOf = (p) => {
  const m = /^\/([^/?#]+)/.exec(String(p || ""));
  return m ? m[1] : "";
};

/** segment → function จากทะเบียน route (segment เดียวต้องอยู่ function เดียว ไม่งั้น throw ตอนโหลด) */
function segmentMap(routes) {
  const map = new Map();
  for (const r of routes) {
    if (r.fn !== ALL && !FUNCTION_CONFIG[r.fn]) throw new Error(`pos/workloads: route ${r.path} ชี้ function ที่ไม่มี "${r.fn}"`);
    const seg = segmentOf(r.path);
    if (map.has(seg) && map.get(seg) !== r.fn) throw new Error(`pos/workloads: segment /${seg} อยู่ 2 function (${map.get(seg)} · ${r.fn})`);
    map.set(seg, r.fn);
  }
  return map;
}

/** gateFor(fnName, routes?) → middleware: segment ของ function นี้ (หรือ '*') = next() · ไม่ใช่ = 404 */
function gateFor(fnName, routes = ROUTES) {
  if (!FUNCTION_CONFIG[fnName]) throw new Error(`pos/workloads: ไม่รู้จัก function "${fnName}"`);
  const map = segmentMap(routes);
  return function workloadGate(req, res, next) {
    const owner = map.get(segmentOf(req.path));
    if (owner === fnName || owner === ALL) return next();
    if (owner) return fail(res, 404, "wrong_function", `เส้นนี้อยู่ที่ function ${owner}`, { serve: owner });
    return fail(res, 404, "not_found", "ไม่พบเส้นทางนี้");
  };
}

// pos_gateway = app แยก (gateway/app.js · ทะเบียน gateway/routes.js) ไม่ผ่าน gateFor · config อยู่ที่นี่ให้เห็นคู่กับ 2 ตัวบน
//   512MiB · concurrency 40 · maxInstances 20 · timeout 60 วิ (ยิงผู้ให้บริการนานสุด 20 วิ kbank-qr) · ไม่ตั้ง minInstances
//   ผูกเฉพาะ GATEWAY_CRED_ENC_KEY (Pack สร้างแล้ว 2026-11-07) · secret ของผู้ให้บริการอื่นยังไม่มี ⇒ ยังไม่ผูก (ผูกตัวที่ไม่มีจริง = deploy ล้ม)
const GATEWAY_FN = "pos_gateway";
const GATEWAY_CONFIG = Object.freeze({ memory: "512MiB", concurrency: 40, maxInstances: 20, timeoutSeconds: 60, secrets: Object.freeze(["GATEWAY_CRED_ENC_KEY"]) });

module.exports = { REGION, FN, ALL, FUNCTION_CONFIG, GATEWAY_FN, GATEWAY_CONFIG, gateFor, segmentOf, segmentMap };

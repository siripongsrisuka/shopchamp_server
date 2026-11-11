// pos/functions.js — Cloud Functions gen2 ของ API ใหม่ (ก้อน 4 · DEV-0001) · index.js ต่อท้ายด้วย exports.pos / exports.pos_heavy / exports.pos_gateway
//
// gen2 (Cloud Run) · region asia-southeast2 เดียวกับ function เดิม · config ต่อ function = workloads.js FUNCTION_CONFIG
//   URL: https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/pos/<path> · /pos_heavy/<path>
//   (Cloud Run service id ใช้ขีดแทนขีดล่าง: pos-heavy)
// require ไฟล์นี้ = ไม่โหลด handler · ไม่สร้าง express app · ไม่แตะฐาน
//   app สร้างตอนคำขอแรกของ instance นั้น ⇒ function เดิม (gen1) ที่โหลด index.js เดียวกันไม่เสียเวลาเปิดเครื่องเพิ่ม
"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { REGION, FN, FUNCTION_CONFIG, GATEWAY_CONFIG, SWEEP_SCHEDULE, SWEEP_CONFIG, SCANGO_SWEEP_SCHEDULE, SCANGO_SWEEP_CONFIG } = require("./workloads");

function lazyApp(fnName) {
  let app = null;
  return (req, res) => {
    if (!app) app = require("./app").makeApp({ fnName });
    return app(req, res);
  };
}

/** pos_gateway: app แยก (gateway/app.js) · สร้างตอนคำขอแรกเหมือนกัน */
function lazyGatewayApp() {
  let app = null;
  return (req, res) => {
    if (!app) app = require("./gateway/app").makeGatewayApp({});
    return app(req, res);
  };
}

const mk = (fnName) => onRequest({ region: REGION, invoker: "public", ...FUNCTION_CONFIG[fnName] }, lazyApp(fnName));

module.exports = {
  pos: mk(FN.POS),
  pos_heavy: mk(FN.HEAVY),
  // URL: …/pos_gateway/<path> · webhook ของผู้ให้บริการต้องยิงได้โดยไม่มี token ⇒ invoker public (ด่านอยู่ในโค้ด)
  pos_gateway: onRequest({ region: REGION, invoker: "public", ...GATEWAY_CONFIG }, lazyGatewayApp()),
  // DEV-0003 U3: กวาดใบจ่าย posxpay ที่ยังรอ ทุก 5 นาที (ไม่มี webhook) · โค้ดโหลดตอนรอบแรก · deploy: --only functions:companyPaySweep
  companyPaySweep: onSchedule({ region: REGION, ...SWEEP_SCHEDULE, ...SWEEP_CONFIG }, () => require("./company/paySweep").runScheduled()),
  // ScanGo: ยิงข่าวที่ค้างใน scangoOutbox ซ้ำ + ปิดบิลที่ค้าง ทุก 1 นาที (pos/scango/outboxSweep.js) · deploy: --only functions:scangoOutboxSweep
  scangoOutboxSweep: onSchedule({ region: REGION, ...SCANGO_SWEEP_SCHEDULE, ...SCANGO_SWEEP_CONFIG }, () => require("./scango/outboxSweep").runScheduled()),
  lazyApp,
  lazyGatewayApp,
};

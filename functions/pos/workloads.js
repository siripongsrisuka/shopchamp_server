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
/** secret ของ posxpay บริษัท (DEV-0003 U2/U3) · ชื่อเดียวกับที่ company/_payCheck.js อ่าน · ผูกทั้ง pos (payRequest/payStatus) และ companyPaySweep */
const COMPANY_PAY_SECRETS = Object.freeze(["COMPANY_POSXPAY_TOKEN", "COMPANY_POSXPAY_SERIAL"]);

/** secret ของช่องทาง ScanGo (ร้าน Shopchamp บน ScanGo · lanes/dev/source/shopchamp-scango-design.md §เส้นเชื่อม)
 *   กุญแจร่วม 2 ทิศ: ScanGo ยิงเข้า /scango/* (scango/_partnerAuth.js) · Shopchamp ยิงออก /provider/shopchamp/* (scango/_outbound.js)
 *   ค่าเดียวกับ SHOPCHAMP_PLATFORM_KEY ฝั่ง scango_server · ❌ ห้ามซ้ำกุญแจกลางของพี่น้อง (ฝั่งโน้นตอบ 503 platform_key_shared)
 *   ⚠️ Pack ยังไม่สร้าง (2026-11-11) ⇒ `firebase functions:secrets:set SCANGO_SHOPCHAMP_KEY --project shopcham-24b0b` ก่อน deploy pos/scangoOutboxSweep
 *   SCANGO_BASE_URL (ฐาน URL ของ function `scango` ฝั่ง ScanGo · ไม่ใช่ความลับ) = env ธรรมดา · บ้านนี้ไม่เคยมี env ธรรมดามาก่อน (ค่าทุกตัวที่ผ่านมาเป็น secret · ดู GATEWAY_CONFIG)
 *     ทางที่ใช้: Pack สร้าง `functions/.env.shopcham-24b0b` (dotenv ของ firebase-functions v2 · โหลดตอน deploy · ใช้กับทุก function ใน codebase) ด้วยบรรทัด
 *       SCANGO_BASE_URL=https://asia-southeast1-scango-53aeb.cloudfunctions.net/scango   (project scango-53aeb · gen2 onRequest ชื่อ scango · Pack ยืนยันค่าจริงก่อน)
 *     agent สร้างไฟล์ .env* ไม่ได้ (hook no-credential ปัด) · `.env` เปล่าถูก gitignore · `.env.<project>` ไม่ถูก ignore ⇒ commit ได้ (ไม่มีของลับ)
 *     ไม่ตั้ง = _outbound ตอบ not_configured (ไม่ยิง ไม่ลง outbox · log warn) · ❌ ไม่ใส่เป็น secret: ค่าไม่ลับ และ secret ที่ยังไม่สร้างทำให้ deploy ล้ม */
const SCANGO_SECRETS = Object.freeze(["SCANGO_SHOPCHAMP_KEY"]);

const FUNCTION_CONFIG = Object.freeze({
  // pos ผูก GATEWAY_CRED_ENC_KEY (Pack สร้าง secret 2026-11-07 · ใช้กับที่ลับ token LINE `shop.lineSettings`)
  //   + ONESIGNAL_REST_API_KEY (Pack สร้าง 2026-11-07 · ท่อ OneSignal ช่วงเปลี่ยนผ่าน `_shared/push/onesignalPipe.js` · ลบพร้อมท่อ)
  //   + COMPANY_POSXPAY_TOKEN / COMPANY_POSXPAY_SERIAL (DEV-0003 U2 · token/serial บริษัทของ posxpay · ⚠️ Pack ยังไม่สร้าง (2026-11-10) ⇒ ต้อง
  //     `firebase functions:secrets:set` ทั้ง 2 ตัวก่อน deploy pos ไม่งั้น deploy ล้ม · ย้าย merchant = เปลี่ยนค่า secret อย่างเดียว)
  //   + SCANGO_SHOPCHAMP_KEY (ScanGo · ดู SCANGO_SECRETS ข้างบน)
  [FN.POS]: Object.freeze({ memory: "1GiB", concurrency: 40, maxInstances: 100, timeoutSeconds: 60, secrets: Object.freeze(["GATEWAY_CRED_ENC_KEY", "ONESIGNAL_REST_API_KEY", ...COMPANY_PAY_SECRETS, ...SCANGO_SECRETS]) }),
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
//   ผูก GATEWAY_CRED_ENC_KEY (Pack สร้าง 2026-11-07) + KBANK_PROXY_URL/KEY/KEY_HEADER (Pack สร้าง 2026-11-08 จากค่าเครื่องกลางของพี่น้อง)
//   + BEAM_PARTNER_ID/BEAM_ENV (Pack สร้าง 2026-11-08 จากค่า partner ของพี่น้อง · ใช้ร่วมกัน)
const GATEWAY_FN = "pos_gateway";
const GATEWAY_CONFIG = Object.freeze({ memory: "512MiB", concurrency: 40, maxInstances: 20, timeoutSeconds: 60, secrets: Object.freeze(["GATEWAY_CRED_ENC_KEY", "KBANK_PROXY_URL", "KBANK_PROXY_KEY", "KBANK_PROXY_KEY_HEADER", "BEAM_PARTNER_ID", "BEAM_ENV"]) });

// companyPaySweep = งานตั้งเวลา (DEV-0003 U3 · pos/company/paySweep.js) ไม่ใช่ HTTP · ไม่ผ่าน gateFor
//   ทุก 5 นาที Asia/Bangkok · 256MiB · timeout 120 วิ (ใบละ 1 inquire ≤15 วิ · เพดาน 500 ใบ/รอบ แต่จริงไม่กี่ใบ) · maxInstances 1 (กันรอบซ้อน ชั้นแรก · lease ใน tx เป็นชั้นสอง)
//   retryCount 0: รอบถัดไปอีก 5 นาทีเก็บตกเอง · ผูก COMPANY_POSXPAY_* ชุดเดียวกับ pos
const SWEEP_FN = "companyPaySweep";
const SWEEP_SCHEDULE = Object.freeze({ schedule: "every 5 minutes", timeZone: "Asia/Bangkok", retryCount: 0 });
const SWEEP_CONFIG = Object.freeze({ memory: "256MiB", timeoutSeconds: 120, maxInstances: 1, secrets: COMPANY_PAY_SECRETS });

// scangoOutboxSweep = งานตั้งเวลา (ScanGo · pos/scango/outboxSweep.js) ไม่ใช่ HTTP · ไม่ผ่าน gateFor
//   ทุก 1 นาที Asia/Bangkok · 256MiB · timeout 120 วิ (outbox ≤200 แถว × ยิง 5 วิ ขนาน 20 · บิลค้าง ≤50 ใบ) · maxInstances 1 (กันรอบซ้อน · lease nextAttemptAt เป็นชั้นสอง)
//   retryCount 0: รอบถัดไปอีก 1 นาทีเก็บตกเอง · secret: SCANGO_SHOPCHAMP_KEY (ยิง ScanGo) + ONESIGNAL_REST_API_KEY (ปิดบิลค้างเดิน sale.create → push สต๊อกวิกฤตผ่านท่อ OneSignal
//   `_shared/push/onesignalPipe.js` · FCM ใช้ Admin SDK ไม่ต้องมี secret · ไม่มีกุญแจ = ท่อ OneSignal ข้ามเอง ไม่พัง)
const SCANGO_SWEEP_FN = "scangoOutboxSweep";
const SCANGO_SWEEP_SCHEDULE = Object.freeze({ schedule: "every 1 minutes", timeZone: "Asia/Bangkok", retryCount: 0 });
const SCANGO_SWEEP_CONFIG = Object.freeze({ memory: "256MiB", timeoutSeconds: 120, maxInstances: 1, secrets: Object.freeze([...SCANGO_SECRETS, "ONESIGNAL_REST_API_KEY"]) });

module.exports = {
  REGION, FN, ALL, FUNCTION_CONFIG, GATEWAY_FN, GATEWAY_CONFIG, COMPANY_PAY_SECRETS, SWEEP_FN, SWEEP_SCHEDULE, SWEEP_CONFIG,
  SCANGO_SECRETS, SCANGO_SWEEP_FN, SCANGO_SWEEP_SCHEDULE, SCANGO_SWEEP_CONFIG, gateFor, segmentOf, segmentMap,
};

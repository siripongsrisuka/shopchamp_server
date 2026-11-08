// pos/gateway/routes.js — ทะเบียน route ของ function `pos_gateway` + ตัวสร้าง express Router (ก้อน 7 · DEV-0001)
//
// URL จริง: https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/pos_gateway/<path>
//   เส้นที่แอปเรียก = /payment/<kebab> · เส้นที่ผู้ให้บริการยิง = /webhook/<ntt|kbank|beam>
// ช่องของแต่ละแถว (รูปเดียวกับ pos/routes.js เพื่อให้รวมทะเบียนได้ภายหลัง):
//   contract  ชื่อสัญญา shopchamp-center/api/<contract>.yaml
//   path      path ใน function (POST เท่านั้น)
//   auth      'shop'   = checkIfAuthenticated → requireShopAccess (ร้านจาก body.shopId) · handler ตรวจซ้ำด้วย callerAccess
//             'public' = ไม่มีด่านตัวตน (ผู้เรียกเป็นระบบภายนอก ไม่มี token ผู้ใช้) · ต้องอยู่ใน PUBLIC_ROUTES พร้อมยามของตัวเอง
//   pkg       ด่านแพ็กเกจ Payment Gateway (REQUIRED / EXEMPT(เหตุผล)) · handler เป็นคนตรวจจริง (gateway/packageGate.js)
//   load      คืน factory ของ handler (ทุกตัวเป็น factory · เรียกด้วย deps)
// ด่าน (เทส routes.test.js บังคับ):
//   ① ทุกแถว auth 'shop' ต้องมีทั้ง checkIfAuthenticated และ requireShopAccess ก่อน handler
//   ② แถว auth 'public' ต้องมีชื่อใน PUBLIC_ROUTES · ชื่อใน PUBLIC_ROUTES ต้องมีแถวจริง (ทะเบียนค้าง = แดง)
//   ③ ไฟล์ยาม (guard.file) ต้องมีจริงและยังมีข้อความ guard.contains ทุกตัว (ถอดการถามผู้ให้บริการซ้ำ = แดง)
//   ทะเบียนผิด = makeGatewayRouter โยนตอนสร้าง (deploy แล้วไม่ขึ้น ดีกว่าขึ้นแบบไม่มีด่าน)
// webhook: เก็บ req.rawBody ไว้ (Beam ตรวจลายเซ็นจากไบต์ดิบ) · บน Cloud Functions framework ใส่ rawBody ให้เองแล้ว
// ผูกเป็น function ที่ gateway/app.js → pos/functions.js → functions/index.js (exports.pos_gateway)
"use strict";

const express = require("express");
const { fail } = require("../_shared/respond");

const shop = (contract, path, file, fn, pkg) => ({ contract, path, auth: "shop", pkg, load: () => require(file)[fn] });
const hook = (contract, path, file, fn) => ({ contract, path, auth: "public", pkg: EXEMPT("webhook: เงินเคลื่อนแล้ว ผู้ให้บริการต้องแจ้งผลได้เสมอ"), load: () => require(file)[fn] });
// pkg = ด่านแพ็กเกจ Payment Gateway (gateway/packageGate.js · Pack เคาะ 2a 2026-11-08) · ทุกแถวต้องประกาศ (routes.test.js)
//   REQUIRED = เส้นที่เริ่มหรือตั้งค่าการรับเงินออนไลน์ → ไม่มีแพ็กเกจ = 403 package_required
//   EXEMPT(why) = เส้นที่ต้องเดินได้แม้แพ็กเกจหมด (ใบที่ออกไปแล้วต้องจบได้ · เงินที่เคลื่อนแล้วต้องบันทึกได้ · ถอดการเชื่อมต่อได้)
const REQUIRED = Object.freeze({ required: true });
function EXEMPT(why) { return Object.freeze({ required: false, why }); }

const GATEWAY_ROUTES = Object.freeze([
  shop("payment.requestQr", "/payment/request-qr", "./requestQr", "requestQr", REQUIRED),
  shop("payment.inquire", "/payment/inquire", "./inquire", "inquire", EXEMPT("ใบที่ออกก่อนแพ็กเกจหมดต้องถามผลจนจบได้")),
  shop("payment.cancelQr", "/payment/cancel-qr", "./cancelQr", "cancelQr", EXEMPT("ใบที่ออกก่อนแพ็กเกจหมดต้องยกเลิกได้")),
  shop("payment.connectionsGet", "/payment/connections-get", "./connections", "connectionsGet", EXEMPT("อ่านอย่างเดียว · คืน packageActive ให้จอแสดงสถานะ")),
  shop("payment.testAndSave", "/payment/test-and-save", "./connections", "testAndSave", REQUIRED),
  shop("payment.channelsCheck", "/payment/channels-check", "./connections", "channelsCheck", REQUIRED),
  shop("payment.pair", "/payment/pair", "./pairing", "pair", REQUIRED),
  shop("payment.unpair", "/payment/unpair", "./pairing", "unpair", EXEMPT("ถอดเครื่องออกได้เสมอ")),
  shop("payment.deviceSaleRecord", "/payment/device-sale-record", "./deviceSale", "deviceSaleRecord", EXEMPT("EDC อนุมัติแล้ว = เงินเคลื่อนแล้ว · ปัดตอนบันทึก = หลักฐานเงินหาย")),
  shop("payment.stationEdcSet", "/payment/station-edc-set", "./stations", "stationEdcSet", Object.freeze({ required: true, exceptClear: "device:null (ถอด EDC ออกจากจุดคิดเงิน) ผ่านได้เหมือน unpair" })),
  shop("payment.simulate", "/payment/simulate", "./simulate", "simulate", REQUIRED),
  hook("gateway.webhookNtt", "/webhook/ntt", "./webhooks/ntt", "webhookNtt"),
  hook("gateway.webhookKbank", "/webhook/kbank", "./webhooks/kbank", "webhookKbank"),
  hook("gateway.webhookBeam", "/webhook/beam", "./webhooks/beam", "webhookBeam"),
]);

// ยามของเส้นที่ถามผู้ให้บริการซ้ำ (แกนร่วม) — ทุก webhook ต้องเดินผ่านไฟล์นี้
const CORE_GUARD = Object.freeze({ file: "pos/gateway/webhooks/core.js", contains: Object.freeze(["await inquiryFn(args)", "confirmPaid({"]) });

/**
 * ทะเบียนเส้นสาธารณะ · เพิ่มแถว = เขียนเหตุผล + ยาม (Pack เห็นใน commit)
 *   guard.file = path จาก functions/ · guard.contains = ข้อความที่ต้องยังอยู่ (ยามหาย = เทสแดง)
 */
const PUBLIC_ROUTES = Object.freeze([
  Object.freeze({
    path: "/webhook/ntt",
    reason: "NTT DATA (NDPS) ยิง notification เมื่อลูกค้าจ่าย — ระบบภายนอก ไม่มี token ผู้ใช้",
    guard: Object.freeze({ file: "pos/gateway/webhooks/ntt.js", contains: Object.freeze(["ALL_ORDERQUERY", "findByProviderRef", "verifyAndSettle"]) }),
    core: CORE_GUARD,
    residual: "ไม่มีลายเซ็นจาก NTT · ใครเดา URL + out_trade_no ได้ก็ทำให้เราถาม NTT ได้ (ถามอย่างเดียว ไม่ mark ถ้า NTT ไม่ยืนยัน)",
  }),
  Object.freeze({
    path: "/webhook/kbank",
    reason: "เครื่องกลาง mTLS ส่งต่อ callback ของ KBank — ระบบภายนอก ไม่มี token ผู้ใช้",
    guard: Object.freeze({ file: "pos/gateway/webhooks/kbank.js", contains: Object.freeze(["KBANK_INQUIRY", "providerId !== PROVIDER_ID", "verifyAndSettle"]) }),
    core: CORE_GUARD,
    residual: "ไม่มีลายเซ็นจากธนาคาร/เครื่องกลาง · ใครเดา referenceId ได้ก็ทำให้เราถามธนาคารได้ (ไม่ mark ถ้าธนาคารไม่ยืนยัน)",
  }),
  Object.freeze({
    path: "/webhook/beam",
    reason: "Beam ยิง event ของ merchant (= ร้าน) — ระบบภายนอก ไม่มี token ผู้ใช้",
    guard: Object.freeze({ file: "pos/gateway/webhooks/beam.js", contains: Object.freeze(["verifyBeamSignature", "getShopBeamCreds", "BEAM_INQUIRY", "expectShopId: shopId"]) }),
    core: CORE_GUARD,
  }),
]);

const APP_LIMIT = "100kb";
const HOOK_LIMIT = "256kb";
// field ที่ handler อ่านจาก req และต้องมาจากในโปรเซสเท่านั้น (ชุดเดียวกับ pos/app.js)
const INTERNAL_FIELDS = Object.freeze(["shopAccess", "auth", "amendVoid", "amendCarry", "amendOf"]);

function stripInternal(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const k of INTERNAL_FIELDS) if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
}
/** ลบ field ภายในจาก req และ body ก่อนด่านตัวตน */
function scrubInternal(req, res, next) {
  for (const k of INTERNAL_FIELDS) {
    if (k in req) {
      try { delete req[k]; } catch (_) { req[k] = undefined; }
    }
  }
  stripInternal(req.body);
  next();
}
/** ลบ field ภายในจาก body อย่างเดียว (หลังอ่าน body · ห้ามลบ req.auth ที่ด่านเพิ่งตั้ง) */
function stripBody(req, res, next) {
  stripInternal(req.body);
  next();
}
/** เก็บไบต์ดิบไว้ให้ตรวจลายเซ็น (ไม่ทับของที่ framework ใส่มาแล้ว) */
function keepRawBody(req, res, buf) {
  if (!req.rawBody) req.rawBody = Buffer.from(buf);
}

/**
 * resolveWithShopData(args) — ตัดสินสิทธิ์แบบเดียวกับ requireShopAccess ตัวกลาง แล้วฝาก doc ร้านที่ด่านอ่านแล้วไว้บน access
 *   ⇒ handler ที่ติดด่านแพ็กเกจไม่ต้องอ่าน shop/{shopId} ซ้ำ (gateway/packageGate.js)
 */
async function resolveWithShopData(args) {
  const v = await require("../_shared/auth").resolveShopAccess(args);
  if (v && v.ok) require("./packageGate").attachShopData(v.access, args && args.shop);
  return v;
}

/** ตรวจทะเบียน → [] เมื่อถูก · ผิด = รายการปัญหา */
function registryProblems(routes, publicRoutes) {
  const problems = [];
  const pub = new Map(publicRoutes.map((p) => [p.path, p]));
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r.path)) problems.push(`path ซ้ำ ${r.path}`);
    seen.add(r.path);
    if (r.auth !== "shop" && r.auth !== "public") problems.push(`${r.path} auth ไม่รู้จัก "${r.auth}"`);
    if (r.auth === "public" && !pub.has(r.path)) problems.push(`${r.path} ไม่มีด่านตัวตนแต่ไม่อยู่ใน PUBLIC_ROUTES`);
    const pkg = r.pkg;
    if (!pkg || typeof pkg.required !== "boolean" || (pkg.required === false && !(typeof pkg.why === "string" && pkg.why))) {
      problems.push(`${r.path} ไม่ได้ประกาศด่านแพ็กเกจ (pkg: REQUIRED หรือ EXEMPT(เหตุผล))`);
    }
    if (r.auth === "public" && pkg && pkg.required === true) problems.push(`${r.path} webhook ห้ามติดด่านแพ็กเกจ`);
  }
  for (const p of publicRoutes) {
    const r = routes.find((x) => x.path === p.path);
    if (!r || r.auth !== "public") problems.push(`PUBLIC_ROUTES มี ${p.path} แต่ไม่มี route สาธารณะนี้`);
    if (!p.reason || !p.guard || !p.guard.file || !Array.isArray(p.guard.contains) || !p.guard.contains.length) problems.push(`PUBLIC_ROUTES ${p.path} ไม่มีเหตุผลหรือยาม`);
  }
  return problems;
}

/**
 * makeGatewayRouter({deps, checkIfAuthenticated, requireShopAccess, routes, publicRoutes}) → express.Router
 *   deps = ส่งเข้า factory ของทุก handler · ด่านไม่ส่ง = ตัวจริงจาก _shared/auth.js
 *   routes / publicRoutes ไม่ส่ง = ทะเบียนจริง (เทสส่งตัวกลายพันธุ์มาพิสูจน์ว่าด่านจับได้)
 *   readiness = middleware ที่วางหลังด่านร้าน ก่อน handler ของเส้นแอป (gateway/app.js: ระบบยังไม่มีกุญแจ = 503 gateway_not_configured) · ไม่ส่ง = ไม่มีด่านนี้
 */
function makeGatewayRouter({ deps, checkIfAuthenticated, requireShopAccess, readiness, routes = GATEWAY_ROUTES, publicRoutes = PUBLIC_ROUTES } = {}) {
  const problems = registryProblems(routes, publicRoutes);
  if (problems.length) throw new Error("gateway/routes: ทะเบียน route ผิด · " + problems.join(" · "));
  let authn = checkIfAuthenticated;
  let shopz = requireShopAccess;
  if (!authn || !shopz) {
    const auth = require("../_shared/auth");
    authn = authn || auth.checkIfAuthenticated;
    shopz = shopz || auth.makeRequireShopAccess({ resolve: resolveWithShopData });
  }
  const router = express.Router();
  for (const r of routes) {
    const factory = r.load();
    if (typeof factory !== "function") throw new Error(`gateway/routes: handler ของ ${r.path} ไม่ใช่ factory`);
    const handler = factory(deps || {});
    if (typeof handler !== "function") throw new Error(`gateway/routes: factory ของ ${r.path} ไม่คืน handler`);
    if (r.auth === "public") {
      router.post(
        r.path,
        express.json({ limit: HOOK_LIMIT, verify: keepRawBody }),
        express.urlencoded({ extended: false, limit: HOOK_LIMIT, verify: keepRawBody }),
        scrubInternal,
        handler,
      );
    } else {
      const chain = [scrubInternal, authn, express.json({ limit: APP_LIMIT }), stripBody, shopz];
      if (typeof readiness === "function") chain.push(readiness);
      router.post(r.path, ...chain, handler);
    }
  }
  router.use((req, res) => fail(res, 404, "not_found", "ไม่พบเส้นทางนี้"));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const type = err && err.type;
    if (type === "entity.too.large") return fail(res, 413, "payload_too_large", "ข้อมูลที่ส่งมาใหญ่เกินกำหนด");
    if (type === "entity.parse.failed" || (err && err.status === 400)) return fail(res, 400, "invalid_json", "รูปข้อมูลที่ส่งมาไม่ใช่ JSON");
    try { console.error("pos_gateway unhandled", err && err.name, err && err.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
    if (res.headersSent) return undefined;
    return fail(res, 500, "internal_error");
  });
  return router;
}

module.exports = { resolveWithShopData, GATEWAY_ROUTES, PUBLIC_ROUTES, CORE_GUARD, INTERNAL_FIELDS, APP_LIMIT, HOOK_LIMIT, makeGatewayRouter, registryProblems, scrubInternal, keepRawBody };

// pos/app.js — express app ของ API ใหม่ (ก้อน 4 · DEV-0001 · ยกท่า claude/app.js ของพี่น้อง)
//
// ลำดับต่อคำขอ (ทุก route ยกเว้นที่อยู่ใน public-routes.js):
//   ① workloadGate      segment ของ function อื่น = 404 wrong_function (workloads.js)
//   ② scrubInternal     ลบ field ภายในที่ handler อ่านจาก req (amendVoid amendCarry amendOf shopAccess auth) ทั้งบน req และใน body
//                       field พวกนี้ใส่ได้จากในโปรเซสเท่านั้น (sale.amend เรียก void/create ตรง · chunk4-case-additions.md §13)
//   ③ checkIfAuthenticated  ไม่มี token / token ไม่ผ่าน = 401 no_auth (ตรวจก่อนอ่าน body · คนไม่มี token ส่งของใหญ่มาก็ไม่ถูกอ่าน)
//      route auth 'partner' (ScanGo → Shopchamp · scango/*) ใช้ requirePartnerKey แทน: กุญแจร่วมใน header x-scango-platform-key
//      เทียบ secret SCANGO_SHOPCHAMP_KEY (scango/_partnerAuth.js) · ไม่ตั้ง = 503 partner_not_configured · ไม่มี/ผิด = 401 no_auth · ไม่มีขั้น ⑥
//      route auth 'partnerSigned' (ScanGo Order API v1 · /scango/v1/*) ไม่มีด่านที่ ③ · หลัง ④ ตรวจลายเซ็น HMAC ของไบต์ดิบ
//      (scango/v1/partnerSign.js · ไม่ตั้ง = 503 partner_not_configured · ผิด/หมดอายุ = 401 signature_invalid|signature_expired) · ไม่มีขั้น ⑥
//   ④ bodyLimit + express.json   เกินเพดาน = 413 payload_too_large · JSON เสีย = 400 invalid_json
//   ⑤ stripBody ลบ field ภายในจาก body อีกรอบหลังอ่าน (ลบแค่ใน body · req.auth ที่ ③ ตั้งต้องอยู่ต่อ)
//   ⑥ requireShopAccess (route auth 'shop')   ร้านจาก body.shopId · แถว access:"reportRead" = requireReportReadAccess (legacy owner-web parity ชั่วคราว)
//   ⑦ handler
// ซองคำตอบเดียว: สำเร็จ 2xx {ok:true,...} · ไม่สำเร็จ non-2xx {ok:false, error, message} (respond.js) · รวม 404 และ error กลาง
//
// 🪤 บน Cloud Functions ตัว framework อ่าน body ให้ก่อนถึง express (req.body + req.rawBody) ⇒ express.json ข้ามเอง
//   และเพดานของมันไม่ทำงาน ⇒ bodyLimit วัดจาก req.rawBody (มี) หรือ content-length เอง
// โหลด handler ตอนสร้าง app (makeApp) ไม่ใช่ตอน require ไฟล์นี้ · functions.js สร้าง app ตอนคำขอแรก
//   ⇒ function เดิม (gen1) ที่โหลด index.js เดียวกันไม่ต้องโหลด handler ของ pos
"use strict";

const express = require("express");
const cors = require("cors");
const { ROUTES } = require("./routes");
const { PUBLIC_ROUTES } = require("./public-routes");
const { gateFor } = require("./workloads");
const { fail } = require("./_shared/respond");

const DEFAULT_LIMIT = "100kb";
// field ที่ handler อ่านจาก req และต้องมาจากในโปรเซสเท่านั้น
const INTERNAL_FIELDS = Object.freeze(["amendVoid", "amendCarry", "amendOf", "shopAccess", "auth"]);

/** "100kb" / "1mb" / ตัวเลข → ไบต์ */
function toBytes(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i.exec(String(v || "").trim());
  if (!m) throw new Error(`pos/app: bodyLimit อ่านไม่ออก "${v}"`);
  const mul = { b: 1, kb: 1024, mb: 1024 * 1024 }[(m[2] || "b").toLowerCase()];
  return Math.floor(Number(m[1]) * mul);
}

function stripInternal(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const k of INTERNAL_FIELDS) if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
}

/** ลบ field ภายในจาก req และ body (body อาจถูกอ่านไว้แล้วโดย framework) */
function scrubInternal(req, res, next) {
  for (const k of INTERNAL_FIELDS) {
    if (k in req) {
      try { delete req[k]; } catch (_) { req[k] = undefined; }
    }
  }
  stripInternal(req.body);
  next();
}

/** ลบ field ภายในจาก body อย่างเดียว (ใช้หลังด่านตัวตน · ห้ามลบ req.auth ที่ด่านเพิ่งตั้ง) */
function stripBody(req, res, next) {
  stripInternal(req.body);
  next();
}

/** เพดานขนาด body · วัดจาก rawBody (Cloud Functions) หรือ content-length */
function bodyLimit(limit) {
  const max = toBytes(limit);
  return function checkBodyLimit(req, res, next) {
    let size = null;
    if (req.rawBody && typeof req.rawBody.length === "number") size = req.rawBody.length;
    else if (req.headers && req.headers["content-length"] !== undefined) size = Number(req.headers["content-length"]);
    if (size !== null && Number.isFinite(size) && size > max) return fail(res, 413, "payload_too_large", "ข้อมูลที่ส่งมาใหญ่เกินกำหนด");
    next();
  };
}

/** express.json verify: เก็บไบต์ดิบไว้ตรวจลายเซ็น (มีแล้ว = ของ framework ไม่ทับ) */
function keepRawBody(req, _res, buf) {
  if (req.rawBody === undefined) req.rawBody = Buffer.from(buf);
}

/** ตรวจทะเบียน route กับทะเบียน public · ผิด = throw ตอนสร้าง app (deploy แล้วไม่ขึ้น ดีกว่าขึ้นแบบไม่มีด่าน) */
function checkRegistry(routes, publicRoutes) {
  const problems = [];
  const pub = new Set(publicRoutes);
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r.path)) problems.push(`path ซ้ำ ${r.path}`);
    seen.add(r.path);
    if (!["shop", "user", "public", "partner", "partnerSigned"].includes(r.auth)) problems.push(`${r.path} auth ไม่รู้จัก "${r.auth}"`);
    if (r.auth === "public" && !pub.has(r.path)) problems.push(`${r.path} ไม่มีด่านตัวตนแต่ไม่อยู่ใน public-routes.js`);
    // partner = เซิร์ฟเวอร์ ScanGo เท่านั้น ⇒ อยู่ใต้ /scango/ และไม่ใช่เส้นฝั่งแอปร้าน (/scango/shop/* เป็น auth shop) · /scango/v1/* = partnerSigned เท่านั้น
    if (r.auth === "partner" && !/^\/scango\/(?!shop\/|v1\/)/.test(r.path)) problems.push(`${r.path} auth partner ใช้ได้เฉพาะเส้น /scango/* ที่ไม่ใช่ /scango/shop/* และ /scango/v1/*`);
    if (r.auth !== "partner" && /^\/scango\/(?!shop\/|v1\/)/.test(r.path)) problems.push(`${r.path} อยู่ใต้ /scango/ แต่ auth ไม่ใช่ partner`);
    if (r.auth === "partnerSigned" && !/^\/scango\/v1\//.test(r.path)) problems.push(`${r.path} auth partnerSigned ใช้ได้เฉพาะเส้น /scango/v1/*`);
    if (r.auth !== "partnerSigned" && /^\/scango\/v1\//.test(r.path)) problems.push(`${r.path} อยู่ใต้ /scango/v1/ แต่ auth ไม่ใช่ partnerSigned`);
    // access "reportRead" (legacy owner-web parity · ไม่ดู status/แพ็กเกจพนักงาน) ให้ได้เฉพาะ route รายงานอ่านอย่างเดียว
    if (r.access !== undefined && r.access !== "reportRead") problems.push(`${r.path} access ไม่รู้จัก "${r.access}"`);
    if (r.access === "reportRead" && (r.auth !== "shop" || !/^report\./.test(String(r.contract)))) problems.push(`${r.path} ใช้ access reportRead ได้เฉพาะ route report.* ที่ auth shop`);
  }
  for (const p of pub) {
    const r = routes.find((x) => x.path === p);
    if (!r || r.auth !== "public") problems.push(`public-routes.js มี ${p} แต่ไม่มี route สาธารณะนี้`);
  }
  if (problems.length) throw new Error("pos/app: ทะเบียน route ผิด · " + problems.join(" · "));
}

/**
 * makeApp({fnName, deps, checkIfAuthenticated, requireShopAccess, requirePartnerKey, routes, publicRoutes}) → express app ของ function นั้น
 *   deps = ส่งเข้า factory ของ handler (ไม่ส่ง = ตัวจริง · e2e ส่งนาฬิกาตรึง)
 *   checkIfAuthenticated / requireShopAccess ไม่ส่ง = ตัวจริงจาก _shared/auth.js
 *   requirePartnerKey ไม่ส่ง = ตัวจริงจาก scango/_partnerAuth.js (อ่าน process.env ตอนคำขอ · เทสส่ง requirePartnerKey(envปลอม))
 *   requirePartnerSignature ไม่ส่ง = ตัวจริงจาก scango/v1/partnerSign.js (อ่าน process.env ตอนคำขอ · เทสส่ง requirePartnerSignature({env, now}))
 *   routes / publicRoutes ไม่ส่ง = ทะเบียนจริง (เทสส่งตัวกลายพันธุ์มาพิสูจน์ว่าด่านจับได้)
 */
function makeApp({ fnName, deps, checkIfAuthenticated, requireShopAccess, requireReportReadAccess, requirePartnerKey, requirePartnerSignature, routes = ROUTES, publicRoutes = PUBLIC_ROUTES } = {}) {
  checkRegistry(routes, publicRoutes);
  const auth = require("./_shared/auth");
  const authn = checkIfAuthenticated || auth.checkIfAuthenticated;
  const shopz = requireShopAccess || auth.requireShopAccess;
  // โหลดเฉพาะเมื่อทะเบียนมีแถว partner (function ที่ไม่มีเส้น scango ไม่ต้องโหลด)
  const partnerz = requirePartnerKey || (routes.some((r) => r.auth === "partner" && (r.fn === "*" || r.fn === fnName)) ? require("./scango/_partnerAuth").requirePartnerKey() : null);
  const signedz = requirePartnerSignature || (routes.some((r) => r.auth === "partnerSigned" && (r.fn === "*" || r.fn === fnName)) ? require("./scango/v1/partnerSign").requirePartnerSignature() : null);
  // เทสที่ส่ง requireShopAccess ปลอมมาอย่างเดียว ⇒ route รายงานใช้ตัวปลอมเดียวกัน (ไม่ซ่อนตัวจริงไว้ใต้เทส)
  const reportz = requireReportReadAccess || (requireShopAccess ? requireShopAccess : auth.requireReportReadAccess);

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(cors({ origin: true }));
  app.use(gateFor(fnName, routes));

  for (const r of routes) {
    if (r.fn !== "*" && r.fn !== fnName) continue;
    const loaded = r.load();
    const handler = r.factory ? loaded(deps || {}) : loaded;
    if (typeof handler !== "function") throw new Error(`pos/app: handler ของ ${r.path} ไม่ใช่ฟังก์ชัน`);
    const limit = r.bodyLimit || DEFAULT_LIMIT;
    const chain = [scrubInternal];
    if (r.auth === "partner") chain.push(partnerz);
    else if (r.auth !== "public" && r.auth !== "partnerSigned") chain.push(authn);
    if (r.auth === "partnerSigned") {
      // ลายเซ็นคิดจากไบต์ดิบ: Cloud Functions เก็บ req.rawBody ให้แล้ว (express.json ข้าม) · ที่อื่นให้ express.json เก็บไบต์ไว้ก่อน parse
      chain.push(bodyLimit(limit), express.json({ limit, verify: keepRawBody }), signedz, stripBody);
    } else chain.push(bodyLimit(limit), express.json({ limit }), stripBody);
    if (r.auth === "shop") chain.push(r.access === "reportRead" ? reportz : shopz);
    app.post(r.path, ...chain, handler);
  }

  app.use((req, res) => fail(res, 404, "not_found", "ไม่พบเส้นทางนี้"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const type = err && err.type;
    if (type === "entity.too.large") return fail(res, 413, "payload_too_large", "ข้อมูลที่ส่งมาใหญ่เกินกำหนด");
    if (type === "entity.parse.failed" || (err && err.status === 400)) return fail(res, 400, "invalid_json", "รูปข้อมูลที่ส่งมาไม่ใช่ JSON");
    try { console.error("pos unhandled", err && err.name, err && err.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
    if (res.headersSent) return undefined;
    return fail(res, 500, "internal_error");
  });
  return app;
}

module.exports = { makeApp, checkRegistry, scrubInternal, stripBody, bodyLimit, toBytes, INTERNAL_FIELDS, DEFAULT_LIMIT };

// pos/app.js — express app ของ API ใหม่ (ก้อน 4 · DEV-0001 · ยกท่า claude/app.js ของพี่น้อง)
//
// ลำดับต่อคำขอ (ทุก route ยกเว้นที่อยู่ใน public-routes.js):
//   ① workloadGate      segment ของ function อื่น = 404 wrong_function (workloads.js)
//   ② scrubInternal     ลบ field ภายในที่ handler อ่านจาก req (amendVoid amendCarry amendOf shopAccess auth) ทั้งบน req และใน body
//                       field พวกนี้ใส่ได้จากในโปรเซสเท่านั้น (sale.amend เรียก void/create ตรง · chunk4-case-additions.md §13)
//   ③ checkIfAuthenticated  ไม่มี token / token ไม่ผ่าน = 401 no_auth (ตรวจก่อนอ่าน body · คนไม่มี token ส่งของใหญ่มาก็ไม่ถูกอ่าน)
//   ④ bodyLimit + express.json   เกินเพดาน = 413 payload_too_large · JSON เสีย = 400 invalid_json
//   ⑤ stripBody ลบ field ภายในจาก body อีกรอบหลังอ่าน (ลบแค่ใน body · req.auth ที่ ③ ตั้งต้องอยู่ต่อ)
//   ⑥ requireShopAccess (route auth 'shop')   ร้านจาก body.shopId
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

/** ตรวจทะเบียน route กับทะเบียน public · ผิด = throw ตอนสร้าง app (deploy แล้วไม่ขึ้น ดีกว่าขึ้นแบบไม่มีด่าน) */
function checkRegistry(routes, publicRoutes) {
  const problems = [];
  const pub = new Set(publicRoutes);
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r.path)) problems.push(`path ซ้ำ ${r.path}`);
    seen.add(r.path);
    if (!["shop", "user", "public"].includes(r.auth)) problems.push(`${r.path} auth ไม่รู้จัก "${r.auth}"`);
    if (r.auth === "public" && !pub.has(r.path)) problems.push(`${r.path} ไม่มีด่านตัวตนแต่ไม่อยู่ใน public-routes.js`);
  }
  for (const p of pub) {
    const r = routes.find((x) => x.path === p);
    if (!r || r.auth !== "public") problems.push(`public-routes.js มี ${p} แต่ไม่มี route สาธารณะนี้`);
  }
  if (problems.length) throw new Error("pos/app: ทะเบียน route ผิด · " + problems.join(" · "));
}

/**
 * makeApp({fnName, deps, checkIfAuthenticated, requireShopAccess, routes, publicRoutes}) → express app ของ function นั้น
 *   deps = ส่งเข้า factory ของ handler (ไม่ส่ง = ตัวจริง · e2e ส่งนาฬิกาตรึง)
 *   checkIfAuthenticated / requireShopAccess ไม่ส่ง = ตัวจริงจาก _shared/auth.js
 *   routes / publicRoutes ไม่ส่ง = ทะเบียนจริง (เทสส่งตัวกลายพันธุ์มาพิสูจน์ว่าด่านจับได้)
 */
function makeApp({ fnName, deps, checkIfAuthenticated, requireShopAccess, routes = ROUTES, publicRoutes = PUBLIC_ROUTES } = {}) {
  checkRegistry(routes, publicRoutes);
  const auth = require("./_shared/auth");
  const authn = checkIfAuthenticated || auth.checkIfAuthenticated;
  const shopz = requireShopAccess || auth.requireShopAccess;

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
    if (r.auth !== "public") chain.push(authn);
    chain.push(bodyLimit(limit), express.json({ limit }), stripBody);
    if (r.auth === "shop") chain.push(shopz);
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

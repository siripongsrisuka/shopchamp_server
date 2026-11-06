// pos/gateway/app.js — express app ของ function `pos_gateway` (ก้อน 7 · DEV-0001 · ผูก export 2026-11-07)
//
// URL: https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/pos_gateway/<path> · ทะเบียนเส้น = gateway/routes.js
// ลำดับต่อคำขอ:
//   ① bodyLimit จาก rawBody (บน Cloud Functions framework อ่าน body ก่อน express ⇒ เพดานของ express.json ไม่ทำงาน · ท่าเดียวกับ pos/app.js)
//      เส้นแอป /payment/* 100kb · เส้น webhook 256kb
//   ② router ของ gateway/routes.js: เส้นแอป = scrubInternal → checkIfAuthenticated → json → stripBody → requireShopAccess → ③ → handler
//                                    เส้น webhook = json/urlencoded (เก็บ rawBody) → scrubInternal → handler (ยามของตัวเอง)
//   ③ requireGatewayReady (เส้นแอปเท่านั้น · หลังด่านตัวตน ⇒ คนไม่มี token ยังได้ 401 ก่อนเสมอ)
//      ระบบยังไม่มีกุญแจเข้ารหัส `GATEWAY_CRED_ENC_KEY` (ไม่มี/ผิดรูป) = 503 gateway_not_configured {scope:'system', missing:[ชื่อ env]}
//      ❌ ไม่บอกค่า · บอกแค่ชื่อ env ที่ขาด · แอปแสดง "ระบบรับเงินออนไลน์ยังไม่เปิดใช้"
//      webhook ไม่ผ่านด่านนี้: แกนร่วม webhooks/core.js ตอบ 503 เองเมื่อต้องถอดกุญแจร้านแต่ไม่มีกุญแจระบบ (ผู้ให้บริการยิงซ้ำ)
//
// 🔑 secret: ยังไม่ผูก `secrets:` ของ gen2 (functions.js) · firebase-tools 15.19.0 ตรวจ secret ทุกตัวที่ผูกตอน deploy
//   (`lib/deploy/functions/validate.js` secretsAreValid → getSecretVersion 'latest') ⇒ secret ที่ยังไม่สร้าง = deploy ล้มทั้งตัว
//   และ Secret Manager API ของ shopcham-24b0b ยังไม่เปิด (gcloud secrets list 2026-11-07)
//   ⇒ handler อ่าน process.env ตอนรัน (secretBox · providers/*) · ไม่มีค่า = ด่าน ③ และ fail-closed รายเจ้า (kbank_proxy_not_configured ฯลฯ)
//   ผูกจริงเมื่อ Pack สร้าง secret แล้ว: เติม `secrets: [...]` ใน GATEWAY_CONFIG ของ workloads.js แล้ว deploy ใหม่
// โหลด handler ตอนสร้าง app (makeGatewayApp) · functions.js สร้างตอนคำขอแรก ⇒ function เดิมที่โหลด index.js ไม่โหลดโค้ดเกตเวย์
"use strict";

const express = require("express");
const cors = require("cors");
const { makeGatewayRouter, APP_LIMIT, HOOK_LIMIT } = require("./routes");
const { readKey, ENC_KEY_ENV } = require("./secretBox");
const { bodyLimit } = require("../app");
const { fail } = require("../_shared/respond");

const NOT_READY_MESSAGE = "ระบบรับเงินออนไลน์ยังไม่เปิดใช้ — ติดต่อทีมงาน Shopchamp";

/** requireGatewayReady(deps) → middleware · กุญแจระบบไม่พร้อม = 503 gateway_not_configured (ไม่บอกค่า) */
function requireGatewayReady(deps) {
  return function gatewayReady(req, res, next) {
    const env = deps && deps.env && typeof deps.env === "object" ? deps.env : undefined;
    const k = readKey({ deps, env });
    if (k.key) return next();
    return fail(res, 503, "gateway_not_configured", NOT_READY_MESSAGE, { scope: "system", missing: [ENC_KEY_ENV] });
  };
}

/**
 * makeGatewayApp({deps, checkIfAuthenticated, requireShopAccess, routes, publicRoutes}) → express app ของ pos_gateway
 *   ไม่ส่งด่าน = ตัวจริงจาก _shared/auth.js (ผ่าน makeGatewayRouter) · deps ส่งต่อทั้ง handler และด่าน ③ (เทสส่ง credKey/env ปลอม)
 */
function makeGatewayApp({ deps, checkIfAuthenticated, requireShopAccess, routes, publicRoutes } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(cors({ origin: true }));
  const appLimit = bodyLimit(APP_LIMIT);
  const hookLimit = bodyLimit(HOOK_LIMIT);
  app.use((req, res, next) => (/^\/webhook\//.test(req.path) ? hookLimit : appLimit)(req, res, next));
  const opts = { deps: deps || {}, checkIfAuthenticated, requireShopAccess, readiness: requireGatewayReady(deps || {}) };
  if (routes) opts.routes = routes;
  if (publicRoutes) opts.publicRoutes = publicRoutes;
  app.use(makeGatewayRouter(opts));
  return app;
}

module.exports = { makeGatewayApp, requireGatewayReady, NOT_READY_MESSAGE };

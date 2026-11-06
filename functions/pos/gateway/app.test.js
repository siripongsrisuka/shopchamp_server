// pos/gateway/app.test.js — เทสชั้น express ของ function `pos_gateway` (ก้อน 7 · ผูก export 2026-11-07) · ไม่แตะฐาน · ไม่ต่อเครือข่ายนอกเครื่อง
// รัน: node --test pos/gateway/app.test.js (pre-commit รันผ่าน check-pos-tests)
// ครอบ: ① ทุกเส้นแอปของทะเบียนจริงไม่มี token = 401 no_auth (handler จริง) + ตัวกลายพันธุ์ถอดด่านต้องแดง
//       ② ระบบไม่มีกุญแจ = 503 gateway_not_configured หลังด่านตัวตนเท่านั้น · ไม่บอกค่า · มีกุญแจ = ถึง handler · webhook ไม่ติดด่านนี้
//       ③ เพดาน body จาก rawBody (แบบ Cloud Functions) · ④ export: index.js ต่อท้าย pos_gateway · functions.js gen2 asia-southeast2 ไม่ผูก secret
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeGatewayApp, requireGatewayReady } = require("./app");
const R = require("./routes");
const { makeCheckIfAuthenticated } = require("../_shared/auth");

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const fakeVerify = async (t) => {
  if (!/^tok-/.test(t)) { const e = new Error("bad"); e.code = "auth/argument-error"; throw e; }
  return { uid: t.slice(4) };
};
const realishAuth = makeCheckIfAuthenticated({ verifyIdToken: fakeVerify, log: () => {} });
const passShop = (req, res, next) => { req.shopAccess = { shopId: req.body.shopId, uid: req.auth.uid, role: "owner", rights: [] }; next(); };
const echo = (tag) => () => (req, res) => res.status(200).json({ ok: true, tag, raw: req.rawBody ? req.rawBody.length : null });
const fakeRoutes = R.GATEWAY_ROUTES.map((r) => ({ ...r, load: () => echo(r.path) }));
const APP_ROUTES = R.GATEWAY_ROUTES.filter((r) => r.auth === "shop");
const HOOK_ROUTES = R.GATEWAY_ROUTES.filter((r) => r.auth === "public");

async function serve(app, fn) {
  const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); }
}
async function post(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ไม่ใช่ JSON */ }
  return { status: r.status, body: json, text };
}

/** ยิงทุกเส้นแอปโดยไม่มี token · คืนรายการที่ไม่ได้ 401 no_auth */
async function unguarded(opts) {
  const app = makeGatewayApp({ requireShopAccess: passShop, deps: { env: {} }, ...opts });
  const bad = [];
  await serve(app, async (base) => {
    for (const r of APP_ROUTES) {
      const res = await post(base, r.path, { shopId: "shopA" });
      if (!(res.status === 401 && res.body && res.body.ok === false && res.body.error === "no_auth")) bad.push(`${r.path} → ${res.status} ${res.text.slice(0, 80)}`);
    }
  });
  return bad;
}

test("① ทะเบียนจริง + handler จริง: ทุกเส้นแอป 11 เส้น ไม่มี token = 401 no_auth (ก่อนด่านกุญแจระบบ)", async () => {
  assert.equal(APP_ROUTES.length, 11);
  assert.deepEqual(await unguarded({ checkIfAuthenticated: realishAuth }), []);
});

test("① ตัวกลายพันธุ์: ถอดด่านตัวตน = เทสข้างบนแดงทุกเส้น", async () => {
  const noAuth = (req, res, next) => { req.auth = { uid: "u-x" }; next(); };
  const bad = await unguarded({ checkIfAuthenticated: noAuth, routes: fakeRoutes });
  assert.equal(bad.length, APP_ROUTES.length);
});

test("② ไม่มีกุญแจระบบ: มี token = 503 gateway_not_configured {scope:'system', missing:[ชื่อ env]} ทุกเส้นแอป · ไม่ถึง handler", async () => {
  const app = makeGatewayApp({ checkIfAuthenticated: realishAuth, requireShopAccess: passShop, routes: fakeRoutes, deps: { env: {} } });
  await serve(app, async (base) => {
    for (const r of APP_ROUTES) {
      const res = await post(base, r.path, { shopId: "shopA" }, { authorization: "Bearer tok-u1" });
      assert.equal(res.status, 503, r.path);
      assert.equal(res.body.error, "gateway_not_configured", r.path);
      assert.equal(res.body.scope, "system");
      assert.deepEqual(res.body.missing, ["GATEWAY_CRED_ENC_KEY"]);
      assert.equal(res.body.tag, undefined, "ไม่ถึง handler");
    }
  });
});

test("② กุญแจผิดรูป = 503 เหมือนกัน และไม่สะท้อนค่ากลับ · กุญแจถูก = ถึง handler", async () => {
  const bad = "not-base64-!!secretvalue";
  const appBad = makeGatewayApp({ checkIfAuthenticated: realishAuth, requireShopAccess: passShop, routes: fakeRoutes, deps: { env: { GATEWAY_CRED_ENC_KEY: bad } } });
  await serve(appBad, async (base) => {
    const res = await post(base, "/payment/request-qr", { shopId: "shopA" }, { authorization: "Bearer tok-u1" });
    assert.equal(res.status, 503);
    assert.ok(!res.text.includes(bad), "ห้ามสะท้อนค่ากุญแจ");
  });
  const appOk = makeGatewayApp({ checkIfAuthenticated: realishAuth, requireShopAccess: passShop, routes: fakeRoutes, deps: { env: { GATEWAY_CRED_ENC_KEY: TEST_KEY } } });
  await serve(appOk, async (base) => {
    for (const r of APP_ROUTES) {
      const res = await post(base, r.path, { shopId: "shopA" }, { authorization: "Bearer tok-u1" });
      assert.equal(res.status, 200, r.path);
      assert.equal(res.body.tag, r.path);
    }
  });
});

test("② webhook ไม่ใช้ token และไม่ติดด่านกุญแจระบบ (แกนร่วมตอบ 503 เองเมื่อต้องใช้กุญแจ)", async () => {
  const app = makeGatewayApp({ checkIfAuthenticated: realishAuth, requireShopAccess: passShop, routes: fakeRoutes, deps: { env: {} } });
  await serve(app, async (base) => {
    for (const r of HOOK_ROUTES) {
      const res = await post(base, r.path, { id: "x" });
      assert.equal(res.status, 200, r.path);
      assert.equal(res.body.tag, r.path);
    }
    assert.equal((await post(base, "/payment/nope", {})).status, 404);
  });
});

test("② ด่านกุญแจอ่าน process.env เมื่อไม่มี deps.env", () => {
  const was = process.env.GATEWAY_CRED_ENC_KEY;
  const run = () => { let code = 0; requireGatewayReady({})({}, { status: (c) => { code = c; return { json: () => {} }; } }, () => { code = "next"; }); return code; };
  try {
    delete process.env.GATEWAY_CRED_ENC_KEY;
    assert.equal(run(), 503);
    process.env.GATEWAY_CRED_ENC_KEY = TEST_KEY;
    assert.equal(run(), "next");
  } finally {
    if (was === undefined) delete process.env.GATEWAY_CRED_ENC_KEY; else process.env.GATEWAY_CRED_ENC_KEY = was;
  }
});

test("③ เพดาน body วัดจาก rawBody (framework อ่าน body ไว้ก่อน): แอป > 100kb · webhook > 256kb = 413", async () => {
  const app = makeGatewayApp({ checkIfAuthenticated: realishAuth, requireShopAccess: passShop, routes: fakeRoutes, deps: { env: { GATEWAY_CRED_ENC_KEY: TEST_KEY } } });
  const call = (p, size) => new Promise((resolve) => {
    const req = { method: "POST", url: p, path: p, headers: { "content-type": "application/json", authorization: "Bearer tok-u1" }, body: { shopId: "shopA" }, rawBody: Buffer.alloc(size), get: () => undefined };
    const res = { statusCode: 200, headersSent: false, setHeader() {}, getHeader() {}, removeHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); return this; }, end() { resolve({ code: this.statusCode }); } };
    app(req, res, () => resolve({ code: "fallthrough" }));
  });
  assert.equal((await call("/payment/inquire", 101 * 1024)).code, 413);
  assert.equal((await call("/webhook/ntt", 200 * 1024)).code !== 413, true, "webhook 200kb ยังรับ");
  assert.equal((await call("/webhook/ntt", 257 * 1024)).code, 413);
});

test("④ export: index.js ต่อท้าย exports.pos_gateway · functions.js gen2 asia-southeast2 invoker public · ยังไม่ผูก secret", () => {
  const index = fs.readFileSync(path.resolve(__dirname, "../../index.js"), "utf8");
  assert.match(index, /^exports\.pos_gateway = posFunctions\.pos_gateway;$/m);
  const F = require("../functions");
  const ep = F.pos_gateway.__endpoint;
  assert.equal(ep.platform, "gcfv2");
  assert.deepEqual(ep.region, ["asia-southeast2"]);
  assert.equal(ep.availableMemoryMb, 512);
  assert.equal(ep.timeoutSeconds, 60);
  assert.equal(ep.concurrency, 40);
  assert.equal(ep.maxInstances, 20);
  assert.ok(!ep.secretEnvironmentVariables || ep.secretEnvironmentVariables.length === 0, "ผูก secret ที่ยังไม่สร้าง = deploy ล้ม");
  assert.deepEqual(ep.httpsTrigger && ep.httpsTrigger.invoker, ["public"]);
  for (const k of ["pos", "pos_heavy"]) assert.equal(F[k].__endpoint.platform, "gcfv2", `${k} ไม่ถูกแตะ`);
});

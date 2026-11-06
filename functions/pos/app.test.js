// pos/app.test.js — เทสชั้น express ของ API ใหม่ (ก้อน 4 · DEV-0001) · ไม่แตะฐาน · ไม่ต่อเครือข่ายนอกเครื่อง
// รัน: node --test pos/app.test.js (pre-commit รันผ่าน check-pos-tests)
// ครอบ: ทะเบียน route ↔ สัญญา · ด่านตัวตนทุก route (+ ตัวกลายพันธุ์ที่ถอดด่านต้องแดง) · ทะเบียน public
//       ลบ field ภายในจาก body/req · เพดาน body · 404 wrong_function · ซองคำตอบของ 404/400/413
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");

const { makeApp, checkRegistry, toBytes, INTERNAL_FIELDS } = require("./app");
const { ROUTES } = require("./routes");
const { PUBLIC_ROUTES } = require("./public-routes");
const { FUNCTION_CONFIG, FN } = require("./workloads");
const { makeCheckIfAuthenticated } = require("./_shared/auth");

const CENTER_API = path.resolve(__dirname, "../../../shopchamp-center/api");

// token ปลอม: "tok-<uid>" ผ่าน · อย่างอื่นไม่ผ่าน (ไม่เรียก Firebase Auth)
const fakeVerify = async (t) => {
  if (!/^tok-/.test(t)) { const e = new Error("bad"); e.code = "auth/argument-error"; throw e; }
  return { uid: t.slice(4) };
};
const realishAuth = makeCheckIfAuthenticated({ verifyIdToken: fakeVerify, log: () => {} });
const passShop = (req, res, next) => { req.shopAccess = { shopId: req.body.shopId, uid: req.auth.uid, role: "owner", rights: [] }; next(); };

async function serve(app, fn) {
  const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => srv.close(r)); }
}
async function post(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ไม่ใช่ JSON */ }
  return { status: r.status, body: json, text };
}

/** ยิงทุก route ที่ไม่ใช่ public โดยไม่มี token · คืนรายการที่ไม่ได้ 401 no_auth (ว่าง = ผ่าน) */
async function unguarded(fnName, opts = {}) {
  const app = makeApp({ fnName, checkIfAuthenticated: realishAuth, requireShopAccess: passShop, ...opts });
  const routes = (opts.routes || ROUTES).filter((r) => (r.fn === fnName || r.fn === "*") && r.auth !== "public");
  const bad = [];
  await serve(app, async (base) => {
    for (const r of routes) {
      const res = await post(base, r.path, { shopId: "shopA" });
      if (!(res.status === 401 && res.body && res.body.ok === false && res.body.error === "no_auth")) bad.push(`${r.path} → ${res.status} ${res.text.slice(0, 80)}`);
    }
  });
  return bad;
}

test("ทะเบียน route: ทุกแถวมีสัญญาที่หัวไฟล์เขียน route เดียวกัน · handler โหลดได้", (t) => {
  for (const r of ROUTES) {
    assert.equal(typeof r.load(), "function", `${r.path} handler`);
    assert.ok(r.fn === "*" || FUNCTION_CONFIG[r.fn], `${r.path} fn`);
  }
  if (!fs.existsSync(CENTER_API)) { t.skip(`ไม่พบ ${CENTER_API} (repo ถูก clone เดี่ยว)`); return; }
  for (const r of ROUTES) {
    const f = path.join(CENTER_API, `${r.contract}.yaml`);
    assert.ok(fs.existsSync(f), `ไม่มีสัญญา ${r.contract}`);
    assert.ok(fs.readFileSync(f, "utf8").includes(`POST /pos${r.path}`), `${r.contract}.yaml ไม่ได้เขียน POST /pos${r.path}`);
  }
  // ทิศกลับ (สัญญาทุกตัวต้องมี route) ไม่ตรวจที่นี่: สัญญาของก้อนอื่นที่ยังไม่ผูก route (payment.* ก้อน 7) จะทำ pre-commit ของทุกคนแดง
});

test("ด่านตัวตน: ทุก route ของ pos และ pos_heavy ไม่มี token = 401 no_auth", async () => {
  for (const fn of Object.values(FN)) assert.deepEqual(await unguarded(fn), [], fn);
});

test("ตัวกลายพันธุ์: ถอดด่านตัวตนออก = เทสด่านตัวตนแดง", async () => {
  const noAuth = (req, res, next) => { req.auth = { uid: "u-x" }; next(); };
  const bad = await unguarded(FN.POS, { checkIfAuthenticated: noAuth });
  assert.ok(bad.length >= 8, `ต้องจับได้ทุก route · ได้ ${bad.length}`);
  // route เดียวที่ตั้งเป็น public เงียบ ๆ (ไม่ลงทะเบียน) = สร้าง app ไม่ได้
  const sneaky = ROUTES.map((r) => (r.path === "/sale/void" ? { ...r, auth: "public" } : r));
  assert.throws(() => makeApp({ fnName: FN.POS, routes: sneaky }), /ไม่อยู่ใน public-routes/);
});

test("ทะเบียน public: ว่างตอนนี้ · แถวค้าง = แดง · ลงทะเบียนแล้วผ่าน", () => {
  assert.deepEqual([...PUBLIC_ROUTES], []);
  assert.throws(() => checkRegistry(ROUTES, ["/sale/create"]), /ไม่มี route สาธารณะนี้/);
  const withHook = [...ROUTES, { contract: "x", path: "/hook/x", fn: "pos", auth: "public", factory: false, load: () => () => {} }];
  assert.doesNotThrow(() => checkRegistry(withHook, ["/hook/x"]));
  assert.throws(() => checkRegistry([...ROUTES, ROUTES[1]], []), /path ซ้ำ/);
});

test("ลบ field ภายใน: amendVoid amendCarry amendOf shopAccess auth จาก body ไม่ถึง handler (body อ่านโดย express และโดย framework)", async () => {
  let seen = null;
  const echo = { contract: "x", path: "/sale/echo", fn: "pos", auth: "shop", factory: false, load: () => (req, res) => {
    seen = { bodyKeys: Object.keys(req.body).sort(), amendVoid: req.amendVoid, amendCarry: req.amendCarry, amendOf: req.amendOf, access: req.shopAccess };
    res.json({ ok: true });
  } };
  const app = makeApp({ fnName: FN.POS, routes: [echo], checkIfAuthenticated: realishAuth, requireShopAccess: passShop });
  const evil = { shopId: "shopA", billId: "b1", amendVoid: true, amendCarry: { x: 1 }, amendOf: "b0", shopAccess: { shopId: "shopA", uid: "u", role: "owner" }, auth: { uid: "admin" } };
  await serve(app, async (base) => {
    const r = await post(base, "/sale/echo", evil, { authorization: "Bearer tok-u1" });
    assert.equal(r.status, 200, r.text);
  });
  assert.deepEqual(seen.bodyKeys, ["billId", "shopId"]);
  assert.equal(seen.amendVoid, undefined);
  assert.equal(seen.amendCarry, undefined);
  assert.equal(seen.amendOf, undefined);
  assert.equal(seen.access.uid, "u1", "shopAccess มาจาก middleware ไม่ใช่ body");

  // แบบ Cloud Functions: framework อ่าน body + rawBody ไว้ก่อน (express.json ข้าม)
  const outer = express();
  // อ่าน stream จนจบเหมือน functions-framework (body-parser 2 ข้ามเมื่อ stream จบแล้วเท่านั้น)
  outer.use(express.raw({ type: "*/*" }), (req, res, next) => { req.rawBody = Buffer.from(JSON.stringify(evil)); req.body = { ...evil }; req.amendVoid = true; next(); });
  outer.use(app);
  seen = null;
  await serve(outer, async (base) => {
    const r = await post(base, "/sale/echo", "{}", { authorization: "Bearer tok-u1" });
    assert.equal(r.status, 200, r.text);
  });
  assert.deepEqual(seen.bodyKeys, ["billId", "shopId"]);
  assert.equal(seen.amendVoid, undefined, "req.amendVoid ที่ติดมาก่อนถึง app ต้องถูกลบ");
  assert.deepEqual([...INTERNAL_FIELDS].sort(), ["amendCarry", "amendOf", "amendVoid", "auth", "shopAccess"]);
});

test("sale.void จริง: amendVoid ใน body ไม่ข้ามด่านสิทธิ์ 116 (พนักงานไม่มีสิทธิ์ = 403)", async () => {
  const staffNo = (req, res, next) => { req.shopAccess = { shopId: req.body.shopId, uid: req.auth.uid, role: "staff", rights: [] }; next(); };
  const app = makeApp({ fnName: FN.POS, checkIfAuthenticated: realishAuth, requireShopAccess: staffNo });
  await serve(app, async (base) => {
    const r = await post(base, "/sale/void", { shopId: "shopA", billId: "b1", requestId: "3c9e1f20-1111-4000-8000-0000000000aa", reason: "x", staffId: "u1", staffName: "x", amendVoid: true }, { authorization: "Bearer tok-u1" });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.ok, false);
  });
});

test("เพดาน body + JSON เสีย + 404 + wrong_function อยู่ในซองเดียว", async () => {
  assert.equal(toBytes("100kb"), 102400);
  assert.equal(toBytes("1mb"), 1048576);
  const pos = makeApp({ fnName: FN.POS, checkIfAuthenticated: realishAuth, requireShopAccess: passShop });
  const auth = { authorization: "Bearer tok-u1" };
  await serve(pos, async (base) => {
    const big = await post(base, "/sale/get", { shopId: "shopA", pad: "x".repeat(110 * 1024) }, auth);
    assert.equal(big.status, 413, big.text);
    assert.equal(big.body.error, "payload_too_large");
    const bigBill = await post(base, "/sale/create", { shopId: "shopA", pad: "x".repeat(300 * 1024) }, auth);
    assert.equal(bigBill.status, 400, "sale.create รับได้ถึง 1mb · ตก schema แทน"); // ผ่านเพดาน ถึง handler แล้วตก schema
    const broken = await post(base, "/sale/get", "{bad json", auth);
    assert.equal(broken.status, 400, broken.text);
    assert.equal(broken.body.error, "invalid_json");
    const nf = await post(base, "/nope/x", {});
    assert.deepEqual([nf.status, nf.body.ok, nf.body.error], [404, false, "not_found"]);
    const get = await fetch(base + "/sale/create");
    assert.equal(get.status, 404);
    assert.equal((await get.json()).error, "not_found");
    assert.equal(get.headers.get("x-powered-by"), null);
  });
  const heavy = makeApp({ fnName: FN.HEAVY, checkIfAuthenticated: realishAuth, requireShopAccess: passShop });
  await serve(heavy, async (base) => {
    const w = await post(base, "/sale/create", {}, auth);
    assert.deepEqual([w.status, w.body.ok, w.body.error, w.body.serve], [404, false, "wrong_function", "pos"]);
    const p = await post(base, "/system/ping", { shopId: "shopA" });
    assert.deepEqual([p.status, p.body.error], [401, "no_auth"], "ping อยู่ทุก function");
  });
});

test("functions.js: require แล้วไม่โหลด handler · ได้ gen2 asia-southeast2 ตาม config", () => {
  // โปรเซสใหม่ (โปรเซสนี้โหลด handler ไปแล้วจากเทสก่อนหน้า)
  const { spawnSync } = require("child_process");
  const probe = "require('./pos/functions');console.log(JSON.stringify(Object.keys(require.cache).filter((k)=>/[\\\\/]pos[\\\\/](sale|shift|member|profile|system|_shared[\\\\/]auth)/.test(k))))";
  const r = spawnSync(process.execPath, ["-e", probe], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, GCLOUD_PROJECT: "demo-shopchamp" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), [], "require functions.js ต้องไม่โหลด handler");
  const f = require("./functions");
  for (const [name, cfg] of Object.entries(FUNCTION_CONFIG)) {
    const e = f[name].__endpoint;
    assert.equal(e.platform, "gcfv2", name);
    assert.deepEqual(e.region, ["asia-southeast2"], name);
    assert.equal(e.concurrency, cfg.concurrency, name);
    assert.equal(e.maxInstances, cfg.maxInstances, name);
    assert.equal(e.timeoutSeconds, cfg.timeoutSeconds, name);
  }
});

test("เพดาน body แบบ Cloud Functions: framework อ่าน body ไว้แล้ว (express.json ข้าม) · วัดจาก rawBody = 413", async () => {
  const pos = makeApp({ fnName: FN.POS, checkIfAuthenticated: realishAuth, requireShopAccess: passShop });
  const big = { shopId: "shopA", pad: "x".repeat(110 * 1024) };
  const outer = express();
  outer.use(express.raw({ type: "*/*", limit: "32mb" }), (req, res, next) => { req.rawBody = req.body; req.body = JSON.parse(req.rawBody.toString("utf8")); next(); });
  outer.use(pos);
  await serve(outer, async (base) => {
    const r = await post(base, "/sale/get", big, { authorization: "Bearer tok-u1" });
    assert.deepEqual([r.status, r.body && r.body.error], [413, "payload_too_large"], r.text.slice(0, 200));
  });
});

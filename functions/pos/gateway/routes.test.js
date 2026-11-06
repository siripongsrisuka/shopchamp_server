// เทส gateway/routes.js · รัน: node --test functions/pos/gateway/routes.test.js
//   ยกท่าจากพี่น้อง (claude/public-routes.js + claudeAuth.mount.test.js):
//   ① ทุกเส้นที่ไม่ใช่ webhook มีทั้ง checkIfAuthenticated และ requireShopAccess ก่อน handler
//   ② เส้นสาธารณะทุกเส้นอยู่ในทะเบียน PUBLIC_ROUTES · ทะเบียนค้าง = แดง · ยามในไฟล์ยังอยู่ครบ (ถอดการถามซ้ำ = แดง)
//   ③ ยิงจริงผ่าน HTTP: ไม่มี token = 401 ทุกเส้นแอป · webhook ไม่ต้อง token และได้ rawBody
//   ④ ทุกแถวมีไฟล์สัญญาที่หัวไฟล์เขียน endpoint ตรงกัน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const R = require("./routes");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const API = path.resolve(FUNCTIONS, "..", "..", "shopchamp-center", "api");

const authn = function checkIfAuthenticated(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ ok: false, error: "no_auth" });
  req.auth = { uid: "u1" };
  return next();
};
const shopz = function requireShopAccess(req, res, next) {
  req.shopAccess = { shopId: req.body.shopId, uid: "u1", role: "owner", rights: [] };
  return next();
};
const echo = (tag) => () => (req, res) => res.status(200).json({ ok: true, tag, shopAccess: req.shopAccess || null, raw: req.rawBody ? req.rawBody.toString("utf8") : null });
const fakeRoutes = R.GATEWAY_ROUTES.map((r) => ({ ...r, load: () => echo(r.path) }));

test("① ทุกเส้นแอป (auth shop) มีด่านตัวตน + ด่านร้าน ก่อน handler · เส้น webhook ไม่มี", () => {
  const router = R.makeGatewayRouter({ checkIfAuthenticated: authn, requireShopAccess: shopz, routes: fakeRoutes });
  const byPath = new Map(router.stack.filter((l) => l.route).map((l) => [l.route.path, l.route.stack.map((s) => s.handle)]));
  for (const r of R.GATEWAY_ROUTES) {
    const chain = byPath.get(r.path);
    assert.ok(chain, `ไม่มี route ${r.path}`);
    const ia = chain.indexOf(authn);
    const is = chain.indexOf(shopz);
    if (r.auth === "shop") {
      assert.ok(ia >= 0 && is > ia && is < chain.length - 1, `${r.path} ต้องมี checkIfAuthenticated → requireShopAccess ก่อน handler`);
    } else {
      assert.equal(ia, -1, `${r.path} webhook ไม่ใช้ token ผู้ใช้`);
      assert.equal(is, -1);
    }
  }
  assert.equal(R.GATEWAY_ROUTES.filter((r) => r.auth === "shop").length, 11);
});

test("② ทะเบียน public: ตรงกับเส้นสาธารณะ 3 เส้น · แอบเปิดเส้นแอปเป็น public = สร้าง router ไม่ได้ · แถวค้าง = แดง", () => {
  assert.deepEqual(R.PUBLIC_ROUTES.map((p) => p.path), ["/webhook/ntt", "/webhook/kbank", "/webhook/beam"]);
  assert.deepEqual(R.registryProblems(R.GATEWAY_ROUTES, R.PUBLIC_ROUTES), []);
  const sneaky = fakeRoutes.map((r) => (r.path === "/payment/test-and-save" ? { ...r, auth: "public" } : r));
  assert.throws(() => R.makeGatewayRouter({ checkIfAuthenticated: authn, requireShopAccess: shopz, routes: sneaky }), /ไม่อยู่ใน PUBLIC_ROUTES/);
  const stale = [...R.PUBLIC_ROUTES, { path: "/webhook/old", reason: "x", guard: { file: "x", contains: ["x"] } }];
  assert.throws(() => R.makeGatewayRouter({ checkIfAuthenticated: authn, requireShopAccess: shopz, routes: fakeRoutes, publicRoutes: stale }), /ไม่มี route สาธารณะนี้/);
});

test("② ยามของทุกเส้นสาธารณะยังอยู่ในไฟล์ (ไฟล์ของเส้น + แกนร่วมที่ถามผู้ให้บริการซ้ำ)", () => {
  for (const p of R.PUBLIC_ROUTES) {
    for (const g of [p.guard, p.core].filter(Boolean)) {
      const file = path.join(FUNCTIONS, g.file);
      assert.ok(fs.existsSync(file), `ไม่มีไฟล์ยาม ${g.file}`);
      const src = fs.readFileSync(file, "utf8");
      for (const word of g.contains) assert.ok(src.includes(word), `${p.path}: ยาม "${word}" หายจาก ${g.file}`);
    }
  }
});

async function withServer(router, fn) {
  const app = express();
  app.use(router);
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("③ HTTP: ไม่มี token = 401 ทุกเส้นแอป · ใส่ shopAccess ปลอมมาใน body ก็ถูกลบ · webhook ไม่ต้อง token และได้ rawBody ตรงไบต์", async () => {
  const router = R.makeGatewayRouter({ checkIfAuthenticated: authn, requireShopAccess: shopz, routes: fakeRoutes });
  await withServer(router, async (base) => {
    for (const r of R.GATEWAY_ROUTES.filter((x) => x.auth === "shop")) {
      const res = await post(base + r.path, { shopId: "shopA" });
      assert.equal(res.status, 401, r.path);
    }
    const ok = await post(base + "/payment/connections-get", { shopId: "shopA", shopAccess: { shopId: "shopZ", role: "owner" } }, { authorization: "Bearer t" });
    assert.equal((await ok.json()).shopAccess.shopId, "shopA");
    const raw = '{"id":"intent-1",  "merchant":{"merchantId":"m-1"}}';
    const hook = await post(base + "/webhook/beam", raw);
    const hb = await hook.json();
    assert.equal(hook.status, 200);
    assert.equal(hb.raw, raw, "rawBody ต้องเป็นไบต์ที่ส่งมาเป๊ะ (ลายเซ็นคิดจากตัวนี้)");
    assert.equal(hb.shopAccess, null, "webhook ไม่มี shopAccess");
    const form = await fetch(base + "/webhook/ntt", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "out_trade_no=X1" });
    assert.equal(form.status, 200);
    const badJson = await post(base + "/webhook/kbank", "{bad");
    assert.equal(badJson.status, 400);
    assert.equal((await post(base + "/payment/nope", {})).status, 404);
  });
});

test("ทะเบียนจริงโหลด handler ได้ครบทุกแถว (factory คืน handler)", () => {
  const router = R.makeGatewayRouter({ checkIfAuthenticated: authn, requireShopAccess: shopz, deps: {} });
  assert.equal(router.stack.filter((l) => l.route).length, R.GATEWAY_ROUTES.length);
});

test("④ ทุกแถวมีไฟล์สัญญา · หัวไฟล์/endpoint เขียน POST /pos_gateway<path> ตรงกัน", (t) => {
  // repo ถูก clone เดี่ยว (เช่นซ้อม pre-commit ใน legacy-freeze.test.js) = ไม่มี center ข้าง ๆ · ข้ามแบบเดียวกับ pos/app.test.js
  if (!fs.existsSync(API)) { t.skip(`ไม่พบ ${API} (repo ถูก clone เดี่ยว)`); return; }
  const missing = [];
  for (const r of R.GATEWAY_ROUTES) {
    const file = path.join(API, `${r.contract}.yaml`);
    if (!fs.existsSync(file)) { missing.push(r.contract); continue; }
    assert.ok(fs.readFileSync(file, "utf8").includes(`POST /pos_gateway${r.path}`), `${r.contract} ไม่เขียน endpoint POST /pos_gateway${r.path}`);
  }
  // สัญญาของผู้ทำคนอื่นอาจยังไม่ขึ้น — เส้นของไฟล์นี้ (connections · pairing · webhook) ต้องมีครบ
  const mine = ["payment.connectionsGet", "payment.testAndSave", "payment.channelsCheck", "payment.pair", "payment.unpair", "gateway.webhookNtt", "gateway.webhookKbank", "gateway.webhookBeam"];
  assert.deepEqual(missing.filter((c) => mine.includes(c)), []);
});

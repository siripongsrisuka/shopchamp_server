// pos/e2e/web-login.e2e.js — ลิงก์ login ใช้ครั้งเดียว ครบวงบน Firestore emulator (DEV-0001 · owner-web-login-design.md §7.2)
// รัน: cd functions && node pos/e2e/run.js pos/e2e/web-login.e2e.js   (ห้ามรันตรง · _env.js ปัดถ้าไม่ได้ต่อ emulator)
//
// ของจริงทั้งสาย: app.js (gate · scrub · ด่านตัวตน · public-routes) → handler ตัวจริง → transaction จริงของ emulator
//   ที่ปลอม: verifyIdToken (token "tok-<uid>[|email]") · นาฬิกา (ตัวแปรเลื่อนได้) · mint (emulator ไม่มี credential เซ็น token)
// doc ที่ "client ปั้นเอง" เขียนด้วย admin SDK = เนื้อเดียวกับที่ client เขียนได้ใต้ rules ที่ live (เปิดทุก doc) · rules ชุดใหม่ปัดอยู่แล้ว (rules-test/firestore.weblogin.test.mjs)
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const E = require("./_env");
const { makeApp } = require("../app");
const { makeCheckIfAuthenticated } = require("../_shared/auth");
const C = require("../webLogin/core");

const { get } = E;
const T0 = Date.parse("2026-11-10T03:00:00.000Z");
let clockMs = T0;
let mintMode = "ok";
const minted = [];
const deps = {
  now: () => new Date(clockMs),
  sealKey: Buffer.alloc(32, 7).toString("base64"), // กุญแจทดสอบ ไม่ใช่กุญแจจริง
  mint: async (uid) => {
    minted.push(uid);
    if (mintMode === "fail") throw Object.assign(new Error("signBlob denied"), { code: "auth/insufficient-permission" });
    return `fake-token-${uid}-${minted.length}`;
  },
  log: () => {},
  limits: { start: { max: 1000 }, consume: { max: 1000 } },
};

const authn = makeCheckIfAuthenticated({
  verifyIdToken: async (t) => {
    if (!/^tok-/.test(t)) throw Object.assign(new Error("bad"), { code: "auth/argument-error" });
    const [uid, email] = t.slice(4).split("|");
    return { uid, email };
  },
  log: () => {},
});

let BASE;
let srv;
before(async () => {
  await E.ready();
  const app = makeApp({ fnName: "pos", deps, checkIfAuthenticated: authn });
  srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  BASE = `http://127.0.0.1:${srv.address().port}/web-login`;
});
after(async () => { await new Promise((r) => srv.close(r)); });

async function post(p, body, tok) {
  const headers = { "content-type": "application/json", "user-agent": "e2e" };
  if (tok) headers.authorization = `Bearer ${tok}`;
  const r = await fetch(BASE + p, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const u = () => `u-${E.ns()}`;
async function startApproved(uid) {
  const s = await post("/start", {}, `tok-${uid}`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const a = await post("/approve", { sessionId: s.body.sessionId }, `tok-${uid}`);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return s.body;
}

test("ครบวง: start → consume pending → approve → consume ได้ token ของคน start · doc ในฐานจริง consumed · ซ้ำ 409", async () => {
  clockMs = T0; mintMode = "ok";
  const owner = u();
  const s = await post("/start", {}, `tok-${owner}`);
  assert.equal(s.status, 200);
  const doc0 = await get("webLogin", s.body.sessionId);
  assert.equal(doc0.status, "pending");
  assert.equal(doc0.startedBy, owner);
  assert.equal(doc0.secretHash, C.sha256Hex(s.body.secret));
  assert.equal(E.ms(doc0.expiresAt), T0 + 120000);
  assert.ok(!JSON.stringify(doc0).includes(s.body.secret));

  const p = await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret });
  assert.deepEqual([p.status, p.body.status], [200, "pending"]);
  assert.equal((await post("/approve", { sessionId: s.body.sessionId }, `tok-${owner}`)).status, 200);
  const c = await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret });
  assert.deepEqual([c.status, c.body.status, c.body.uid], [200, "approved", owner]);
  assert.match(c.body.token, new RegExp(`^fake-token-${owner}-`));
  const doc1 = await get("webLogin", s.body.sessionId);
  assert.equal(doc1.status, "consumed");
  assert.equal(doc1.consumeUa, "e2e");
  assert.equal(E.ms(doc1.consumedAt), T0);
  assert.deepEqual([(await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret })).status], [409]);
});

test("consume 2 ตัวพร้อมกัน = token ใบเดียว · อีกตัว 409 already_used", async () => {
  clockMs = T0; mintMode = "ok";
  const owner = u();
  const s = await startApproved(owner);
  const body = { sessionId: s.sessionId, secret: s.secret };
  const rs = await Promise.all([post("/consume", body), post("/consume", body), post("/consume", body)]);
  const okOnes = rs.filter((r) => r.status === 200);
  assert.equal(okOnes.length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.error])));
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.error === "already_used"), JSON.stringify(rs.map((r) => r.status)));
  assert.equal((await get("webLogin", s.sessionId)).status, "consumed");
});

test("🔒 doc ปั้นเอง (เนื้อที่ client เขียนได้ใต้ rules live) ไม่ออก token · รอบจริงที่ถูกแก้ startedBy ก็ไม่ออก", async () => {
  clockMs = T0; mintMode = "ok";
  const before = minted.length;
  const secret = crypto.randomBytes(32).toString("hex");
  const victim = u();
  const sid = C.randomSessionId();
  await E.db.collection("webLogin").doc(sid).set({ v: 1, status: "approved", startedBy: victim, secretHash: C.sha256Hex(secret), createdAt: new Date(T0), expiresAt: new Date(T0 + 60000), seal: "a".repeat(64) });
  const c = await post("/consume", { sessionId: sid, secret });
  assert.deepEqual([c.status, c.body.error, c.body.token], [403, "session_invalid", undefined]);

  const attacker = u();
  const s = await post("/start", {}, `tok-${attacker}`);
  await E.db.collection("webLogin").doc(s.body.sessionId).update({ startedBy: victim, status: "approved" });
  const c2 = await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret });
  assert.deepEqual([c2.status, c2.body.error], [403, "session_invalid"]);
  assert.equal(minted.length, before, "ไม่มีการ mint เลย");
});

test("หมดอายุด้วยนาฬิกาตรึง: 120 วิพอดีผ่าน · 120.001 วิ 410 · secret ผิดได้ 403 ก่อน 410", async () => {
  mintMode = "ok";
  clockMs = T0;
  const owner = u();
  const s = await post("/start", {}, `tok-${owner}`);
  clockMs = T0 + 120000;
  assert.equal((await post("/approve", { sessionId: s.body.sessionId }, `tok-${owner}`)).status, 200);
  clockMs = T0 + 120001;
  const c = await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret });
  assert.deepEqual([c.status, c.body.error], [410, "session_expired"]);
  const wrong = await post("/consume", { sessionId: s.body.sessionId, secret: crypto.randomBytes(32).toString("hex") });
  assert.deepEqual([wrong.status, wrong.body.error], [403, "bad_secret"]);
  assert.equal((await get("webLogin", s.body.sessionId)).status, "approved", "หมดอายุไม่เขียน");
});

test("mint ล้ม = 500 · doc ยัง approved ในฐาน · consume รอบถัดไปได้ token", async () => {
  clockMs = T0;
  const owner = u();
  const s = await startApproved(owner);
  mintMode = "fail";
  const c1 = await post("/consume", { sessionId: s.sessionId, secret: s.secret });
  assert.deepEqual([c1.status, c1.body.error], [500, "internal_error"]);
  assert.equal((await get("webLogin", s.sessionId)).status, "approved");
  mintMode = "ok";
  const c2 = await post("/consume", { sessionId: s.sessionId, secret: s.secret });
  assert.deepEqual([c2.status, c2.body.uid], [200, owner]);
  assert.equal((await get("webLogin", s.sessionId)).status, "consumed");
});

test("ด่าน: start/approve ไม่มี token 401 · consume ไม่มี token ถึง handler · บัญชีกลาง 403 · คนอื่น approve 403 · uid ใน body 400", async () => {
  clockMs = T0; mintMode = "ok";
  assert.equal((await post("/start", {})).status, 401);
  assert.equal((await post("/approve", { sessionId: "AbCdEfGhIjKlMnOpQr12" })).status, 401);
  assert.equal((await post("/consume", { sessionId: "AbCdEfGhIjKlMnOpQr12", secret: "0".repeat(64) })).status, 404);
  assert.deepEqual([(await post("/start", {}, "tok-u-shared|owner3@gmail.com")).body.error], ["shared_account"]);
  const owner = u();
  const s = await post("/start", {}, `tok-${owner}`);
  const other = await post("/approve", { sessionId: s.body.sessionId }, `tok-${u()}`);
  assert.deepEqual([other.status, other.body.error], [403, "not_session_owner"]);
  assert.equal((await get("webLogin", s.body.sessionId)).status, "pending");
  assert.equal((await post("/start", { uid: "u-victim" }, `tok-${owner}`)).status, 400);
  assert.equal((await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret, uid: "u-victim" })).status, 400);
});

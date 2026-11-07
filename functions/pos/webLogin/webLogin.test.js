// เทส web-login (DEV-0001 · owner-web-login-design.md §7.1) · ของที่ชุด case ของสัญญา webLogin.*.yaml คุมไม่ได้
//   (harness บันทึกการเขียนแต่ไม่ลงฐาน ⇒ เดินหลายขั้นต่อกันไม่ได้ · ค่าสุ่มจริง · ถัง · log · ชั้น express)
//   รัน: node --test pos/webLogin/webLogin.test.js (pre-commit รันผ่าน check-pos-tests)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");

// ── Firestore ปลอมแบบเล็ก: เขียนลงฐานของเทสจริง ⇒ ตรวจผลหลายขั้นได้ · create() ชน = โยน code 6 แบบ SDK ──
let DATA = {};
let WRITES = [];
const getColl = (c) => (DATA[c] = DATA[c] || {});
function ref(c, id) {
  const r = {
    id, path: `${c}/${id}`,
    get: async () => ({ exists: getColl(c)[id] !== undefined, id, data: () => getColl(c)[id] }),
    create: async (v) => {
      if (getColl(c)[id] !== undefined) { const e = new Error("6 ALREADY_EXISTS: Document already exists"); e.code = 6; throw e; }
      WRITES.push({ op: "create", path: r.path }); getColl(c)[id] = v;
    },
    update: async (v) => { WRITES.push({ op: "update", path: r.path, data: v }); getColl(c)[id] = { ...(getColl(c)[id] || {}), ...v }; },
  };
  return r;
}
const fakeDb = {
  collection: (c) => ({ doc: (id) => ref(c, id) }),
  runTransaction: async (fn) => {
    const queued = [];
    const tx = { get: (r) => r.get(), update: (r, v) => { queued.push(() => r.update(v)); return tx; } };
    const out = await fn(tx);
    for (const q of queued) await q();
    return out;
  },
};
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {} } };

const W = require("./webLogin");
const C = require("./core");
const { SHARED_EMAILS, isSharedEmail } = require("./sharedAccounts");
const { makeRateLimiter, clientIp } = require("../_shared/rateLimit");

// กุญแจทดสอบ (ไม่ใช่กุญแจจริง) · base64 ของ 32 ไบต์ 0x07
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const NOW0 = Date.parse("2026-11-10T03:00:00.000Z");
let clockMs = NOW0;
const LOG = [];
const deps = (over) => ({ now: () => new Date(clockMs), sealKey: TEST_KEY, mint: async (uid) => `token-for-${uid}`, log: (l) => LOG.push(l), ...(over || {}) });
const reset = () => { DATA = {}; WRITES = []; clockMs = NOW0; LOG.length = 0; };

function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(handler, req) {
  const r = res();
  await handler({ headers: {}, ...req }, r);
  return r;
}
const owner = { auth: { uid: "u-owner", email: "real@shop.test" } };

// ── ตัวช่วย pure ─────────────────────────────────────────────────────────────
test("randomSessionId: 20 ตัว [A-Za-z0-9] · ทิ้งไบต์ ≥ 248 (ไม่เอียง)", () => {
  for (let i = 0; i < 200; i++) assert.match(C.randomSessionId(), /^[A-Za-z0-9]{20}$/);
  assert.equal(C.SID_CUTOFF, 248);
  // ไบต์ 248-255 ทั้งหมดต้องถูกทิ้ง: ป้อนชุดที่มีแต่ 255 สลับกับ 0 → ได้ 'A' ล้วน (0 % 62 = 0)
  let n = 0;
  const fake = () => { n++; return Buffer.from(Array.from({ length: 32 }, (_, i) => (i % 2 ? 0 : 255))); };
  assert.equal(C.randomSessionId(fake), "A".repeat(20));
  assert.equal(n, 2, "16 ตัวใช้ได้ต่อชุด 32 ไบต์ ⇒ ต้องขอ 2 ชุด");
  // ไบต์ 247 = ตัวสุดท้ายที่ยังรับ (247 % 62 = 61 = '9')
  assert.equal(C.randomSessionId(() => Buffer.alloc(32, 247)), "9".repeat(20));
  // การกระจาย: นับตัวอักษรจาก 2,000 รอบ ทุกตัวต้องโผล่ (ไม่มีตัวที่หายเพราะ modulo ผิด)
  const seen = new Set();
  for (let i = 0; i < 2000; i++) for (const ch of C.randomSessionId()) seen.add(ch);
  assert.equal(seen.size, 62);
});

test("secretMatches: ตรง = true · ผิด/รูปเพี้ยนไม่โยน = false", () => {
  const s = C.newSecret();
  assert.match(s, /^[0-9a-f]{64}$/);
  const h = C.sha256Hex(s);
  assert.equal(C.secretMatches(s, h), true);
  assert.equal(C.secretMatches(C.newSecret(), h), false);
  for (const bad of [undefined, null, 42, "", s.toUpperCase(), s.slice(1), { s }]) {
    assert.equal(C.secretMatches(bad, h), false, String(bad));
    assert.equal(C.secretMatches(s, bad), false, String(bad));
  }
});

test("readSealKey: HKDF จากกุญแจฐาน · ไม่มี/ผิดรูป = error · กุญแจผนึก ≠ กุญแจฐาน", () => {
  const k = C.readSealKey({ sealKey: TEST_KEY });
  assert.equal(k.key.length, 32);
  assert.ok(!k.key.equals(Buffer.alloc(32, 7)), "ต้องไม่ใช้กุญแจฐานตรง ๆ");
  const want = Buffer.from(crypto.hkdfSync("sha256", Buffer.alloc(32, 7), Buffer.alloc(0), "shopchamp-weblogin-seal-v1", 32));
  assert.ok(k.key.equals(want));
  assert.ok(C.readSealKey({ env: { GATEWAY_CRED_ENC_KEY: TEST_KEY } }).key.equals(want), "อ่านจาก env ได้");
  assert.equal(C.readSealKey({ env: {} }).error.code, "gateway_cred_key_missing");
  assert.equal(C.readSealKey({ sealKey: Buffer.alloc(16).toString("base64") }).error.code, "gateway_cred_key_invalid");
  assert.equal(C.readSealKey({ sealKey: "not base64!" }).error.code, "gateway_cred_key_invalid");
});

test("sealOf/sealMatches: แก้ field ใดในผนึกก็ไม่ตรง · ย้ายข้าม doc ไม่ได้ · กุญแจอื่นไม่ตรง", () => {
  const { key } = C.readSealKey({ sealKey: TEST_KEY });
  const sid = "AbCdEfGhIjKlMnOpQr12";
  const exp = new Date(NOW0 + C.TTL_MS);
  const base = { startedBy: "u-owner", secretHash: C.sha256Hex("x"), expiresAt: exp };
  const doc = { ...base, seal: C.sealOf(key, { sessionId: sid, ...base, expiresAtMs: exp.getTime() }) };
  assert.equal(C.sealMatches(key, sid, doc), true);
  assert.equal(C.sealMatches(key, sid, { ...doc, expiresAt: { toMillis: () => exp.getTime() } }), true, "Timestamp ก็ได้");
  assert.equal(C.sealMatches(key, "ZzZzZzZzZzZzZzZzZzZz", doc), false, "ย้ายข้าม doc");
  assert.equal(C.sealMatches(key, sid, { ...doc, startedBy: "u-victim" }), false, "startedBy");
  assert.equal(C.sealMatches(key, sid, { ...doc, secretHash: C.sha256Hex("y") }), false, "secretHash");
  assert.equal(C.sealMatches(key, sid, { ...doc, expiresAt: new Date(exp.getTime() + 1) }), false, "expiresAt");
  assert.equal(C.sealMatches(key, sid, { ...doc, expiresAt: undefined }), false, "ไม่มี expiresAt");
  assert.equal(C.sealMatches(key, sid, { ...doc, seal: undefined }), false, "ไม่มีผนึก");
  assert.equal(C.sealMatches(key, sid, { ...doc, seal: "zz" }), false, "ผนึกรูปผิดไม่โยน");
  assert.equal(C.sealMatches(C.readSealKey({ sealKey: Buffer.alloc(32, 8).toString("base64") }).key, sid, doc), false, "กุญแจอื่น");
  assert.equal(C.sealMatches(key, sid, { ...doc, status: "approved" }), true, "status ไม่อยู่ในผนึก (ความเสี่ยงที่เขียนไว้ §2.4)");
});

test("isExpired: ขอบพอดีผ่าน · เกิน 1 ms ไม่ผ่าน · ไม่มีค่า = หมด", () => {
  assert.equal(C.isExpired(100, 100), false);
  assert.equal(C.isExpired(101, 100), true);
  assert.equal(C.isExpired(100, null), true);
  assert.equal(C.isExpired(100, NaN), true);
  assert.equal(C.msOf(1234), null, "ตัวเลขดิบไม่นับเป็นเวลา");
  assert.equal(C.msOf("2026-11-10"), null);
});

test("sharedAccounts: 11 บัญชี (anonymoususer + owner..owner10) · เทียบตัวเล็ก/ตัดช่องว่าง", () => {
  assert.equal(SHARED_EMAILS.length, 11);
  assert.ok(isSharedEmail(" Owner3@Gmail.com "));
  assert.ok(isSharedEmail("anonymoususer@gmail.com"));
  assert.ok(isSharedEmail("owner10@gmail.com"));
  assert.equal(isSharedEmail("owner11@gmail.com"), false);
  assert.equal(isSharedEmail("real@shop.test"), false);
  assert.equal(isSharedEmail(null), false);
});

// ── เดินครบวง ────────────────────────────────────────────────────────────────
test("ครบวง: start → consume (pending) → approve → consume (token ของ startedBy) → consume ซ้ำ 409", async () => {
  reset();
  const d = deps();
  const s = await call(W.start(d), { ...owner, body: {}, headers: { "user-agent": "RN-App/5.00.00 " + "x".repeat(200) } });
  assert.equal(s.code, 200, JSON.stringify(s.body));
  const { sessionId, secret, expiresAt } = s.body;
  assert.match(sessionId, /^[A-Za-z0-9]{20}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(expiresAt, NOW0 + 120000);
  const doc = DATA.webLogin[sessionId];
  assert.equal(doc.status, "pending");
  assert.equal(doc.startedBy, "u-owner");
  assert.equal(doc.secretHash, C.sha256Hex(secret));
  assert.equal(doc.v, 1);
  assert.equal(doc.startUa.length, 120);
  assert.ok(!JSON.stringify(doc).includes(secret), "ไม่เก็บ secret ดิบ");
  assert.deepEqual(WRITES.map((w) => w.op), ["create"]);

  const web = { headers: { "user-agent": "WebView", "x-forwarded-for": "203.0.113.9, 10.0.0.1" } };
  const p = await call(W.consume(d), { ...web, body: { sessionId, secret } });
  assert.deepEqual([p.code, p.body.status], [200, "pending"]);
  assert.equal(p.body.token, undefined);
  assert.equal(WRITES.length, 1, "pending ไม่เขียน");

  const a = await call(W.approve(d), { ...owner, body: { sessionId } });
  assert.deepEqual([a.code, a.body], [200, { ok: true }]);
  assert.equal(DATA.webLogin[sessionId].status, "approved");

  const c = await call(W.consume(d), { ...web, body: { sessionId, secret } });
  assert.deepEqual([c.code, c.body.status, c.body.token, c.body.uid], [200, "approved", "token-for-u-owner", "u-owner"]);
  assert.equal(DATA.webLogin[sessionId].status, "consumed");
  assert.equal(DATA.webLogin[sessionId].consumeUa, "WebView");

  const again = await call(W.consume(d), { ...web, body: { sessionId, secret } });
  assert.deepEqual([again.code, again.body.error], [409, "already_used"]);
  const reApprove = await call(W.approve(d), { ...owner, body: { sessionId } });
  assert.deepEqual([reApprove.code, reApprove.body.error], [409, "already_used"]);

  // audit: ทุกเหตุการณ์ 1 บรรทัด · ไม่มี secret / token / อีเมล
  const all = JSON.stringify(LOG);
  assert.ok(!all.includes(secret) && !all.includes("token-for") && !all.includes("real@shop.test"), all);
  assert.deepEqual(LOG.map((l) => `${l.event}:${l.result}`), ["start:ok", "consume:pending", "approve:ok", "consume:ok", "consume:already_used", "approve:already_used"]);
  assert.ok(LOG.every((l) => l.message === "weblogin" && l.sid6 === sessionId.slice(0, 6)));
  assert.equal(LOG[3].uid6, "u-owne");
});

test("mint ล้ม = 500 · doc ยัง approved · ลองใหม่ได้ · ไม่ log ข้อความของ mint", async () => {
  reset();
  let fail = true;
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const d = deps({ mint: async (uid) => { if (fail) throw Object.assign(new Error("Permission iam.serviceAccounts.signBlob denied SECRETISH"), { code: "auth/insufficient-permission" }); return `token-for-${uid}`; } });
    const s = await call(W.start(d), { ...owner, body: {} });
    await call(W.approve(d), { ...owner, body: { sessionId: s.body.sessionId } });
    const c1 = await call(W.consume(d), { body: { sessionId: s.body.sessionId, secret: s.body.secret } });
    assert.deepEqual([c1.code, c1.body.error], [500, "internal_error"]);
    assert.equal(DATA.webLogin[s.body.sessionId].status, "approved");
    assert.ok(!errs.join("\n").includes("SECRETISH"), errs.join("\n"));
    assert.equal(LOG.at(-1).result, "mint_failed");
    fail = false;
    const c2 = await call(W.consume(d), { body: { sessionId: s.body.sessionId, secret: s.body.secret } });
    assert.deepEqual([c2.code, c2.body.uid], [200, "u-owner"]);
  } finally { console.error = orig; }
});

test("🔒 doc ที่ client ปั้นเอง (rules live เปิด) ไม่ออก token · secret ของตัวเองก็ไม่ช่วย", async () => {
  reset();
  const d = deps();
  let minted = 0;
  const d2 = { ...d, mint: async (u) => { minted++; return `t-${u}`; } };
  const secret = C.newSecret();
  const sid = "EvilEvilEvilEvilEvil";
  DATA.webLogin = { [sid]: { v: 1, status: "approved", startedBy: "u-victim", secretHash: C.sha256Hex(secret), expiresAt: new Date(NOW0 + 60000), seal: "a".repeat(64) } };
  const c = await call(W.consume(d2), { body: { sessionId: sid, secret } });
  assert.deepEqual([c.code, c.body.error], [403, "session_invalid"]);
  assert.equal(minted, 0);
  // ผนึกจริงของรอบตัวเอง แต่แก้ startedBy เป็นเหยื่อ
  const s = await call(W.start(d), { auth: { uid: "u-attacker" }, body: {} });
  DATA.webLogin[s.body.sessionId] = { ...DATA.webLogin[s.body.sessionId], startedBy: "u-victim", status: "approved" };
  const c2 = await call(W.consume(d2), { body: { sessionId: s.body.sessionId, secret: s.body.secret } });
  assert.deepEqual([c2.code, c2.body.error], [403, "session_invalid"]);
  assert.equal(minted, 0);
  // ย้ายผนึกจริงไปวางใน doc id อื่น
  DATA.webLogin.MovedMovedMovedMoved = { ...DATA.webLogin[s.body.sessionId], startedBy: "u-attacker" };
  const c3 = await call(W.consume(d2), { body: { sessionId: "MovedMovedMovedMoved", secret: s.body.secret } });
  assert.deepEqual([c3.code, c3.body.error], [403, "session_invalid"]);
  assert.equal(minted, 0);
});

test("approve: คนอื่นมา approve รอบของเรา = 403 not_session_owner ไม่เขียน · บัญชีกลาง 403", async () => {
  reset();
  const d = deps();
  const s = await call(W.start(d), { ...owner, body: {} });
  WRITES = [];
  const a = await call(W.approve(d), { auth: { uid: "u-other" }, body: { sessionId: s.body.sessionId } });
  assert.deepEqual([a.code, a.body.error], [403, "not_session_owner"]);
  const sh = await call(W.approve(d), { auth: { uid: "u-owner", email: "owner3@gmail.com" }, body: { sessionId: s.body.sessionId } });
  assert.deepEqual([sh.code, sh.body.error], [403, "shared_account"]);
  assert.equal(WRITES.length, 0);
});

test("หมดอายุ: ขอบ 120 วิพอดียังใช้ได้ · 120.001 วิ 410 · consume หมดอายุแต่ secret ผิด = 403 ก่อน", async () => {
  reset();
  const d = deps();
  const s = await call(W.start(d), { ...owner, body: {} });
  clockMs = NOW0 + 120000;
  assert.equal((await call(W.approve(d), { ...owner, body: { sessionId: s.body.sessionId } })).code, 200);
  clockMs = NOW0 + 120001;
  const c = await call(W.consume(d), { body: { sessionId: s.body.sessionId, secret: s.body.secret } });
  assert.deepEqual([c.code, c.body.error], [410, "session_expired"]);
  const wrong = await call(W.consume(d), { body: { sessionId: s.body.sessionId, secret: C.newSecret() } });
  assert.deepEqual([wrong.code, wrong.body.error], [403, "bad_secret"]);
});

test("ไม่มีกุญแจผนึก = 503 ทั้ง 3 เส้น · start ไม่เขียน", async () => {
  reset();
  const d = deps({ sealKey: undefined, env: {} });
  const s = await call(W.start(d), { ...owner, body: {} });
  assert.deepEqual([s.code, s.body.error], [503, "weblogin_not_configured"]);
  assert.equal((await call(W.approve(d), { ...owner, body: { sessionId: "AbCdEfGhIjKlMnOpQr12" } })).code, 503);
  assert.equal((await call(W.consume(d), { body: { sessionId: "AbCdEfGhIjKlMnOpQr12", secret: C.newSecret() } })).code, 503);
  assert.equal(WRITES.length, 0);
});

test("start: sessionId ชน = ลองใหม่ 1 ครั้ง · ชนซ้ำ = 500 · ตัวสุ่มคืนรูปผิด = 500 ไม่เขียน", async () => {
  reset();
  const seq = [{ sessionId: "AbCdEfGhIjKlMnOpQr12", secret: "a".repeat(64) }, { sessionId: "AbCdEfGhIjKlMnOpQr12", secret: "b".repeat(64) }, { sessionId: "NewNewNewNewNewNewNe", secret: "c".repeat(64) }];
  let i = 0;
  const d = deps({ newSession: () => seq[i++] });
  const first = await call(W.start(d), { ...owner, body: {} });
  assert.equal(first.body.sessionId, "AbCdEfGhIjKlMnOpQr12");
  const second = await call(W.start(d), { ...owner, body: {} });
  assert.deepEqual([second.code, second.body.sessionId, second.body.secret], [200, "NewNewNewNewNewNewNe", "c".repeat(64)]);
  const same = deps({ newSession: () => ({ sessionId: "AbCdEfGhIjKlMnOpQr12", secret: "d".repeat(64) }) });
  assert.equal((await call(W.start(same), { ...owner, body: {} })).code, 500);
  WRITES = [];
  const badGen = deps({ newSession: () => ({ sessionId: "short", secret: "x" }) });
  assert.equal((await call(W.start(badGen), { ...owner, body: {} })).code, 500);
  assert.equal(WRITES.length, 0);
});

test("ถัง: start 20 ครั้ง/10 นาที/uid → ครั้งที่ 21 = 429 · uid อื่นไม่โดน · ครบหน้าต่างแล้วได้อีก", async () => {
  reset();
  const h = W.start(deps());
  for (let i = 0; i < 20; i++) assert.equal((await call(h, { ...owner, body: {} })).code, 200, `ครั้งที่ ${i + 1}`);
  const r = await call(h, { ...owner, body: {} });
  assert.deepEqual([r.code, r.body.error], [429, "rate_limited"]);
  assert.equal((await call(h, { auth: { uid: "u-two" }, body: {} })).code, 200);
  clockMs = NOW0 + 10 * 60 * 1000;
  assert.equal((await call(h, { ...owner, body: {} })).code, 200);
});

test("ถัง: consume 30 ครั้ง/นาที/IP (x-forwarded-for ตัวแรก) → 31 = 429 ก่อนอ่านฐาน · IP อื่นไม่โดน", async () => {
  reset();
  const h = W.consume(deps());
  const body = { sessionId: "NotThereNotThereNotT", secret: C.newSecret() };
  const ip = (v) => ({ headers: { "x-forwarded-for": v }, body });
  for (let i = 0; i < 30; i++) assert.equal((await call(h, ip("198.51.100.7, 10.1.1.1"))).code, 404);
  const r = await call(h, ip("198.51.100.7"));
  assert.deepEqual([r.code, r.body.error], [429, "rate_limited"]);
  assert.equal((await call(h, ip("198.51.100.8"))).code, 404);
  // 400 ไม่กินถัง
  const h2 = W.consume(deps({ limits: { consume: { max: 1 } } }));
  assert.equal((await call(h2, { headers: { "x-forwarded-for": "1.1.1.1" }, body: {} })).code, 400);
  assert.equal((await call(h2, ip("1.1.1.1"))).code, 404);
  assert.equal((await call(h2, ip("1.1.1.1"))).code, 429);
});

test("rateLimit: หน้าต่างเลื่อน · ปัดแล้วไม่ต่อโทษ · คีย์เกินเพดานถูกล้าง · max 0 ปัดทุกครั้ง", () => {
  const L = makeRateLimiter({ max: 2, windowMs: 1000 });
  assert.equal(L.hit("a", 0).ok, true);
  assert.equal(L.hit("a", 500).ok, true);
  const no = L.hit("a", 600);
  assert.deepEqual([no.ok, no.retryAfterMs], [false, 400]);
  assert.equal(L.hit("a", 999).ok, false);
  assert.equal(L.hit("a", 1000).ok, true, "ตัวแรกหลุดหน้าต่าง");
  assert.equal(L.hit("", 0).ok, true, "คีย์ว่างรวมถัง ?");
  assert.equal(L.hit(undefined, 0).ok, true);
  assert.equal(L.hit(null, 0).ok, false, "ถัง ? เต็ม ไม่ปล่อยผ่าน");
  const S = makeRateLimiter({ max: 1, windowMs: 1000, maxKeys: 3 });
  for (const k of ["a", "b", "c"]) S.hit(k, 0);
  S.hit("d", 2000);
  assert.equal(S.size(), 1, "คีย์หมดหน้าต่างถูกล้าง");
  for (const k of ["e", "f", "g", "h"]) S.hit(k, 2000);
  assert.ok(S.size() <= 3, "ไม่เกินเพดานคีย์");
  assert.equal(makeRateLimiter({ max: 0, windowMs: 10 }).hit("a", 0).ok, false);
  assert.throws(() => makeRateLimiter({ max: -1, windowMs: 10 }));
  assert.throws(() => makeRateLimiter({ max: 1, windowMs: 0 }));
  assert.equal(clientIp({ headers: { "x-forwarded-for": " 203.0.113.1 , 10.0.0.1" } }), "203.0.113.1");
  assert.equal(clientIp({ headers: {}, ip: "::1" }), "::1");
  assert.equal(clientIp({}), "");
});

test("ไม่ log secret: บรรทัด audit ตั้งต้นเป็น JSON บรรทัดเดียว message weblogin", async () => {
  reset();
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  let s;
  try {
    s = await call(W.start(deps({ log: undefined })), { ...owner, body: {} });
  } finally { console.log = orig; }
  assert.equal(out.length, 1);
  const line = JSON.parse(out[0]);
  assert.deepEqual(line, { severity: "INFO", message: "weblogin", event: "start", result: "ok", uid6: "u-owne", sid6: s.body.sessionId.slice(0, 6) });
  assert.ok(!out[0].includes(s.body.secret));
});

// ── ชั้น express (ของจริง: app.js + ด่านตัวตน) ────────────────────────────────
test("express: consume ไม่มี token ไม่ได้ 401 (public) · start/approve ไม่มี token = 401 · body มี auth ถูกลบ", async () => {
  const { makeApp } = require("../app");
  const { makeCheckIfAuthenticated } = require("../_shared/auth");
  const authn = makeCheckIfAuthenticated({ verifyIdToken: async (t) => { if (!/^tok-/.test(t)) throw new Error("bad"); return { uid: t.slice(4) }; }, log: () => {} });
  reset();
  const app = makeApp({ fnName: "pos", deps: deps(), checkIfAuthenticated: authn });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/web-login`;
  const post = async (p, body, tok) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.deepEqual((await post("/consume", {})).status, 400, "ไม่มี token ถึง handler (400 ไม่ใช่ 401)");
    assert.equal((await post("/consume", { sessionId: "NotThereNotThereNotT", secret: C.newSecret() })).status, 404);
    assert.deepEqual([(await post("/start", {})).status, (await post("/approve", { sessionId: "NotThereNotThereNotT" })).status], [401, 401]);
    // auth ใน body ถูก scrub ⇒ handler ไม่เห็น · consume ยังต้องมี body ตรง schema (auth = field เกิน แต่ถูกลบก่อน)
    const s = await post("/start", { auth: { uid: "u-victim" } }, "tok-u-owner");
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(DATA.webLogin[s.body.sessionId].startedBy, "u-owner", "ตัวตนจาก token ไม่ใช่ body");
    assert.equal((await post("/start", { uid: "u-victim" }, "tok-u-owner")).status, 400, "uid ใน body = 400");
    assert.equal((await post("/approve", { sessionId: s.body.sessionId }, "tok-u-owner")).status, 200);
    const c = await post("/consume", { sessionId: s.body.sessionId, secret: s.body.secret, auth: { uid: "u-victim" } });
    assert.deepEqual([c.status, c.body.uid], [200, "u-owner"]);
  } finally { await new Promise((r) => srv.close(r)); }
});

// ── §11 ข้อ 12: log deny ของ requireShopAccess ติด uid6 + shared ─────────────────
test("requireShopAccess deny: log มี uid6 และ shared:true สำหรับบัญชีกลาง · ไม่มีอีเมล/uid เต็ม", async () => {
  const { makeRequireShopAccess } = require("../_shared/auth");
  const shopDb = {
    collection: (c) => ({
      doc: (id) => ({ get: async () => (c === "shop" && id === "shopA" ? { exists: true, data: () => ({ shopId: "u-realowner", humanResource: [{ id: "u-realowner", position: ["001"], status: "active" }] }) } : { exists: false, data: () => undefined }) }),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true, size: 0 }) }) }),
    }),
  };
  const logs = [];
  const mw = makeRequireShopAccess({ db: shopDb, now: () => new Date(NOW0), log: (...a) => logs.push(a.join(" ")) });
  for (const auth of [{ uid: "anonUid1234567", email: "anonymoususer@gmail.com" }, { uid: "strangerUid999", email: "x@y.test" }]) {
    const r = res();
    let nexted = false;
    await mw({ body: { shopId: "shopA" }, auth }, r, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(r.code, 403);
  }
  assert.equal(logs.length, 2, logs.join("\n"));
  assert.match(logs[0], /^pos shopAccess deny shopA .* uid6=anonUi shared=true$/);
  assert.match(logs[1], /uid6=strang shared=false$/);
  assert.ok(!logs.join(" ").includes("anonymoususer@") && !logs.join(" ").includes("anonUid1234567"));
});

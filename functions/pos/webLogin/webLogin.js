// pos/webLogin/webLogin — ปุ่มรายงานเปิดเว็บเจ้าของร้านในแอป · ลิงก์ login ใช้ครั้งเดียว (DEV-0001)
//
// แบบ: lanes/dev/source/owner-web-login-design.md §2 · สัญญากลาง §8 · สัญญา shopchamp-center/api/webLogin.{start,approve,consume}.yaml
// คำขอ: WebLoginStartRequest · WebLoginApproveRequest · WebLoginConsumeRequest (@shopchamp/schema 0.1.15 · strict ⇒ uid ใน body = 400)
// route: start / approve = auth 'user' (ID token ของแอป) · consume = auth 'public' (เว็บยังไม่มีตัวตนตอนแลก · ยาม = secret + ผนึก + อายุ + ถัง IP)
//
// ลำดับตรวจตายตัว (§2.3):
//   start   ① ไม่มี req.auth.uid 401 no_auth ② schema 400 ③ บัญชีกลาง 403 shared_account ④ ถัง uid 429 rate_limited
//           ⑤ กุญแจผนึก 503 weblogin_not_configured ⑥ create() doc pending → 200 {sessionId, secret, expiresAt:<ms>}
//   approve ① 401 ② 400 ③ 403 shared_account ④ 503 ⑤ tx: ไม่มี doc 404 session_not_found · expiresAt อ่านไม่ออก 410
//           · ผนึกไม่ตรง 403 session_invalid · startedBy ≠ คนเรียก 403 not_session_owner · หมดอายุ 410 session_expired
//           · status ≠ pending 409 already_used · update {status:'approved', approvedAt} → 200
//   consume ① 400 ② ถัง IP 429 ③ 503 ④ tx: ไม่มี doc 404 · secret ผิด 403 bad_secret (ก่อนเผยอะไรอื่น รวมอายุ)
//           · expiresAt อ่านไม่ออก 410 · ผนึกไม่ตรง 403 session_invalid · หมดอายุ 410 · pending → 200 {status:'pending'} ไม่เขียน
//           · status ≠ approved 409 already_used · mint(startedBy) ใน tx ก่อน update → update {status:'consumed', consumedAt, consumeUa}
//           → 200 {status:'approved', token, uid} · mint ล้ม = 500 internal_error และ doc ยัง approved (tx ไม่ commit)
//   ⚠️ expiresAt อ่านไม่ออกตัดสินก่อนผนึก: ผนึกครอบ expiresAt ⇒ ไม่มีค่าก็ตรวจผนึกไม่ได้ · ตอบ 410 (fail-closed · ไม่มีใครได้ token ทั้ง 2 ทาง)
// 🔒 uid ที่ออก token = startedBy ที่ผนึกไว้เท่านั้น · custom token ไม่มี claims
// 🔒 secret / token ❌ log ❌ เก็บ (doc เก็บ sha256) · audit = Cloud Logging 1 บรรทัด/เหตุการณ์ (§2.7) {event, result, uid6, sid6}
//
// deps (factory): now · mint(uid) → token · sealKey (base64 · harness/เทส) · env · newSession() → {sessionId, secret} (harness ตรึงค่า)
//   · log(line) (เทสเก็บบรรทัด audit) · limits {start:{max,windowMs}, consume:{max,windowMs}} (เทส)
//   ถังสร้างต่อการเรียก factory = ต่อ app = ต่อ instance (§2.6)
"use strict";

const { db } = require("../../firebase");
const { WebLoginStartRequest, WebLoginApproveRequest, WebLoginConsumeRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { makeRateLimiter, clientIp } = require("../_shared/rateLimit");
const { isSharedEmail } = require("./sharedAccounts");
const C = require("./core");

const LIMITS = Object.freeze({
  start: Object.freeze({ max: 20, windowMs: 10 * 60 * 1000 }),
  consume: Object.freeze({ max: 30, windowMs: 60 * 1000 }),
});

const MSG = Object.freeze({
  shared_account: "บัญชีนี้เปิดรายงานอัตโนมัติไม่ได้ กรุณาเข้าสู่ระบบด้วยบัญชีของร้าน",
  rate_limited: "ขอเข้าเว็บถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
  weblogin_not_configured: "ระบบเข้าเว็บอัตโนมัติยังไม่พร้อม",
  session_not_found: "ไม่พบรอบเข้าเว็บนี้ กรุณาเปิดใหม่จากแอป",
  session_invalid: "รอบเข้าเว็บนี้ไม่ถูกต้อง กรุณาเปิดใหม่จากแอป",
  not_session_owner: "รอบเข้าเว็บนี้เป็นของบัญชีอื่น",
  session_expired: "รอบเข้าเว็บหมดอายุแล้ว กรุณาเปิดใหม่จากแอป",
  already_used: "รอบเข้าเว็บนี้ถูกใช้ไปแล้ว กรุณาเปิดใหม่จากแอป",
  bad_secret: "ลิงก์เข้าเว็บไม่ถูกต้อง",
});

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (status, code) => { throw new Refusal(deny(status, code, MSG[code])); };

const uidOf = (req) => (req && req.auth && typeof req.auth.uid === "string" && req.auth.uid !== "" ? req.auth.uid : "");
const emailOf = (req) => (req && req.auth && typeof req.auth.email === "string" ? req.auth.email : null);

/** บรรทัด audit · Cloud Run อ่าน JSON บรรทัดเดียวเป็น jsonPayload (message "weblogin") · ❌ ไม่มี secret/token/อีเมล */
function auditOf(deps) {
  const custom = deps && typeof deps.log === "function" ? deps.log : null;
  return function audit(event, result, uid, sessionId) {
    const line = { message: "weblogin", event, result, uid6: C.short6(uid), sid6: C.short6(sessionId) };
    try {
      if (custom) custom(line);
      else console.log(JSON.stringify({ severity: result === "ok" || result === "pending" ? "INFO" : "WARNING", ...line }));
    } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
  };
}

function limiterOf(deps, name) {
  const over = deps && deps.limits && typeof deps.limits === "object" ? deps.limits[name] : undefined;
  return makeRateLimiter(over && typeof over === "object" ? { ...LIMITS[name], ...over } : LIMITS[name]);
}

const defaultMint = (uid) => require("../../firebase").admin.auth().createCustomToken(uid);

/** ส่ง deny + audit · คืนผลของ sendDeny */
function denyWith(res, audit, event, d, uid, sid) {
  audit(event, d.error, uid, sid);
  return sendDeny(res, d);
}

// ── start ────────────────────────────────────────────────────────────────────
function start(deps) {
  const limiter = limiterOf(deps, "start");
  const audit = auditOf(deps);
  return async function handler(req, res) {
    const uid = uidOf(req);
    try {
      if (!uid) { audit("start", "no_auth", "", ""); return fail(res, 401, "no_auth"); }
      const input = parseOr400(WebLoginStartRequest, req.body, res);
      if (!input) { audit("start", "invalid_request", uid, ""); return undefined; }
      if (isSharedEmail(emailOf(req))) return denyWith(res, audit, "start", deny(403, "shared_account", MSG.shared_account), uid, "");
      const now = await readNow(deps);
      if (!limiter.hit(uid, now.getTime()).ok) return denyWith(res, audit, "start", deny(429, "rate_limited", MSG.rate_limited), uid, "");
      const k = C.readSealKey(deps);
      if (k.error) return denyWith(res, audit, "start", deny(503, "weblogin_not_configured", MSG.weblogin_not_configured), uid, "");

      const gen = depOr(deps, "newSession", () => ({ sessionId: C.randomSessionId(), secret: C.newSecret() }));
      const expiresAt = new Date(now.getTime() + C.TTL_MS);
      const ua = C.uaOf(req);
      let made = null;
      // sessionId ชนกัน (62^20) แทบเป็นไปไม่ได้ · create() ชน = ลองใหม่ 1 ครั้ง แล้วยอมแพ้เป็น 500
      for (let attempt = 0; attempt < 2 && !made; attempt++) {
        const g = gen() || {};
        if (!C.SID_RE.test(String(g.sessionId)) || !C.HEX64_RE.test(String(g.secret))) throw new Error("webLogin: ตัวสุ่มรอบคืนรูปผิด");
        const secretHash = C.sha256Hex(g.secret);
        const doc = {
          v: 1,
          secretHash,
          startedBy: uid,
          status: "pending",
          createdAt: now,
          expiresAt,
          seal: C.sealOf(k.key, { sessionId: g.sessionId, startedBy: uid, secretHash, expiresAtMs: expiresAt.getTime() }),
        };
        if (ua) doc.startUa = ua;
        try {
          await db.collection(C.COLLECTION).doc(g.sessionId).create(doc);
          made = g;
        } catch (e) {
          const exists = e && (e.code === 6 || e.code === "already-exists" || /ALREADY_EXISTS/.test(String(e.message)));
          if (!exists || attempt === 1) throw e;
        }
      }
      audit("start", "ok", uid, made.sessionId);
      return ok(res, { sessionId: made.sessionId, secret: made.secret, expiresAt: expiresAt.getTime() });
    } catch (e) {
      audit("start", "internal_error", uid, "");
      return internalError(res, e);
    }
  };
}

// ── approve ──────────────────────────────────────────────────────────────────
function approve(deps) {
  const audit = auditOf(deps);
  return async function handler(req, res) {
    const uid = uidOf(req);
    let sid = "";
    try {
      if (!uid) { audit("approve", "no_auth", "", ""); return fail(res, 401, "no_auth"); }
      const input = parseOr400(WebLoginApproveRequest, req.body, res);
      if (!input) { audit("approve", "invalid_request", uid, ""); return undefined; }
      sid = input.sessionId;
      if (isSharedEmail(emailOf(req))) return denyWith(res, audit, "approve", deny(403, "shared_account", MSG.shared_account), uid, sid);
      const k = C.readSealKey(deps);
      if (k.error) return denyWith(res, audit, "approve", deny(503, "weblogin_not_configured", MSG.weblogin_not_configured), uid, sid);
      const now = await readNow(deps);
      const ref = db.collection(C.COLLECTION).doc(sid);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) refuse(404, "session_not_found");
        const d = snap.data() || {};
        const expMs = C.msOf(d.expiresAt);
        if (expMs === null) refuse(410, "session_expired");
        if (!C.sealMatches(k.key, sid, d)) refuse(403, "session_invalid");
        if (d.startedBy !== uid) refuse(403, "not_session_owner");
        if (C.isExpired(now.getTime(), expMs)) refuse(410, "session_expired");
        if (d.status !== "pending") refuse(409, "already_used");
        tx.update(ref, { status: "approved", approvedAt: now });
      });
      audit("approve", "ok", uid, sid);
      return ok(res, {});
    } catch (e) {
      if (e instanceof Refusal) return denyWith(res, audit, "approve", e.deny, uid, sid);
      audit("approve", "internal_error", uid, sid);
      return internalError(res, e);
    }
  };
}

// ── consume (public) ─────────────────────────────────────────────────────────
class MintFailed extends Error {}

function consume(deps) {
  const limiter = limiterOf(deps, "consume");
  const audit = auditOf(deps);
  const mint = depOr(deps, "mint", defaultMint);
  return async function handler(req, res) {
    let sid = "";
    let owner = "";
    try {
      const input = parseOr400(WebLoginConsumeRequest, req.body, res);
      if (!input) { audit("consume", "invalid_request", "", ""); return undefined; }
      sid = input.sessionId;
      const now = await readNow(deps);
      if (!limiter.hit(clientIp(req), now.getTime()).ok) return denyWith(res, audit, "consume", deny(429, "rate_limited", MSG.rate_limited), "", sid);
      const k = C.readSealKey(deps);
      if (k.error) return denyWith(res, audit, "consume", deny(503, "weblogin_not_configured", MSG.weblogin_not_configured), "", sid);
      const ref = db.collection(C.COLLECTION).doc(sid);
      const ua = C.uaOf(req);

      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) refuse(404, "session_not_found");
        const d = snap.data() || {};
        // secret ก่อนทุกอย่าง: คนไม่มี secret ไม่ได้รู้แม้แต่ว่ารอบหมดอายุหรือใช้ไปแล้ว
        if (!C.secretMatches(input.secret, d.secretHash)) refuse(403, "bad_secret");
        const expMs = C.msOf(d.expiresAt);
        if (expMs === null) refuse(410, "session_expired");
        if (!C.sealMatches(k.key, sid, d)) refuse(403, "session_invalid");
        owner = d.startedBy;
        if (C.isExpired(now.getTime(), expMs)) refuse(410, "session_expired");
        if (d.status === "pending") return { pending: true };
        if (d.status !== "approved") refuse(409, "already_used");
        let token;
        try {
          token = await mint(d.startedBy);
        } catch (e) {
          throw new MintFailed(e && e.code ? String(e.code) : "mint_failed");
        }
        if (typeof token !== "string" || token === "") throw new MintFailed("mint_empty");
        const upd = { status: "consumed", consumedAt: now };
        if (ua) upd.consumeUa = ua;
        tx.update(ref, upd);
        return { token, uid: d.startedBy };
      });
      if (out.pending) {
        audit("consume", "pending", owner, sid);
        return ok(res, { status: "pending" });
      }
      audit("consume", "ok", owner, sid);
      return ok(res, { status: "approved", token: out.token, uid: out.uid });
    } catch (e) {
      if (e instanceof Refusal) return denyWith(res, audit, "consume", e.deny, owner, sid);
      audit("consume", e instanceof MintFailed ? "mint_failed" : "internal_error", owner, sid);
      return internalError(res, e instanceof MintFailed ? new Error("webLogin mint failed " + e.message) : e);
    }
  };
}

module.exports = { start, approve, consume, LIMITS, MSG };

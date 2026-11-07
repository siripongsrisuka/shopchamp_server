// pos/office/_officeStore.js — ด่านคนเข้า office + ที่เก็บ passkey ของ shopchampoffice (DEV-0003)
//
// ด่านคน (openOffice): ตัดสินจาก watcher/roster ที่ server อ่านเองทุกคำขอ (pos/_shared/watcherRoster.js · ไม่มี cache)
//   root = แก้ทะเบียนได้ · watcher = ดูอย่างเดียว · คนอื่น = 403 office_no_access · อ่านทะเบียนล้ม = 500 (ไม่เดา)
//   client ไม่อ่าน doc ทะเบียนเอง (rules ปัด client ทุกคน)
//
// collections (Admin SDK เท่านั้น · rules ปัด client ทุกคน):
//   officePasskeys/{credentialId}        {uid, publicKey(base64url), counter, transports, deviceType, backedUp, label, rpID, createdAt, lastUsedAt}
//   officePasskeyChallenges/{uid}        {challenge, type:'register'|'auth', origin, createdAt} · 1 ใบต่อคน · ใช้ครั้งเดียว (อ่าน+ลบใน transaction)
//   officeAudit/{id}                     รอยการกระทำ (สำเร็จ และถูกปัดหลังยืนยันตัวแล้ว)
//
// ของจากข้างนอกผ่าน deps ได้ทุกตัว (harness/เทสส่งตัวปลอม · ไม่ส่ง = ตัวจริง โหลดตอนเรียกครั้งแรก):
//   now · lookupUserByEmail · lookupUsers · generateRegistrationOptions · verifyRegistrationResponse
//   generateAuthenticationOptions · verifyAuthenticationResponse (ของ @simplewebauthn/server)
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const { depOr } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const C = require("./_officeCore");

const PASSKEYS = "officePasskeys";
const CHALLENGES = "officePasskeyChallenges";
const AUDIT = "officeAudit";

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (status, code, message, extra) => { throw new Refusal(deny(status, code, message || C.PASSKEY_MESSAGES[code], extra)); };

// ── ของจริง (โหลดช้า · harness ไม่แตะ) ─────────────────────────────────────
const realAdmin = () => require("../../firebase").admin;
const webauthn = () => require("@simplewebauthn/server");

async function realLookupUserByEmail(email) {
  try {
    const u = await realAdmin().auth().getUserByEmail(email);
    return { uid: u.uid, email: u.email || "", displayName: u.displayName || "", disabled: !!u.disabled };
  } catch (e) {
    if (e && e.code === "auth/user-not-found") return null;
    throw e;
  }
}

async function realLookupUsers(uids) {
  const users = [];
  for (let i = 0; i < uids.length; i += 100) {
    const r = await realAdmin().auth().getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
    for (const u of r.users) users.push({ uid: u.uid, email: u.email || "", displayName: u.displayName || "", disabled: !!u.disabled });
  }
  const found = new Set(users.map((u) => u.uid));
  return { users, missing: uids.filter((u) => !found.has(u)) };
}

function toolsOf(deps) {
  return {
    lookupUserByEmail: depOr(deps, "lookupUserByEmail", realLookupUserByEmail),
    lookupUsers: depOr(deps, "lookupUsers", realLookupUsers),
    generateRegistrationOptions: depOr(deps, "generateRegistrationOptions", (o) => webauthn().generateRegistrationOptions(o)),
    verifyRegistrationResponse: depOr(deps, "verifyRegistrationResponse", (o) => webauthn().verifyRegistrationResponse(o)),
    generateAuthenticationOptions: depOr(deps, "generateAuthenticationOptions", (o) => webauthn().generateAuthenticationOptions(o)),
    verifyAuthenticationResponse: depOr(deps, "verifyAuthenticationResponse", (o) => webauthn().verifyAuthenticationResponse(o)),
  };
}

// ── ด่านคน ─────────────────────────────────────────────────────────────────

/**
 * callerOf(req) → {uid, email} · ไม่มี = refuse 401
 * roleOf(uid) → 'root' | 'watcher' | 'none' (อ่าน watcher/roster ครั้งเดียว · ล้ม = โยนต่อ)
 */
function callerOf(req) {
  const a = req && req.auth;
  const uid = a && typeof a.uid === "string" && a.uid !== "" ? a.uid : "";
  if (!uid) refuse(401, "no_auth");
  const email = a && typeof a.email === "string" && a.email !== "" ? a.email : null;
  return { uid, email };
}

async function readRole(uid) {
  const snap = await WR.rosterRef(db).get();
  const data = snap && snap.exists ? snap.data() : null;
  return { role: WR.staffRoleOf(WR.parseRoster(data), uid), data };
}

/** gate(req, {need}) — need 'staff' (watcher/root) | 'root' · คืน {uid, email, role, roster} */
async function gate(req, need) {
  const caller = callerOf(req);
  const { role, data } = await readRole(caller.uid);
  if (role === WR.ROLE.NONE) refuse(403, "office_no_access", "บัญชีนี้ไม่ได้อยู่ในทะเบียนทีมงาน Shopchamp · ให้ root เพิ่มชื่อใน Watcher Console");
  if (need === "root" && role !== WR.ROLE.ROOT) refuse(403, "root_required", "เฉพาะ root · บัญชี watcher ดูได้อย่างเดียว");
  return { ...caller, role, roster: data };
}

// ── passkey ────────────────────────────────────────────────────────────────

function rpOr400(origin) {
  const rp = C.resolveRp(origin);
  if (!rp) refuse(400, "bad_origin");
  return rp;
}

async function listCredentials(uid) {
  const snap = await db.collection(PASSKEYS).where("uid", "==", uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
}

function credShape(c) {
  return { id: c.id, label: c.label || "", deviceType: c.deviceType || null, backedUp: c.backedUp === true, rpID: c.rpID || null, createdAt: C.isoOf(c.createdAt), lastUsedAt: C.isoOf(c.lastUsedAt) };
}

/** เก็บ challenge ใหม่ (ทับใบเก่า · 1 ใบต่อคน) */
async function saveChallenge(uid, { challenge, type, origin }, now) {
  await db.collection(CHALLENGES).doc(uid).set({ challenge, type, origin, createdAt: now });
}

/** อ่าน + ลบ challenge ใน transaction เดียว (ใช้ครั้งเดียว · กัน replay) · แล้วค่อยตรวจชนิด/อายุ/ที่อยู่เว็บ */
async function consumeChallenge(uid, expectedType, origin, now) {
  const ref = db.collection(CHALLENGES).doc(uid);
  const data = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    return snap.data() || {};
  });
  if (!data) refuse(409, "no_challenge");
  if (data.type !== expectedType) refuse(409, "wrong_challenge_type");
  if (C.challengeExpired(C.msOf(data.createdAt), now.getTime())) refuse(409, "challenge_expired");
  if (data.origin !== origin) refuse(400, "bad_origin");
  if (typeof data.challenge !== "string" || !data.challenge) refuse(409, "no_challenge");
  return data;
}

/**
 * verifyAssertion({uid, origin, authResp, now, tools}) → {credentialId}
 *   จุดเดียวของการตรวจลายนิ้ว (ทดสอบพิธี · ก่อนเพิ่มกุญแจใบที่ 2 · ก่อนบันทึกทะเบียน) · requireUserVerification
 */
async function verifyAssertion({ uid, origin, authResp, now, tools }) {
  const rp = rpOr400(origin);
  const { challenge } = await consumeChallenge(uid, "auth", rp.origin, now);
  const credId = authResp && typeof authResp.id === "string" ? authResp.id : "";
  if (!credId) refuse(400, "assertion_failed");
  const credRef = db.collection(PASSKEYS).doc(credId);
  const credSnap = await credRef.get();
  if (!credSnap.exists) refuse(403, "unknown_credential");
  const cred = credSnap.data() || {};
  if (cred.uid !== uid) refuse(403, "credential_wrong_user");
  if (cred.rpID && cred.rpID !== rp.rpID) refuse(403, "unknown_credential", "กุญแจนี้ลงทะเบียนไว้กับที่อยู่เว็บอื่น · ลงทะเบียนบนที่อยู่นี้ก่อน");
  let v;
  try {
    v = await tools.verifyAuthenticationResponse({
      response: authResp,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: credId, publicKey: C.fromB64url(cred.publicKey), counter: Number(cred.counter) || 0, transports: Array.isArray(cred.transports) ? cred.transports : [] },
      requireUserVerification: true,
    });
  } catch (e) {
    try { console.warn("office passkey verify throw", e && e.message); } catch (_) { /* */ }
    refuse(403, "assertion_failed");
  }
  if (!v || v.verified !== true) refuse(403, "assertion_failed");
  const newCounter = v.authenticationInfo && Number.isInteger(v.authenticationInfo.newCounter) ? v.authenticationInfo.newCounter : Number(cred.counter) || 0;
  await credRef.update({ counter: newCounter, lastUsedAt: now });
  return { credentialId: credId };
}

// ── audit ──────────────────────────────────────────────────────────────────

const stamp = (now) => now.toISOString().replace(/[:.]/g, "-");
/** id = เวลา_uid_การกระทำ[_ตัวขยาย] · ตัวขยาย (เช่น credential id) กันชนเมื่อ 2 การกระทำเกิดใน ms เดียวกัน */
function auditRef(now, uid, action, qualifier) {
  const q = qualifier ? `_${String(qualifier).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}` : "";
  return db.collection(AUDIT).doc(`${stamp(now)}_${uid}_${action.replace(/[^a-z]/gi, "")}${q}`);
}
function auditEntry({ action, result, actor, passkeyCredentialId, now, extra }) {
  return { action, result, actorUid: actor.uid, actorEmail: actor.email || null, passkeyCredentialId: passkeyCredentialId || null, at: now, ...(extra || {}) };
}
/** เขียน audit นอก transaction (ทางถูกปัด) · ล้ม = log แล้วไปต่อ (ไม่บังคำตอบที่ถูกปัดอยู่แล้ว) */
async function auditOutside(args) {
  try { await auditRef(args.now, args.actor.uid, args.action, args.extra && args.extra.rejectCode).set(auditEntry(args)); } catch (e) {
    try { console.error("office audit fail", e && e.message); } catch (_) { /* */ }
  }
}

module.exports = {
  PASSKEYS, CHALLENGES, AUDIT, Refusal, refuse, toolsOf, callerOf, gate, readRole, rpOr400,
  listCredentials, credShape, saveChallenge, consumeChallenge, verifyAssertion, auditRef, auditEntry, auditOutside, stamp,
};

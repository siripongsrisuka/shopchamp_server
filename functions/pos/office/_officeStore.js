// pos/office/_officeStore.js — ด่านคนเข้า office + รอยการกระทำของ shopchampoffice (DEV-0003) · passkey ถอดออกแล้ว (Pack 2026-11-11)
//
// ด่านคน (openOffice): ตัดสินจาก watcher/roster ที่ server อ่านเองทุกคำขอ (pos/_shared/watcherRoster.js · ไม่มี cache)
//   root = แก้ทะเบียนได้ · watcher = ดูอย่างเดียว · คนอื่น = 403 office_no_access · อ่านทะเบียนล้ม = 500 (ไม่เดา)
//   client ไม่อ่าน doc ทะเบียนเอง (rules ปัด client ทุกคน)
//
// collections (Admin SDK เท่านั้น · rules ปัด client ทุกคน):
//   officeAudit/{id}                     รอยการกระทำ (สำเร็จ และถูกปัดระหว่างทาง)
//   (officePasskeys · officePasskeyChallenges = ของเก่าก่อนถอด passkey · ไม่มีโค้ดอ่าน/เขียนแล้ว)
//
// ของจากข้างนอกผ่าน deps ได้ (harness/เทสส่งตัวปลอม · ไม่ส่ง = ตัวจริง): now · lookupUserByEmail · lookupUsers
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const { depOr } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const C = require("./_officeCore");

const AUDIT = "officeAudit";

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (status, code, message, extra) => { throw new Refusal(deny(status, code, message, extra)); };

// ── ของจริง (โหลดช้า · harness ไม่แตะ) ─────────────────────────────────────
const realAdmin = () => require("../../firebase").admin;

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
  AUDIT, Refusal, refuse, toolsOf, callerOf, gate, readRole, auditRef, auditEntry, auditOutside, stamp,
};

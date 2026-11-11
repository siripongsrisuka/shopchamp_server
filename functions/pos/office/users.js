// pos/office/users — หน้า "ผู้ใช้งาน" ของ shopchampoffice: ทะเบียนคนที่เข้าใช้ office ได้ (DEV-0003 · Pack สั่ง 2026-11-11 · เลือกแบบ 1)
//
// สัญญา: shopchamp-center/api/office.accessRequest.yaml · office.userList.yaml · office.userAdd.yaml · office.userSetStatus.yaml
// ยังไม่มีการกำหนดสิทธิ์ (Pack: "ยังไม่เอาเรื่องการกำหนดสิทธิ์") ⇒ ผู้ใช้ active ที่ไม่อยู่ใน watcher/roster เข้า office ได้แต่ยังไม่เห็นเมนู/ข้อมูลลูกค้า
//   ทีมงาน (watcher/root) ยังตัดสินที่ watcher/roster ที่เดียว · หน้านี้แสดงทีมงานเป็นแถว active (จัดการที่ Watcher Console)
//
// ที่เก็บ: officeUsers/{uid}  {uid, email, name, photoURL, status, addedVia:'request'|'root', requestedAt, decidedAt, decidedBy:{uid,email,name}, updatedAt}
//   server เท่านั้น (rules ไม่มี match = ปัด client ทุกคน)
//
// accessRequest  คนที่ login แล้วแต่ไม่อยู่ในทะเบียนทีมงาน → สร้างคำขอ pending (มีอยู่แล้ว = ไม่เขียนซ้ำ) · ถูกปิด/ปฏิเสธ = 409 access_closed
// userList       ทีมงาน (watcher/root) · แถว = officeUsers ∪ ทีมงานใน roster · ตัวนับ 5 ช่อง
// userAdd        root + passkey · อีเมล → หาใน Firebase Auth → active ทันที
// userSetStatus  root + passkey · approve pending→active · reject pending→rejected · disable active→disabled · enable disabled|rejected→active
//   ทีมงานใน roster = 409 in_roster (จัดการที่ Watcher Console) · สถานะเปลี่ยนระหว่างแตะนิ้ว = 409 status_changed
// audit: officeAudit ทุกการกด (สำเร็จ ใน transaction เดียวกับการเขียน · ถูกปัดหลังแตะนิ้วแล้ว = นอก transaction)
"use strict";

const { db } = require("../../firebase");
const { PasskeyAssertion } = require("@shopchamp/schema");
const { ok, sendDeny, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const S = require("./_officeStore");
const C = require("./_officeCore");

const USERS = "officeUsers";
const READ_CAP = 1000;
const STATUS = Object.freeze({ ACTIVE: "active", PENDING: "pending", DISABLED: "disabled", REJECTED: "rejected" });
const STATUS_ORDER = Object.freeze({ pending: 0, active: 1, disabled: 2, rejected: 3 });
/** การกด → จากสถานะไหนได้บ้าง → ไปสถานะไหน */
const TRANSITIONS = Object.freeze({
  approve: { from: ["pending"], to: "active" },
  reject: { from: ["pending"], to: "rejected" },
  disable: { from: ["active"], to: "disabled" },
  enable: { from: ["disabled", "rejected"], to: "active" },
});

const str = (v) => (typeof v === "string" ? v : "");
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const usersRef = () => db.collection(USERS);

// ── ตรวจรูปคำขอ (strict · field เกิน = 400) ─────────────────────────────────
function bad(message) { S.refuse(400, "invalid_request", message); }
function bodyOf(req) {
  const b = req ? req.body : undefined;
  if (b === undefined || b === null) return {};
  if (!isObj(b)) bad("คำขอต้องเป็น object");
  return b;
}
function onlyKeys(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`ไม่รับช่อง: ${extra.join(", ")}`);
}
function passkeyOf(v) {
  const r = PasskeyAssertion.safeParse(v);
  if (!r.success) bad("passkey ต้องเป็นผลแตะนิ้ว {origin, authResp}");
  return r.data;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailOf(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) bad("email ต้องเป็นอีเมล");
  return e;
}
function uidOf(v) {
  if (typeof v !== "string" || !C.UID_RE.test(v)) bad("uid ผิดรูป");
  return v;
}
function actionOf(v) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, v)) bad("action ต้องเป็น approve | reject | disable | enable");
  return v;
}

// ── ของร่วม ────────────────────────────────────────────────────────────────
function wrap(run) {
  return async function handler(req, res) {
    try {
      return await run(req, res);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

/** ชื่อผู้กด: ชื่อในทะเบียนทีมงาน → อีเมล → uid */
function actorOf(g) {
  const people = g.roster && Array.isArray(g.roster.people) ? g.roster.people : [];
  const p = people.find((x) => x && x.uid === g.uid);
  return { uid: g.uid, email: g.email || "", name: (p && str(p.name).trim()) || g.email || g.uid };
}

/** สถานะของคนนอกทีมงาน (ไม่มี doc = 'none') · ใช้ใน whoami */
async function accessOf(uid) {
  const snap = await usersRef().doc(uid).get();
  if (!snap || !snap.exists) return "none";
  const s = str((snap.data() || {}).status);
  return Object.prototype.hasOwnProperty.call(STATUS_ORDER, s) ? s : "none";
}

function rowOfDoc(id, d) {
  return {
    uid: str(d.uid) || id,
    email: str(d.email),
    name: str(d.name),
    photoURL: str(d.photoURL) || null,
    status: Object.prototype.hasOwnProperty.call(STATUS_ORDER, d.status) ? d.status : STATUS.PENDING,
    level: null,
    addedVia: d.addedVia === "root" ? "root" : "request",
    requestedAt: C.isoOf(d.requestedAt),
    decidedAt: C.isoOf(d.decidedAt),
    decidedBy: isObj(d.decidedBy) ? { uid: str(d.decidedBy.uid), email: str(d.decidedBy.email), name: str(d.decidedBy.name) } : null,
  };
}

/** แถวทั้งหมด = ทีมงานใน roster (active · level) ทับ doc ของคนเดียวกัน + officeUsers ที่เหลือ · เรียง pending ก่อน แล้วตามชื่อ */
function buildRows(roster, docs) {
  const parsed = WR.parseRoster(roster);
  const people = roster && Array.isArray(roster.people) ? roster.people : [];
  const byUid = new Map(people.filter((p) => p && typeof p.uid === "string").map((p) => [p.uid, p]));
  const rows = new Map();
  for (const { id, data } of docs) rows.set(id, rowOfDoc(id, data || {}));
  for (const uid of parsed.uids) {
    const p = byUid.get(uid) || {};
    const prev = rows.get(uid);
    rows.set(uid, {
      uid,
      email: str(p.email) || (prev ? prev.email : ""),
      name: str(p.name) || (prev ? prev.name : ""),
      photoURL: prev ? prev.photoURL : null,
      status: STATUS.ACTIVE,
      level: parsed.rootUids.has(uid) ? "root" : "watcher",
      addedVia: "roster",
      requestedAt: prev ? prev.requestedAt : null,
      decidedAt: roster && roster.publishedAt ? C.isoOf(roster.publishedAt) : null,
      decidedBy: roster && typeof roster.publishedBy === "string" ? { uid: str(roster.publishedByUid), email: roster.publishedBy, name: "" } : null,
    });
  }
  const list = [...rows.values()].sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.name || a.email || a.uid).localeCompare(b.name || b.email || b.uid, "th"));
  const counts = { total: list.length, active: 0, pending: 0, disabled: 0, rejected: 0 };
  for (const r of list) counts[r.status] += 1;
  return { rows: list, counts };
}

async function audit(now, actor, action, result, extra, credentialId) {
  await S.auditOutside({ action, result, actor, passkeyCredentialId: credentialId || null, now, extra });
}

// ── handler ────────────────────────────────────────────────────────────────

function accessRequest(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    onlyKeys(bodyOf(req), []);
    const now = await readNow(deps);
    const { role } = await S.readRole(caller.uid);
    if (role !== WR.ROLE.NONE) return ok(res, { access: "staff", created: false });
    const a = req.auth || {};
    const ref = usersRef().doc(caller.uid);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap && snap.exists) return { status: str((snap.data() || {}).status) };
      tx.create(ref, {
        uid: caller.uid, email: (caller.email || "").toLowerCase(), name: str(a.name).slice(0, 120), photoURL: str(a.picture).slice(0, 1000) || null,
        status: STATUS.PENDING, addedVia: "request", requestedAt: now, decidedAt: null, decidedBy: null, updatedAt: now,
      });
      return { created: true, status: STATUS.PENDING };
    });
    if (out.status === STATUS.DISABLED || out.status === STATUS.REJECTED) {
      S.refuse(409, "access_closed", out.status === STATUS.DISABLED ? "บัญชีนี้ถูกปิดใช้ office · ติดต่อ root" : "คำขอเข้าใช้ถูกปฏิเสธ · ติดต่อ root", { access: out.status });
    }
    return ok(res, { access: out.status === STATUS.ACTIVE ? STATUS.ACTIVE : STATUS.PENDING, created: out.created === true });
  });
}

function userList(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    onlyKeys(bodyOf(req), []);
    await readNow(deps);
    const g = await S.gate(req, "staff");
    const snap = await usersRef().limit(READ_CAP).get();
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    return ok(res, { ...buildRows(g.roster, docs), canEdit: g.role === WR.ROLE.ROOT, truncated: docs.length >= READ_CAP });
  });
}

function userAdd(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["email", "passkey"]);
    const email = emailOf(b.email);
    const pk = passkeyOf(b.passkey);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const tools = S.toolsOf(deps);

    // ด่านก่อนแตะนิ้ว (ไม่เสียนิ้วกับคนที่เพิ่มไม่ได้)
    const u = await tools.lookupUserByEmail(email);
    if (!u || typeof u.uid !== "string" || !u.uid) S.refuse(404, "user_not_found", "ไม่พบบัญชีที่ใช้อีเมลนี้ · ให้เจ้าตัว login office ด้วย Google ครั้งแรกก่อน หรือสมัครแอป Shopchamp ด้วยอีเมลนี้");
    if (!C.UID_RE.test(u.uid)) S.refuse(422, "uid_unsupported", "บัญชีนี้มี uid รูปที่ทะเบียนรับไม่ได้");
    if (WR.parseRoster(g.roster).uids.has(u.uid)) S.refuse(409, "already_staff", "คนนี้เป็นทีมงาน (watcher/root) อยู่แล้ว · จัดการที่ Watcher Console");
    const pre = await usersRef().doc(u.uid).get();
    if (pre && pre.exists && str((pre.data() || {}).status) === STATUS.ACTIVE) S.refuse(409, "already_active", "คนนี้ใช้งานได้อยู่แล้ว");

    const { credentialId } = await S.verifyAssertion({ uid: caller.uid, origin: pk.origin, authResp: pk.authResp, now, tools });
    const ref = usersRef().doc(u.uid);
    const decidedBy = { uid: actor.uid, email: actor.email, name: actor.name };
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const live = snap && snap.exists ? snap.data() || {} : null;
      if (live && str(live.status) === STATUS.ACTIVE) return { already: true };
      const base = {
        uid: u.uid, email: str(u.email).toLowerCase() || email, name: str(u.displayName).slice(0, 120) || (live ? str(live.name) : ""),
        status: STATUS.ACTIVE, decidedAt: now, decidedBy, updatedAt: now,
      };
      if (live) tx.update(ref, { ...base, prevStatus: str(live.status) });
      else tx.create(ref, { ...base, photoURL: null, addedVia: "root", requestedAt: null });
      tx.create(S.auditRef(now, caller.uid, "user.add", u.uid), S.auditEntry({
        action: "user.add", result: "ok", actor, passkeyCredentialId: credentialId, now, extra: { targetUid: u.uid, email, prevStatus: live ? str(live.status) : null },
      }));
      return { created: !live };
    });
    if (out.already) {
      await audit(now, actor, "user.add", "rejected", { targetUid: u.uid, rejectCode: "already_active" }, credentialId);
      S.refuse(409, "already_active", "คนนี้ใช้งานได้อยู่แล้ว");
    }
    return ok(res, { uid: u.uid, email: str(u.email).toLowerCase() || email, name: str(u.displayName), status: STATUS.ACTIVE, created: out.created });
  });
}

function userSetStatus(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["uid", "action", "passkey"]);
    const uid = uidOf(b.uid);
    const action = actionOf(b.action);
    const pk = passkeyOf(b.passkey);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const tools = S.toolsOf(deps);
    const t = TRANSITIONS[action];

    if (WR.parseRoster(g.roster).uids.has(uid)) S.refuse(409, "in_roster", "คนนี้เป็นทีมงาน (watcher/root) · ถอดหรือเปลี่ยนที่ Watcher Console");
    const pre = await usersRef().doc(uid).get();
    if (!pre || !pre.exists) S.refuse(404, "user_not_found", "ไม่พบผู้ใช้นี้ในทะเบียน office");
    const preStatus = str((pre.data() || {}).status);
    if (!t.from.includes(preStatus)) S.refuse(409, "bad_transition", `สถานะ ${preStatus || "-"} ทำ ${action} ไม่ได้`, { status: preStatus });

    const { credentialId } = await S.verifyAssertion({ uid: caller.uid, origin: pk.origin, authResp: pk.authResp, now, tools });
    const ref = usersRef().doc(uid);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const live = snap && snap.exists ? snap.data() || {} : null;
      if (!live || str(live.status) !== preStatus) return { changed: true, status: live ? str(live.status) : null };
      tx.update(ref, { status: t.to, prevStatus: preStatus, decidedAt: now, decidedBy: { uid: actor.uid, email: actor.email, name: actor.name }, updatedAt: now });
      tx.create(S.auditRef(now, caller.uid, `user.${action}`, uid), S.auditEntry({
        action: `user.${action}`, result: "ok", actor, passkeyCredentialId: credentialId, now, extra: { targetUid: uid, from: preStatus, to: t.to },
      }));
      return { changed: false };
    });
    if (out.changed) {
      await audit(now, actor, `user.${action}`, "rejected", { targetUid: uid, rejectCode: "status_changed" }, credentialId);
      S.refuse(409, "status_changed", "สถานะของผู้ใช้นี้เปลี่ยนระหว่างแตะนิ้ว · โหลดใหม่แล้วลองอีกครั้ง", { status: out.status });
    }
    return ok(res, { uid, status: t.to });
  });
}

module.exports = { USERS, STATUS, TRANSITIONS, accessOf, buildRows, accessRequest, userList, userAdd, userSetStatus };

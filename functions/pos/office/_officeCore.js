// pos/office/_officeCore.js — ตรรกะล้วนของ shopchampoffice (DEV-0003 · Watcher Console) · ไม่แตะฐาน ไม่แตะเครือข่าย
//
// 2 ส่วน
//   ① passkey (WebAuthn) — ยกแบบจากบ้านพี่น้อง (adminharness/_harnessCore.js) แล้วแก้ชื่อ
//      origin allowlist (fail-closed) · challenge หมดอายุ 5 นาที · เพดานกุญแจ 3 ใบต่อคน
//      เพิ่มกุญแจ: 0 ใบ = ผ่าน (คนใหม่ต้องเริ่มได้) · มีแล้ว = ต้องแตะกุญแจเดิมก่อน
//   ② ทะเบียน watcher/roster — ด่านเดียวกับ shopchamp-center/gate/watcher-publish.js › parseRosterFile
//      (uid รูป [A-Za-z0-9]{20,128} · ไม่ซ้ำ · level watcher|root · root ≤ 10 · รายชื่อว่างต้องยืนยัน)
//      รูป doc ปลายทาง + rosterSha = สูตรเดียวกับ gate/ledger-sign.js › rosterManifest (เทส rosterCore.test.js เทียบกับตัวจริงใน center)
"use strict";

const crypto = require("crypto");

// ── ① passkey ────────────────────────────────────────────────────────────────

// ที่อยู่เว็บที่ทำพิธีได้ · rpID = hostname (กุญแจผูกกับโดเมน · ย้ายโดเมน = ลงกุญแจใหม่)
//   5173 = vite dev · 4173 = vite preview · site จริง shopchampoffice (Pack สร้าง site เอง)
const ALLOWED_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://localhost:4173",
  "https://shopchampoffice.web.app",
  "https://shopchampoffice.firebaseapp.com",
]);

/** origin → {origin, rpID} · ไม่อยู่ในลิสต์ = null */
function resolveRp(origin) {
  if (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin)) return null;
  return { origin, rpID: new URL(origin).hostname };
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 3;
const RP_NAME = "shopchampoffice";

/** challenge หมดอายุไหม · อ่านเวลาไม่ได้ = หมด (fail-closed) */
function challengeExpired(createdAtMs, nowMs) {
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs > CHALLENGE_TTL_MS || createdAtMs - nowMs > 60 * 1000;
}

const isCountable = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** เพิ่มกุญแจใบใหม่ได้ไหม · {allow, code} */
function decideEnroll({ count, max, hasAssertion } = {}) {
  if (!isCountable(count) || !isCountable(max) || max < 1) return { allow: false, code: "bad_credential_count" };
  if (count >= max) return { allow: false, code: "passkey_cap_reached" };
  if (count >= 1 && !hasAssertion) return { allow: false, code: "enroll_needs_existing" };
  if (count === 0 && hasAssertion) return { allow: false, code: "enroll_no_existing" };
  return { allow: true, code: null };
}

const PASSKEY_MESSAGES = Object.freeze({
  bad_origin: "ที่อยู่เว็บนี้ไม่อยู่ในรายการที่ยืนยันตัวได้ · เปิดจากที่อยู่หลักของ shopchampoffice",
  passkey_cap_reached: `กุญแจครบ ${MAX_PASSKEYS_PER_USER} ใบแล้ว`,
  enroll_needs_existing: "บัญชีนี้มีกุญแจแล้ว · ต้องแตะกุญแจเดิมก่อนเพิ่มใบใหม่",
  enroll_no_existing: "บัญชีนี้ยังไม่มีกุญแจ · ไม่ต้องแนบผลแตะกุญแจเดิม",
  bad_credential_count: "นับกุญแจของบัญชีนี้ไม่ได้ · ปฏิเสธไว้ก่อน",
  no_credentials: "ยังไม่มี passkey · ลงทะเบียนเครื่องนี้ก่อน",
  no_challenge: "ไม่มีพิธียืนยันตัวที่ค้างอยู่ · กดใหม่อีกครั้ง",
  wrong_challenge_type: "พิธียืนยันตัวไม่ตรงกับคำสั่ง · กดใหม่อีกครั้ง",
  challenge_expired: "ยืนยันตัวช้าเกิน 5 นาที · กดใหม่อีกครั้ง",
  unknown_credential: "เครื่องนี้ยังไม่ได้ลงทะเบียนกับบัญชีนี้",
  credential_wrong_user: "กุญแจนี้ไม่ใช่ของบัญชีนี้",
  assertion_failed: "ยืนยันตัวไม่ผ่าน",
  enroll_failed: "ลงทะเบียนกุญแจไม่ผ่าน",
  credential_exists: "กุญแจนี้ลงทะเบียนไว้แล้ว",
});

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s || ""), "base64url");

// ── ② ทะเบียน ────────────────────────────────────────────────────────────────

const ROOT_MAX = 10;
const ROSTER_MAX = 500;
const UID_RE = /^[A-Za-z0-9]{20,128}$/;
const LEVELS = new Set(["watcher", "root"]);

/**
 * checkPeople(people) → {people, problems[]} · ด่านเดียวกับ watcher-publish.js › parseRosterFile (ข้อความเป็นรหัส)
 *   problems = [{code, message, uid?}] · ว่าง = ผ่าน
 */
function checkPeople(people) {
  const problems = [];
  const list = Array.isArray(people) ? people : [];
  if (list.length > ROSTER_MAX) problems.push({ code: "too_many", message: `รายชื่อเกิน ${ROSTER_MAX} คน` });
  const seen = new Set();
  const out = [];
  list.forEach((p, i) => {
    const uid = p && typeof p.uid === "string" ? p.uid.trim() : "";
    if (!UID_RE.test(uid)) problems.push({ code: "bad_uid", message: `แถว ${i + 1} uid ผิดรูป`, uid });
    if (seen.has(uid)) problems.push({ code: "duplicate_uid", message: `uid ซ้ำ ${uid}`, uid });
    seen.add(uid);
    const level = p && p.level;
    if (!LEVELS.has(level)) problems.push({ code: "bad_level", message: `แถว ${i + 1} level ต้องเป็น watcher หรือ root`, uid });
    out.push({ uid, name: p && typeof p.name === "string" ? p.name.trim() : "", level });
  });
  const roots = out.filter((p) => p.level === "root").length;
  if (roots > ROOT_MAX) problems.push({ code: "too_many_roots", message: `root ${roots} คน เกินเพดาน ${ROOT_MAX}` });
  return { people: out, problems };
}

/** ข้อความที่ใช้คิด rosterSha · ต้องตรง gate/ledger-sign.js › rosterManifest ทุกตัวอักษร */
function rosterManifest(people) {
  const rows = (Array.isArray(people) ? people : []).map((p) => [String((p || {}).uid || ""), String((p || {}).level || ""), String((p || {}).name || "")]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ["watcher-roster v1", ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
}

/** รูป doc ปลายทาง (ยังไม่รวม publishedAt/publishedBy/via) · สูตรเดียวกับ watcher-publish.js › rosterDoc */
function rosterDoc(people, emails) {
  const sorted = [...people].sort((a, b) => (a.uid < b.uid ? -1 : 1));
  return {
    uids: sorted.map((p) => p.uid),
    rootUids: sorted.filter((p) => p.level === "root").map((p) => p.uid),
    people: sorted.map((p) => ({ uid: p.uid, email: (emails && emails[p.uid]) || "", name: p.name, level: p.level })),
    count: sorted.length,
    rootCount: sorted.filter((p) => p.level === "root").length,
    rosterSha: crypto.createHash("sha256").update(rosterManifest(people)).digest("hex"),
  };
}

/** diff ของบนฐาน (data ดิบ/null) กับชุดใหม่ · ใช้ uids/rootUids ตัวเดียวกับที่ server ตัดสิน */
function diffRoster(live, next) {
  const lu = new Set(live && Array.isArray(live.uids) ? live.uids : []);
  const lr = new Set(live && Array.isArray(live.rootUids) ? live.rootUids : []);
  const nu = new Set(next.uids);
  const nr = new Set(next.rootUids);
  const level = (u, r) => (r.has(u) ? "root" : "watcher");
  return {
    added: next.uids.filter((u) => !lu.has(u)).map((u) => ({ uid: u, level: level(u, nr) })),
    removed: [...lu].filter((u) => !nu.has(u)).map((u) => ({ uid: u, level: level(u, lr) })),
    levelChanged: next.uids.filter((u) => lu.has(u) && level(u, lr) !== level(u, nr)).map((u) => ({ uid: u, from: level(u, lr), to: level(u, nr) })),
  };
}

/** ms ของ Date / Timestamp · อ่านไม่ได้ = null */
function msOf(t) {
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (t && typeof t === "object" && typeof t.toMillis === "function") {
    const ms = t.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === "string") { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : null; }
  return null;
}
const isoOf = (t) => { const ms = msOf(t); return ms === null ? null : new Date(ms).toISOString(); };

module.exports = {
  ALLOWED_ORIGINS, resolveRp, CHALLENGE_TTL_MS, MAX_PASSKEYS_PER_USER, RP_NAME, challengeExpired, decideEnroll, PASSKEY_MESSAGES,
  b64url, fromB64url,
  ROOT_MAX, ROSTER_MAX, UID_RE, checkPeople, rosterManifest, rosterDoc, diffRoster, msOf, isoOf,
};

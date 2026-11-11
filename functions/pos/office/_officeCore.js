// pos/office/_officeCore.js — ตรรกะล้วนของ shopchampoffice (DEV-0003 · Watcher Console) · ไม่แตะฐาน ไม่แตะเครือข่าย
//
// ส่วน passkey (WebAuthn) ถอดออกแล้ว (Pack 2026-11-11 "ถอดเรื่องระบบกุญแจยืนยันออก")
//   ทะเบียน watcher/roster — ด่านเดียวกับ shopchamp-center/gate/watcher-publish.js › parseRosterFile
//      (uid รูป [A-Za-z0-9]{20,128} · ไม่ซ้ำ · level watcher|root · root ≤ 10 · รายชื่อว่างต้องยืนยัน)
//      รูป doc ปลายทาง + rosterSha = สูตรเดียวกับ gate/ledger-sign.js › rosterManifest (เทส rosterCore.test.js เทียบกับตัวจริงใน center)
"use strict";

const crypto = require("crypto");

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
  ROOT_MAX, ROSTER_MAX, UID_RE, checkPeople, rosterManifest, rosterDoc, diffRoster, msOf, isoOf,
};

// pos/_shared/watcherRoster.js — ทะเบียนทีมงาน Shopchamp ที่ server ตัดสินเอง (DEV-0001 watcher · Pack เคาะ 2026-11-07 ข้อ 1-9)
//
// ที่เก็บ: doc `watcher/roster` ใน shopcham-24b0b · ❌ ไม่อยู่ใต้ `admin/*` (rules ให้ผู้ login อ่าน admin ได้ทุกตัว)
//   rules ไม่มี match ให้ client ⇒ client อ่าน/เขียนไม่ได้ · เขียนได้ทางเดียว = `shopchamp-center/gate/watcher-publish.js` ที่ Pack รัน
// รูป: { uids:[uid...], rootUids:[uid...], people:[{uid,email,name,level}], count, rootCount, publishedAt, publishedBy, via, rosterSha }
//   ตัวตัดสินอ่าน `uids` กับ `rootUids` อย่างเดียว · `people` ไว้ให้คนอ่านและ audit (ข้อ 1: ระบุตัวด้วย uid)
// 2 ระดับ (ข้อ 2):
//   watcher = อ่านได้ทุกร้าน · เขียนไม่ได้ (เส้นเขียนตอบ 403 watcher_read_only)
//   root    = ทำแทนร้านได้ทุกร้าน · ไม่เกิน 10 คน · root ⊆ watcher เสมอ · เขียนแล้วติดรอย byAdmin/adminUid บนเอกสาร
// fail-closed ทุกทาง: doc ไม่มี · ช่องไม่ใช่ array · ว่าง · uid ไม่ใช่สตริง = ไม่มีใครเป็นทีมงาน
//   rootUids เกิน 10 = ไม่มี root เลย (ทะเบียนผิดรูป ไม่เลือกให้ว่าใครได้) · root ที่ไม่อยู่ใน uids = ไม่ใช่ root
//   อ่าน doc ล้ม = โยนต่อ (ผู้เรียกตอบ 500 · ไม่เดาว่าเป็นทีมงาน)
// ⚠️ ไม่มีขาอ่าน admin/adminConfig คู่กันในไฟล์นี้หรือที่ไหนในโค้ดใหม่ (บทเรียนพี่น้อง: อ่าน 2 ทะเบียนคู่ = ถอดชื่อแล้วยังเข้าได้)
"use strict";

const ROSTER_COLLECTION = "watcher";
const ROSTER_DOC = "roster";
const ROOT_MAX = 10;
const ROLE = Object.freeze({ WATCHER: "watcher", ROOT: "root", NONE: "none" });

const isNonEmptyString = (v) => typeof v === "string" && v !== "";

/** parseRoster(data) — {uids:Set, rootUids:Set} · รูปผิดทุกแบบ = ชุดว่าง */
function parseRoster(data) {
  const empty = { uids: new Set(), rootUids: new Set() };
  if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
  if (!Array.isArray(data.uids)) return empty;
  const uids = new Set(data.uids.filter(isNonEmptyString));
  if (!uids.size) return empty;
  let rootUids = new Set();
  if (Array.isArray(data.rootUids)) {
    const roots = data.rootUids.filter(isNonEmptyString);
    if (new Set(roots).size <= ROOT_MAX) rootUids = new Set(roots.filter((u) => uids.has(u)));
  }
  return { uids, rootUids };
}

/** staffRoleOf(roster, uid) — 'root' | 'watcher' | 'none' · roster = ผลของ parseRoster หรือ data ดิบ */
function staffRoleOf(roster, uid) {
  if (!isNonEmptyString(uid)) return ROLE.NONE;
  const r = roster && roster.uids instanceof Set ? roster : parseRoster(roster);
  if (!r.uids.has(uid)) return ROLE.NONE;
  return r.rootUids.has(uid) ? ROLE.ROOT : ROLE.WATCHER;
}

/** rosterRef(db) — ตัวอ้าง doc ทะเบียน (ใช้ทั้งนอกและใน transaction) */
function rosterRef(db) {
  return db.collection(ROSTER_COLLECTION).doc(ROSTER_DOC);
}

/** snapToRoster(snap) — snapshot → roster ที่ตัดสินได้ · ไม่มี doc = ว่าง */
function snapToRoster(snap) {
  return parseRoster(snap && snap.exists ? snap.data() : null);
}

/** readRoster(db) — อ่านครั้งเดียวต่อคำขอ ไม่มี cache (ถอดชื่อแล้วคำขอถัดไปถูกปัดทันที) · ล้ม = โยนต่อ */
async function readRoster(db) {
  return snapToRoster(await rosterRef(db).get());
}

module.exports = { parseRoster, staffRoleOf, rosterRef, snapToRoster, readRoster, ROLE, ROOT_MAX, ROSTER_COLLECTION, ROSTER_DOC };

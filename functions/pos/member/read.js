// pos/member/read.js — อ่านสมาชิกของร้านผ่าน API แทนการอ่าน Firestore ตรงจากแอป (DEV-0010 คลื่น 2 · อ่านอย่างเดียว)
//
// indexSync (member.indexSync · POST /pos/member/index-sync): ดัชนีค้นหา memberList ทีละหน้า แทน `shopchamp_app/src/hook/useLocalMember.js:127`
//   ของเดิม: memberList where shopId == key and updateTime > latestFetchTime (วนทุกคีย์ร้าน · ไม่มี limit · เวลาละเอียดแค่ ms)
//   ใหม่:    memberList where shopId ==/in K and updateTime > FLOOR orderBy updateTime, __name__ startAfter(cursor) limit n+1
//            = ตัวช่วยกลาง _shared/syncCursor.js ตัวเดียวกับ stock.sync (cursor เวลานาโนวินาที+id · ไม่ส่ง cursor = ทั้งร้าน)
//            index memberList(shopId ASC, updateTime ASC, __name__ ASC) มีใน shopchamp_server/firestore.indexes.json
//   คำตอบ {lists:[{id, shopId, members, updateTime ISO}], nextCursor, hasMore} · doc ดัชนีไม่มีการลบ (rebuildIndex ทิ้งจนว่าง = members [])
//   ไม่มีเลขสิทธิ์ (จอขายของทุกคนดึง · แบบ member.rebuildIndex)
//
// list (member.list · POST /pos/member/list): สมาชิกทั้งร้านทีละหน้า แทน `shopchamp_app/src/screens/MemberScreen.js:222`
//   ของเดิม: member where shopId == key (วนทุกคีย์ · ไม่มี limit · ทุกครั้งที่เปิดจอ)
//   ใหม่:    member where shopId ==/in K orderBy __name__ startAfter(id) limit n select(LIST_FIELDS) · เรียง doc id
//   hasMore = หน้าเต็มพอดี (ไม่อ่านเผื่อ 1 ตัว · หน้าถัดไปว่าง = ค่าอ่านขั้นต่ำ 1) · ร้านเพดาน 3,000 คน ⇒ limit ไม่ส่ง 1000 / สูงสุด 3000
//   ❌ ดึงเฉพาะที่เปลี่ยนไม่ได้: doc member ไม่มีช่องเวลาแก้ล่าสุด (create เขียน timestamp · sale เขียน lastTime · void/redeemPoint/payCredit/update
//      ไม่เขียนเวลาเลย) และแอปเก่า 3.12 ยังเขียน member ตรง ⇒ ถ้าเพิ่มช่องเวลาตอนนี้ ของที่แอปเก่าแก้จะหลุด (ตรวจ 2026-11-14 · grep pos/)
//   สิทธิ์ '107' (เมนูสมาชิก `HomeScreen.js:86`) หรือ '101' (ตั้งค่า → ขั้นสูง → ระบบสมาชิก `AdvanceScreen.js:26` → จอเดียวกัน)
//
// get (member.get · POST /pos/member/get): สมาชิก 1 คน แทน `shopchamp_app/src/modal/Modal_FindMember.js:59`
//   member/{memberId} · shopId ของ doc ไม่ใช่คีย์ร้าน = 404 member_not_found (ไม่บอกว่ามีอยู่) · ไม่มีเลขสิทธิ์ (แคชเชียร์เลือกสมาชิกที่จอขาย)
//   คำตอบ {member:{id, name, tel, point, credit, creditArray}} (ช่องที่จอใช้ · ไล่ใน dev0010-survey-member.md ข้อ 4)
//
// paidHistory (member.paidHistory · POST /pos/member/paid-history): แทน `shopchamp_app/src/screens/MemberPaidScreen.js:54`
//   ของเดิม: paidHistory where memberId == id and timestamp >= วันนี้-365 (❌ ไม่กรองร้าน)
//   ใหม่:    query เดิม (index paidHistory(memberId, timestamp) มีแล้ว) select(shopId paid existCredit timestamp) แล้ว**กรอง shopId ∈ K**
//   คำตอบ {rows:[{id, paid, existCredit, timestamp ISO}]} เรียงใหม่ก่อน (แบบ normalSort ของจอ) · สิทธิ์เท่าจอสมาชิก ('107' หรือ '101')
//
// K = คีย์ร้านแบบแอปเดิม `memberShopKeys` (`shopchamp_app/src/domain/memberProductBody.js:148`): [ช่อง shopId ของร้าน, doc id] ไม่ซ้ำ
//   ร้านทั่วไป = คีย์เดียว · ร้านรุ่นแรกที่ช่อง ≠ doc id = 2 คีย์ (สมาชิกเก่าถือช่อง · ที่เพิ่มผ่าน API ร้านที่พิสูจน์ช่องไม่ผ่านถือ doc id)
//   (Pack 2026-11-14 ข้อ 8 · ค่าจาก doc ร้านที่ผู้เรียกผ่านด่านแล้ว)
// ด่าน: middleware requireShopAccess (สมาชิกร้าน active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน · ได้ทุกสิทธิ์แบบเจ้าของ)
// ค่าอ่าน: shop 1 + doc ที่ได้ (ขั้นต่ำ 1 ต่อ query) · ไม่ส่งข้อมูลร้านอื่น · ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน
// ❌ ไม่ require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db, admin } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag } = require("../_shared/auth");
const SC = require("../_shared/syncCursor");

const INDEX_DEFAULT_LIMIT = 100;
const LIST_DEFAULT_LIMIT = 1000;
const MEMBER_RIGHT = "107";
const SETTINGS_RIGHT = "101";
const LIST_FIELDS = Object.freeze(["name", "tel", "point", "credit", "creditArray", "bought", "timestamp", "lastTime"]);
const GET_FIELDS = Object.freeze(["name", "tel", "point", "credit", "creditArray"]);
const PAID_FIELDS = Object.freeze(["paid", "existCredit", "timestamp"]);
const PAID_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
/** เวลา (Date / Timestamp มี toMillis หรือ toDate) → ms · อย่างอื่น = null (Firestore เทียบช่วงข้ามชนิดไม่ได้ ⇒ ไม่เข้าเงื่อนไขเดิมอยู่แล้ว) */
function msOf(v) {
  let ms = null;
  if (v instanceof Date) ms = v.getTime();
  else if (v && typeof v.toMillis === "function") ms = v.toMillis();
  else if (v && typeof v.toDate === "function") { const d = v.toDate(); ms = d instanceof Date ? d.getTime() : null; }
  return typeof ms === "number" && !Number.isNaN(ms) ? ms : null;
}
const memberScreenRight = (access) => hasRight(access, MEMBER_RIGHT) || hasRight(access, SETTINGS_RIGHT);

function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

/** memberShopKeys(shopDocId, shop) — [ช่อง shopId ของร้าน, doc id] ไม่ซ้ำ ไม่ว่าง · แบบแอปเดิม */
function memberShopKeys(shopDocId, shop) {
  const field = typeof shop.shopId === "string" ? shop.shopId : "";
  return [field, shopDocId].filter((k, i, a) => k !== "" && a.indexOf(k) === i);
}

/** pickPlain(d, fields) — เฉพาะช่องที่มีใน doc · เวลาเป็น ISO */
function pickPlain(d, fields) {
  const out = {};
  for (const f of fields) if (d[f] !== undefined) out[f] = SC.toPlain(d[f]);
  return out;
}

/** gate + schema + สิทธิ์ + อ่านร้าน → {access, input, keys} · ไม่ผ่าน = ตอบไปแล้ว คืน null */
async function open(req, res, schemaName, rightOk, validate) {
  const body = isObj(req && req.body) ? req.body : {};
  const gate = callerAccess(req, body.shopId, { read: true });
  if (!gate.ok) { sendDeny(res, gate); return null; }
  const access = gate.access;
  const input = parseOr400(schemaOf(schemaName), body, res);
  if (!input) return null;
  if (rightOk && !rightOk(access)) { sendDeny(res, deny(403, "right_required")); return null; }
  if (validate && !validate(input)) { badCursor(res); return null; }
  const snap = await db.collection("shop").doc(access.shopId).get();
  if (!snap.exists) { sendDeny(res, deny(404, "shop_not_found")); return null; }
  return { access, input, keys: memberShopKeys(access.shopId, snap.data() || {}) };
}

function badCursor(res) {
  return fail(res, 400, "invalid_request", undefined, { issues: [{ path: "cursor", message: "cursor ไม่ถูกต้อง (ใช้ nextCursor จากคำตอบเท่านั้น)" }] });
}

function indexSync(_deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, "MemberIndexSyncRequest", null, (i) => i.cursor === undefined || SC.parseCursor(i.cursor) !== null);
      if (!o) return;
      const { access, input, keys } = o;
      const cur = input.cursor === undefined ? null : SC.parseCursor(input.cursor);
      const { page, hasMore } = await SC.readChangedPage({ db, admin, coll: "memberList", keys, cursor: cur, limit: input.limit || INDEX_DEFAULT_LIMIT });
      const lists = page.map((r) => ({
        id: r.id,
        shopId: r.d.shopId,
        members: Array.isArray(r.d.members) ? SC.toPlain(r.d.members) : [],
        updateTime: SC.toPlain(r.d.updateTime),
      }));
      return ok(res, { ...adminFlag(access), lists, nextCursor: SC.nextCursorOf(page, cur, input.cursor), hasMore });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function list(_deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, "MemberListRequest", memberScreenRight, (i) => i.cursor === undefined || SC.validDocId(i.cursor));
      if (!o) return;
      const { access, input, keys } = o;
      const limit = input.limit || LIST_DEFAULT_LIMIT;
      let q = keys.length === 1
        ? db.collection("member").where("shopId", "==", keys[0])
        : db.collection("member").where("shopId", "in", keys);
      q = q.orderBy("__name__");
      if (input.cursor !== undefined) q = q.startAfter(input.cursor);
      const snap = await q.limit(limit).select("shopId", ...LIST_FIELDS).get();
      // กรอง/เรียงซ้ำในโค้ด: ฐานจริงทำมาแล้ว (ไม่มีผล) · กันฐานปลอมที่ไม่เรียง/ไม่ startAfter และ doc ร้านอื่น
      const docs = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => keys.includes(r.d.shopId) && (input.cursor === undefined || r.id > input.cursor))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit);
      const rows = docs.map((r) => ({ ...pickPlain(r.d, LIST_FIELDS), id: r.id }));
      const last = docs[docs.length - 1];
      const nextCursor = last ? last.id : input.cursor === undefined ? null : input.cursor;
      return ok(res, { ...adminFlag(access), rows, nextCursor, hasMore: docs.length === limit });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function get(_deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, "MemberGetRequest", null);
      if (!o) return;
      const { access, input, keys } = o;
      const snap = await db.collection("member").doc(input.memberId).get();
      const d = snap.exists ? snap.data() || {} : null;
      if (!d || !keys.includes(d.shopId)) return sendDeny(res, deny(404, "member_not_found"));
      return ok(res, { ...adminFlag(access), member: { ...pickPlain(d, GET_FIELDS), id: input.memberId } });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

function paidHistory(deps) {
  return async function handler(req, res) {
    try {
      const o = await open(req, res, "MemberPaidHistoryRequest", memberScreenRight);
      if (!o) return;
      const { access, input, keys } = o;
      const now = await readNow(deps);
      const since = new Date(now.getTime() - PAID_DAYS * DAY_MS);
      const snap = await db.collection("paidHistory")
        .where("memberId", "==", input.memberId)
        .where("timestamp", ">=", since)
        .select("shopId", "memberId", ...PAID_FIELDS)
        .get();
      const rows = (snap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.memberId === input.memberId && keys.includes(r.d.shopId))
        .map((r) => ({ ...r, ms: msOf(r.d.timestamp) }))
        .filter((r) => r.ms !== null && r.ms >= since.getTime())
        .sort((a, b) => (b.ms - a.ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ ...pickPlain(r.d, PAID_FIELDS), id: r.id }));
      return ok(res, { ...adminFlag(access), rows });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { indexSync, list, get, paidHistory, memberShopKeys };

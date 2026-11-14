// pos/shopStaff/checkInStatus — ใบลงเวลาที่ค้างอยู่ + ประวัติ 10 ใบล่าสุดของผู้เรียกเอง (DEV-0010 คลื่น 2 · อ่านอย่างเดียว)
//
// สัญญา: shopchamp-center/api/staff.checkInStatus.yaml · คำขอ StaffCheckInStatusRequest (@shopchamp/schema › requests/shopStaff.ts)
// แทน `shopchamp_app/src/screens/CheckInScreen.js:48` (checkIn doc) · `:54` (checkInHistory query) · `:78` (checkIn doc ก่อนออกงาน)
//
// คนที่ดู = uid ของ token เท่านั้น ❌ ไม่รับ profileId (Pack 2026-11-14 ข้อ 10 · ต่างจากแบบแอปพี่น้องที่รับจาก body)
// auth (route): 'user' แล้วตัดสินร้านในนี้ ด่านเดียวกับ staff.checkIn (`checkIn.js`):
//   auth.resolveShopAccess (ทีมงานก่อน · สมาชิก active + แพ็กเกจ · watcher) · ไม่ผ่าน = 403 not_shop_member {reason}
//   ยกเว้นข้อเดียว (AC-82): แถวของตัวเอง status 'active' แต่แพ็กเกจพนักงานหมด = ดูได้ (ไม่งั้นโหลดสถานะไม่ได้ ⇒ กดออกงานไม่ได้
//     ทั้งที่ staff.checkIn ยอมให้ออกงาน) · แถว inActive ยังถูกปัด
//   watcher ดูได้ (อ่านอย่างเดียว · ไม่มีใบของตัวเองในร้าน = current null history ว่าง)
//   สิทธิ์ '103' ลงเวลา (เมนู `shopchamp_app/src/screens/HomeScreen.js:95`) → 403 right_required
//   ไม่ดูแพ็กเกจพรีเมี่ยม (เมนูนี้ premium:false)
// ลำดับ: ไม่มี req.auth.uid 401 no_auth → schema → shop + watcher/roster → ร้านไม่มี 404 → ด่านข้างบน → อ่านใบ
// Firestore อ่าน: shop/{shopId} · watcher/roster · checkIn/{shop doc id + uid} · checkInHistory where id == <shop doc id + uid>
//   orderBy clockIn desc limit 10 (index id ASC, clockIn DESC มีใน firestore.indexes.json · query เดียวกับแอปเดิม)
//   ⇒ ใบลงเวลาเท่าของเดิม (1 + ≤10) · shop + roster คือค่าด่าน
// คำตอบ: {ok, current: rec|null, history: rec[≤10] เรียง clockIn ใหม่ก่อน, byAdmin?}
//   rec = {id (doc id), shopId, profileId, clockIn, clockOut, clockInImage, clockOutImage, billDate} · เวลาเป็น ISO · ช่องอื่นไม่ส่ง
//   current.id = doc id ใบค้าง (แอปใช้ผูกรหัสกันซ้ำตอนออกงาน `CheckInScreen.js:99`)
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { hasRight, adminFlag, resolveShopAccess, staffStatusOf, roleOf } = require("../_shared/auth");
const WR = require("../_shared/watcherRoster");
const { isObj, toIsoDeep } = require("./common");

const CHECKIN_RIGHT = "103";
const HISTORY_LIMIT = 10;
const REC_FIELDS = Object.freeze(["shopId", "profileId", "clockIn", "clockOut", "clockInImage", "clockOutImage", "billDate"]);

function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

/** recOf(id, d) — whitelist ช่องของใบลงเวลา · เวลาเป็น ISO · ไม่มีช่อง = null */
function recOf(id, d) {
  const out = { id };
  for (const k of REC_FIELDS) out[k] = d[k] === undefined ? null : toIsoDeep(d[k]);
  return out;
}

/** ms ของ clockIn ไว้เรียง (Timestamp/Date) · อ่านไม่ได้ = -Infinity (ไปท้าย) */
function clockMs(v) {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v && typeof v.toDate === "function") return v.toDate().getTime();
  return -Infinity;
}

function checkInStatus(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : null;
      if (!uid) return sendDeny(res, deny(401, "no_auth"));
      const body = isObj(req && req.body) ? req.body : {};
      const input = parseOr400(schemaOf("StaffCheckInStatusRequest"), body, res);
      if (!input) return;

      const now = await readNow(deps);
      const shopDocId = input.shopId;
      const [shopSnap, cfgSnap] = await Promise.all([db.collection("shop").doc(shopDocId).get(), WR.rosterRef(db).get()]);
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = shopSnap.data() || {};
      const verdict = await resolveShopAccess({ shopDocId, shop, uid, now, roster: WR.snapToRoster(cfgSnap) });
      let access = null;
      if (verdict.ok) access = verdict.access;
      else if (verdict.extra && verdict.extra.reason === "inactive" && staffStatusOf(shop, uid, null) === "active") {
        // AC-82: แถว active แต่แพ็กเกจพนักงานหมด → ดูสถานะได้ด้วยสิทธิ์ของแถวนั้น (แบบ op out ของ staff.checkIn)
        const row = (Array.isArray(shop.humanResource) ? shop.humanResource : []).find((p) => isObj(p) && p.id === uid && p.status === "active");
        const role = roleOf(row);
        access = { shopId: shopDocId, uid, role, rights: role === "staff" && Array.isArray(row.rights) ? row.rights.filter((r) => typeof r === "string") : [], packageExpired: true };
      } else return sendDeny(res, verdict);
      if (!hasRight(access, CHECKIN_RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const ciId = `${shopDocId}${uid}`;
      const [ciSnap, histSnap] = await Promise.all([
        db.collection("checkIn").doc(ciId).get(),
        db.collection("checkInHistory").where("id", "==", ciId).orderBy("clockIn", "desc").limit(HISTORY_LIMIT).get(),
      ]);
      const current = ciSnap.exists ? recOf(ciId, ciSnap.data() || {}) : null;
      // เรียง/กรองซ้ำในโค้ด: ฐานจริงเรียงและตัดมาแล้ว (ไม่มีผล) · กันฐานที่ไม่เรียงให้ (harness)
      const history = (histSnap.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.id === ciId)
        .sort((a, b) => clockMs(b.d.clockIn) - clockMs(a.d.clockIn))
        .slice(0, HISTORY_LIMIT)
        .map((r) => recOf(r.id, r.d));
      return ok(res, { current, history, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { checkInStatus };

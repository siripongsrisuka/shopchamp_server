// pos/shopStaff/checkIn — ลงเวลาเข้า/ออกงานของบัญชีที่เรียก ใน transaction (ก้อน 9c · DEV-0001)
//
// สัญญา: shopchamp-center/api/staff.checkIn.yaml · คำขอ StaffCheckInRequest (@shopchamp/schema › requests/shopStaff.ts)
// แทน `app:screens/CheckInScreen.js:64-147` (ปุ่มเดียวเดาทิศจาก doc · เขียน 3 ใบไม่รอผล ไม่ atomic · DI-40 · F17)
//
// auth (route): checkIfAuthenticated อย่างเดียว (แบบ profile.loading) · ตัดสินสิทธิ์เข้าร้านเองใน transaction
//   เหตุ: AC-82 (Pack: แก้ = ออกงานได้เสมอ) · requireShopAccess ปัดพนักงานที่แพ็กเกจพนักงานหมดทุกคำขอ ⇒ ออกงานไม่ได้
//   กติกา: auth.resolveShopAccess ตัวเดียวกับ middleware (ทีมงานก่อน · สมาชิก active + แพ็กเกจ) · ไม่ผ่าน = 403 not_shop_member {reason}
//     ยกเว้นข้อเดียว: op out + แถวของตัวเอง status 'active' แต่แพ็กเกจพนักงานหมด = ให้ออกงานได้ (สิทธิ์ตามแถวนั้น)
//     แถว inActive (เจ้าของปิดใช้งาน) ยังถูกปัดทุกทาง (decision 2026-11-06)
//
// ลำดับ: ไม่มี req.auth.uid 401 no_auth → schema → tx อ่านครบก่อนเขียน: shop · watcher/roster · checkIn/{shop doc id + uid} · checkInHistory/{requestId} · profile/{uid}
//   watcher ที่ไม่ใช่สมาชิก = 403 watcher_read_only (ลงเวลาเป็นการเขียนข้อมูลร้าน · DEV-0001 watcher)
//   ร้านไม่มี 404 · ตัดสินสิทธิ์ข้างบน · สิทธิ์ '103' ลงเวลา (เมนู `app:screens/HomeScreen.js:72,188`) → 403 right_required
//   op in : แพ็กเกจพนักงานหมด 403 staff_package_required (แอปเก่าปัดที่เมนู `HomeScreen.js:546`)
//           มีใบค้าง requestId เดิม = 200 duplicate · requestId อื่น = 409 already_checked_in (ทิศมาจากปุ่มที่ผู้ใช้กด ไม่เดา · DI-12)
//           requestId นี้เคยเข้างานไปแล้ว (ออกงานไปแล้วก็ตาม) = 200 duplicate ไม่เกิดใบใหม่ · จำจาก notification/checkIn_{requestId}
//             (ใบแจ้งเตือนไม่มีใครลบ: แอปเก่าและ server ไม่มีทางลบ) · ใบนั้นเป็นของคนอื่น/ร้านอื่น/ทิศอื่น = 409 request_id_conflict
//           เขียน checkIn รูปเดิม + clockIn/billDate จากเวลา server (DI-83) + requestId staffName (+ byAdmin adminUid)
//   op out: ใบประวัติ requestId นี้มีแล้วและเป็นของคนนี้ร้านนี้ = 200 duplicate · ของคนอื่น = 409 request_id_conflict
//           ไม่มีใบค้าง = 409 not_checked_in · ไม่ดูแพ็กเกจ (AC-82)
//           checkInHistory/{requestId} = เนื้อใบเดิมทั้งหมด + {id: doc id ใบเดิม, clockOut: now, clockOutImage, clockOutRequestId} · ลบใบ checkIn
//   ทั้ง 2 ทาง: notification/checkIn_{requestId} รูปเดิม `CheckInScreen.js:119-125` {heading, shopId, notificationContent, categoryId:3, timestamp}
//           + ช่องใหม่ profileId checkInOp (เพิ่มอย่างเดียว · จอประวัติแจ้งเตือนเดิมไม่อ่าน)
//   push OneSignal / LINE ของแอปเก่า (`CheckInScreen.js:126-142`) ยังอยู่ฝั่งแอป ไม่ทำที่นี่
// shopId ที่เขียน = doc id ร้าน (แอปเก่าเขียน shop.id · รายงานเว็บค้นด้วยค่านี้)
"use strict";

const { db } = require("../../firebase");
const { StaffCheckInRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { hasRight, adminTrail, adminFlag, resolveShopAccess, staffStatusOf, roleOf, isReadOnly } = require("../_shared/auth");
const WR = require("../_shared/watcherRoster");
const { isStaffPackageActive } = require("../_shared/premium");
const { billDateOf } = require("../_shared/billClock");
const { isObj, Refusal, refuse, thaiReceiptTime, displayName, toIsoDeep } = require("./common");

const CHECKIN_RIGHT = "103";
const HEADING = "เข้า - ออกงาน";
const NOTI_CATEGORY_CHECKIN = 3;

function checkIn(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : null;
      if (!uid) return sendDeny(res, deny(401, "no_auth"));
      const body = isObj(req && req.body) ? req.body : {};
      const input = parseOr400(StaffCheckInRequest, body, res);
      if (!input) return;

      const now = await readNow(deps);
      const shopDocId = input.shopId;
      const ciId = `${shopDocId}${uid}`;
      const shopRef = db.collection("shop").doc(shopDocId);
      const cfgRef = WR.rosterRef(db);
      const ciRef = db.collection("checkIn").doc(ciId);
      const histRef = db.collection("checkInHistory").doc(input.requestId);
      const profileRef = db.collection("profile").doc(uid);
      const notiRef = db.collection("notification").doc(`checkIn_${input.requestId}`); // id คงที่ต่อการกด ⇒ ส่งซ้ำไม่เกิดแจ้งเตือนซ้ำ
      let access = null;

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, cfgSnap, ciSnap, histSnap, profileSnap, notiSnap] = await Promise.all([tx.get(shopRef), tx.get(cfgRef), tx.get(ciRef), tx.get(histRef), tx.get(profileRef), tx.get(notiRef)]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const verdict = await resolveShopAccess({ shopDocId, shop, uid, now, roster: WR.snapToRoster(cfgSnap) });
        if (verdict.ok && isReadOnly(verdict.access)) refuse(deny(403, "watcher_read_only"));
        if (verdict.ok) access = verdict.access;
        else if (input.op === "out" && verdict.extra && verdict.extra.reason === "inactive" && staffStatusOf(shop, uid, null) === "active") {
          // AC-82: แถว active แต่แพ็กเกจพนักงานหมด → ออกงานได้ด้วยสิทธิ์ของแถวนั้น
          const row = (Array.isArray(shop.humanResource) ? shop.humanResource : []).find((p) => isObj(p) && p.id === uid && p.status === "active");
          const role = roleOf(row);
          access = { shopId: shopDocId, uid, role, rights: role === "staff" && Array.isArray(row.rights) ? row.rights.filter((r) => typeof r === "string") : [], packageExpired: true };
        } else refuse(verdict);
        if (!hasRight(access, CHECKIN_RIGHT)) refuse(deny(403, "right_required"));
        const trail = adminTrail(access);
        const name = displayName(profileSnap.exists ? profileSnap.data() : null, "");
        const ci = ciSnap.exists ? ciSnap.data() || {} : null;

        const noti = notiSnap.exists ? notiSnap.data() || {} : null;
        const notiMine = (op) => noti && noti.shopId === shopDocId && noti.profileId === uid && noti.checkInOp === op;
        if (input.op === "in") {
          if (ci && ci.requestId === input.requestId) return { duplicate: true, clockIn: toIsoDeep(ci.clockIn) };
          if (noti) {
            if (notiMine("in")) return { duplicate: true, clockIn: toIsoDeep(noti.timestamp) };
            refuse(deny(409, "request_id_conflict", "รหัสคำขอนี้ถูกใช้แล้ว"));
          }
          if (ci) {
            refuse(deny(409, "already_checked_in", "ลงเวลาเข้างานไว้แล้ว กรุณาลงเวลาออกก่อน", { clockIn: toIsoDeep(ci.clockIn) }));
          }
          if (!isStaffPackageActive(shop, now)) refuse(deny(403, "staff_package_required", "แพ็กเกจพนักงานหมดอายุ"));
          tx.set(ciRef, {
            clockIn: now,
            clockOut: now,
            shopId: shopDocId,
            profileId: uid,
            clockInImage: input.imageUrl,
            clockOutImage: "",
            id: "",
            billDate: billDateOf(now),
            requestId: input.requestId,
            staffName: name,
            ...trail,
          });
          tx.set(notiRef, { heading: HEADING, shopId: shopDocId, notificationContent: `${name}\nประเภท:เข้างาน\nเวลา:${thaiReceiptTime(now)} `, categoryId: NOTI_CATEGORY_CHECKIN, timestamp: now, profileId: uid, checkInOp: "in", ...trail });
          return { duplicate: false, clockIn: now.toISOString() };
        }

        // op out
        if (histSnap.exists) {
          const h = histSnap.data() || {};
          if (h.shopId === shopDocId && h.profileId === uid) return { duplicate: true, clockIn: toIsoDeep(h.clockIn), clockOut: toIsoDeep(h.clockOut) };
          refuse(deny(409, "request_id_conflict", "รหัสคำขอนี้ถูกใช้แล้ว"));
        }
        if (noti) refuse(deny(409, "request_id_conflict", "รหัสคำขอนี้ถูกใช้แล้ว")); // requestId ของการเข้างานส่งมาเป็นออกงาน
        if (!ci) refuse(deny(409, "not_checked_in", "ยังไม่ได้ลงเวลาเข้างาน"));
        tx.set(histRef, { ...ci, id: ciId, clockOut: now, clockOutImage: input.imageUrl, clockOutRequestId: input.requestId, ...trail });
        tx.delete(ciRef);
        tx.set(notiRef, { heading: HEADING, shopId: shopDocId, notificationContent: `${name}\nประเภท:ออกจากงาน\nเวลา:${thaiReceiptTime(now)} `, categoryId: NOTI_CATEGORY_CHECKIN, timestamp: now, profileId: uid, checkInOp: "out", ...trail });
        return { duplicate: false, clockIn: toIsoDeep(ci.clockIn), clockOut: now.toISOString() };
      });

      return ok(res, { op: input.op, checkInId: ciId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { checkIn };

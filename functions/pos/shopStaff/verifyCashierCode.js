// pos/shopStaff/verifyCashierCode — ตรวจรหัสแคชเชียร์ที่ server (บั๊ก #13 · DEV-0001)
//
// สัญญา: shopchamp-center/api/staff.verifyCashierCode.yaml · คำขอ StaffVerifyCashierCodeRequest (@shopchamp/schema › requests/cashierCode.ts)
// แทน `app:modal/Modal_Staff.js:96` (เทียบรหัสในเครื่องจาก shop.humanResource[].password ที่อ่านลงเครื่องทั้งร้าน)
// decision 2026-11-06 ข้อ #12 #13 ทาง 2: แอปใหม่ใช้ทางนี้ · สำเนาเดิมใน doc ร้านคงไว้ให้แอปเก่า ⇒ ที่มาของรหัส = humanResource[].password ตัวเดิม
//   (แอปเก่ายังตั้ง/แก้รหัสที่ช่องนี้ · ถ้า server เก็บที่อื่น 2 ที่จะไม่ตรงกัน) · ย้ายออกจาก doc ร้านเมื่อ Pack สั่งลบสำเนาเดิม
//
// ลำดับ: callerAccess → schema → สิทธิ์ '100' ขาย หรือ '101' ตั้งค่า (หน้าเลือกแคชเชียร์ตอนกดระบบขาย · ชุดเดียวกับ setCashierCode)
//   tx: shop · cashierCodeGuard/{shop doc id}_{staffId}
//   ร้านไม่มี 404 shop_not_found · ผู้เรียกไม่ active 403 not_shop_member (ทีมงาน byAdmin ผ่าน)
//   ไม่มีแถว 404 staff_not_found · ไม่ใช่เจ้าของและไม่มีสิทธิ์ '100' 409 not_cashier · ทุกแถวเป็น inActive 409 staff_inactive (C19)
//   ยังไม่ตั้งรหัส 409 code_not_set (แอปไปหน้าตั้งรหัสครั้งแรก staff.manage setCashierCode)
//   กำลังล็อก 429 code_locked {retryAfterSec} · ❌ ไม่เทียบรหัส ไม่นับ ไม่เขียน (ระหว่างล็อกเดาไม่ได้)
//   ตรง → ลบใบนับผิด (ถ้ามี) → 200 {staffId, staff: แถวไม่มี password email tel + hasPassword}
//   ผิด  → นับ failCount · ครบ MAX_FAILS = ล็อก LOCK_BASE_MS × 2^(lockCount-1) ไม่เกิน LOCK_MAX_MS แล้วเริ่มนับใหม่
//          ยังไม่ครบ 403 wrong_code {attemptsLeft} · ครบ 429 code_locked {retryAfterSec}
//   ใบนับผิดที่ผิดครั้งล่าสุดเก่ากว่า STALE_MS = เริ่มใหม่ทั้งหมด (lockCount ด้วย)
// เทียบรหัสด้วย timingSafeEqual บน sha256 (ไม่รั่วความยาว/ตำแหน่งที่ต่าง) · แถวซ้ำ id เดียวกัน = ตรงแถวไหนก็ได้
// ❌ ไม่คืนรหัส · ไม่ log รหัส · ใบนับผิดไม่เก็บรหัสหรือ hash ของรหัส (รหัส 4 หลัก hash แล้วเดากลับได้)
// ใบนับผิดเป็นของ server: rules ไม่มี match ⇒ client อ่าน/เขียนไม่ได้ (ค่าตั้งต้นของ firestore.rules)
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const { StaffVerifyCashierCodeRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, adminTrail, OWNER_POSITION } = require("../_shared/auth");
const { isObj, Refusal, refuse, callerStillActive } = require("./common");
const { publicRow } = require("./staffManage");

const SALE_RIGHT = "100";
const SETTINGS_RIGHT = "101";
const GUARD_COLLECTION = "cashierCodeGuard";
const MAX_FAILS = 5;
const LOCK_BASE_MS = 5 * 60 * 1000;
const LOCK_MAX_MS = 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

const isOwnerRow = (p) => isObj(p) && Array.isArray(p.position) && p.position.includes(OWNER_POSITION);
const codeOf = (p) => (typeof p.password === "string" ? p.password : typeof p.password === "number" && Number.isFinite(p.password) ? String(p.password) : "");
const msOf = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v && typeof v.toDate === "function") return v.toDate().getTime();
  return null;
};
const digest = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest();
const sameCode = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const lockMsOf = (lockCount) => Math.min(LOCK_BASE_MS * 2 ** Math.max(0, lockCount - 1), LOCK_MAX_MS);

function verifyCashierCode(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(StaffVerifyCashierCodeRequest, body, res);
      if (!input) return;
      if (![SALE_RIGHT, SETTINGS_RIGHT].some((r) => hasRight(access, r))) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const nowMs = now.getTime();
      const shopRef = db.collection("shop").doc(access.shopId);
      const guardRef = db.collection(GUARD_COLLECTION).doc(`${access.shopId}_${input.staffId}`);

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, guardSnap] = await Promise.all([tx.get(shopRef), tx.get(guardRef)]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);

        const hr = Array.isArray(shop.humanResource) ? shop.humanResource : [];
        const mine = hr.filter((p) => isObj(p) && p.id === input.staffId);
        if (!mine.length) refuse(deny(404, "staff_not_found", "ไม่พบพนักงานคนนี้ในร้าน"));
        if (!mine.some((p) => isOwnerRow(p) || (Array.isArray(p.rights) && p.rights.includes(SALE_RIGHT)))) refuse(deny(409, "not_cashier", "พนักงานคนนี้ไม่มีสิทธิ์ขาย"));
        if (mine.every((p) => p.status === "inActive")) refuse(deny(409, "staff_inactive", "พนักงานคนนี้ถูกปิดการใช้งาน"));
        const codes = mine.map(codeOf).filter((c) => c !== "");
        if (!codes.length) refuse(deny(409, "code_not_set", "พนักงานคนนี้ยังไม่ได้ตั้งรหัสแคชเชียร์"));

        let g = guardSnap.exists ? guardSnap.data() || {} : {};
        const lastFail = msOf(g.lastFailAt);
        if (lastFail !== null && nowMs - lastFail > STALE_MS) g = {};
        const lockedUntil = msOf(g.lockedUntil);
        if (lockedUntil !== null && lockedUntil > nowMs) return { locked: true, retryAfterSec: Math.ceil((lockedUntil - nowMs) / 1000) };

        if (codes.some((c) => sameCode(c, input.password))) {
          if (guardSnap.exists) tx.delete(guardRef);
          return { match: true, staff: publicRow(mine[0]) };
        }

        const failCount = (Number.isInteger(g.failCount) && g.failCount > 0 ? g.failCount : 0) + 1;
        const prevLocks = Number.isInteger(g.lockCount) && g.lockCount > 0 ? g.lockCount : 0;
        const doc = { shopId: access.shopId, staffId: input.staffId, lastFailAt: now, lastFailBy: access.uid, ...adminTrail(access) };
        if (failCount >= MAX_FAILS) {
          const lockCount = prevLocks + 1;
          const ms = lockMsOf(lockCount);
          tx.set(guardRef, { ...doc, failCount: 0, lockCount, lockedUntil: new Date(nowMs + ms) });
          return { locked: true, justLocked: true, retryAfterSec: Math.ceil(ms / 1000) };
        }
        tx.set(guardRef, { ...doc, failCount, lockCount: prevLocks, lockedUntil: null });
        return { wrong: true, attemptsLeft: MAX_FAILS - failCount };
      });

      if (out.locked) {
        return fail(res, 429, "code_locked", `กรอกรหัสผิดหลายครั้ง ลองใหม่ใน ${Math.ceil(out.retryAfterSec / 60)} นาที หรือให้เจ้าของร้านตรวจรหัสที่หน้าจัดการพนักงาน`, { retryAfterSec: out.retryAfterSec, ...adminFlag(access) });
      }
      if (out.wrong) return fail(res, 403, "wrong_code", "รหัสแคชเชียร์ไม่ถูกต้อง", { attemptsLeft: out.attemptsLeft, ...adminFlag(access) });
      return ok(res, { staffId: input.staffId, staff: out.staff, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { verifyCashierCode, MAX_FAILS, LOCK_BASE_MS, LOCK_MAX_MS, STALE_MS, GUARD_COLLECTION };

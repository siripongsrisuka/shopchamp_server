// pos/shopStaff/staffManage — จัดการพนักงานของร้านทีละคน ใน transaction (ก้อน 9c · DEV-0001)
//
// สัญญา: shopchamp-center/api/staff.manage.yaml · คำขอ StaffManageRequest (@shopchamp/schema › requests/shopStaff.ts)
// แทน `app:screens/StaffScreen.js:263-316` (เขียน humanResource + noti* ทั้งก้อนจาก state ที่โหลดตอนเปิดจอ · DI-01 · C18)
//   และ `app:Modal/Modal_Human.js:59` (ค้น profile ด้วยเบอร์ตรงจากเครื่อง · ได้อีเมล เบอร์ของคนอื่นทั้งก้อน)
//
// ลำดับ: callerAccess → schema → สิทธิ์ → 403 right_required
//   find add update remove = '101' (จอพนักงานอยู่ใต้เมนูตั้งค่า) · setCashierCode = '100' ขาย หรือ '101' (หน้าเลือกแคชเชียร์ตอนกดระบบขาย `HomeScreen.js:595,620`)
//   op find   ค้น profile where tel == (นอก transaction · อ่านอย่างเดียว) · คืน {id, name, imageId, inShop} เท่านั้น ❌ อีเมล เบอร์ (DI-22 · PDPA)
//   op add    tx: shop · profile/{staffId}
//             ผู้เรียกไม่ active 403 · มีในร้านแล้ว = 200 existed:true ไม่เขียน (ส่งซ้ำหลังสำเร็จได้ผลเดิม) · ไม่มี profile 404 profile_not_found
//             แพ็กเกจพนักงานหมด 403 staff_package_required (แอปเก่าปัดที่ปุ่ม `StaffScreen.js:333-343`)
//             แถวใหม่รูปเดิม {id, name, email, tel, imageId (จาก profile ในฐาน), position:[], status:'active', rights, password:''} ต่อท้าย
//             ใส่ id ลงผู้รับแจ้งเตือนตาม notify
//   op update tx: shop · ไม่มีแถว 404 staff_not_found · แถวเจ้าของ (position มี '001') ห้ามเปลี่ยนเป็น inActive 409 owner_protected
//             แก้เฉพาะช่องที่ส่ง (rights · status · password · ผู้รับแจ้งเตือนรายทาง) · ทุกแถวที่ id ตรง (ร้านที่มีแถวซ้ำ)
//             password ว่างไม่รับ (C16) · ล้างรหัสต้องส่ง clearPassword
//             รหัสแคชเชียร์ของแถวเจ้าของ แก้หรือล้างได้เฉพาะเจ้าของ/ทีมงาน 403 owner_required (C16 · กันพนักงานตั้งรหัสเจ้าของแล้วขายในชื่อเจ้าของ)
//             status inActive + ใบเข้างานค้าง → ปิดใบให้แบบเดียวกับ remove {autoClosed:'staff_inactive'} (ปิดใช้งานแล้วพนักงานกดออกงานเองไม่ได้)
//   op setCashierCode tx: shop · ไม่มีแถว 404 staff_not_found · แถวไม่มีสิทธิ์ '100' 409 not_cashier (หน้าเดิมแสดงเฉพาะคนมี '100')
//             แถวเจ้าของ + ผู้เรียกไม่ใช่เจ้าของ 403 owner_required · มีรหัสแล้ว 409 code_already_set (C18 · ของเดิมเขียนทับไม่ดูรหัสเดิม)
//             รหัสเดิมเท่าที่ส่ง = 200 duplicate ไม่เขียน
//   op remove tx: shop · checkIn/{shop doc id + staffId}
//             ไม่มีแถว = 200 removed:false (ส่งซ้ำได้) · แถวเจ้าของ 409 owner_protected
//             ลบทุกแถวที่ id ตรง + เอา id ออกจากผู้รับแจ้งเตือนทั้ง 9 ช่อง (แอปเก่าลืม notiShift notiCancelBill · shop S2)
//             ใบเข้างานที่ค้าง → ย้ายเข้า checkInHistory {autoClosed:'staff_removed', clockOut: now, closedBy} แล้วลบ (DI-12 ส่วนถอดพนักงาน)
// คำตอบ: แถวพนักงานไม่มี password email tel (#13 · DI-22) · humanResource ในฐานยังเก็บ email tel รูปเดิม (แอปเก่าอ่าน `initialResource`)
// เขียน shop ด้วย tx.update เฉพาะ humanResource และช่องผู้รับที่เปลี่ยน + `staffUpdate:{at, by, op, staffId, byAdmin?, adminUid?}` (เพิ่มอย่างเดียว)
// ❌ ไม่คืนแถว humanResource ดิบ (มีรหัสแคชเชียร์ #13) · คืนแถวที่แก้แบบไม่มี password + hasPassword
"use strict";

const { db } = require("../../firebase");
const { StaffManageRequest, STAFF_NOTIFY_FIELDS } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, isOwner, adminFlag, OWNER_POSITION } = require("../_shared/auth");
const { isStaffPackageActive } = require("../_shared/premium");
const { isObj, Refusal, refuse, callerStillActive } = require("./common");

const SETTINGS_RIGHT = "101";
const SALE_RIGHT = "100";
const rightsFor = (op) => (op === "setCashierCode" ? [SALE_RIGHT, SETTINGS_RIGHT] : [SETTINGS_RIGHT]);
const ALL_NOTI_FIELDS = Object.freeze(["notiImport", "notiShift", "notiStaff", "notiStock", "notiSummary", "notiCancelBill", "notiCheckin", "notiCredit", "notiRequisition"]);
const FIND_LIMIT = 10;

const isOwnerRow = (p) => isObj(p) && Array.isArray(p.position) && p.position.includes(OWNER_POSITION);
const idList = (v) => (Array.isArray(v) ? v : []);

/** publicRow(p) — แถวพนักงานที่ส่งออกได้ (ตัดรหัสแคชเชียร์ #13 · อีเมลและเบอร์ DI-22) */
function publicRow(p) {
  const { password, email, tel, ...rest } = p; // eslint-disable-line no-unused-vars
  return { ...rest, hasPassword: typeof password === "string" && password !== "" };
}

function trailOf(access, now, op, staffId) {
  const t = { at: now, by: access.uid, op, staffId };
  if (access.byAdmin === true) { t.byAdmin = true; t.adminUid = access.uid; }
  return t;
}

async function find(input, res, access) {
  const snap = await db.collection("profile").where("tel", "==", input.tel).limit(FIND_LIMIT).get();
  const shopSnap = await db.collection("shop").doc(access.shopId).get();
  const hr = shopSnap.exists ? idList((shopSnap.data() || {}).humanResource) : [];
  const inShop = new Set(hr.filter(isObj).map((p) => p.id));
  const people = (snap.docs || []).map((d) => {
    const p = d.data() || {};
    return { id: d.id, name: typeof p.name === "string" ? p.name : "", imageId: typeof p.imageId === "string" ? p.imageId : "", inShop: inShop.has(d.id) };
  });
  return ok(res, { people });
}

/** closeCheckIn — ใบเข้างานที่ค้าง → checkInHistory {autoClosed, clockOut: now, closedBy} แล้วลบ · คืน true ถ้าปิด */
function closeCheckIn(tx, checkInRef, checkInSnap, access, now, why) {
  if (!checkInSnap || !checkInSnap.exists) return false;
  const ci = checkInSnap.data() || {};
  const tag = why === "staff_removed" ? "removed" : "inactive";
  const histRef = db.collection("checkInHistory").doc(`${checkInRef.id}_${tag}_${now.getTime()}`);
  const hist = { ...ci, id: checkInRef.id, clockOut: now, clockOutImage: "", autoClosed: why, closedBy: access.uid };
  if (access.byAdmin === true) { hist.byAdmin = true; hist.adminUid = access.uid; }
  tx.set(histRef, hist);
  tx.delete(checkInRef);
  return true;
}

function staffManage(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(StaffManageRequest, body, res);
      if (!input) return;
      if (!rightsFor(input.op).some((r) => hasRight(access, r))) return sendDeny(res, deny(403, "right_required"));
      if (input.op === "find") return await find(input, res, access);

      const now = await readNow(deps);
      const shopDocId = access.shopId;
      const shopRef = db.collection("shop").doc(shopDocId);
      const profileRef = input.op === "add" ? db.collection("profile").doc(input.staffId) : null;
      const closesCheckIn = input.op === "remove" || (input.op === "update" && input.status === "inActive");
      const checkInRef = closesCheckIn ? db.collection("checkIn").doc(`${shopDocId}${input.staffId}`) : null;

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, profileSnap, checkInSnap] = await Promise.all([
          tx.get(shopRef),
          profileRef ? tx.get(profileRef) : Promise.resolve(null),
          checkInRef ? tx.get(checkInRef) : Promise.resolve(null),
        ]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);

        const hr = idList(shop.humanResource);
        const mine = hr.filter((p) => isObj(p) && p.id === input.staffId);
        const write = {};
        let result;

        if (input.op === "add") {
          if (mine.length) return { existed: true, staff: publicRow(mine[0]) };
          if (!profileSnap.exists) refuse(deny(404, "profile_not_found", "ไม่พบบัญชีผู้ใช้นี้"));
          if (!isStaffPackageActive(shop, now)) refuse(deny(403, "staff_package_required", "แพ็กเกจพนักงานหมดอายุ เพิ่มพนักงานไม่ได้"));
          const p = profileSnap.data() || {};
          const str = (v) => (typeof v === "string" ? v : "");
          const row = { id: input.staffId, name: str(p.name), email: str(p.email), tel: str(p.tel), imageId: str(p.imageId), position: [], status: "active", rights: input.rights, password: "" };
          write.humanResource = [...hr, row];
          for (const key of input.notify) {
            const f = STAFF_NOTIFY_FIELDS[key];
            const cur = idList(shop[f]);
            if (!cur.includes(input.staffId)) write[f] = [...cur, input.staffId];
          }
          result = { existed: false, staff: publicRow(row) };
        } else if (input.op === "update") {
          if (!mine.length) refuse(deny(404, "staff_not_found", "ไม่พบพนักงานคนนี้ในร้าน"));
          if (input.status === "inActive" && mine.some(isOwnerRow)) refuse(deny(409, "owner_protected", "ปิดการใช้งานเจ้าของร้านไม่ได้"));
          if ((input.password !== undefined || input.clearPassword === true) && mine.some(isOwnerRow) && !isOwner(access)) {
            refuse(deny(403, "owner_required", "รหัสแคชเชียร์ของเจ้าของร้าน แก้ได้เฉพาะเจ้าของ"));
          }
          const patch = {};
          if (input.rights !== undefined) patch.rights = input.rights;
          if (input.status !== undefined) patch.status = input.status;
          if (input.password !== undefined) patch.password = input.password;
          if (input.clearPassword === true) patch.password = "";
          if (Object.keys(patch).length) write.humanResource = hr.map((p) => (isObj(p) && p.id === input.staffId ? { ...p, ...patch } : p));
          for (const [key, on] of Object.entries(input.notify || {})) {
            const f = STAFF_NOTIFY_FIELDS[key];
            const cur = idList(shop[f]);
            const has = cur.includes(input.staffId);
            if (on && !has) write[f] = [...cur, input.staffId];
            if (!on && has) write[f] = cur.filter((x) => x !== input.staffId);
          }
          const updated = (write.humanResource || hr).find((p) => isObj(p) && p.id === input.staffId);
          result = { staff: publicRow(updated), closedCheckIn: input.status === "inActive" ? closeCheckIn(tx, checkInRef, checkInSnap, access, now, "staff_inactive") : undefined };
        } else if (input.op === "setCashierCode") {
          if (!mine.length) refuse(deny(404, "staff_not_found", "ไม่พบพนักงานคนนี้ในร้าน"));
          if (!mine.some((p) => isOwnerRow(p) || (Array.isArray(p.rights) && p.rights.includes(SALE_RIGHT)))) refuse(deny(409, "not_cashier", "พนักงานคนนี้ไม่มีสิทธิ์ขาย"));
          if (mine.some(isOwnerRow) && !isOwner(access)) refuse(deny(403, "owner_required", "รหัสแคชเชียร์ของเจ้าของร้าน ตั้งได้เฉพาะเจ้าของ"));
          const codes = mine.map((p) => (typeof p.password === "string" ? p.password : ""));
          if (codes.every((c) => c === input.password)) return { duplicate: true };
          if (codes.some((c) => c !== "")) refuse(deny(409, "code_already_set", "พนักงานคนนี้ตั้งรหัสไว้แล้ว ถ้าลืมให้เจ้าของล้างรหัสที่หน้าจัดการพนักงาน"));
          write.humanResource = hr.map((p) => (isObj(p) && p.id === input.staffId ? { ...p, password: input.password } : p));
          result = { duplicate: false };
        } else {
          if (!mine.length) return { removed: false };
          if (mine.some(isOwnerRow)) refuse(deny(409, "owner_protected", "ลบเจ้าของร้านไม่ได้"));
          write.humanResource = hr.filter((p) => !(isObj(p) && p.id === input.staffId));
          for (const f of ALL_NOTI_FIELDS) {
            const cur = idList(shop[f]);
            if (cur.includes(input.staffId)) write[f] = cur.filter((x) => x !== input.staffId);
          }
          result = { removed: true, closedCheckIn: closeCheckIn(tx, checkInRef, checkInSnap, access, now, "staff_removed") };
        }

        if (Object.keys(write).length) {
          write.staffUpdate = trailOf(access, now, input.op, input.staffId);
          tx.update(shopRef, write);
        }
        return result;
      });

      return ok(res, { op: input.op, staffId: input.staffId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { staffManage, publicRow };

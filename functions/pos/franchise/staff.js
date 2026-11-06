// pos/franchise/staff.js — พนักงานของแฟรนไชส์: ค้นบัญชีจากเบอร์ · เพิ่ม · แก้สิทธิ์ · เอาออก (ก้อน 9f · DEV-0002) · สิทธิ์ 723
//
// สัญญา: shopchamp-center/api/franchise.{staffFind,staffSave}.yaml
// แทน (census chunk6-log.md): 282 `fr:modal/Modal_FindHuman.js:46` (profile ทั้ง doc เข้าเครื่อง SF-16) · 276 277 `fr:screens/StaffScreen.js:36-78`
//   เดิม: เขียนทั้ง array humanRight จากค่าเก่า (DI-37 · SF-07) · เพิ่มคนซ้ำสิทธิ์หาย (SF-32) · คัด profile ทั้งก้อนลง doc (SF-02)
//   ลบตัวเอง/คนสุดท้ายที่มีสิทธิ์ 723 ได้ ⇒ แฟรนไชส์ไม่มีผู้ดูแล (SF-41 · DI-70)
// เขียน humanRight + humanResource (= id ของ humanRight เหมือนเดิม StaffScreen.js:47) ใน transaction ที่อ่าน doc สด
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const F = require("./_franchise");

const plain = (ref) => ref.get();
const FIND_MAX = 10;

// ── franchise.staffFind ──
const staffFind = F.makeHandler("FranchiseStaffFindRequest", async ({ uid, input }) => {
  const { franchise } = await F.readGate(plain, input.franchiseId, uid, { rights: [F.RIGHT.STAFF] });
  const snap = await db.collection("profile").where("tel", "==", input.tel).limit(FIND_MAX).get();
  const inList = new Set(F.arr(franchise.humanRight).filter(F.isObj).map((r) => r.id));
  const profiles = snap.docs.map((d) => {
    const p = d.data() || {};
    return { id: d.id, name: F.str(p.name), tel: F.str(p.tel), imageId: F.str(p.imageId), alreadyStaff: inList.has(d.id) };
  });
  return { profiles, count: profiles.length };
});

// ── franchise.staffSave ──
// นับเฉพาะแถวที่ใช้งานได้ (ไม่มีช่อง status หรือ 'active') · ด่านเดียวกับ franchiseAccessOf ⇒ แถวไม่ใช้งานตั้งสิทธิ์ไม่ได้อยู่แล้ว
const isActiveRow = (r) => typeof r.status !== "string" || r.status === "active";
const has723 = (rows) => rows.some((r) => isActiveRow(r) && F.arr(r.rights).includes(F.RIGHT.STAFF));

const staffSave = F.makeHandler("FranchiseStaffSaveRequest", async ({ uid, input, now }) => db.runTransaction(async (tx) => {
  const pRef = db.collection("profile").doc(input.staffUid);
  const [{ ref, franchise, access }, pSnap] = await Promise.all([
    F.readGate((r) => tx.get(r), input.franchiseId, uid, { rights: [F.RIGHT.STAFF] }),
    input.op === "add" ? tx.get(pRef) : Promise.resolve(null),
  ]);
  // แถวเดิมทุกตัวเหลือเฉพาะช่องของแถว (SF-02 · ทิ้ง port currentLogin birthday ที่ติดมาจากของเดิม)
  const before = F.arr(franchise.humanRight).filter(F.isObj).map(F.staffRow);
  const idx = before.findIndex((r) => r.id === input.staffUid);
  const rights = input.rights ? [...new Set(input.rights)] : null;
  let after;
  if (input.op === "add") {
    // กดซ้ำหลังคำตอบหาย: อยู่แล้วและสิทธิ์เท่าที่ขอ = สำเร็จไปแล้ว · สิทธิ์ต่าง = 409 ไม่ทับ (SF-32)
    if (idx >= 0 && F.sameValue([...before[idx].rights].sort(), [...rights].sort())) return { op: "add", staffUid: input.staffUid, duplicate: true, ...F.adminFlag(access) };
    if (idx >= 0) F.refuse(deny(409, "staff_exists", "คนนี้อยู่ในรายชื่อแล้ว แก้สิทธิ์จากรายการแทน"));
    if (!pSnap.exists) F.refuse(deny(404, "profile_not_found", "ไม่พบบัญชีผู้ใช้"));
    const p = pSnap.data() || {};
    after = [...before, F.staffRow({ id: input.staffUid, name: p.name, tel: p.tel, email: p.email, imageId: p.imageId, rights })];
  } else if (input.op === "update") {
    if (idx < 0) F.refuse(deny(404, "staff_not_found", "ไม่พบคนนี้ในรายชื่อ"));
    if (F.sameValue([...before[idx].rights].sort(), [...rights].sort())) return { op: "update", staffUid: input.staffUid, unchanged: true, ...F.adminFlag(access) };
    after = before.map((r, i) => (i === idx ? { ...r, rights } : r));
  } else {
    if (idx < 0) return { op: "remove", staffUid: input.staffUid, removed: false, ...F.adminFlag(access) };
    after = before.filter((_, i) => i !== idx);
  }
  // ต้องเหลือคนที่ตั้งสิทธิ์ได้อย่างน้อย 1 คน (SF-41) · ของเดิมที่ไม่มีใครมี 723 อยู่ก่อน = ไม่บังคับ
  if (has723(before) && !has723(after)) F.refuse(deny(409, "last_staff_admin", "ต้องเหลือคนที่มีสิทธิ์กำหนดสิทธิ์อย่างน้อย 1 คน"));
  tx.update(ref, { humanRight: after, humanResource: after.map((r) => r.id), updateTime: now, updatedBy: uid, ...F.adminTrail(access) });
  return { op: input.op, staffUid: input.staffUid, ...(input.op === "remove" ? { removed: true } : {}), count: after.length, ...F.adminFlag(access) };
}));

module.exports = { staffFind, staffSave };

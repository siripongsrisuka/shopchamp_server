// pos/member/delete — ลบสมาชิก + เอาแถวออกจากดัชนีค้นหา + ตัวนับสมาชิกจากจำนวนจริง (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.delete.yaml · คำขอ MemberDeleteRequest
// ทางเดิม: `main3:src/screens/MemberScreen.js:328-356` (W9 + L3 + C3 ใน transaction) · ปุ่มลบไม่ตรวจสิทธิ์ (K11)
//   ⇒ ค่าตั้งต้นที่เลือก: สิทธิ์ '126' แก้ไขสมาชิก (ข้อเปิดในเอกสาร 9b · Pack เปลี่ยนได้)
//   ของเดิม totalMember − 1 จากค่าในฐาน แม้สมาชิกถูกลบไปแล้ว (F58) ⇒ ใหม่นับจากจำนวนจริง
//
// transaction: shop (ด่าน _gate) · member (404 / 409 ร้านอื่น #8) · memberList/{letter+shopField} เมื่อมี letter
//   + นับสมาชิกจริงด้วย count() (อ่านนอก transaction · รวมคนที่กำลังลบ) · ร้าน S5 ที่พิสูจน์ไม่ได้ = max(นับได้, ตัวนับเดิม) − 1
// เขียน: ดัชนี {members ไม่มีแถวนี้, updateTime} (มี doc เท่านั้น) · shop {totalMember: จำนวนจริง − 1} · member delete (ลบจริงแบบเดิม)
//   ส่งซ้ำหลังลบสำเร็จ = 404 member_not_found ไม่เขียนอะไร (แอปถือว่าลบแล้ว)
//   ❓ สมาชิกที่ยังมีหนี้เงินเซ็นลบได้ตามเดิม (ข้อเปิด K11 ส่วน "ลบสมาชิกที่มีหนี้")
"use strict";

const { db } = require("../../firebase");
const { MemberDeleteRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, checkOwnedDoc } = require("../_shared/auth");
const { Refusal, refuse, readShopForWrite, isObj, storedCount } = require("./_gate");

const DELETE_RIGHT = "126"; // แก้ไขสมาชิก (main3 src/screens/StaffScreen.js:73)

function del(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(MemberDeleteRequest, body, res);
      if (!input) return;
      if (!hasRight(access, DELETE_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: DELETE_RIGHT }));

      const now = await readNow(deps);
      const memberRef = db.collection("member").doc(input.memberId);

      const out = await db.runTransaction(async (tx) => {
        const { shopRef, shop, ref, shopField, fieldUnproven } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const memberSnap = await tx.get(memberRef);
        const member = memberSnap.exists ? memberSnap.data() : undefined;
        const mc = checkOwnedDoc("member", member, ref);
        if (!mc.ok) refuse(mc);
        const letter = logic.isMemberLetter(member.letter) ? member.letter : null;
        const listRef = letter ? db.collection("memberList").doc(letter + shopField) : null;
        const listSnap = listRef ? await tx.get(listRef) : null;
        const countSnap = await db.collection("member").where("shopId", "==", shopField).count().get();
        const count = countSnap && typeof countSnap.data === "function" ? countSnap.data().count : undefined;
        if (!Number.isInteger(count) || count < 0) refuse(deny(500, "internal_error"));
        // S5 ที่พิสูจน์ไม่ได้: นับด้วย doc id ไม่เห็นสมาชิกเดิม ⇒ ตัวนับเดิม − 1 แบบแอปเก่า (C3) ไม่เขียนทับเป็นเลขเล็ก (ผ4)
        const totalMember = fieldUnproven ? Math.max(0, Math.max(count, storedCount(shop)) - 1) : Math.max(0, count - 1);

        if (listSnap && listSnap.exists) {
          tx.update(listRef, { members: logic.memberIndexRemove((listSnap.data() || {}).members, input.memberId), updateTime: now });
        }
        tx.update(shopRef, { totalMember });
        tx.delete(memberRef);
        return { totalMember, index: listSnap && listSnap.exists ? "updated" : "skipped" };
      });

      return ok(res, { memberId: input.memberId, deleted: true, totalMember: out.totalMember, index: out.index, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { delete: del, del };

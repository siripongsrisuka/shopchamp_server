// pos/member/update — แก้ชื่อและเบอร์สมาชิก + แก้แถวดัชนีค้นหาให้ตรง (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.update.yaml · คำขอ MemberUpdateRequest
// ทางเดิม: `main3:src/Modal/Modal_EditMember.js:31-37` `member.update({name, tel})` อย่างเดียว · ไม่แตะ memberList (F28)
//   สิทธิ์เดิมตรวจที่จอ '126' แก้ไขสมาชิก (`main3:src/screens/MemberScreen.js:413-416`) ⇒ server ตรวจเอง
//
// transaction: shop (ด่าน _gate) · member (404 / 409 ร้านอื่น · #8 K3) · memberList/{letter+shopField} เมื่อสมาชิกมี letter ที่ใช้ได้
// เขียน: member {name, tel} + รอยทีมงาน (_gate trailFor: ทีมงาน = byAdmin adminUid · คนในร้านแก้ต่อ = ล้างรอย) · ดัชนี: มี doc = แทนแถว id นี้ (ไม่มีแถว = ต่อท้าย) + updateTime ใหม่ ⇒ จอขายทุกเครื่องดึงชื่อใหม่ (F28)
//   letter ใช้ได้แต่ไม่มี doc ดัชนี = set doc ใหม่ 1 แถว · ไม่มี letter (ร้านยังไม่ย้ายดัชนี) = ไม่แตะดัชนี ให้ member.rebuildIndex ทำ
//   ชื่อในตะกร้า ใบเสร็จ และ bill.member ที่ออกไปแล้วไม่เปลี่ยน (F29 เป็นงานของจอ)
"use strict";

const { db } = require("../../firebase");
const { MemberUpdateRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, checkOwnedDoc } = require("../_shared/auth");
const { Refusal, refuse, readShopForWrite, isObj, trailFor } = require("./_gate");

const EDIT_RIGHT = "126"; // แก้ไขสมาชิก (main3 src/screens/StaffScreen.js:73)

function update(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(MemberUpdateRequest, body, res);
      if (!input) return;
      if (!hasRight(access, EDIT_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: EDIT_RIGHT }));

      const now = await readNow(deps);
      const memberRef = db.collection("member").doc(input.memberId);

      const out = await db.runTransaction(async (tx) => {
        const { ref, shopField } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const memberSnap = await tx.get(memberRef);
        const member = memberSnap.exists ? memberSnap.data() : undefined;
        const mc = checkOwnedDoc("member", member, ref);
        if (!mc.ok) refuse(mc);
        const letter = logic.isMemberLetter(member.letter) ? member.letter : null;
        const listRef = letter ? db.collection("memberList").doc(letter + shopField) : null;
        const listSnap = listRef ? await tx.get(listRef) : null;

        tx.update(memberRef, { name: input.name, tel: input.tel, ...trailFor(access, member) });
        const row = logic.memberIndexRowOf(input.memberId, { name: input.name, tel: input.tel });
        let index = "skipped";
        if (listRef && listSnap.exists) {
          tx.update(listRef, { members: logic.memberIndexUpsert((listSnap.data() || {}).members, row), updateTime: now });
          index = "updated";
        } else if (listRef) {
          tx.set(listRef, { shopId: shopField, members: [row], updateTime: now });
          index = "created";
        }
        return { index };
      });

      return ok(res, { memberId: input.memberId, name: input.name, tel: input.tel, index: out.index, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { update };

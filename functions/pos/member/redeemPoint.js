// pos/member/redeemPoint — ตัดแต้มที่ลูกค้าใช้แลกนอกบิล + สมุดตัดแต้ม (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.redeemPoint.yaml · คำขอ MemberRedeemPointRequest
// ทางเดิม: `main3:src/Modal/Modal_PointMember.js:37-50` · ด่านเทียบค่าใน redux (F12) แล้ว `point - minusPoint` ใน transaction ไม่ตรวจซ้ำ (K12)
//   สิทธิ์เดิมตรวจที่จอ '125' จัดการแต้มสะสม (`main3:src/screens/MemberScreen.js:383-386`) ⇒ server ตรวจเอง
//
// transaction (อ่านครบก่อนเขียน): shop (ด่าน _gate) · pointHistory/{requestId} · member
//   requestId มีแล้วของร้านนี้ + สมาชิกเดิม + แต้มเดิม = 200 duplicate (กดซ้ำไม่ตัดซ้ำ F11) · คนละรายการ = 409 request_id_mismatch
//     ของร้านอื่น = 409 request_id_other_shop · ตรวจก่อนสมาชิก เพราะส่งซ้ำหลังสมาชิกถูกลบได้
//   member ไม่มี 404 (F56 ของเดิมปิดหน้าต่างเหมือนสำเร็จ) · ร้านอื่น 409 member_other_shop (#8 K3)
//   staffId ไม่อยู่ในร้าน 409 staff_not_in_shop · ไม่ active 409 staff_inactive (B-11 แบบ member.payCredit)
//   logic.redeemMemberPoint กับแต้มในฐานตอนนั้น: ไม่พอ = 409 point_insufficient (K12 · F12)
// เขียน: member {point: แต้มหลังตัด} (ฟิลด์เดิม ชนิดเดิม) + รอยทีมงาน (_gate trailFor) · pointHistory/{requestId} ใหม่ (K12 สมุดตัดแต้ม · entities/pointHistory.ts)
"use strict";

const { db } = require("../../firebase");
const { MemberRedeemPointRequest, PointHistory } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, belongsToShop, checkOwnedDoc, staffStatusOf } = require("../_shared/auth");
const { billDateOf } = require("../_shared/billClock");
const { Refusal, refuse, readShopForWrite, isObj, trailFor } = require("./_gate");

const POINT_RIGHT = "125"; // จัดการแต้มสะสม (main3 src/screens/StaffScreen.js:72)
const sameRequest = (prev, input) => prev.memberId === input.memberId && Number(prev.points) === input.points;

function redeemPoint(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(MemberRedeemPointRequest, body, res);
      if (!input) return;
      if (!hasRight(access, POINT_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: POINT_RIGHT }));

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const memberRef = db.collection("member").doc(input.memberId);
      const histRef = db.collection("pointHistory").doc(input.requestId);

      const out = await db.runTransaction(async (tx) => {
        const { shop, ref, shopField } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const [histSnap, memberSnap] = await Promise.all([tx.get(histRef), tx.get(memberRef)]);

        if (histSnap.exists) {
          const prev = histSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) refuse(deny(409, "request_id_other_shop", "รหัสรายการนี้เป็นของร้านอื่น"));
          if (!sameRequest(prev, input)) refuse(deny(409, "request_id_mismatch", "รหัสรายการนี้ใช้กับรายการอื่นไปแล้ว"));
          return { duplicate: true, points: prev.points, pointBefore: prev.pointBefore, pointAfter: prev.pointAfter };
        }

        const member = memberSnap.exists ? memberSnap.data() : undefined;
        const mc = checkOwnedDoc("member", member, ref);
        if (!mc.ok) refuse(mc);
        const st = staffStatusOf(shop, input.staffId, access);
        if (st === "not_in_shop") refuse(deny(409, "staff_not_in_shop", "ไม่พบพนักงานในร้านนี้"));
        if (st !== "active") refuse(deny(409, "staff_inactive", "พนักงานไม่ได้อยู่ในสถานะใช้งาน"));

        const r = logic.redeemMemberPoint(member, input.points);
        if (!r.ok) {
          if (r.error === "POINT_INSUFFICIENT") refuse(deny(409, "point_insufficient", "แต้มสะสมไม่เพียงพอ", { point: r.before }));
          refuse(deny(400, "invalid_request"));
        }
        const hist = {
          shopId: shopField,
          memberId: input.memberId,
          kind: "redeem",
          points: input.points,
          pointBefore: r.before,
          pointAfter: r.after,
          requestId: input.requestId,
          staffId: input.staffId,
          staffName: input.staffName,
          timestamp: now,
          billDate: billDateOf(now),
          ...trail,
        };
        const check = PointHistory.safeParse(hist);
        if (!check.success) refuse(deny(500, "internal_error")); // รูปที่เขียนผิด = บั๊กของ handler ไม่เขียนลงฐาน
        tx.update(memberRef, { point: r.after, ...trailFor(access, member) });
        tx.set(histRef, hist);
        return { duplicate: false, points: input.points, pointBefore: r.before, pointAfter: r.after };
      });

      return ok(res, { memberId: input.memberId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { redeemPoint, sameRequest };

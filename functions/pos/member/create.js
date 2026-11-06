// pos/member/create — สร้างสมาชิกใหม่ + แถวดัชนีค้นหา + ตัวนับสมาชิกของร้าน (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.create.yaml · คำขอ MemberCreateRequest (@shopchamp/schema · requests/memberManage.ts)
// ทางเดิมที่แทน: `main3:src/Modal/Modal_NewMember.js:39-118` (W1 + L1/L2 ใน transaction · C1 ตัวนับ +1 นอก transaction)
//
// ลำดับ:
//   1. callerAccess → 401/403 · MemberCreateRequest → 400 · แต้มตั้งต้น > 0 ต้องมีสิทธิ์ '125' · เงินเซ็นตั้งต้น > 0 ต้องมี '124' (K11)
//   2. transaction (อ่านครบก่อนเขียน): shop (ด่าน _gate) · member/{memberUUID} · memberList/{letter+shopField}
//      + นับสมาชิกจริงของร้านด้วย count() (อ่านนอก transaction · ไม่ล็อก) แทนตัวนับ shop.totalMember ที่เพี้ยน (F58)
//      memberUUID มีแล้วในร้านนี้ = 200 duplicate (ส่งซ้ำตอนเน็ตช้าไม่ได้สมาชิก 2 คน F23) · ของร้านอื่น = 409 member_uuid_other_shop
//      เพดาน (K20 · logic.memberQuota): ไม่มีแพ็กเกจสมาชิก 50 · มี 3,000 · เต็ม = 409 member_limit
//   3. เขียน (รูปเดิมของ W1 · เพิ่ม field อย่างเดียว):
//      member/{memberUUID}: initialMember + {name, tel, point, credit, shopId, timestamp, letter} + ใหม่ {createdByUid}
//      memberList/{letter+shopField}: มี doc = update {members ต่อแถว, updateTime} · ไม่มี = set {shopId, members, updateTime}
//      shop: {totalMember: จำนวนจริง + 1} (ใน transaction เดียวกัน · ของเดิมนอก transaction)
//        ร้าน S5 ที่พิสูจน์ field ไม่ได้ (_gate fieldUnproven): จำนวน = max(นับด้วย doc id, shop.totalMember เดิม) ทั้งเพดานและตัวนับ
//   ตัวอักษรของดัชนี = logic.letterForMemberId(memberUUID) (ตายตัวต่อ id ⇒ ส่งซ้ำได้ doc ดัชนีเดิม) · ของเดิมสุ่ม
//   ทีมงาน (byAdmin) = member ที่สร้างใหม่มี {byAdmin:true, adminUid} · คำตอบมี byAdmin:true
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { MemberCreateRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, belongsToShop } = require("../_shared/auth");
const { vipActive } = require("../_shared/premium");
const { Refusal, refuse, readShopForWrite, isObj, storedCount } = require("./_gate");

const POINT_RIGHT = "125"; // จัดการแต้มสะสม (main3 src/screens/StaffScreen.js:72)
const CREDIT_RIGHT = "124"; // จัดการเซ็น (main3 src/screens/StaffScreen.js:71)

/** สมาชิกในคำตอบ: รูปที่แอปเอาไปใส่ตะกร้าได้ทันที (ของเดิมคืน obj + id · `Modal_NewMember.js:106-109`) */
function memberView(id, doc) {
  return { id, name: doc.name, tel: doc.tel, point: doc.point, credit: doc.credit, letter: doc.letter, shopId: doc.shopId };
}

function create(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(MemberCreateRequest, body, res);
      if (!input) return;
      if (input.point > 0 && !hasRight(access, POINT_RIGHT)) return sendDeny(res, deny(403, "right_required", "ไม่มีสิทธิ์ตั้งแต้มตั้งต้น", { right: POINT_RIGHT }));
      if (input.credit > 0 && !hasRight(access, CREDIT_RIGHT)) return sendDeny(res, deny(403, "right_required", "ไม่มีสิทธิ์ตั้งเงินเซ็นตั้งต้น", { right: CREDIT_RIGHT }));

      const now = await readNow(deps);
      const trail = adminTrail(access);
      const memberRef = db.collection("member").doc(input.memberUUID);
      const letter = logic.letterForMemberId(input.memberUUID);

      const out = await db.runTransaction(async (tx) => {
        const { shopRef, shop, ref, shopField, fieldUnproven } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const listRef = db.collection("memberList").doc(letter + shopField);
        const [memberSnap, listSnap] = await Promise.all([tx.get(memberRef), tx.get(listRef)]);

        if (memberSnap.exists) {
          const prev = memberSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) refuse(deny(409, "member_uuid_other_shop", "รหัสสมาชิกนี้เป็นของร้านอื่น"));
          return { duplicate: true, member: memberView(input.memberUUID, prev) };
        }

        const countSnap = await db.collection("member").where("shopId", "==", shopField).count().get();
        const counted = countSnap && typeof countSnap.data === "function" ? countSnap.data().count : undefined;
        // S5 ที่พิสูจน์ไม่ได้: สมาชิกเดิมถือ field ที่นับไม่ได้ ⇒ ใช้ตัวนับเดิมของร้านเป็นพื้น (ไม่ข้ามเพดาน · ไม่เขียนตัวนับลด · ผ4)
        const count = fieldUnproven && Number.isInteger(counted) ? Math.max(counted, storedCount(shop)) : counted;
        const quota = logic.memberQuota({ count, memberPackage: vipActive(shop, "member", now) });
        if (!quota.ok) {
          if (quota.count === null) refuse(deny(500, "internal_error"));
          refuse(deny(409, "member_limit", `เพิ่มสมาชิกได้สูงสุด ${quota.limit.toLocaleString("en-US")} ราย`, { limit: quota.limit }));
        }

        const doc = {
          name: input.name,
          tel: input.tel,
          point: input.point,
          credit: input.credit,
          moreCredit: 0,
          shopId: shopField,
          landlordId: "",
          timestamp: now,
          bought: [],
          config: [],
          uid: "",
          providerId: "",
          imageId: "",
          letter,
          createdByUid: access.uid,
          ...trail,
        };
        const row = logic.memberIndexRowOf(input.memberUUID, doc);
        if (listSnap.exists) {
          const list = listSnap.data() || {};
          tx.update(listRef, { members: logic.memberIndexUpsert(list.members, row), updateTime: now });
        } else {
          tx.set(listRef, { shopId: shopField, members: [row], updateTime: now });
        }
        tx.set(memberRef, doc);
        tx.update(shopRef, { totalMember: quota.count + 1 });
        return { duplicate: false, member: memberView(input.memberUUID, doc), totalMember: quota.count + 1 };
      });

      if (out.duplicate) return ok(res, { memberId: input.memberUUID, duplicate: true, member: out.member, ...adminFlag(access) });
      return ok(res, { memberId: input.memberUUID, duplicate: false, member: out.member, totalMember: out.totalMember, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { create, memberView };

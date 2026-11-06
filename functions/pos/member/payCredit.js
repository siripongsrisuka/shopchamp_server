// pos/member/payCredit — รับชำระหนี้เงินเซ็นของสมาชิก (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.payCredit.yaml · คำขอ MemberPayCreditRequest (@shopchamp/schema)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ลำดับ:
//   1. callerAccess → 401 no_shop_access · 403 wrong_shop (ก่อนตรวจรูปคำขอ · คนไม่มีสิทธิ์ไม่ได้รู้รูป schema)
//   2. MemberPayCreditRequest → 400 invalid_request (ยอด ≤ 0 · ทศนิยมเกิน 2 · ช่องเงินเซ็น 3 · รหัสช่องรุ่นเก่า 3 หลัก)
//      + paymentId สตริงตัวเลขล้วน: "1" → 1 (ให้กะนับเงินสด · logic CASH_IDS เทียบชนิดตรง) · "3" → 400 · "03" " 3" → 400
//        (schema รับสตริงทุกตัวที่ไม่ใช่ 3 หลัก ⇒ ด่านช่องเงินเซ็นของ schema ข้ามได้ · verify W2 · ควรย้ายไป schema ภายหลัง)
//   2b. สิทธิ์ '124' จัดการเซ็น (แอปเก่าปัดที่จอ main3 src/screens/MemberScreen.js:398-401) → 403 right_required
//       เจ้าของ/ทีมงานผ่านทุกสิทธิ์ (hasRight) · verify W1
//   3. transaction: อ่านครบ 4 ใบก่อนเขียน (shop · paidHistory/{payUUID} · member · shift)
//      ร้านไม่มี 404 shop_not_found · payUUID เดิมของร้านนี้ 200 duplicate (ไม่ตัดหนี้ซ้ำ · ตรวจก่อนกะ เพราะส่งซ้ำหลังปิดกะได้)
//      payUUID ของร้านอื่น 409 pay_uuid_other_shop · member 404/409 · shift 404/409 · กะปิด 409 shift_not_open (#17)
//      คนรับไม่อยู่ในร้าน 409 staff_not_in_shop · เกินหนี้รวม 409 pay_over_total (logic.member.applyCreditPayment)
//   4. เขียน (เพิ่ม field อย่างเดียว · แอปเก่าอ่านได้ตามเดิม):
//      member: {credit, creditArray} จาก applyCreditPayment (แถวที่ชำระครบยังอยู่ remainCredit 0 · F22)
//      paidHistory/{payUUID}: รูปเดิมของ app:modal/Modal_CreditMember.js:96-103 {shopId, paid, existCredit, memberId, timestamp, billDate}
//        paid เป็นตัวเลข (F45 · จอ app:screens/MemberPaidScreen.js:31 แสดงค่าดิบใน <Text> ได้ทั้งเลขและข้อความ)
//        + ใหม่ {receiptUUID, shiftId, shiftOpenTime, staffId, staffName, paymentId, paymentName, cutBills} (logic.shift.creditCashReceived อ่าน shiftId paymentId paid)
//      notification/{auto}: รูปเดิม Modal_CreditMember.js:86-92 {heading, shopId, notificationContent, categoryId:4, timestamp}
//      ทีมงาน (byAdmin) = paidHistory และ notification มี {byAdmin:true, adminUid} · member ไม่ติดป้าย (เป็นเอกสารที่มีอยู่แล้ว ไม่ใช่เอกสารที่เขียนเพิ่ม)
//   shopId ที่เขียน = field shop.shopId (แอปเก่าเขียนด้วยค่านี้) · ไม่มี = doc id
//   push OneSignal / LINE ของแอปเก่า (Modal_CreditMember.js:111-127) ยังอยู่ฝั่งแอป ไม่ทำที่นี่
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น · เวลาเขียนเป็น Date (admin SDK แปลงเป็น Timestamp เอง)
"use strict";

const { db } = require("../../firebase");
const { MemberPayCreditRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, shopRefOf, belongsToShop, checkOwnedDoc, staffInShop } = require("../_shared/auth");
const { billDateOf } = require("../_shared/billClock");

const NOTI_HEADING = "ลูกค้าชำระเงินเซ็น";
const NOTI_CATEGORY_CREDIT = 4;
const DEFAULT_PAYMENT_NAMES = Object.freeze({ 1: "เงินสด", 2: "พร้อมเพย์" });
const CREDIT_RIGHT = "124"; // จัดการเซ็น (main3 src/screens/StaffScreen.js:71)
const CREDIT_PAYMENT_ID = 3; // ช่องเงินเซ็น · ตรงกับ schema

// สตางค์ด้วยตัวแปลงของ logic ตัวเดียวกับ applyCreditPayment ("1,000" อ่านได้ · verify W3)
const sat = (v) => logic.toSatang(v);
const baht = (s) => (s === 0 ? 0 : s / 100);
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

/**
 * paymentIdOf(id) — ทำ paymentId ให้เป็นรูปเดียวกับที่ logic อ่าน · คืน {ok:true, id} | {ok:false}
 *   number = ตามเดิม (schema ตรวจแล้ว) · สตริงที่ไม่ใช่ตัวเลข (uuid ของช่องที่ร้านเพิ่มเอง) = ตามเดิม
 *   สตริงตัวเลขรูปปกติ "1" "12" → number · เป็นช่องเงินเซ็น = ปัด · ตัวเลขมีศูนย์นำหรือช่องว่าง ("03" " 3") = ปัด (กำกวม)
 */
function paymentIdOf(id) {
  if (typeof id !== "string" || !/^\s*\d+\s*$/.test(id)) return { ok: true, id };
  if (!/^[1-9]\d*$/.test(id)) return { ok: false };
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n === CREDIT_PAYMENT_ID) return { ok: false };
  return { ok: true, id: n };
}

/** ชื่อช่องรับเงิน: shop.shopchampPayment ก่อน · ไม่มีใช้ชื่อตั้งต้นของช่อง 1 2 · ช่องที่ไม่รู้จัก = '' */
function paymentNameOf(shop, paymentId) {
  const list = Array.isArray(shop && shop.shopchampPayment) ? shop.shopchampPayment : [];
  const row = list.find((c) => isObj(c) && String(c.id) === String(paymentId));
  if (row && typeof row.name === "string" && row.name) return row.name;
  return DEFAULT_PAYMENT_NAMES[paymentId] || "";
}

/** บิลที่ถูกตัดหนี้: เทียบแถวเดิมกับแถวใหม่ (applyCreditPayment ข้ามแถวที่ไม่ใช่ object · ลำดับที่เหลือคงเดิม) */
function cutBillsOf(oldArray, newArray) {
  const before = (Array.isArray(oldArray) ? oldArray : []).filter(isObj);
  const after = Array.isArray(newArray) ? newArray : [];
  const out = [];
  before.forEach((r, i) => {
    const n = after[i];
    if (!isObj(n)) return;
    const cut = Math.max(0, sat(r.remainCredit)) - Math.max(0, sat(n.remainCredit));
    if (cut <= 0) return;
    const row = { billId: r.billId === undefined ? null : r.billId, amount: baht(cut) };
    if (r.receiptNumber !== undefined) row.receiptNumber = r.receiptNumber;
    out.push(row);
  });
  return out;
}

/** ข้อความแจ้งเตือนรูปเดิม (Modal_CreditMember.js:73 · useToLocale = ทศนิยม 2 ตำแหน่งมีคอมมา) */
function notificationContentOf(name, paid, existCredit) {
  const pay = Number(paid).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `ลูกค้า ${name === undefined ? "" : name}\nยอดเงินชำระ ${pay} บาท\nยอดค้างชำระคงเหลือ ${existCredit} บาท`;
}

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

function payCredit(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const parsed = parseOr400(MemberPayCreditRequest, body, res);
      if (!parsed) return;
      const pid = paymentIdOf(parsed.paymentId);
      if (!pid.ok) {
        return sendDeny(res, deny(400, "invalid_request", undefined, {
          issues: [{ path: "paymentId", message: "paymentId ต้องไม่ใช่ช่องเงินเซ็น และตัวเลขต้องไม่มีศูนย์นำหรือช่องว่าง" }],
        }));
      }
      const input = { ...parsed, paymentId: pid.id };
      if (!hasRight(access, CREDIT_RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const shopDocId = access.shopId;
      const trail = adminTrail(access);

      const shopRef = db.collection("shop").doc(shopDocId);
      const paidRef = db.collection("paidHistory").doc(input.payUUID);
      const memberRef = db.collection("member").doc(input.memberId);
      const shiftRef = db.collection("shift").doc(input.shiftId);
      const notiRef = db.collection("notification").doc();

      const out = await db.runTransaction(async (tx) => {
        // อ่านครบก่อนเขียน
        const [shopSnap, paidSnap, memberSnap, shiftSnap] = await Promise.all([
          tx.get(shopRef), tx.get(paidRef), tx.get(memberRef), tx.get(shiftRef),
        ]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const ref = shopRefOf(shopDocId, shop);

        if (paidSnap.exists) {
          const prev = paidSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) refuse(deny(409, "pay_uuid_other_shop", "รหัสรับชำระนี้เป็นของร้านอื่น"));
          return { duplicate: true };
        }

        const member = memberSnap.exists ? memberSnap.data() : undefined;
        const mc = checkOwnedDoc("member", member, ref);
        if (!mc.ok) refuse(mc);
        const shift = shiftSnap.exists ? shiftSnap.data() : undefined;
        const sc = checkOwnedDoc("shift", shift, ref);
        if (!sc.ok) refuse(sc);
        if (shift.status !== true) refuse(deny(409, "shift_not_open", "กะปิดอยู่ กรุณาเปิดกะก่อนรับชำระ"));
        if (!staffInShop(shop, input.staffId, access)) refuse(deny(409, "staff_not_in_shop", "ไม่พบพนักงานที่รับเงินในร้านนี้"));

        const r = logic.applyCreditPayment(member, input.amount);
        if (!r.ok) {
          if (r.error === "PAY_OVER_TOTAL") refuse(deny(409, "pay_over_total", "ยอดชำระมากกว่ายอดเซ็นคงเหลือ"));
          if (r.error === "PAY_NOT_POSITIVE") refuse(deny(400, "invalid_request"));
          refuse(deny(500, "internal_error"));
        }
        const cutBills = cutBillsOf(member.creditArray, r.update.creditArray);
        const shopField = ref.shopId || shopDocId;

        tx.update(memberRef, { credit: r.update.credit, creditArray: r.update.creditArray });
        tx.set(paidRef, {
          shopId: shopField,
          paid: r.paid,
          existCredit: r.existCredit,
          memberId: input.memberId,
          timestamp: now,
          billDate: billDateOf(now),
          receiptUUID: input.payUUID,
          shiftId: input.shiftId,
          shiftOpenTime: shift.openTime === undefined ? null : shift.openTime,
          staffId: input.staffId,
          staffName: input.staffName,
          paymentId: input.paymentId,
          paymentName: paymentNameOf(shop, input.paymentId),
          cutBills,
          ...trail,
        });
        tx.set(notiRef, {
          heading: NOTI_HEADING,
          shopId: shopField,
          notificationContent: notificationContentOf(member.name, r.paid, r.existCredit),
          categoryId: NOTI_CATEGORY_CREDIT,
          timestamp: now,
          ...trail,
        });
        return { duplicate: false, paid: r.paid, existCredit: r.existCredit, cutBills };
      });

      if (out.duplicate) return ok(res, { paidHistoryId: input.payUUID, duplicate: true, ...adminFlag(access) });
      return ok(res, {
        paidHistoryId: input.payUUID,
        paid: out.paid,
        existCredit: out.existCredit,
        cutBills: out.cutBills,
        duplicate: false,
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { payCredit, paymentIdOf, paymentNameOf, cutBillsOf, notificationContentOf };

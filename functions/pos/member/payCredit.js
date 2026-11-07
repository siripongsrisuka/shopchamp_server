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
//        payUUID เดิมแต่ memberId หรือยอดต่าง 409 pay_uuid_mismatch (B-13)
//      payUUID ของร้านอื่น 409 pay_uuid_other_shop · member 404/409 · shift 404/409 · กะปิด 409 shift_not_open (#17)
//        ด่านกะ 3 ข้อหลังใช้กับร้านที่ shop.shift === true เท่านั้น · ร้านไม่ใช้ระบบกะ (ก้อน 5 ข้อ ①) = ปัดแค่ shift ของร้านอื่น
//        ไม่ส่ง shiftId / shift ไม่มีในฐาน = paidHistory.shiftId null (กะไหนก็ไม่นับ · แอปเก่าไม่เคยเขียนช่องนี้)
//      คนรับไม่อยู่ในร้าน 409 staff_not_in_shop · อยู่แต่ไม่ active 409 staff_inactive (B-11) · เกินหนี้รวม 409 pay_over_total (logic.member.applyCreditPayment)
//   4. เขียน (เพิ่ม field อย่างเดียว · แอปเก่าอ่านได้ตามเดิม):
//      member: {credit, creditArray} จาก applyCreditPayment (แถวที่ชำระครบยังอยู่ remainCredit 0 · F22)
//      paidHistory/{payUUID}: รูปเดิมของ app:modal/Modal_CreditMember.js:96-103 {shopId, paid, existCredit, memberId, timestamp, billDate}
//        paid เป็นตัวเลข (F45 · จอ app:screens/MemberPaidScreen.js:31 แสดงค่าดิบใน <Text> ได้ทั้งเลขและข้อความ)
//        + ใหม่ {receiptUUID, shiftId, shiftOpenTime, staffId, staffName, paymentId, paymentName, cutBills} (logic.shift.creditCashReceived อ่าน shiftId paymentId paid)
//      notification/{auto}: รูปเดิม Modal_CreditMember.js:86-92 {heading, shopId, notificationContent, categoryId:4, timestamp}
//      ทีมงาน (byAdmin) = paidHistory และ notification มี {byAdmin:true, adminUid} · member ไม่ติดป้าย (เป็นเอกสารที่มีอยู่แล้ว ไม่ใช่เอกสารที่เขียนเพิ่ม)
//   shopId ที่เขียน = field shop.shopId (แอปเก่าเขียนด้วยค่านี้) · ไม่มี = doc id
//   ทางเว็บ (body.source 'web' · DEV-0002 · Pack เคาะ 2026-11-07) — ตรวจหลังด่านสมาชิก ก่อนด่านคนรับ · ทางแอป (ไม่ส่ง/'app') คงเดิมทุกอย่าง
//     ช่องรับเงินอ่านจาก shop.shopchampPayment เอง (ไม่มีช่องนี้ = ค่าตั้งต้น 1 เงินสด 2 พร้อมเพย์) · ไม่มีในร้าน/ปิดใช้ 409 payment_not_in_shop
//     เงินสด = logic.isCashChannel(id ของแถวในร้าน) · ไม่เชื่อว่าเว็บแยกช่องถูก
//     ไม่ใช่เงินสด: ไม่ผูกกะ (paidHistory.shiftId null) · ส่ง shiftId มา 409 noncash_no_shift
//     เงินสด + ร้านใช้กะ: ไม่ส่ง shiftId 409 cash_shift_required · shift ไม่มี 404 shift_not_found · ร้านอื่น 409 shift_other_shop · ปิด 409 shift_not_open
//     เงินสด + ร้านไม่ใช้กะ: เหมือนทางแอปของร้านไม่ใช้กะ (ก้อน 5 ข้อ ①)
//     paidHistory ทางเว็บมี source:'web' (เพิ่ม field อย่างเดียว)
//   push (DEV-0001 push · แอปใหม่ไม่มี OneSignal): หลัง commit ส่ง FCM หา shop.notiCredit ในร้านนี้ (แทน pushByTwoFilter ของแอป
//     `APP/src/modal/Modal_CreditMember.js:71`) · หัวข้อ/ข้อความเดียวกับ notification · data {sound:<หัวข้อ>} · duplicate = ไม่ส่ง
//     LINE ของแอป (Modal_CreditMember.js:111-127) ยังอยู่ฝั่งแอป
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น · เวลาเขียนเป็น Date (admin SDK แปลงเป็น Timestamp เอง)
"use strict";

const { db } = require("../../firebase");
const { MemberPayCreditRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc, staffStatusOf } = require("../_shared/auth");
const { billDateOf } = require("../_shared/billClock");
const { notify, idsOf } = require("../_shared/push/notify");

const NOTI_HEADING = "ลูกค้าชำระเงินเซ็น";
const NOTI_CATEGORY_CREDIT = 4;
const DEFAULT_PAYMENT_NAMES = Object.freeze({ 1: "เงินสด", 2: "พร้อมเพย์" });
const CREDIT_RIGHT = "124"; // จัดการเซ็น (main3 src/screens/StaffScreen.js:71)
const CREDIT_PAYMENT_ID = 3; // ช่องเงินเซ็น · ตรงกับ schema
// ช่องตั้งต้นเมื่อ doc ร้านไม่มี shopchampPayment (แบบ handleShop ของแอปและเว็บ · app:config/initialShop.js:104-116)
const DEFAULT_CHANNELS = Object.freeze([{ id: 1, name: "เงินสด", status: true }, { id: 2, name: "พร้อมเพย์", status: true }]);
const WEB_NEED_SHIFT = "ต้องเปิดกะก่อน หรือรับเป็นโอน";

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

/**
 * shopChannelOf(shop, paymentId) — แถวช่องรับเงินของร้านที่ตรงกับ paymentId (ทางเว็บ) · ไม่มี/ปิดใช้ (status false) = null
 *   เทียบด้วย String เพราะ paymentId ผ่าน paymentIdOf แล้ว ("1" → 1) · แถว uuid เทียบตรง
 */
function shopChannelOf(shop, paymentId) {
  const list = Array.isArray(shop && shop.shopchampPayment) ? shop.shopchampPayment : DEFAULT_CHANNELS;
  const row = list.find((c) => isObj(c) && c.id !== undefined && c.id !== null && String(c.id) === String(paymentId));
  if (!row || row.status === false) return null;
  return row;
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

/** sameRequest(prev, input) — paidHistory เดิมเป็นคำขอเดียวกันไหม (B-13): memberId ตรง และยอดตรงระดับสตางค์ */
function sameRequest(prev, input) {
  return prev.memberId === input.memberId && sat(prev.paid) === sat(input.amount);
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
      const shiftRef = input.shiftId === undefined ? null : db.collection("shift").doc(input.shiftId);
      const notiRef = db.collection("notification").doc();

      const out = await db.runTransaction(async (tx) => {
        // อ่านครบก่อนเขียน
        const [shopSnap, paidSnap, memberSnap, shiftSnap] = await Promise.all([
          tx.get(shopRef), tx.get(paidRef), tx.get(memberRef), shiftRef ? tx.get(shiftRef) : Promise.resolve(null),
        ]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId, shop });

        if (paidSnap.exists) {
          const prev = paidSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) refuse(deny(409, "pay_uuid_other_shop", "รหัสรับชำระนี้เป็นของร้านอื่น"));
          // B-13 (agent เลือก): payUUID เดิมแต่คนละสมาชิกหรือคนละยอด = ไม่ใช่การส่งซ้ำ ⇒ ปัด ไม่ตอบ duplicate ให้เครื่องเชื่อว่ารับแล้ว
          if (!sameRequest(prev, input)) refuse(deny(409, "pay_uuid_mismatch", "รหัสรับชำระนี้ใช้กับรายการอื่นไปแล้ว"));
          return { duplicate: true };
        }

        const member = memberSnap.exists ? memberSnap.data() : undefined;
        const mc = checkOwnedDoc("member", member, ref);
        if (!mc.ok) refuse(mc);
        const shift = shiftSnap && shiftSnap.exists ? shiftSnap.data() : undefined;
        // ก้อน 5 ข้อ ① (Pack เคาะ 2026-11-06): ร้านไม่ใช้ระบบกะ (shop.shift ไม่ใช่ true) รับชำระได้เหมือนแอปเก่า
        //   (main3 src/Modal/Modal_CreditMember.js:40-112 ไม่ดูกะเลย) · ยังปัด shift ของร้านอื่น · shift ที่ไม่มีในฐาน = ไม่ผูกกะ
        //   ร้านใช้ระบบกะ = ต้องเข้ากะที่เปิดอยู่ตามเดิม (#17)
        const usesShift = shop.shift === true;
        let shiftForRow = null; // {shiftId, openTime} ที่เขียนลง paidHistory · null = ไม่ผูกกะ
        const fromWeb = input.source === "web";
        let webCash = false;
        if (fromWeb) {
          const ch = shopChannelOf(shop, input.paymentId);
          if (!ch) refuse(deny(409, "payment_not_in_shop", "ไม่พบช่องทางรับเงินนี้ในร้าน หรือช่องนี้ปิดใช้อยู่"));
          webCash = logic.isCashChannel(ch.id);
          if (!webCash && shiftRef) refuse(deny(409, "noncash_no_shift", "รับโอนหรือช่องทางที่ไม่ใช่เงินสด ไม่ต้องเลือกกะ"));
        }
        if (fromWeb && !webCash) {
          // ไม่ใช่เงินสด: ไม่ผูกกะ ไม่ว่าร้านใช้กะหรือไม่ (Pack เคาะ 2026-11-07)
        } else if (fromWeb && usesShift) {
          if (!shiftRef) refuse(deny(409, "cash_shift_required", WEB_NEED_SHIFT));
          const sc = checkOwnedDoc("shift", shift, ref);
          if (!sc.ok) refuse(sc);
          if (shift.status !== true) refuse(deny(409, "shift_not_open", WEB_NEED_SHIFT));
          shiftForRow = { shiftId: input.shiftId, openTime: shift.openTime };
        } else if (usesShift) {
          if (!shiftRef) refuse(deny(409, "shift_not_open", "กะปิดอยู่ กรุณาเปิดกะก่อนรับชำระ"));
          const sc = checkOwnedDoc("shift", shift, ref);
          if (!sc.ok) refuse(sc);
          if (shift.status !== true) refuse(deny(409, "shift_not_open", "กะปิดอยู่ กรุณาเปิดกะก่อนรับชำระ"));
          shiftForRow = { shiftId: input.shiftId, openTime: shift.openTime };
        } else if (shift !== undefined) {
          if (!belongsToShop(shift.shopId, ref)) refuse(deny(409, "shift_other_shop"));
          // กะเปิดอยู่จริง (ร้านปิดสวิตช์กลางกะ) = ผูกรอบนั้นตามเดิม · ไม่เปิด = ผูก doc ประจำจุดแบบไม่มีเวลาเปิดรอบ
          shiftForRow = { shiftId: input.shiftId, openTime: shift.status === true ? shift.openTime : undefined };
        }
        // B-11 (Pack เคาะ 2026-11-06): คนรับต้อง status active · ไม่อยู่ในร้าน 409 staff_not_in_shop · อยู่แต่ไม่ active 409 staff_inactive
        const staffState = staffStatusOf(shop, input.staffId, access);
        if (staffState === "not_in_shop") refuse(deny(409, "staff_not_in_shop", "ไม่พบพนักงานที่รับเงินในร้านนี้"));
        if (staffState !== "active") refuse(deny(409, "staff_inactive", "พนักงานที่รับเงินไม่ได้อยู่ในสถานะใช้งาน"));

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
          shiftId: shiftForRow ? shiftForRow.shiftId : null,
          shiftOpenTime: shiftForRow && shiftForRow.openTime !== undefined ? shiftForRow.openTime : null,
          staffId: input.staffId,
          staffName: input.staffName,
          paymentId: input.paymentId,
          paymentName: paymentNameOf(shop, input.paymentId),
          cutBills,
          ...(fromWeb ? { source: "web" } : {}),
          ...trail,
        });
        const notiContent = notificationContentOf(member.name, r.paid, r.existCredit);
        tx.set(notiRef, {
          heading: NOTI_HEADING,
          shopId: shopField,
          notificationContent: notiContent,
          categoryId: NOTI_CATEGORY_CREDIT,
          timestamp: now,
          ...trail,
        });
        const push = { to: { kind: "staff", shopId: access.shopId, ids: idsOf(shop.notiCredit) }, heading: NOTI_HEADING, content: notiContent, data: { sound: NOTI_HEADING } };
        return { duplicate: false, paid: r.paid, existCredit: r.existCredit, cutBills, push };
      });

      if (out.duplicate) return ok(res, { paidHistoryId: input.payUUID, duplicate: true, ...adminFlag(access) });
      await notify(deps, out.push);
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

module.exports = { payCredit, paymentIdOf, paymentNameOf, shopChannelOf, cutBillsOf, notificationContentOf, sameRequest };

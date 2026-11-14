// pos/sale/amend — แก้ไขบิลที่ปิดแล้ว = ยกเลิกใบเดิม + ออกใบใหม่ (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.amend.yaml · ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now · createSale · voidSale (ไม่ส่ง = handler sale.create / sale.void ในโปรเซส)
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับด่าน (ทุกด่านอยู่ก่อนเรียก createSale):
//   ไม่มี req.shopAccess 401 → schema 400 → wrong_shop 403 → สิทธิ์ '143' 403
//   ① txn: อ่าน shop · bill · shift (อ่านครบก่อนเขียน) → premium 403 → สวิตช์ 403 → บิล 404/409 · legacy · duplicate · in_progress · void
//          → ล็อกทั้งใบ 409 → กะ 409 → โครงใบใหม่ 409 → ประทับ bill.amend {status:pending}
//      ด่านกะเฉพาะร้านที่ใช้ระบบกะ (shop.shift === true) · ร้านไม่ใช้กะแก้ได้ทุกบิลไม่จำกัดวัน ปัดแค่กะของร้านอื่น
//        (Pack เคาะ 2026-11-06 · ก้อน 5 · lanes/dev/source/chunk5-shift-tax.md)
//   ② createSale ({body, carry, access, amendOf}) · receiptUUID = amend:<billId>:<requestId> ⇒ ยิงซ้ำได้ duplicate
//   ③ txn: บิลเดิม amend.newBillId/newReceiptNumber · บิลใหม่ amendOf + amend {status:done, requestId, ofReceiptNumber, ofBillId}
//      (amend ต้องมี status + requestId ให้ผ่าน schema Bill · ไม่งั้น sale.void / sale.get อ่านใบใหม่ไม่ได้)
//   ④ voidSale ({body, access, amendVoid:true}) · requestId เดียวกับคำขอแก้ ⇒ ยิงซ้ำได้ alreadyVoid
//   ⑤ txn: amend.status done + amendedBy + notification หมวด 8 "แก้ไขใบเสร็จ" (B-5 · 1 ใบต่อการแก้ · sale.void ที่เรียกจาก ④ ไม่เขียนหมวด 1 ซ้อน)
//      หลัง ⑤ สำเร็จ: push FCM หา shop.notiCancelBill ในร้านนี้ หัวข้อ "แก้ไขใบเสร็จ" (DEV-0001 push · แอปใหม่ไม่มี OneSignal · แอปไม่เคยส่งเรื่องนี้ = ใหม่)
//      เลข 8 = เลขว่างถัดไป: แอปเก่าใช้ 1-7 (main3 src/screens/NotificationHistory.js:52-60) และ 99 (PayScreen.js:158 ฯลฯ) · เว็บเจ้าของใช้ 4 99
// ยิงซ้ำ requestId เดิมที่ค้าง pending = เดินต่อด้วย changes ที่ประทับไว้ (เปลี่ยนเนื้อไม่ได้) · ข้ามขั้นที่มีหลักฐานว่าทำแล้ว
// amendedBy เขียนที่ ⑤ (หลังยกเลิก) ไม่ใช่ ③: สัญญา sale.void ตอบ already_void ให้บิลที่มี amendedBy
//   ⇒ เขียนก่อน ④ = handler ยกเลิกตัวจริงจะปัดคำขอยกเลิกของการแก้เอง
// amend.staff = ชื่อพนักงาน (schema Bill: string) · id อยู่ที่ amend.staffId · uid ผู้เรียกที่ amend.staffUid
// ใบที่เกิดจากการแก้ (amend มี ofBillId แต่ไม่มี newBillId/changes) = ลิงก์ย้อนอย่างเดียว ไม่ใช่ล็อก ⇒ แก้ต่อเป็นทอดได้
//   ตอนประทับล็อกบนใบนั้น เก็บ ofBillId ofReceiptNumber ไว้ในก้อนเดิม (ลิงก์ย้อนไม่หาย)
// เขียนเพิ่ม field อย่างเดียว · แอปเก่าอ่าน void reason ของบิลเดิม และบิลใหม่รูปเดิม
"use strict";

const { db } = require("../../firebase");
const { SaleAmendRequest, SaleCreateRequest } = require("@shopchamp/schema");
const { isVoidedBill, toMillis, toNumber } = require("@shopchamp/logic");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { callerAccess, hasRight, resolveShopRef, checkOwnedDoc, belongsToShop, adminTrail, adminFlag } = require("../_shared/auth");
const { readNow, depOr } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const { amendReceiptUUID, amendLockState, sameRequestId } = require("../_shared/idempotency");
const { amendLocks, checkAmendShape, refundDueOf } = require("./amendRules");
const { notify, idsOf } = require("../_shared/push/notify");

const AMEND_RIGHT = "143";
const REASON_MAX = 500; // schema Reason (requests/sale.ts)
const MESSAGES = {
  legacy_bill_view_only: "บิลรุ่นแรกดูได้อย่างเดียว",
  bill_void: "บิลนี้ยกเลิกแล้ว",
  amend_in_progress: "บิลนี้กำลังถูกแก้ไขจากเครื่องอื่น",
  bill_locked: "บิลนี้แก้ไขไม่ได้",
  shift_unknown: "ไม่รู้ว่าบิลนี้อยู่กะไหน แก้ไขไม่ได้",
  shift_closed: "กะของบิลนี้ปิดแล้ว แก้ไขไม่ได้",
  line_mismatch: "รายการไม่ตรงกับบิลเดิม",
  qty_increase: "เพิ่มจำนวนไม่ได้",
  net_increase: "ยอดใหม่มากกว่าเดิมไม่ได้",
  net_decrease: "จำนวนเท่าเดิม ยอดใหม่ต้องเท่าเดิม (ลดราคาเองไม่ได้)",
  payment_mismatch: "ยอดช่องจ่ายไม่เท่ายอดใหม่",
  nothing_changed: "ไม่มีอะไรเปลี่ยน",
  amend_create_failed: "ออกบิลใหม่ไม่สำเร็จ กดยืนยันอีกครั้ง",
  amend_reverse_failed: "ยกเลิกบิลเดิมไม่สำเร็จ กดยืนยันอีกครั้ง",
};

// field ของบิลเดิมที่ส่งต่อให้ใบใหม่ (ผ่าน schema SaleCreateRequest ทีละช่อง · ไม่ผ่าน = ไม่ส่ง)
// scangoOrder = หัวใบ ScanGo (เลขออเดอร์ · รอบ · โซน) ใบใหม่คงหัวเดิม (DEV-0009 · Pack 2026-11-14)
const CARRY_BODY_FIELDS = ["manualDiscount", "posId", "posNumber", "cashierId", "cashierName", "vatType", "note", "franchiseId", "scangoOrder"];
const MONEY_INPUT_FIELDS = ["moneyMustPaid", "productDiscount", "vatAmount", "rounding", "change"];
const NOTI_HEADING_AMEND = "แก้ไขใบเสร็จ";
const NOTI_CATEGORY_AMEND = 8; // B-5 · 7 = เบิกสินค้า ห้ามใช้ · ดูหัวไฟล์ ⑤

const money2 = (v) => {
  const n = toNumber(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
};
/** ข้อความแจ้งเตือนการแก้ (โครงเดียวกับ "ยกเลิกใบเสร็จ" ของแอปเก่า BillHistoryScreen.js:393 + เลขใบใหม่และยอดคืน) */
function amendNotificationContentOf({ reason, oldReceiptNumber, newReceiptNumber, oldMust, newMust, refundDue, staffName }) {
  return `เหตุผล ${reason}  \nใบเดิม ${oldReceiptNumber} → ใบใหม่ ${newReceiptNumber} \nยอดเงิน ${money2(oldMust)} → ${money2(newMust)} บาท \nคืนลูกค้า ${money2(refundDue)} บาท \nโดย ${staffName} `;
}

class Deny extends Error {
  constructor(status, error, extra) {
    super(error);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}
const refuse = (status, error, extra) => { throw new Deny(status, error, extra); };

/** ตัด undefined ทิ้งทั้งก้อน (Firestore ปัด undefined) · Date / Timestamp คงไว้ */
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (!v || typeof v !== "object" || v instanceof Date || typeof v.toMillis === "function") return v;
  const out = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = clean(v[k]);
  return out;
}

const dateOf = (t) => {
  const ms = toMillis(t);
  return ms === null ? undefined : new Date(ms);
};
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= 128 && !v.includes("/");

/** changes ที่ประทับบนบิลเดิม = เนื้อของใบใหม่ (ยิงซ้ำใช้ตัวนี้ ไม่ใช่ body ใหม่) */
function changesOf(input) {
  const out = { product: input.product, payment: input.payment };
  for (const k of MONEY_INPUT_FIELDS) if (input[k] !== undefined) out[k] = input[k];
  return out;
}

/** amend ที่เป็นลิงก์ย้อนของใบที่เกิดจากการแก้อย่างเดียว (ยังไม่เคยถูกแก้ต่อ) · ไม่นับเป็นล็อก */
function isBackLinkOnly(a) {
  return !!a && typeof a === "object" && typeof a.ofBillId === "string" && a.ofBillId !== "" && !a.newBillId && !a.changes;
}

/** ลิงก์ย้อนที่ต้องเก็บไว้ตอนประทับล็อกใหม่ทับก้อน amend */
function backLinkOf(a) {
  if (!a || typeof a !== "object") return {};
  return clean({ ofBillId: a.ofBillId, ofReceiptNumber: a.ofReceiptNumber });
}

/** พนักงานที่ประทับไว้ · รับรูป object ของรุ่นก่อนแก้ด้วย (ไม่เคย deploy แต่กันค้างในฐานทดสอบ) */
function stampedStaff(a) {
  if (!a || typeof a !== "object") return {};
  if (a.staff && typeof a.staff === "object") return { id: a.staff.id, name: a.staff.name };
  return { id: a.staffId, name: typeof a.staff === "string" ? a.staff : undefined };
}

/** ด่านกะ (สัญญาข้อ 6) · คืน shift ref หรือ throw Deny */
function checkShift(bill, shiftData, shopRef) {
  if (shiftData === undefined) refuse(409, "shift_unknown");
  if (!belongsToShop(shiftData.shopId, shopRef)) refuse(409, "shift_other_shop");
  if (shiftData.status !== true) refuse(409, "shift_closed");
  const openMs = toMillis(shiftData.openTime);
  if (openMs === null) refuse(409, "shift_closed");
  const billOpenMs = toMillis(bill.shiftOpenTime);
  if (billOpenMs !== null) {
    if (billOpenMs !== openMs) refuse(409, "shift_closed");
  } else {
    const billMs = toMillis(bill.dateTime);
    if (billMs === null || billMs <= openMs) refuse(409, "shift_closed");
  }
}

/**
 * ร้านไม่ใช้ระบบกะ (ก้อน 5): ด่านกะเหลือข้อเดียว = กะที่บิลอ้างต้องไม่ใช่ของร้านอื่น
 *   (sale.create ปัด shift_other_shop อยู่แล้ว · ปัดที่นี่ก่อนประทับ = ไม่ต้องล้มกลางทาง)
 *   ไม่มี shiftId / ไม่มี doc กะ / กะปิด = แก้ได้ (แอปเก่าไม่ผูกบิลร้านไม่ใช้กะกับรอบไหน)
 */
function checkShiftNoShiftShop(shiftData, shopRef) {
  if (shiftData !== undefined && !belongsToShop(shiftData.shopId, shopRef)) refuse(409, "shift_other_shop");
}

/** body ของ sale.create สำหรับใบใหม่
 *   ร้านไม่ใช้กะ (usesShift false): shiftId ประจำจุดขายของบิลเดิมเท่านั้น (ว่าง = ไม่ส่ง) · ไม่ส่ง shiftOpenTime
 *     ⇒ sale.create ตอบ shift 'off' · ใบใหม่ไม่มี shiftOpenTime/shiftUnassigned/shiftHistoryId (รูปบิลแอปเก่า)
 */
function createBodyOf({ shopId, billId, requestId, oldBill, changes, usesShift = true }) {
  const body = {
    shopId,
    receiptUUID: amendReceiptUUID(billId, requestId),
    product: changes.product.map(({ fromIndex, ...line }) => line), // eslint-disable-line no-unused-vars
    payment: changes.payment,
  };
  if (usesShift || validDocId(oldBill.shiftId)) body.shiftId = oldBill.shiftId;
  for (const k of MONEY_INPUT_FIELDS) if (changes[k] !== undefined) body[k] = changes[k];
  // ช่องที่แอปเก่าอ่านตรงไม่มีค่าตั้งต้น (main3 src/hook/usePrintAction.js:66-67 · :205-206 `pointDiscount.value` `campaign.length`)
  //   ใบที่แก้ได้ผ่านล็อก member/promotion แล้ว (amendRules.amendLocks) ⇒ แต้มลด 0 และไม่มีโปร · ใส่ค่าว่างให้ใบใหม่เสมอ
  //   ไม่ใส่ = พิมพ์ใบกำกับเต็มของใบใหม่จากจอประวัติแอปเก่า throw (พบจาก e2e pos/e2e/amend-compat.e2e.js)
  body.pointDiscount = { value: 0, point: 0 };
  body.campaign = [];
  const openTime = usesShift ? dateOf(oldBill.shiftOpenTime) : undefined;
  if (openTime) body.shiftOpenTime = openTime.toISOString();
  const shape = SaleCreateRequest.shape || {};
  for (const k of CARRY_BODY_FIELDS) {
    let v = oldBill[k];
    if (k === "manualDiscount" && v !== undefined) v = toNumber(v);
    if (v === undefined || v === null || !shape[k]) continue;
    if (shape[k].safeParse(v).success) body[k] = v;
  }
  return body;
}

/** carry: ใบใหม่ถือเวลาและป้ายกะของใบเดิม (ส่งทาง carry ไม่ใช่ body · สัญญาข้อ ②) · ร้านไม่ใช้กะไม่ถือเวลาเปิดรอบ */
function carryOf(oldBill, usesShift = true) {
  return clean({
    shiftId: usesShift || validDocId(oldBill.shiftId) ? oldBill.shiftId : undefined,
    shiftOpenTime: usesShift ? dateOf(oldBill.shiftOpenTime) : undefined,
    dateTime: dateOf(oldBill.dateTime),
    billDate: typeof oldBill.billDate === "string" ? oldBill.billDate : undefined,
    soldAt: dateOf(oldBill.soldAt),
  });
}

/** เรียก handler แบบ factory ในโปรเซสด้วย req/res ปลอม · คืน {status, ...body} */
function inProcess(loadFactory, reqExtra) {
  return async (deps, input) => {
    const handler = loadFactory()(deps);
    const res = {
      statusCode: 0, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      send(b) { this.body = b; return this; },
    };
    await handler({ body: input.body, shopAccess: input.access, ...reqExtra(input) }, res);
    const b = res.body && typeof res.body === "object" ? res.body : {};
    return { ...b, status: res.statusCode };
  };
}
const realCreate = inProcess(() => require("./create").create, (input) => ({ amendCarry: input.carry, amendOf: input.amendOf }));
const realVoid = inProcess(() => require("./void").void, () => ({ amendVoid: true }));

/** บิลเดิมปิดงานแล้วด้วยคำขอนี้ (status done · requestId เดียวกัน · amendedBy = ใบใหม่ของคำขอนี้) → amend · ไม่ใช่ = null */
async function finishedByMe(billDoc, requestId, newBillId) {
  const snap = await billDoc.get();
  const b = snap.exists ? snap.data() : null;
  const a = b && b.amend;
  if (!a || a.status !== "done" || !sameRequestId(a.requestId, requestId)) return null;
  if (!b.amendedBy || b.amendedBy !== newBillId) return null;
  return a;
}

function amend(deps) {
  const log = console.warn;
  const createSale = depOr(deps, "createSale", null);
  const voidSale = depOr(deps, "voidSale", null);

  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
    const input = parseOr400(SaleAmendRequest, body, res);
    if (input === null) return res;
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!hasRight(access, AMEND_RIGHT)) return fail(res, 403, "right_required");

    const refuseRes = (e) => fail(res, e.status, e.error, MESSAGES[e.error], e.extra);
    let now;
    try { now = await readNow(deps); } catch (e) { return internalError(res, e); }
    const innerDeps = { now: () => now };
    const callCreate = createSale ? (i) => createSale(i) : (i) => realCreate(innerDeps, i);
    const callVoid = voidSale ? (i) => voidSale(i) : (i) => realVoid(innerDeps, i);

    const shopDoc = db.collection("shop").doc(access.shopId);
    const billDoc = db.collection("bill").doc(input.billId);
    const trail = adminTrail(access);

    // ① ด่านทั้งหมด + ประทับ pending
    let step;
    try {
      step = await db.runTransaction(async (txn) => {
        const [shopSnap, billSnap] = [await txn.get(shopDoc), await txn.get(billDoc)];
        const bill = billSnap.exists ? billSnap.data() : undefined;
        let shiftData;
        if (bill && validDocId(bill.shiftId)) {
          const s = await txn.get(db.collection("shift").doc(bill.shiftId));
          shiftData = s.exists ? s.data() : undefined;
        }
        // คำขออื่นที่ค้าง pending: ใบใหม่ของคำขอนั้นอาจออกไปแล้วแต่ยังไม่ผูก (ล้มระหว่าง ② กับ ③) ⇒ อ่าน receiptGuard ของมัน
        const held = bill && bill.amend && typeof bill.amend === "object" ? bill.amend : null;
        let heldGuardExists = false;
        if (held && held.status === "pending" && typeof held.requestId === "string" && held.requestId !== "" && !sameRequestId(held.requestId, input.requestId)) {
          const g = await txn.get(db.collection("receiptGuard").doc(amendReceiptUUID(input.billId, held.requestId)));
          heldGuardExists = !!g.exists;
        }
        // ── อ่านครบแล้ว · ต่อจากนี้ตรวจแล้วเขียน ──
        if (!shopSnap.exists) refuse(404, "shop_not_found");
        const shop = shopSnap.data();
        const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        const usesShift = shop.shift === true; // ค่าตั้งต้นแอปเก่า false (main3 src/config/initialShop.js:75)
        if (!isPremiumActive(shop, now)) refuse(403, "premium_required");
        if (shop.amendBill !== true) refuse(403, "feature_disabled");

        const owned = checkOwnedDoc("bill", bill, shopRef);
        if (!owned.ok) refuse(owned.status, owned.error);
        if (typeof bill.receiptNumber !== "string" || bill.receiptNumber === "") refuse(409, "legacy_bill_view_only");

        const lockAmend = isBackLinkOnly(bill.amend) ? null : bill.amend;
        const lock = amendLockState(lockAmend, input.requestId, now);
        if (lock === "done") return { kind: "duplicate", bill };
        if (lock === "busy") refuse(409, "amend_in_progress");
        if (lock === "free" && lockAmend && lockAmend.status === "pending" && (lockAmend.newBillId || heldGuardExists)) {
          // คำขออื่นค้างเกิน 5 นาทีแต่ออกใบใหม่ไปแล้ว ⇒ รับช่วงแทน = ใบใหม่ 2 ใบ · ให้เครื่องเดิมกดยืนยันซ้ำ
          refuse(409, "amend_in_progress", { stalled: true });
        }

        const resume = lock === "resume";
        const prior = resume ? bill.amend : null;
        // ยิงซ้ำหลังออกใบใหม่แล้ว = เดินต่อให้จบ (บิลเดิมอาจยกเลิกแล้วด้วยขั้น ④ ของคำขอนี้เอง)
        if (resume && prior.newBillId) return { kind: "continue", bill, shopRef, changes: prior.changes, usesShift, notiIds: idsOf(shop.notiCancelBill) };

        if (lock === "taken" || isVoidedBill(bill) || bill.amendedBy) refuse(409, "bill_void");
        const locks = amendLocks(bill);
        if (locks.length) refuse(409, "bill_locked", { lock: locks[0] });
        if (usesShift) {
          if (!validDocId(bill.shiftId)) refuse(409, "shift_unknown");
          checkShift(bill, shiftData, shopRef);
        } else {
          checkShiftNoShiftShop(shiftData, shopRef);
        }

        const changes = resume && prior.changes ? prior.changes : changesOf(input);
        const bad = checkAmendShape(bill, changes);
        if (bad) refuse(409, bad);

        if (!resume) {
          txn.update(billDoc, {
            amend: clean({
              status: "pending",
              requestId: input.requestId,
              at: now,
              reason: input.reason,
              staff: input.staffName,
              staffId: input.staffId,
              staffUid: access.uid,
              changes,
              ...trail,
              ...backLinkOf(bill.amend),
            }),
          });
        }
        return { kind: "continue", bill, shopRef, changes, usesShift, notiIds: idsOf(shop.notiCancelBill) };
      });
    } catch (e) {
      if (e instanceof Deny) return refuseRes(e);
      return internalError(res, e);
    }

    const oldBill = step.bill;
    if (step.kind === "duplicate") {
      const a = oldBill.amend;
      return ok(res, {
        ...adminFlag(access),
        status: "done",
        duplicate: true,
        oldBillId: input.billId,
        newBillId: a.newBillId,
        newReceiptNumber: a.newReceiptNumber,
        refundDue: a.refundDue,
      });
    }

    const changes = step.changes;
    const usesShift = step.usesShift !== false;
    const refundDue = refundDueOf(oldBill, changes.moneyMustPaid);
    const prior = oldBill.amend && oldBill.amend.requestId === input.requestId ? oldBill.amend : {};
    let newBillId = prior.newBillId;
    let newReceiptNumber = prior.newReceiptNumber;

    // ② ออกใบใหม่ (ข้ามเมื่อคำขอนี้ผูกใบใหม่ไว้แล้ว)
    if (!newBillId) {
      let created;
      try {
        created = await callCreate({
          body: createBodyOf({ shopId: access.shopId, billId: input.billId, requestId: input.requestId, oldBill, changes, usesShift }),
          carry: carryOf(oldBill, usesShift),
          access,
          amendOf: { billId: input.billId, receiptNumber: oldBill.receiptNumber },
        });
      } catch (e) {
        log("pos/sale/amend: createSale ล้ม", e && e.message);
        created = null;
      }
      if (!created || created.ok !== true || !validDocId(created.billId) || typeof created.receiptNumber !== "string") {
        return fail(res, 500, "amend_create_failed", MESSAGES.amend_create_failed, { oldBillId: input.billId, inner: created && created.error });
      }
      newBillId = created.billId;
      newReceiptNumber = created.receiptNumber;

      // ③ ผูก 2 ทาง
      try {
        await db.runTransaction(async (txn) => {
          const newDoc = db.collection("bill").doc(newBillId);
          const [cur] = [await txn.get(billDoc)];
          const a = cur.exists ? cur.data().amend : null;
          if (a && a.requestId && a.requestId !== input.requestId) throw new Error("คำขออื่นรับช่วงบิลนี้ระหว่างออกใบใหม่");
          txn.update(billDoc, { "amend.newBillId": newBillId, "amend.newReceiptNumber": newReceiptNumber });
          txn.set(newDoc, clean({
            amendOf: input.billId,
            amend: { status: "done", requestId: input.requestId, at: now, ofReceiptNumber: oldBill.receiptNumber, ofBillId: input.billId },
            ...trail,
          }), { merge: true });
        });
      } catch (e) {
        log("pos/sale/amend: ผูกใบใหม่ไม่สำเร็จ", e && e.message);
        return fail(res, 500, "amend_create_failed", MESSAGES.amend_create_failed, { oldBillId: input.billId, newBillId });
      }
    }

    // ④ ยกเลิกใบเดิม
    //   ร้านไม่ใช้กะ: ไม่ส่ง shiftId ⇒ sale.void ไม่เขียน voidShiftId/voidShiftOpenTime (เงินคืนไม่ลงกะ เหมือนแอปเก่ายกเลิก)
    //     doc กะประจำจุดของร้านที่เคยใช้กะอาจค้าง status true ⇒ ส่งไป = เงินคืนลงรอบที่ร้านไม่ได้ใช้
    const reason = `แก้ไข → ${newReceiptNumber} · ${prior.reason || input.reason}`.slice(0, REASON_MAX);
    let voided;
    try {
      voided = await callVoid({
        body: clean({
          shopId: access.shopId,
          billId: input.billId,
          requestId: input.requestId,
          reason,
          staffId: stampedStaff(prior).id || input.staffId,
          staffName: stampedStaff(prior).name || input.staffName,
          shiftId: usesShift ? oldBill.shiftId : undefined,
        }),
        access,
        amendVoid: true,
      });
    } catch (e) {
      log("pos/sale/amend: voidSale ล้ม", e && e.message);
      voided = null;
    }
    if (voided && voided.ok !== true && voided.error === "already_void") {
      // ยิงซ้ำ requestId เดิมพร้อมกัน: อีกตัวทำจบรวม ⑤ ไปแล้ว ⇒ ผลเดิม (duplicate) ไม่ใช่ล้ม
      const fin = await finishedByMe(billDoc, input.requestId, newBillId).catch(() => null);
      if (fin) {
        return ok(res, {
          ...adminFlag(access),
          status: "done",
          duplicate: true,
          oldBillId: input.billId,
          newBillId: fin.newBillId,
          newReceiptNumber: fin.newReceiptNumber,
          refundDue: fin.refundDue,
        });
      }
    }
    if (!voided || voided.ok !== true) {
      return fail(res, 500, "amend_reverse_failed", MESSAGES.amend_reverse_failed, { oldBillId: input.billId, newBillId, inner: voided && voided.error });
    }

    // ⑤ จบ
    const amendStaffName = stampedStaff(prior).name || input.staffName;
    const amendContent = amendNotificationContentOf({
      reason: prior.reason || input.reason,
      oldReceiptNumber: oldBill.receiptNumber,
      newReceiptNumber,
      oldMust: oldBill.moneyMustPaid,
      newMust: changes.moneyMustPaid,
      refundDue,
      staffName: amendStaffName,
    });
    try {
      await db.runTransaction(async (txn) => {
        const cur = await txn.get(billDoc);
        const a = cur.exists ? cur.data().amend : null;
        if (a && a.requestId && a.requestId !== input.requestId) throw new Error("คำขออื่นรับช่วงบิลนี้ก่อนปิดงาน");
        txn.update(billDoc, {
          amendedBy: newBillId,
          "amend.status": "done",
          "amend.newBillId": newBillId,
          "amend.newReceiptNumber": newReceiptNumber,
          "amend.refundDue": refundDue,
          "amend.doneAt": now,
        });
        txn.set(db.collection("notification").doc(), {
          heading: NOTI_HEADING_AMEND,
          shopId: (step.shopRef && (step.shopRef.shopId || step.shopRef.id)) || access.shopId,
          notificationContent: amendContent,
          categoryId: NOTI_CATEGORY_AMEND,
          timestamp: now,
          ...trail,
        });
      });
    } catch (e) {
      log("pos/sale/amend: ปิดงานไม่สำเร็จ", e && e.message);
      return fail(res, 500, "amend_reverse_failed", MESSAGES.amend_reverse_failed, { oldBillId: input.billId, newBillId });
    }
    // push (DEV-0001 push): แจ้ง notiCancelBill ในร้านนี้ หัวข้อ "แก้ไขใบเสร็จ" · ข้อความเดียวกับ notification หมวด 8 · ครั้งที่ปิดงานสำเร็จเท่านั้น (duplicate ไม่ถึงตรงนี้)
    await notify(deps, {
      to: { kind: "staff", shopId: access.shopId, ids: step.notiIds },
      heading: NOTI_HEADING_AMEND, content: amendContent,
      data: { screen: "HomeScreen", sound: `แก้ไขใบเสร็จ โดย ${amendStaffName}` },
    });

    return ok(res, {
      ...adminFlag(access),
      status: "done",
      duplicate: false,
      oldBillId: input.billId,
      newBillId,
      newReceiptNumber,
      refundDue,
    });
  };
}

module.exports = { amend, createBodyOf, carryOf, checkShift, checkShiftNoShiftShop, amendNotificationContentOf, NOTI_CATEGORY_AMEND };

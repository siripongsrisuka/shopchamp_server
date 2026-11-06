// pos/sale/void — ยกเลิกบิลทั้งใบ (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.void.yaml · route POST /pos/sale/void · ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now · now() ไม่ส่ง = new Date()
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับ (อ่านทั้งหมดก่อนเขียน · ทุกอย่างใน transaction เดียว ⇒ 2 เครื่องกดพร้อมกัน คืนสต็อกและแต้มครั้งเดียว #6):
//   1. ด่านนอก transaction: req.shopAccess (401/403) · รูปคำขอ (400) · สิทธิ์ '116' หรือเจ้าของ (403)
//      ยกเว้นเรียกจาก sale.amend ขั้น ④ (req.amendVoid === true · ใส่ได้จากในโปรเซสเท่านั้น express ไม่ส่ง field นี้):
//      ข้าม 116 ตามสัญญา sale.amend.yaml ④ · แต่ยืนยันใน transaction ว่าบิลมี amend {status:pending} ของ requestId นี้
//      (sale.amend ประทับไว้ที่ ① หลังผ่านด่าน 143) ไม่ใช่ = 403 right_required เหมือนเดิม
//   2. อ่าน bill · shop · shift (ถ้าส่ง) → ตัดสินสถานะบิล
//   3. อ่าน stock ของทุกแถว แล้วอ่านสมาชิกในกลุ่มผูกที่ยังไม่ได้อ่าน · อ่าน member ถ้าบิลมีสมาชิก
//   2b. บิลมี amend {status:pending} ของคำขอแก้อื่นที่ยังไม่เกิน 5 นาที (หรืออ่านเวลาไม่ได้) → 409 amend_in_progress (B-9 · 2026-11-06)
//       ยกเว้นคำขอยกเลิกของการแก้นั้นเอง (req.amendVoid + amend.requestId ตรง) · pending เกิน 5 นาที = ค้าง ยกเลิกได้ตามปกติ
//   4. เขียน: stock (คืนตาม logic.planVoidReturn + restoreOnVoid) · bill · member · notification
//      เรียกจาก sale.amend (amendVoid ผ่าน) = ไม่เขียนแจ้งเตือน "ยกเลิกใบเสร็จ" · sale.amend เขียนหมวด "แก้ไขใบเสร็จ" เองที่ ⑤ (B-5)
//
// รูปที่เขียน = รูปที่แอปเก่าเขียน + field เพิ่มอย่างเดียว (แอปเก่ายังอ่านได้):
//   แอปเก่า `shopchamp_app/src/screens/BillHistoryScreen.js:341-470`
//     stock {stock, cost, updateTime} · bill {void:true, voidStaff, reason} · member {point, bought, creditArray, credit?}
//     notification {heading:'ยกเลิกใบเสร็จ', shopId, notificationContent, categoryId:1, timestamp}
//   เพิ่ม: bill voidAt voidStaffId voidRequestId voidShiftId voidShiftOpenTime voidRefundCash · ทีมงาน byAdmin adminUid ทุกเอกสาร
//     voidRefundCash = refundCash ของครั้งแรก (B-10) ⇒ ยิงซ้ำตอบ refundCash เดิม · บิลที่ยกเลิกก่อนมี field นี้ ยิงซ้ำไม่มี refundCash
//   ต่างจากแอปเก่าโดยตั้งใจ:
//     - `updateTime` `timestamp` = นาฬิกา server (deps.now) แทน serverTimestamp() เพราะไม่โหลด SDK ในไฟล์นี้
//     - stock doc ที่ไม่มีแล้ว / เป็นของร้านอื่น = ข้ามแถวนั้นและ log (แอปเก่า throw ทั้งใบ ⇒ บิลที่สินค้าถูกลบยกเลิกไม่ได้เลย)
//     - แต้มต่ำสุด 0 และคืนแต้มที่แลก (#16 · logic.applyVoidToMember)
"use strict";

const { SaleVoidRequest, Bill, BillLegacyV1 } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, deny, parseOr400, internalError, zodIssues } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { AMEND_PENDING_TTL_MS } = require("../_shared/idempotency");

const VOID_RIGHT = "116"; // สิทธิ์ยกเลิกบิลเดิมของแอป (`BillHistoryScreen.js:89`)
const NOTI_HEADING = "ยกเลิกใบเสร็จ";
const NOTI_CATEGORY_VOID = 1;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v !== "";

// ── ตัวช่วยล้วน (export ไว้เทส) ────────────────────────────────────────────────

/**
 * billStateForVoid(raw, requestId) — ตัดสินบิลที่อ่านได้ (ผ่านด่านร้านแล้ว)
 *   → {kind:"void", bill} | {kind:"replay"} | deny 409 (legacy_bill_view_only · bill_unreadable · already_void)
 *   ลอง Bill ก่อน · ไม่ผ่านแต่เป็นรุ่นแรก = ดูอย่างเดียว (Pack เลือก 1) · ไม่ผ่านทั้ง 2 = ไม่เขียนทับ
 */
function billStateForVoid(raw, requestId) {
  const parsed = Bill.safeParse(raw);
  if (!parsed.success) {
    if (BillLegacyV1.safeParse(raw).success) return deny(409, "legacy_bill_view_only", "บิลรุ่นแรกดูได้อย่างเดียว ยกเลิกไม่ได้");
    return { ...deny(409, "bill_unreadable", "อ่านบิลนี้ไม่ได้ ยังไม่ได้ยกเลิก"), issues: zodIssues(parsed.error) };
  }
  const bill = parsed.data;
  if (logic.isVoidedBill(bill)) {
    // ยิงซ้ำด้วยคำขอเดิม = ผลเดิม · บิลที่ถูกแก้ไข (amendedBy) หรือยกเลิกด้วยคำขออื่น/แอปเก่า = already_void
    if (!isNonEmptyString(bill.amendedBy) && isNonEmptyString(bill.voidRequestId) && bill.voidRequestId === requestId) {
      return { kind: "replay", bill };
    }
    return deny(409, "already_void", "บิลนี้ถูกยกเลิกไปแล้ว");
  }
  return { kind: "void", bill };
}

/**
 * amendVoidAllowed(raw, requestId) — บิลนี้กำลังถูกแก้ด้วยคำขอนี้จริงไหม (sale.amend ประทับ ① แล้ว · ยังไม่ปิด ⑤)
 *   ใช้เฉพาะตอน req.amendVoid · ถ้าไม่ใช่ = ห้ามข้ามด่าน 116
 */
function amendVoidAllowed(raw, requestId) {
  const a = isObj(raw) ? raw.amend : undefined;
  return isObj(a) && a.status === "pending" && isNonEmptyString(a.requestId) && a.requestId === requestId;
}

/**
 * amendPendingFresh(raw, now) — บิลมีคำขอแก้ค้าง pending ที่ยังไม่ถือว่าค้างตาย (< 5 นาที · อ่านเวลาไม่ได้ = ยังค้าง fail-closed)
 *   ใช้ตัดสิน 409 amend_in_progress ของ B-9 · ตัวเดียวกับ TTL ของ sale.amend (idempotency.AMEND_PENDING_TTL_MS)
 */
function amendPendingFresh(raw, now) {
  const a = isObj(raw) ? raw.amend : undefined;
  if (!isObj(a) || a.status !== "pending") return false;
  const at = logic.toMillis(a.at);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (at === null || !Number.isFinite(nowMs)) return true;
  return nowMs - at < AMEND_PENDING_TTL_MS;
}

/** replayResultOf(bill) — คำตอบของคำขอเดิมที่ยิงซ้ำ ประกอบจาก field ที่เขียนไว้ครั้งแรก (ไม่เขียนเพิ่ม)
 *   voidShift: open เมื่อครั้งแรกบันทึก voidShiftId (เขียนเฉพาะตอนกะเปิด) · taxNumber คงอยู่บนบิล (#21)
 *   refundCash: จาก bill.voidRefundCash ที่เก็บตอนยกเลิกครั้งแรก (B-10) · บิลที่ไม่มี field นี้ (ยกเลิกก่อน B-10) = ไม่ตอบ (คิดซ้ำไม่ได้)
 */
function replayResultOf(bill) {
  const out = { replay: true, voidShift: { status: isNonEmptyString(bill && bill.voidShiftId) ? "open" : "none" } };
  if (isNonEmptyString(bill && bill.taxNumber)) out.taxNumber = bill.taxNumber;
  if (bill && typeof bill.voidRefundCash === "number" && Number.isFinite(bill.voidRefundCash)) out.refundCash = bill.voidRefundCash;
  return out;
}

/** shiftForVoid(snapData, shopRef) — กะที่ส่งมา · ร้านอื่น = 409 · ไม่มี/ปิดแล้ว = none · เปิดอยู่ = open + openTime */
function shiftForVoid(data, shopRef) {
  if (data === undefined || data === null) return { status: "none", missing: true };
  const owned = checkOwnedDoc("shift", data, shopRef);
  if (!owned.ok) return owned;
  if (data.status === true && data.openTime && typeof data.openTime === "object") return { status: "open", openTime: data.openTime };
  return { status: "none" };
}

/** ข้อความแจ้งเตือนรูปเดียวกับแอปเก่า (`BillHistoryScreen.js:393` · useToLocale = ทศนิยม 2 ตำแหน่ง มีจุลภาค) */
function notificationContentOf({ reason, moneyMustPaid, staffName, receiptNumber }) {
  const n = logic.toNumber(moneyMustPaid);
  const money = Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
  return `เหตุผล ${reason}  \nยอดเงิน ${money} บาท \nโดย ${staffName} \nเลขที่ใบเสร็จ ${receiptNumber} `;
}

/** stockIdsOfLines(lines) — id สินค้าของทุกแถว (ไม่ซ้ำ) · ใช้อ่าน doc ก่อนวางแผนคืน (บิลเก่าไม่มี snapshot ใช้ค่าตั้งปัจจุบัน) */
function stockIdsOfLines(lines) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (isObj(l) && validDocId(l.id) && !out.includes(l.id)) out.push(l.id);
  }
  return out;
}

function validDocId(v) {
  return isNonEmptyString(v) && v.length <= 1500 && !v.includes("/") && v !== "." && v !== "..";
}

// ── handler ─────────────────────────────────────────────────────────────────

function makeVoid(deps) {
  const log = (deps && typeof deps.log === "function") ? deps.log : console.warn;
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(SaleVoidRequest, body, res);
      if (!input) return;
      const hasVoidRight = hasRight(access, VOID_RIGHT);
      const viaAmend = !!req && req.amendVoid === true;
      if (!hasVoidRight && !viaAmend) return sendDeny(res, deny(403, "right_required"));

      const now = await readNow(deps);
      const { db } = require("../../firebase");
      const trail = adminTrail(access);

      const result = await db.runTransaction(async (tx) => {
        const billRef = db.collection("bill").doc(input.billId);
        const shopRef = db.collection("shop").doc(access.shopId);
        const shiftRef = input.shiftId ? db.collection("shift").doc(input.shiftId) : null;
        const [billSnap, shopSnap, shiftSnap] = await Promise.all([
          tx.get(billRef),
          tx.get(shopRef),
          shiftRef ? tx.get(shiftRef) : Promise.resolve(null),
        ]);
        const shop = shopSnap && shopSnap.exists ? shopSnap.data() : undefined;
        if (!shop) return { deny: deny(404, "shop_not_found") };
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });

        const raw = billSnap && billSnap.exists ? billSnap.data() : undefined;
        const owned = checkOwnedDoc("bill", raw, ref);
        if (!owned.ok) return { deny: owned };
        const ownAmend = viaAmend && amendVoidAllowed(raw, input.requestId);
        if (!hasVoidRight && !ownAmend) return { deny: deny(403, "right_required") };

        const state = billStateForVoid(raw, input.requestId);
        if (state.ok === false) {
          if (state.error === "bill_unreadable") log("pos sale.void bill_unreadable", input.billId, JSON.stringify(state.issues || []));
          return { deny: state };
        }
        const bill = state.bill;
        if (state.kind === "replay") return replayResultOf(bill);
        if (!ownAmend && amendPendingFresh(raw, now)) return { deny: deny(409, "amend_in_progress", "บิลนี้กำลังถูกแก้ไขจากเครื่องอื่น") };

        let shift = { status: "none" };
        if (shiftRef) {
          shift = shiftForVoid(shiftSnap && shiftSnap.exists ? shiftSnap.data() : undefined, ref);
          if (shift.ok === false) return { deny: shift };
          if (shift.missing) log("pos sale.void shift_missing", input.shiftId);
        }

        // ── อ่าน stock: แถวของบิล → วางแผน → สมาชิกกลุ่มผูกที่ยังไม่ได้อ่าน (อ่านครบก่อนเขียน)
        const stockDocs = new Map();
        const readStocks = async (ids) => {
          const todo = ids.filter((id) => validDocId(id) && !stockDocs.has(id));
          const snaps = await Promise.all(todo.map((id) => tx.get(db.collection("stock").doc(id))));
          todo.forEach((id, i) => {
            const s = snaps[i];
            const d = s && s.exists ? s.data() : undefined;
            // ของร้านอื่น = ไม่ใช้เป็นค่าตั้ง และไม่เขียน
            stockDocs.set(id, isObj(d) && belongsToShop(d.shopId, ref) ? d : null);
          });
        };
        await readStocks(stockIdsOfLines(bill.product));
        const plan = logic.planVoidReturn(bill.product, (id) => stockDocs.get(id) || undefined);
        await readStocks(plan.moves.map((m) => m.id));
        if (plan.issues.length) log("pos sale.void stock_issues", input.billId, JSON.stringify(plan.issues));

        // ── อ่าน member
        const memberId = isObj(bill.member) && validDocId(bill.member.id) ? bill.member.id : null;
        let memberRef = null;
        let member = null;
        if (memberId) {
          memberRef = db.collection("member").doc(memberId);
          const ms = await tx.get(memberRef);
          const md = ms && ms.exists ? ms.data() : undefined;
          if (isObj(md) && belongsToShop(md.shopId, ref)) member = md;
          else if (isObj(md)) log("pos sale.void member_other_shop", input.billId, memberId);
        }
        const memberEffect = logic.applyVoidToMember(member, {
          id: input.billId,
          gainPoint: bill.gainPoint,
          usedPoint: bill.usedPoint,
          moneyMustPaid: bill.moneyMustPaid,
          payment: bill.payment,
          dateTime: bill.dateTime,
        }, { yearMonth: (logic.boughtMonthOf(now) || {}).yearMonth });

        // ── เขียน (หลังอ่านครบ)
        const skipped = [];
        for (const move of plan.moves) {
          const d = stockDocs.get(move.id);
          if (!d) { skipped.push(move.id); continue; }
          const next = logic.restoreOnVoid(d, move);
          tx.update(db.collection("stock").doc(move.id), { stock: next.stock, cost: next.cost, updateTime: now, ...trail });
        }
        if (skipped.length) log("pos sale.void stock_skipped", input.billId, JSON.stringify(skipped));

        const billUpdate = {
          void: true,
          voidStaff: input.staffName,
          reason: input.reason,
          voidAt: now,
          voidStaffId: input.staffId,
          voidRequestId: input.requestId,
          ...trail,
        };
        if (shift.status === "open") {
          billUpdate.voidShiftId = input.shiftId;
          billUpdate.voidShiftOpenTime = shift.openTime;
        }
        const refundCash = memberEffect.ok ? memberEffect.refundCash : 0;
        billUpdate.voidRefundCash = refundCash;
        tx.update(billRef, billUpdate);

        if (memberRef && member && memberEffect.ok && memberEffect.update) {
          tx.update(memberRef, { ...memberEffect.update, ...trail });
        }

        if (!ownAmend) tx.set(db.collection("notification").doc(), {
          heading: NOTI_HEADING,
          shopId: ref.shopId || ref.id,
          notificationContent: notificationContentOf({
            reason: input.reason,
            moneyMustPaid: bill.moneyMustPaid,
            staffName: input.staffName,
            receiptNumber: bill.receiptNumber,
          }),
          categoryId: NOTI_CATEGORY_VOID,
          timestamp: now,
          ...trail,
        });

        return {
          voided: true,
          taxNumber: isNonEmptyString(bill.taxNumber) ? bill.taxNumber : undefined,
          voidShift: { status: shift.status },
          refundCash,
        };
      });

      if (result.deny) return sendDeny(res, result.deny);
      if (result.replay) {
        const again = { billId: input.billId, alreadyVoid: true, voidShift: result.voidShift, ...adminFlag(access) };
        if (result.taxNumber) again.taxNumber = result.taxNumber;
        if (result.refundCash !== undefined) again.refundCash = result.refundCash;
        return ok(res, again);
      }
      const out = {
        billId: input.billId,
        alreadyVoid: false,
        voidShift: result.voidShift,
        refundCash: result.refundCash,
        ...adminFlag(access),
      };
      if (result.taxNumber) out.taxNumber = result.taxNumber;
      return ok(res, out);
    } catch (err) {
      return internalError(res, err);
    }
  };
}

module.exports = {
  void: makeVoid,
  billStateForVoid,
  amendVoidAllowed,
  amendPendingFresh,
  replayResultOf,
  shiftForVoid,
  notificationContentOf,
  stockIdsOfLines,
};

// pos/shift/manage — เปิดกะ · เงินเข้าออก · ปิดกะ (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/shift.manage.yaml (route POST /pos/shift/manage · factory · deps: now)
// สถานะ: ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: manage(deps) => handler(req, res) · อ่านนาฬิกาครั้งเดียวต่อคำขอด้วย readNow(deps) · ไม่รับเวลาเครื่อง (SC-13)
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับตรวจ: schema 400 → callerAccess 401/403 → (transaction) shop 404 → shift 404/409 → staff 409
//            → duplicate (ก่อนด่านสถานะกะ · กดรัวหลังสำเร็จได้ผลเดิม) → สถานะกะ 409 → คิดยอด → เขียน
// transaction: อ่านครบทุกตัวก่อนเขียน · เขียนรูปเดิมที่แอปเก่าอ่าน เพิ่ม field อย่างเดียว
//   open   อ่าน shop shift                                      → update shift
//   during อ่าน shop shift                                      → update shift.duringShift (ต่อท้าย)
//          ยอดคาดสำหรับคำเตือน CASH_OUT_OVER อ่านบิลหลัง commit (เตือนอย่างเดียว ไม่เขียน · ไม่ล็อกบิลทั้งกะทุกครั้งที่กดเงินเข้าออก)
//   close  อ่าน shop shift shiftHistory/<shiftId>_<openMs> shiftHistory where closeRequestId== bill paidHistory → set shiftHistory · update shift
//          duplicate close หาทุกรอบของจุดขายนี้ (ไม่ใช่แค่รอบปัจจุบัน) ⇒ ส่งซ้ำช้าหลังมีคนเปิดรอบใหม่ ไม่ไปปิดรอบใหม่ทิ้ง
//   during ตอนกะปิด: หา entryId ในประวัติรอบล่าสุด (shiftHistory/<shiftId>_<openMs>) ⇒ ส่งซ้ำหลังปิดกะได้ผลเดิม ไม่ได้ 409
"use strict";

const { db } = require("../../firebase");
const { ShiftManageRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, deny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, resolveShopRef, belongsToShop, checkOwnedDoc, staffInShop, adminTrail, adminFlag } = require("../_shared/auth");
const { shiftHistoryDocId } = require("../_shared/idempotency");

const SHIFT_MESSAGES = {
  shift_already_open: "กะนี้เปิดอยู่แล้วจากอีกเครื่อง",
  shift_not_open: "กะนี้ปิดอยู่",
  staff_not_in_shop: "ไม่พบพนักงานนี้ในร้าน",
  summary_changed: "ยอดกะเปลี่ยนระหว่างทาง กรุณาตรวจยอดใหม่แล้วยืนยันอีกครั้ง",
  shift_open_time_bad: "เวลาเปิดกะอ่านไม่ได้ ปิดกะไม่ได้",
};
const refuse = (status, error, extra) => deny(status, error, SHIFT_MESSAGES[error], extra);

// ── pure (ส่งออกให้เทสข้างไฟล์) ─────────────────────────────────────────────

const isoOf = (t) => {
  const ms = logic.toMillis(t);
  return ms === null ? null : new Date(ms).toISOString();
};
const satang = (n) => Math.round(Number(n) * 100);

/** รอบที่ยังเปิดของ doc shift · roundId = doc id ของประวัติรอบนี้ */
function openRoundOf(shiftId, shift) {
  const roundId = shiftHistoryDocId(shiftId, shift && shift.openTime);
  if (!roundId) return null;
  return { roundId, rounds: [{ roundId, shiftId, openTime: shift.openTime, closeTime: null }] };
}

/** ข้อมูลเข้า logic.shift.roundSummary/closeShift จากเอกสารที่อ่านมา · เอกสารร้านอื่นตัดทิ้ง (shiftId ซ้ำข้ามร้านไม่ควรเกิด แต่ fail-closed) */
function roundInput({ round, shift, shop, shopRef, billDocs, paidDocs }) {
  const mine = (docs) => (docs || []).map((d) => ({ ...d.data(), id: d.id })).filter((x) => belongsToShop(x.shopId, shopRef));
  return {
    roundId: round.roundId,
    rounds: round.rounds,
    bills: mine(billDocs),
    paidHistory: mine(paidDocs),
    openCash: shift.openCash,
    duringShift: shift.duringShift,
    smartCategory: shop.smartCategory,
    POSs: shop.POSs,
  };
}

/** สรุปในคำตอบ · `outside` (บิลเก่าของ doc กะเดียวกันทุกรอบ) ยาวได้ไม่จำกัด ⇒ ส่งเป็นจำนวน */
function summaryForResponse(summary) {
  const { outside, ...rest } = summary || {};
  return { ...rest, outsideQty: Array.isArray(outside) ? outside.length : 0 };
}

function openWrite({ input, now, shift, access }) {
  const n = logic.nextShiftCount({ shiftCount: shift.shiftCount, lastShiftDate: shift.lastShiftDate, now });
  if (!n.ok) return null;
  return {
    count: n.count,
    shiftDate: n.shiftDate,
    patch: {
      status: true,
      openTime: now,
      openCash: input.openCash,
      openId: input.staffId,
      openName: input.staffName,
      lastShiftDate: n.shiftDate,
      shiftCount: n.count,
      duringShift: [],
      openRequestId: input.requestId,
      // ทีมงานเปิด = ติดรอย · คนทั่วไปเปิดทับรอยของรอบก่อน (field บน doc ประจำจุดขายที่ใช้ซ้ำทุกรอบ)
      ...(access.byAdmin === true ? adminTrail(access) : shift.byAdmin === true ? { byAdmin: false, adminUid: null } : {}),
    },
  };
}

function duringEntry({ input, now, access }) {
  return {
    type: input.type,
    amount: input.amount,
    comment: input.comment,
    staff: input.staffName,
    staffId: input.staffId,
    timestamp: now,
    entryId: input.requestId,
    ...adminTrail(access),
  };
}

// รอยทีมงานบน doc shift เป็นของคนเปิด ⇒ ย้ายไป openByAdmin/openAdminUid · byAdmin/adminUid ของประวัติ = คนปิดเท่านั้น
function openTrail(shift) {
  const { byAdmin, adminUid, ...rest } = shift || {};
  if (byAdmin !== true) return rest;
  return { ...rest, openByAdmin: true, openAdminUid: adminUid === undefined ? null : adminUid };
}

function historyDoc({ shiftId, shift, closed, input, now, access }) {
  return {
    ...openTrail(shift),
    // doc id ของ shift เสมอ · sale.create หารอบที่ปิดแล้วด้วย id == shiftId
    id: shiftId,
    ...logic.shiftHistoryFields(closed),
    closeCash: input.closeCash,
    closeName: input.staffName,
    closeId: input.staffId,
    closeTime: now,
    closeWithDraw: input.closeWithDraw,
    closeRequestId: input.requestId,
    lateSales: 0,
    lateBillQty: 0,
    ...(access && access.byAdmin === true ? adminTrail(access) : shift && shift.byAdmin === true ? { byAdmin: false, adminUid: null } : {}),
  };
}

// ── Firestore ───────────────────────────────────────────────────────────────

const shiftBillsQuery = (coll, shiftId) => db.collection(coll).where("shiftId", "==", shiftId);

async function readCommon(tx, access, input) {
  const shopSnap = await tx.get(db.collection("shop").doc(access.shopId));
  if (!shopSnap.exists) return { refusal: deny(404, "shop_not_found") };
  const shop = shopSnap.data() || {};
  const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });
  const shiftRef = db.collection("shift").doc(input.shiftId);
  const shiftSnap = await tx.get(shiftRef);
  const shift = shiftSnap.exists ? shiftSnap.data() : undefined;
  const owned = checkOwnedDoc("shift", shift, shopRef);
  if (!owned.ok) return { refusal: owned };
  if (!staffInShop(shop, input.staffId, access)) return { refusal: refuse(409, "staff_not_in_shop") };
  return { shop, shopRef, shiftRef, shift };
}

async function runOpen(tx, ctx) {
  const { input, now, access } = ctx;
  const c = await readCommon(tx, access, input);
  if (c.refusal) return c;
  const { shift, shiftRef } = c;
  if (shift.openRequestId === input.requestId) {
    return { body: { op: "open", shiftId: input.shiftId, openTime: isoOf(shift.openTime), shiftCount: shift.shiftCount, lastShiftDate: shift.lastShiftDate, duplicate: true } };
  }
  if (shift.status === true) return { refusal: refuse(409, "shift_already_open") };
  const w = openWrite({ input, now, shift, access });
  if (!w) throw new Error("nextShiftCount: now อ่านไม่ได้");
  tx.update(shiftRef, w.patch);
  return { body: { op: "open", shiftId: input.shiftId, openTime: now.toISOString(), shiftCount: w.count, lastShiftDate: w.shiftDate, duplicate: false } };
}

async function runDuring(tx, ctx) {
  const { input, now, access } = ctx;
  const c = await readCommon(tx, access, input);
  if (c.refusal) return c;
  const { shift, shiftRef } = c;
  const list = Array.isArray(shift.duringShift) ? shift.duringShift : [];
  if (list.some((e) => e && e.entryId === input.requestId)) {
    return { body: { op: "during", shiftId: input.shiftId, entryId: input.requestId, warnings: [], duplicate: true } };
  }
  if (shift.status !== true) {
    // ปิดกะล้าง duringShift ⇒ ตัวกันซ้ำย้ายไปอยู่ในประวัติรอบที่เพิ่งปิด
    const round = openRoundOf(input.shiftId, shift);
    const histSnap = round ? await tx.get(db.collection("shiftHistory").doc(round.roundId)) : null;
    const hist = histSnap && histSnap.exists ? histSnap.data() : undefined;
    if (hist && belongsToShop(hist.shopId, c.shopRef) && Array.isArray(hist.duringShift) && hist.duringShift.some((e) => e && e.entryId === input.requestId)) {
      return { body: { op: "during", shiftId: input.shiftId, entryId: input.requestId, warnings: [], duplicate: true } };
    }
    return { refusal: refuse(409, "shift_not_open") };
  }
  tx.update(shiftRef, { duringShift: [...list, duringEntry({ input, now, access })] });
  return { body: { op: "during", shiftId: input.shiftId, entryId: input.requestId, warnings: [], duplicate: false }, afterCommit: { shop: c.shop, shopRef: c.shopRef, shift } };
}

async function runClose(tx, ctx) {
  const { input, now, access } = ctx;
  const c = await readCommon(tx, access, input);
  if (c.refusal) return c;
  const { shop, shopRef, shift, shiftRef } = c;
  const round = openRoundOf(input.shiftId, shift);
  const histRef = round ? db.collection("shiftHistory").doc(round.roundId) : null;
  const histSnap = histRef ? await tx.get(histRef) : null;
  const hist = histSnap && histSnap.exists ? histSnap.data() : undefined;
  // requestId มาจากเครื่อง (ไม่ใช่ id ทั้งระบบ) ⇒ นับเฉพาะประวัติของร้านนี้ + จุดขายนี้ (doc id ขึ้นต้น <shiftId>_)
  const sameReq = await tx.get(db.collection("shiftHistory").where("closeRequestId", "==", input.requestId));
  const prev = (sameReq.docs || []).find((d) => d.id.startsWith(`${input.shiftId}_`) && belongsToShop((d.data() || {}).shopId, shopRef));
  if (prev) {
    const h = prev.data() || {};
    return {
      body: {
        op: "close", shiftId: input.shiftId, shiftHistoryId: prev.id,
        expectedCash: typeof h.currentCash === "number" ? h.currentCash : null,
        closeDiff: typeof h.closeDiff === "number" ? h.closeDiff : null,
        warnings: [], duplicate: true,
      },
    };
  }
  if (shift.status !== true || hist) return { refusal: refuse(409, "shift_not_open") };
  if (!round) return { refusal: refuse(409, "shift_open_time_bad") };
  const billSnap = await tx.get(shiftBillsQuery("bill", input.shiftId));
  const paidSnap = await tx.get(shiftBillsQuery("paidHistory", input.shiftId));
  // ── อ่านครบแล้ว · ต่อจากนี้คิดและเขียนเท่านั้น ──
  const closed = logic.closeShift({
    ...roundInput({ round, shift, shop, shopRef, billDocs: billSnap.docs, paidDocs: paidSnap.docs }),
    closeCash: input.closeCash,
    closeWithDraw: input.closeWithDraw,
  });
  if (!closed.canClose) {
    if (closed.errors.includes("ROUND_NOT_FOUND")) return { refusal: refuse(409, "shift_open_time_bad") };
    return { refusal: deny(400, "invalid_request", undefined, { issues: closed.errors.map((e) => ({ path: "", message: e })) }) };
  }
  if (satang(closed.expectedCash) !== satang(input.expectedCash)) {
    return { refusal: refuse(409, "summary_changed", { expectedCash: closed.expectedCash, summary: summaryForResponse(closed.summary) }) };
  }
  tx.set(histRef, historyDoc({ shiftId: input.shiftId, shift, closed, input, now, access }));
  tx.update(shiftRef, { status: false, duringShift: [] });
  return {
    body: {
      op: "close", shiftId: input.shiftId, shiftHistoryId: round.roundId,
      expectedCash: closed.expectedCash, closeDiff: closed.closeDiff, cashRemain: closed.cashRemain,
      summary: summaryForResponse(closed.summary), warnings: closed.warnings, duplicate: false,
    },
  };
}

// คำเตือนนำเงินออกเกินเงินคาด (SC-26 เตือน ไม่บล็อก) · ยอดคาดก่อนรายการนี้ · อ่านไม่ได้ = ไม่เตือน (ไม่ล้มคำตอบที่เขียนสำเร็จแล้ว)
async function duringWarnings(input, after) {
  try {
    const round = openRoundOf(input.shiftId, after.shift);
    if (!round) return [];
    const [billSnap, paidSnap] = await Promise.all([shiftBillsQuery("bill", input.shiftId).get(), shiftBillsQuery("paidHistory", input.shiftId).get()]);
    const s = logic.roundSummary(roundInput({ round, shift: after.shift, shop: after.shop, shopRef: after.shopRef, billDocs: billSnap.docs, paidDocs: paidSnap.docs }));
    return logic.checkDuringEntry({ type: input.type, amount: input.amount, expectedCash: s.expectedCash }).warnings;
  } catch (e) {
    return [];
  }
}

const RUN = { open: runOpen, during: runDuring, close: runClose };

function manage(deps) {
  return async function handler(req, res) {
    const input = parseOr400(ShiftManageRequest, req && req.body, res);
    if (!input) return undefined;
    const a = callerAccess(req, input.shopId);
    if (!a.ok) return sendDeny(res, a);
    const access = a.access;
    try {
      const now = await readNow(deps);
      const r = await db.runTransaction((tx) => RUN[input.op](tx, { input, now, access }));
      if (r.refusal) return sendDeny(res, r.refusal);
      const body = { ...r.body, ...adminFlag(access) };
      if (r.afterCommit) body.warnings = await duringWarnings(input, r.afterCommit);
      return ok(res, body);
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { manage, openRoundOf, roundInput, summaryForResponse, openWrite, duringEntry, historyDoc, SHIFT_MESSAGES };

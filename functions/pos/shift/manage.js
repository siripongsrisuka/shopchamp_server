// pos/shift/manage — เปิดกะ · เงินเข้าออก · ปิดกะ (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/shift.manage.yaml (route POST /pos/shift/manage · factory · deps: now)
// สถานะ: ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: manage(deps) => handler(req, res) · อ่านนาฬิกาครั้งเดียวต่อคำขอด้วย readNow(deps) · ไม่รับเวลาเครื่อง (SC-13)
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับตรวจ: schema 400 → callerAccess 401/403 → (transaction) shop 404 → shift 404/409 → staff 409
//            → duplicate (ก่อนด่านสถานะกะ · กดรัวหลังสำเร็จได้ผลเดิม) → สถานะกะ 409 → คิดยอด → เขียน
//   staff: open ต้องเป็นพนักงาน status 'active' (B-11 · Pack เคาะ 2026-11-06 · inActive = 409 staff_inactive)
//          during/close ดูแค่ว่าอยู่ในร้าน (คนที่ถูกปิดสถานะกลางกะยังบันทึกเงินและปิดกะของตัวเองได้ ⇒ กะไม่ค้างเปิด)
//          แอปเก่าที่ยังไม่อัปเปิดกะเองไม่ผ่าน API ⇒ ด่านนี้ไม่ครอบเครื่องรุ่นเก่า
// transaction: อ่านครบทุกตัวก่อนเขียน · เขียนรูปเดิมที่แอปเก่าอ่าน เพิ่ม field อย่างเดียว
//   open   อ่าน shop shift                                      → update shift · set notification
//   during อ่าน shop shift shiftHistory where entryIds array-contains requestId → update shift.duringShift (ต่อท้าย) · set notification
//          ยอดคาดสำหรับคำเตือน CASH_OUT_OVER อ่านบิลหลัง commit (เตือนอย่างเดียว ไม่เขียน · ไม่ล็อกบิลทั้งกะทุกครั้งที่กดเงินเข้าออก)
//          ส่งซ้ำช้าหลังมีคนเปิดรอบใหม่ (B-12) = หา entryId ในประวัติทุกรอบของจุดขายนี้ (doc id ขึ้นต้น <shiftId>_ · ร้านนี้) ⇒ duplicate ไม่ต่อท้ายรอบใหม่
//   close  อ่าน shop shift shiftHistory/<shiftId>_<openMs> shiftHistory where closeRequestId== bill paidHistory → set shiftHistory · update shift · set notification
//          duplicate close หาทุกรอบของจุดขายนี้ (ไม่ใช่แค่รอบปัจจุบัน) ⇒ ส่งซ้ำช้าหลังมีคนเปิดรอบใหม่ ไม่ไปปิดรอบใหม่ทิ้ง
//          บิล/ใบรับชำระ (A-8 · กรองเวลาแบบ server เดิม `apis/shift.js:246-249` ไม่อ่านทั้งประวัติจุดขาย):
//            bill        where shiftId== · shiftOpenTime== openTime   (บิลแอปใหม่มีป้ายรอบ · นาฬิกาเครื่องเพี้ยนก็เข้ารอบที่ป้ายบอก SC-13)
//            bill        where shiftId== · dateTime >= openTime       (บิลแอปเก่าไม่มีป้าย · เดิมใช้ > · >= กว้างกว่าแล้ว logic.shift.roundOf ตัดอีกชั้น)
//            paidHistory where shiftId== · shiftOpenTime== openTime  · paidHistory where shiftId== · timestamp >= openTime
//            รวมด้วย doc id ไม่นับซ้ำ · ⚠️ index ผสมที่ต้องมีบน Firestore จริง: bill (shiftId ASC, dateTime ASC) · paidHistory (shiftId ASC, timestamp ASC)
//              (`shopchamp_server/firestore.indexes.json` ยังไม่มี 2 ตัวนี้ · ไม่ได้แก้ไฟล์นั้น · ต้องสร้างก่อนผูก route) · คู่ == == ใช้ index เดี่ยวได้
//          ประวัติ: ช่องของ initialShift ที่ doc กะรุ่นเก่าไม่มี (ก่อน มี.ค. 2025 ไม่มี receiptNumber) เติมค่าตั้งต้นเดิม (C-2) · entryIds ของรอบ (B-12)
//   during ตอนกะปิด: หา entryId ในประวัติรอบล่าสุด (shiftHistory/<shiftId>_<openMs>) ⇒ ส่งซ้ำหลังปิดกะได้ผลเดิม ไม่ได้ 409
// แจ้งเตือน (A-9 · คงแบบแอปเก่า main3 `src/screens/ShiftScreen.js:155-310`): notification categoryId 2 ทุกครั้งที่ open/during/close สำเร็จ
//   heading/notificationContent รูปเดิม · doc id = <shiftId>_<op>_<requestId> (ส่งซ้ำเขียนทับใบเดิม ไม่เพิ่มใบ) · ทีมงาน = มี {byAdmin, adminUid}
//   push OneSignal (notiShift) และ LINE (lineNoti.shift) ยังอยู่ฝั่งแอป ไม่ทำที่นี่ (แบบเดียวกับ member.payCredit)
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
  staff_inactive: "พนักงานนี้ถูกปิดสถานะ เปิดกะไม่ได้",
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
    // ไม่ส่ง POSs (A-7): บิลที่ไม่มี shiftId (แอปก่อน f95d0366) ไม่รับเหมือน server เดิม · query ก็ไม่ดึงมาอยู่แล้ว
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

// ค่าตั้งต้นของ doc กะ (main3 `src/config/initialShift.js`) · ประวัติจาก doc รุ่นเก่าที่ขาดช่องเหล่านี้เติมค่าเดิม (C-2)
//   ช่องที่ปิดกะเขียนทับอยู่แล้ว (close* currentCash) ไม่ต้องเติม · openId/openName ไม่อยู่ใน initialShift แต่ schema ShiftHistory บังคับ = ''
const HISTORY_DEFAULTS = Object.freeze({
  closeBy: "", closeComment: "", openBy: "", openComment: "", openDiff: "", openWithDraw: "",
  openCash: "", openId: "", openName: "", posId: "", receiptNumber: "",
});
const withDefaults = (shift) => {
  const out = { ...(shift || {}) };
  for (const [k, v] of Object.entries(HISTORY_DEFAULTS)) if (out[k] === undefined) out[k] = v;
  return out;
};

function historyDoc({ shiftId, shift, closed, input, now, access }) {
  const during = Array.isArray(shift && shift.duringShift) ? shift.duringShift : [];
  return {
    ...openTrail(withDefaults(shift)),
    // doc id ของ shift เสมอ · sale.create หารอบที่ปิดแล้วด้วย id == shiftId
    id: shiftId,
    ...logic.shiftHistoryFields(closed),
    closeCash: input.closeCash,
    closeName: input.staffName,
    closeId: input.staffId,
    closeTime: now,
    closeWithDraw: input.closeWithDraw,
    closeRequestId: input.requestId,
    entryIds: during.map((e) => (e && typeof e.entryId === "string" ? e.entryId : null)).filter((x) => x !== null),
    lateSales: 0,
    lateBillQty: 0,
    ...(access && access.byAdmin === true ? adminTrail(access) : shift && shift.byAdmin === true ? { byAdmin: false, adminUid: null } : {}),
  };
}

// ── แจ้งเตือน (A-9 · ข้อความรูปเดิมของ ShiftScreen.js) ─────────────────────────

const NOTI_CATEGORY_SHIFT = 2;
const DURING_NAMES = Object.freeze({ 1: "นำเงินเข้า", 2: "นำเงินออก" });
// useToLocale ของแอปเก่า: ทศนิยม 2 ตำแหน่งมีคอมมา · อ่านไม่ได้ = '' (`value?.toLocaleString(...)||''`)
const toLocale = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
};
// stringDateTimeReceipt ของแอปเก่า (dd/mm/yyyy hh:mm:ss ตามเวลาเครื่องไทย) · server คิดเป็น UTC+7 ตรง
const pad = (n, w) => String(n).padStart(w || 2, "0");
const thaiDateTime = (t) => {
  const ms = logic.toMillis(t);
  if (ms === null) return "";
  const d = new Date(ms + 7 * 3600000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function openNotification({ input, count }) {
  return { heading: `เปิดกะที่ ${count}`, notificationContent: `ยอดเงิน ${toLocale(input.openCash)} บาท\nโดย ${input.staffName}` };
}
function duringNotification({ input, shift }) {
  return {
    heading: `จัดการเงินระหว่างกะ (กะที่${shift.shiftCount})`,
    notificationContent: `${input.type === 1 ? "นำเงินเข้า" : "นำเงินออก"}\nจำนวนเงิน : ${input.amount} บาท\nเหตุผล: ${input.comment}\nโดย ${input.staffName}`,
  };
}
function closeNotification({ input, shift, closed }) {
  const s = closed.summary;
  let c = `โดย ${input.staffName}\nรายได้รวม : ${toLocale(s.totalNet)}`;
  for (const p of s.payments) c += `\n${p.name} : ${toLocale(p.amount)}`; // payments ไม่พา change (SC-29) = amount − change ของแอปเก่า
  c += `\nเงินสดเริ่มต้นเปิดกะ ${toLocale(shift.openCash)}\nยอดชำระเงินสด ${toLocale(s.cashSales)}\nเงินสดรวมที่คาดไว้ ${toLocale(closed.expectedCash)}`;
  c += `\nเงินสดที่นับได้จริง ${toLocale(closed.closeCash)}\nยอดเงินขาด/เกิน ${toLocale(closed.closeDiff)}\nเงินสดที่ถอนออก ${toLocale(closed.closeWithDraw)}\nยอดเงินสดคงเหลือในเครื่อง ${toLocale(closed.cashRemain)}`;
  const during = Array.isArray(shift.duringShift) ? shift.duringShift : [];
  if (during.length > 0) {
    c += "\nระหว่างกะ";
    during.forEach((e, i) => {
      const x = e || {};
      c += `\n${i + 1}. ${DURING_NAMES[x.type] === undefined ? x.type : DURING_NAMES[x.type]} ${toLocale(x.amount)} บาท\n โดย ${x.staff}, เหตุผล : ${x.comment} \nเวลา ${thaiDateTime(x.timestamp)} น.`;
    });
  }
  return { heading: `ปิดกะที่ ${shift.shiftCount}`, notificationContent: c };
}

// ── Firestore ───────────────────────────────────────────────────────────────

const shiftBillsQuery = (coll, shiftId) => db.collection(coll).where("shiftId", "==", shiftId);
const TIME_FIELD = { bill: "dateTime", paidHistory: "timestamp" };

/** A-8: เอกสารของรอบนี้ = ป้าย shiftOpenTime == openTime ∪ เวลา >= openTime (รวมด้วย doc id) · get = tx.get หรือ q => q.get() */
async function roundDocs(get, coll, shiftId, openTime) {
  const [byLabel, byTime] = await Promise.all([
    get(shiftBillsQuery(coll, shiftId).where("shiftOpenTime", "==", openTime)),
    get(shiftBillsQuery(coll, shiftId).where(TIME_FIELD[coll], ">=", openTime)),
  ]);
  const seen = new Map();
  for (const d of [...(byLabel.docs || []), ...(byTime.docs || [])]) if (!seen.has(d.id)) seen.set(d.id, d);
  return [...seen.values()];
}

const notiRefOf = (input) => db.collection("notification").doc(`${input.shiftId}_${input.op}_${encodeURIComponent(input.requestId)}`);
function notificationDoc({ shopRef, noti, now, access }) {
  return { ...noti, shopId: shopRef.shopId || shopRef.id, categoryId: NOTI_CATEGORY_SHIFT, timestamp: now, ...adminTrail(access) };
}

async function readCommon(tx, access, input, staffOpts) {
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
  if (staffOpts && staffOpts.activeOnly && !staffInShop(shop, input.staffId, access, { activeOnly: true })) return { refusal: refuse(409, "staff_inactive") };
  return { shop, shopRef, shiftRef, shift };
}

async function runOpen(tx, ctx) {
  const { input, now, access } = ctx;
  const c = await readCommon(tx, access, input, { activeOnly: true });
  if (c.refusal) return c;
  const { shift, shiftRef } = c;
  if (shift.openRequestId === input.requestId) {
    return { body: { op: "open", shiftId: input.shiftId, openTime: isoOf(shift.openTime), shiftCount: shift.shiftCount, lastShiftDate: shift.lastShiftDate, duplicate: true } };
  }
  if (shift.status === true) return { refusal: refuse(409, "shift_already_open") };
  const w = openWrite({ input, now, shift, access });
  if (!w) throw new Error("nextShiftCount: now อ่านไม่ได้");
  tx.update(shiftRef, w.patch);
  tx.set(notiRefOf(input), notificationDoc({ shopRef: c.shopRef, noti: openNotification({ input, count: w.count }), now, access }));
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
  // B-12: ประวัติทุกรอบของจุดขายนี้ที่เก็บ entryIds (เขียนตั้งแต่ server ใหม่) ⇒ ส่งซ้ำช้าหลังเปิดรอบใหม่ = duplicate
  const sameEntry = await tx.get(db.collection("shiftHistory").where("entryIds", "array-contains", input.requestId));
  if ((sameEntry.docs || []).some((d) => d.id.startsWith(`${input.shiftId}_`) && belongsToShop((d.data() || {}).shopId, c.shopRef))) {
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
  tx.set(notiRefOf(input), notificationDoc({ shopRef: c.shopRef, noti: duringNotification({ input, shift }), now, access }));
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
  const txGet = (q) => tx.get(q);
  const billDocs = await roundDocs(txGet, "bill", input.shiftId, shift.openTime);
  const paidDocs = await roundDocs(txGet, "paidHistory", input.shiftId, shift.openTime);
  // ── อ่านครบแล้ว · ต่อจากนี้คิดและเขียนเท่านั้น ──
  const closed = logic.closeShift({
    ...roundInput({ round, shift, shop, shopRef, billDocs, paidDocs }),
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
  tx.set(notiRefOf(input), notificationDoc({ shopRef, noti: closeNotification({ input, shift, closed }), now, access }));
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
    const qGet = (q) => q.get();
    const openTime = after.shift.openTime;
    const [billDocs, paidDocs] = await Promise.all([roundDocs(qGet, "bill", input.shiftId, openTime), roundDocs(qGet, "paidHistory", input.shiftId, openTime)]);
    const s = logic.roundSummary(roundInput({ round, shift: after.shift, shop: after.shop, shopRef: after.shopRef, billDocs, paidDocs }));
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

module.exports = {
  manage, openRoundOf, roundInput, summaryForResponse, openWrite, duringEntry, historyDoc, SHIFT_MESSAGES,
  openNotification, duringNotification, closeNotification, roundDocs, HISTORY_DEFAULTS, thaiDateTime,
};

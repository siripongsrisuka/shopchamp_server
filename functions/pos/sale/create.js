// pos/sale/create — ออกบิลขาย 1 ใบ (ออนไลน์ + บิลออฟไลน์ที่ซิงก์ขึ้นมา) (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.create.yaml · route POST /pos/sale/create · ยังไม่ export จาก index.js และยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now · now() ไม่ส่ง = new Date()
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับ (อ่านทั้งหมดก่อนเขียน · ทุกอย่างใน transaction เดียว · ด่านที่ปัดได้อยู่ก่อนเขียน ⇒ ปัดแล้วเลขไม่ถูกเผา):
//   1. นอก transaction: req.shopAccess (401/403) · receiptUUID (400 ก่อน Zod) · SaleCreateRequest (400) · อ่านนาฬิกาครั้งเดียว
//   2. อ่าน receiptGuard · shop → ซ้ำ = ตอบ duplicate ไม่เขียนอะไร (guard รูปแอปเก่าอ่าน bill/{usedBy} เพิ่ม)
//   3. อ่าน ตัวนับ · shift (+ shiftHistory เมื่อรอบปิดแล้ว) · member · stock ของทุกแถว แล้วสมาชิกกลุ่มผูกที่ยังไม่ได้อ่าน
//   4. ตัดสิน: shift_other_shop · member_not_found/other_shop · point_insufficient · เลขบิล (counter-broken = หา floorRun แล้วคิดใหม่)
//   5. เขียน: bill · receiptGuard · ตัวนับ (merge) · stock · member · shiftHistory (late)
//
// รูปที่เขียน = รูปที่แอปเก่าเขียน + field เพิ่มอย่างเดียว (แอปเก่ายังอ่านได้):
//   แอปเก่า `shopchamp_app/src/screens/CheckoutScreen.js:544-700` (transaction) · `:749-783` (finalReceipt)
//     bill {...finalReceipt, receiptNumber, existPoint, franchiseId} · billId|billDayId {month|date, receipts}
//     stock {stock, updateTime, latestSaleDate?} · member {point, bought, lastTime, creditArray?}
//   เพิ่ม: bill receiptUUID shiftOpenTime shiftUnassigned? shiftHistoryId? stockSnapshot ในแถวสินค้า · ตระกูล offline
//          ตัวนับ serverKey serverRun · guard billId shopId · shiftHistory lateSales lateBillQty · ทีมงาน byAdmin adminUid ทุกเอกสาร
//   ร้านไม่ใช้ระบบกะ (ก้อน 5 ข้อ ①): รูปบิลเท่าแอปเก่าเป๊ะในส่วนกะ = shiftId ประจำจุดขาย (ถ้าส่ง) · ไม่มี shiftOpenTime/shiftUnassigned
//   ต่างจากแอปเก่าโดยตั้งใจ:
//     - `bill.shopId` = field `shop.shopId` แบบแอปเก่า (ร้านเก่า ≠ doc id ได้ · ทุก query ของบิลใช้ค่านี้) · guard.shopId = shop doc id ตามสัญญา
//     - `latestSaleDate` `lastTime` = นาฬิกา server (deps.now) แทน serverTimestamp()
//     - stock `updateTime` = serverTimestamp() เหมือนแอปเก่า (DEV-0007 · เดิมใช้ deps.now ที่อ่านก่อน tx ⇒ เครื่องอื่นซิงก์หลุด · _shared/stockJournal.js ①)
//   สมุด stockJournal kind 'sale' ใน tx เดียวกัน (DEV-0007 · _shared/stockJournal.js ②) · duplicate = ไม่ถึงจุดเขียน ⇒ ไม่นับซ้ำ
//     - ช่องที่ server คิดเอง ทับค่าจากเครื่องเสมอ: franchiseId (= shop.franchiseId | '') · gainPoint usedPoint (= ผล saleMemberEffect)
//     - pointDiscount campaign ที่คำขอไม่ส่ง = เติม {value:0, point:0} และ [] (C-1 · แอปเก่าเขียน 2 ช่องนี้ทุกบิล)
//     - บิลออฟไลน์ที่ soldAt ถูก clamp = unassigned · ไม่มี shiftId/shiftOpenTime · เก็บ shiftIdAtSale (B-8)
//     - stock doc ที่ไม่มี / เป็นของร้านอื่น = ข้ามแถวนั้นและ log (แอปเก่า throw ทั้งใบ · สัญญา: ไม่ปัดการขาย · ติดลบได้ตอนซิงก์)
//     - สต็อกตัดตามค่าตั้งใน stock doc ที่อ่านใน transaction (ไม่เชื่อ stockCountStatus/linkDetail จากเครื่อง · คำขอไม่มีช่องนี้)
// push สต๊อกวิกฤต (DEV-0001 push · แอปใหม่ไม่มี OneSignal): หลัง commit (ไม่ใช่ duplicate) สินค้าที่ขายแล้วหมด/ต่ำกว่า safetyStock
//   → FCM + OneSignal หา shop.notiStock ในร้านนี้ หัวข้อ 'แชมป์บอท 🤖' (รูปเดิมของแอปรุ่นก่อน · แอปใหม่ทำหายไปแล้ว) · lowStockTextOf
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { SaleCreateRequest, CREDIT_PAYMENT_ID } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag, resolveShopRef, belongsToShop, checkOwnedDoc } = require("../_shared/auth");
const { nextBillNumber, billDateOf, billReceiptTypeOf, receiptTypeOf } = require("../_shared/billClock");
const { resolveOfflineSync, stampOfflineFields } = require("../_shared/offlineSync");
const { readReceiptUUID, classifyGuard, legacyDuplicateFromBill, guardDoc } = require("../_shared/idempotency");
const { notify, idsOf } = require("../_shared/push/notify");
const { serverTime, makeJournal, moveContext } = require("../_shared/stockJournal");

// ผลตรวจที่ปัดใน transaction ⇒ โยนออกมาตอบนอก transaction (ยังไม่เขียนอะไร)
class Refusal extends Error {
  constructor(d, logDetail) {
    super(d.error);
    this.deny = d;
    this.logDetail = logDetail;
  }
}
const refuse = (status, error, logDetail) => { throw new Refusal(deny(status, error), logDetail); };

const dataOf = (snap) => (snap && snap.exists ? snap.data() : undefined);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= 1500 && !v.includes("/");
const validDate = (v) => v instanceof Date && Number.isFinite(v.getTime());

/**
 * applyAmendCarry(bill, carry) — ใบใหม่จาก sale.amend ถือเวลาของใบเดิม (สัญญา sale.amend ข้อ ②) · แก้ `bill` ในที่
 *   carry มาจาก req.amendCarry ที่ amend.js ส่งในโปรเซสเท่านั้น (ผ่าน HTTP ไม่ได้ · express ไม่เติม field นี้)
 *   dateTime ไม่ใช่ Date ที่อ่านได้ = ไม่แตะอะไรเลย · billDate ไม่ใช่ข้อความ 8 หลัก = คิดจาก dateTime เดิม
 *   เลขใบใหม่ยังมาจากนาฬิกา server (คิดก่อนเรียกฟังก์ชันนี้)
 */
function applyAmendCarry(bill, carry) {
  if (!isObj(carry) || !validDate(carry.dateTime)) return bill;
  bill.dateTime = carry.dateTime;
  bill.billDate = typeof carry.billDate === "string" && /^\d{8}$/.test(carry.billDate) ? carry.billDate : billDateOf(carry.dateTime);
  if (validDate(carry.soldAt)) bill.soldAt = carry.soldAt;
  return bill;
}

// ── รอบกะ (#18) ─────────────────────────────────────────────────────────────
// shift.status && openTime == shiftOpenTime ⇒ open · ไม่งั้นหา shiftHistory ที่ id==shiftId และ openTime == shiftOpenTime ⇒ late
// ไม่เจอ / ไม่มี shift doc ⇒ unassigned (ไม่ปัดการขาย) · เทียบ ms ในโค้ด ไม่ใช้ == กับ Timestamp
// ก้อน 5 ข้อ ① (Pack เคาะ 2026-11-06): ไม่ส่ง shiftOpenTime = ไม่อ้างรอบเปิด
//   ร้านไม่ใช้ระบบกะ (shop.shift ไม่ใช่ true · ค่าตั้งต้นแอปเก่า main3 src/config/initialShop.js:75) ⇒ 'off' เหมือนแอปเก่า
//     (ขายได้ · บิลถือ shiftId ประจำจุดขาย · ไม่มี shiftOpenTime · ไม่ติดป้าย shiftUnassigned)
//   ร้านใช้ระบบกะ ⇒ 'unassigned' ตามเดิม (เงินต้องไม่หาย ตามรอยได้)
//   ยังอ่าน shift doc เมื่อมี shiftId เพื่อปัด shift_other_shop (สรุปกะแอปเก่า query bill ด้วย shiftId อย่างเดียว ไม่กรองร้าน)
async function readShiftRound(tx, { shiftId, shiftOpenMs, shopRef, shopUsesShift }) {
  const noRound = () => (shopUsesShift ? { status: "unassigned" } : { status: "off" });
  if (shiftId === undefined) return noRound();
  const shiftRef = db.collection("shift").doc(shiftId);
  const shift = dataOf(await tx.get(shiftRef));
  if (shift === undefined) return shiftOpenMs === null ? noRound() : { status: "unassigned" };
  if (!belongsToShop(shift.shopId, shopRef)) refuse(409, "shift_other_shop");
  if (shiftOpenMs === null) return noRound();
  if (shift.status && logic.toMillis(shift.openTime) === shiftOpenMs) return { status: "open" };
  // shiftHistory.shopId คัดลอกจาก shift.shopId (`schema/shiftHistory.md` แถว 2) ⇒ query ด้วยค่าเดียวกัน
  const q = db.collection("shiftHistory").where("shopId", "==", shift.shopId).where("id", "==", shiftId);
  const hs = await tx.get(q);
  const docs = hs && Array.isArray(hs.docs) ? hs.docs : [];
  const hit = docs.find((d) => {
    const h = d.data();
    return isObj(h) && belongsToShop(h.shopId, shopRef) && logic.toMillis(h.openTime) === shiftOpenMs;
  });
  if (!hit) return { status: "unassigned" };
  return { status: "late", shiftHistoryId: hit.id, ref: db.collection("shiftHistory").doc(hit.id), data: hit.data() };
}

// ── สต็อก ───────────────────────────────────────────────────────────────────
// อ่าน stock ของทุกแถวก่อน แล้วอ่านสมาชิกกลุ่มผูกที่ยังไม่ได้อ่าน (ทั้งหมดก่อนเขียน)
async function readStock(tx, { product, shopRef }) {
  const docs = new Map(); // id → data (เฉพาะ doc ที่มีและเป็นของร้านนี้)
  const skipped = [];
  const readIds = async (ids) => {
    const todo = [...new Set(ids)].filter((id) => validDocId(id) && !docs.has(id) && !skipped.some((s) => s.id === id));
    const snaps = await Promise.all(todo.map((id) => tx.get(db.collection("stock").doc(id))));
    todo.forEach((id, i) => {
      const d = dataOf(snaps[i]);
      if (d === undefined) skipped.push({ id, why: "not_found" });
      else if (!belongsToShop(d.shopId, shopRef)) skipped.push({ id, why: "other_shop" });
      else docs.set(id, d);
    });
  };
  await readIds(product.map((l) => l.id));
  // แถวที่ตัดสต็อก: ค่าตั้งจาก doc ในฐาน · จำนวนจากบิล
  const lines = product.map((l) => {
    const d = docs.get(l.id);
    if (!d) return { id: l.id, qty: l.qty };
    return { id: l.id, qty: l.qty, stockCountStatus: d.stockCountStatus, linkMultiply: d.linkMultiply, linkDetail: d.linkDetail };
  });
  const plan = logic.planStockDeduction(lines);
  await readIds(plan.moves.map((m) => m.id));
  return { docs, skipped, lines, plan };
}

// ── floorRun เมื่อ receipts ของรอบนี้อ่านไม่ได้ (counter-broken) ─────────────────
// ลำดับสูงสุดจากบิลที่เลขขึ้นต้นด้วยหัวรอบนี้ · ใช้ index bill(shopId, receiptNumber) ใน firestore.indexes.json (ต้อง deploy ก่อนใช้จริง)
//   emulator ไม่บังคับ index ⇒ เทส floorRun ใน create.test.js / emulator ไม่ได้พิสูจน์ index ของ production
async function findFloorRun(tx, { billShopId, receiptPattern, now }) {
  const p = logic.periodOf(receiptTypeOf(receiptPattern), now, "Asia/Bangkok");
  if (!p.ok) return null;
  const sample = logic.formatDocNumber(p.type, p.key, 1);
  if (!sample) return null;
  const head = sample.slice(0, -6);
  const q = db.collection("bill").where("shopId", "==", billShopId)
    .where("receiptNumber", ">=", head + "000000").where("receiptNumber", "<=", head + "999999");
  const snap = await tx.get(q);
  let max = 0;
  for (const d of (snap && snap.docs) || []) {
    const rn = d.data() && d.data().receiptNumber;
    if (typeof rn === "string" && rn.length === head.length + 6 && rn.startsWith(head)) {
      const run = Number(rn.slice(head.length));
      if (Number.isSafeInteger(run) && run > max) max = run;
    }
  }
  return max;
}

const sumCredit = (payment) =>
  logic.sumMoney(payment.filter((p) => p.id === CREDIT_PAYMENT_ID), "amount");

function create(deps) {
  return async function handler(req, res) {
    const body = req && isObj(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const receiptUUID = readReceiptUUID(body);
    if (receiptUUID === null) return fail(res, 400, "invalid_receipt_uuid");
    const input = parseOr400(SaleCreateRequest, body, res);
    if (!input) return;

    try {
      const now = await readNow(deps);
      const shopDocId = access.shopId;
      const trail = adminTrail(access);
      const offline = resolveOfflineSync({ flag: input.offline, soldAt: input.soldAt, trusted: !!req.shopAccess, now });
      const shiftOpenAt = input.shiftOpenTime === undefined ? null : new Date(input.shiftOpenTime);
      const shiftOpenMs = shiftOpenAt === null ? null : shiftOpenAt.getTime();

      const out = await db.runTransaction(async (tx) => {
        // ── อ่าน ──
        const guardRef = db.collection("receiptGuard").doc(receiptUUID);
        const shopRefDoc = db.collection("shop").doc(shopDocId);
        const [guardSnap, shopSnap] = await Promise.all([tx.get(guardRef), tx.get(shopRefDoc)]);
        const shop = dataOf(shopSnap);
        if (shop === undefined) refuse(404, "shop_not_found");
        const shopRef = await resolveShopRef({ db, shopDocId, shop });

        let g = classifyGuard({ guardId: receiptUUID, guard: dataOf(guardSnap), shopDocId, shopField: shopRef.shopId, shopFieldState: shopRef.fieldState });
        if (g.kind === "duplicate" && g.needsBillRead) {
          const bill = dataOf(await tx.get(db.collection("bill").doc(g.billId)));
          g = legacyDuplicateFromBill(g, bill, shopRef);
        }
        if (g.kind === "other_shop") refuse(409, "receipt_uuid_other_shop");
        if (g.kind === "duplicate") return { duplicate: true, billId: g.billId, receiptNumber: g.receiptNumber };

        const receiptPattern = shop.receiptPattern;
        const counterRef = db.collection(receiptTypeOf(receiptPattern) === "month" ? "billId" : "billDayId").doc(shopDocId);
        const memberId = input.member ? input.member.id : null;
        const [counterSnap, memberSnap] = await Promise.all([
          tx.get(counterRef),
          memberId ? tx.get(db.collection("member").doc(memberId)) : Promise.resolve(null),
        ]);
        const read = await readShiftRound(tx, { shiftId: input.shiftId, shiftOpenMs, shopRef, shopUsesShift: shop.shift === true });
        // B-8 (Pack เคาะ 2026-11-06): บิลออฟไลน์ที่ soldAt ถูก clamp (ย้อนเกิน 4 วัน / ล่วงหน้าเกิน 5 นาที) ไม่ผูกกะใด
        //   ยังอ่านกะเพื่อปัด shift_other_shop เหมือนบิลอื่น · ไม่บวก lateSales · บิลไม่ถือ shiftId/shiftOpenTime (ดูก้อนประกอบบิล)
        const round = offline.soldAtClamped ? { status: "unassigned", reason: "soldAt_clamped" } : read;
        const stock = await readStock(tx, { product: input.product, shopRef });

        // ── ตัดสิน (ยังไม่เขียน) ──
        const billRef = db.collection("bill").doc();
        const billShopId = shopRef.shopId || shopDocId;
        let memberData = null;
        if (memberId) {
          memberData = dataOf(memberSnap);
          const own = checkOwnedDoc("member", memberData, shopRef);
          if (!own.ok) throw new Refusal(own);
        }

        const stored = dataOf(counterSnap) === undefined ? null : dataOf(counterSnap);
        let num = nextBillNumber({ receiptPattern, stored, now });
        if (!num.ok && num.reason === "counter-broken") {
          const floorRun = await findFloorRun(tx, { billShopId, receiptPattern, now });
          if (floorRun !== null) num = nextBillNumber({ receiptPattern, stored, now, floorRun });
        }
        if (!num.ok) refuse(500, "counter_failed", { reason: num.reason, counter: stored });
        const receiptNumber = num.receiptNumber;

        let memberUpdate = null;
        let existPoint = "";
        // แต้มบนบิล = ค่าที่ server ใช้คิดจริง (void คืน/หักจาก bill.usedPoint bill.gainPoint · member.js applyVoidToMember)
        //   ไม่มีสมาชิก = 0 ทั้งคู่ (แอปเก่า prepareDataToWrite)
        let pointsOnBill = { gainPoint: 0, usedPoint: 0 };
        if (memberData) {
          // แอปเก่าคิด usedPoint = แต้มของ pointToDiscount + pointToItem เสมอ ⇒ ไม่หักน้อยกว่ารางวัลที่แลกจริง
          const redeemed = logic.usedPointOf(input.pointDiscount ? [input.pointDiscount] : [], input.pointToItem);
          const usedPoint = Math.max(input.usedPoint !== undefined ? input.usedPoint : 0, redeemed);
          const eff = logic.saleMemberEffect({
            hasMember: true,
            creditAmount: sumCredit(input.payment),
            creditPoint: shop.creditPoint,
            earned: input.gainPoint || 0,
            usedPoint,
            moneyMustPaid: input.moneyMustPaid,
          });
          if (!eff.ok) refuse(400, "invalid_request");
          pointsOnBill = { gainPoint: eff.gainPoint, usedPoint: eff.usedPoint };
          const m =logic.applySaleToMember(memberData, {
            pointDelta: eff.pointDelta, creditDebt: eff.creditDebt, moneyMustPaid: input.moneyMustPaid,
            soldAt: offline.soldAt, billId: billRef.id, receiptNumber, receiptUUID, now,
          });
          if (!m.ok) refuse(m.error === "POINT_INSUFFICIENT" ? 409 : 404, m.error === "POINT_INSUFFICIENT" ? "point_insufficient" : "member_not_found");
          memberUpdate = m.update;
          existPoint = m.existPoint;
          if (offline.offlineSync && Array.isArray(memberUpdate.creditArray) && eff.creditDebt > 0) {
            const last = memberUpdate.creditArray[memberUpdate.creditArray.length - 1];
            memberUpdate.creditArray[memberUpdate.creditArray.length - 1] = { ...last, soldAt: offline.soldAt };
          }
        }

        // ── ประกอบบิล ──
        const billDate = billDateOf(offline.soldAt);
        const product = input.product.map((l, i) => {
          const d = stock.docs.get(l.id);
          return d ? { ...l, stockSnapshot: logic.stockSnapshotOf(stock.lines[i]) } : { ...l };
        });
        const bill = {
          ...input,
          product,
          ...trail,
          ...pointsOnBill,
          // แฟรนไชส์ของบิล = ของร้าน ไม่ใช่ของเครื่อง (แอปเก่า CheckoutScreen.js:143 `franchiseId = ''` จาก shop · :688)
          //   เว็บแฟรนไชส์ดึงบิลด้วยค่านี้ ⇒ เชื่อเครื่อง = เขียนบิลเข้ารายงานแฟรนไชส์อื่นได้
          franchiseId: typeof shop.franchiseId === "string" ? shop.franchiseId : "",
          shopId: billShopId,
          receiptNumber,
          billDate,
          receiptType: billReceiptTypeOf(receiptPattern),
          receiptUUID,
          dateTime: offline.soldAt,
          existPoint,
          // C-1: แอปเก่าพิมพ์ใบกำกับอ่าน pointDiscount.value และ campaign.length ตรง (main3 src/hook/usePrintAction.js:66-67 · :205-206)
          //   คำขอไม่ส่ง = เติมค่าว่างรูปเดียวกับที่แอปเก่าเขียนเสมอ
          pointDiscount: isObj(input.pointDiscount) ? input.pointDiscount : { value: 0, point: 0 },
          campaign: Array.isArray(input.campaign) ? input.campaign : [],
          // C-2: สูตรเดียวกันคิด Number(manualDiscount) + Number(productDiscount) · ไม่มี field = NaN บนใบกำกับ
          //   ค่าว่างรูปแอปเก่า (manualDiscount '' · productDiscount 0 · บิลจากแอปเก่าในร้านทดสอบ 202611000001)
          manualDiscount: input.manualDiscount !== undefined ? input.manualDiscount : "",
          productDiscount: input.productDiscount !== undefined ? input.productDiscount : 0,
        };
        if (shiftOpenAt !== null) bill.shiftOpenTime = shiftOpenAt;
        if (round.status === "unassigned") bill.shiftUnassigned = true;
        if (round.reason === "soldAt_clamped") {
          // B-8: สรุปกะของแอปเก่านับ `shiftId == … and dateTime > openTime` (functions/apis/shift.js:246-249) · dateTime ของบิลนี้ = now
          //   ⇒ ถ้าคง shiftId ไว้ บิลจะถูกนับเข้ารอบที่เปิดอยู่ของแอปเก่าด้วย · ไม่มี shiftId = ไม่มีกะไหน (แอปเก่าและใหม่) นับ
          //   shiftId ที่เครื่องส่งมาเก็บไว้ที่ shiftIdAtSale เพื่อสอบย้อน (ไม่มีผู้อ่าน)
          if (input.shiftId !== undefined) bill.shiftIdAtSale = input.shiftId;
          delete bill.shiftId;
          delete bill.shiftOpenTime;
        }
        if (round.status === "late") bill.shiftHistoryId = round.shiftHistoryId;
        stampOfflineFields(bill, offline, now, { ref: input.offlineRef });
        applyAmendCarry(bill, req.amendCarry);

        // ── เขียน ──
        tx.set(billRef, bill);
        tx.set(guardRef, guardDoc({ now, receiptNumber, billId: billRef.id, shopDocId, trail }));
        tx.set(counterRef, { ...num.write, ...trail }, { merge: true });
        const lowStock = [];
        const journal = makeJournal({ shopDocId, now, cutOff: shop.cutOff, moves: moveContext({ shop, access, now, staffName: input.cashierName, refId: billRef.id, refNo: receiptNumber }) });
        for (const mv of stock.plan.moves) {
          const d = stock.docs.get(mv.id);
          if (!d) continue;
          const upd = { stock: logic.stockAfterMove(d.stock, -mv.qty), updateTime: serverTime(), ...trail };
          journal.move("sale", mv.id, d.stock, upd.stock);
          if (stock.plan.soldIds.includes(mv.id)) lowStock.push({ doc: d, next: upd.stock });
          if (stock.plan.soldIds.includes(mv.id)) upd.latestSaleDate = now;
          tx.update(db.collection("stock").doc(mv.id), upd);
        }
        journal.write(tx, db, trail);
        if (memberUpdate) tx.update(db.collection("member").doc(memberId), { ...memberUpdate, ...trail });
        if (round.status === "late") {
          const h = round.data || {};
          tx.update(round.ref, {
            lateSales: logic.addMoney(h.lateSales, input.moneyMustPaid),
            lateBillQty: (Number.isSafeInteger(h.lateBillQty) ? h.lateBillQty : 0) + 1,
            ...trail,
          });
        }
        return {
          duplicate: false, billId: billRef.id, receiptNumber, billDate: bill.billDate, round,
          skipped: stock.skipped, issues: stock.plan.issues,
          lowStockText: lowStockTextOf(lowStock), notiStock: idsOf(shop.notiStock),
        };
      });

      if (out.duplicate) {
        return ok(res, { duplicate: true, billId: out.billId, receiptNumber: out.receiptNumber, ...adminFlag(access) });
      }
      if (out.skipped.length || out.issues.length) {
        console.warn("pos sale.create stock skipped", out.billId, JSON.stringify({ skipped: out.skipped, issues: out.issues }).slice(0, 2000));
      }
      // push สต๊อกวิกฤต (DEV-0001 push · แทนแอปเก่า main3/merchant_2025 `CheckOutScreen.js:819-831` · แอปใหม่ไม่มีจุดนี้แล้ว)
      if (out.lowStockText) {
        await notify(deps, { to: { kind: "staff", shopId: access.shopId, ids: out.notiStock }, heading: "แชมป์บอท 🤖", content: out.lowStockText, data: { screen: "HomeScreen" } });
      }
      const shift = { status: out.round.status };
      if (out.round.shiftHistoryId) shift.shiftHistoryId = out.round.shiftHistoryId;
      if (out.round.reason) shift.reason = out.round.reason;
      return ok(res, {
        duplicate: false,
        billId: out.billId,
        receiptNumber: out.receiptNumber,
        billDate: out.billDate,
        offline: offline.offlineSync,
        soldAtClamped: offline.soldAtClamped,
        shift,
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof Refusal) {
        if (e.logDetail) console.error("pos sale.create", e.deny.error, JSON.stringify(e.logDetail).slice(0, 4000));
        return sendDeny(res, e.deny);
      }
      return internalError(res, e);
    }
  };
}

/**
 * lowStockTextOf([{doc, next}]) — ข้อความ "สินค้าคงเหลือวิกฤต" รูปเดิม (`shopcham_merchant_2025/src/db/firestore.js:75` alertStock)
 *   ก่อนขาย ≤ 0 = ข้าม (เตือนไปแล้ว) · หลังขาย ≤ 0 = "<ชื่อ> หมดแล้วค่ะ" (ไม่ดูสวิตช์ · แบบเดิม)
 *   สวิตช์ safetyStock.status ปิด = ข้าม · ก่อนขายต่ำกว่าระดับแล้ว = ข้าม · หลังขายต่ำกว่าระดับ = บรรทัดเตือน
 *   ไม่มีบรรทัดเลย = null (ไม่ส่ง) · นับเฉพาะสินค้าที่ขายในบิล (ไม่รวมสมาชิกกลุ่มผูก)
 */
function lowStockTextOf(rows) {
  let text = "สินค้าคงเหลือวิกฤต";
  let lines = 0;
  for (const { doc, next } of rows || []) {
    const prev = logic.toNumber(doc.stock);
    const after = logic.toNumber(next);
    if (!Number.isFinite(prev) || !Number.isFinite(after) || prev <= 0) continue;
    const name = typeof doc.name === "string" ? doc.name : "";
    const unit = typeof doc.unit === "string" ? doc.unit : "";
    if (after <= 0) { text += `\n${name} หมดแล้วค่ะ`; lines++; continue; }
    const ss = doc.safetyStock && typeof doc.safetyStock === "object" ? doc.safetyStock : {};
    const level = logic.toNumber(ss.qty);
    if (!ss.status || !Number.isFinite(level) || prev < level) continue;
    if (after < level) { text += `\n${name} เหลือ ${after} ${unit} น้อยกว่าระดับปลอดภัย(< ${level} ${unit})`; lines++; }
  }
  return lines ? text : null;
}

module.exports = { create, applyAmendCarry, lowStockTextOf };

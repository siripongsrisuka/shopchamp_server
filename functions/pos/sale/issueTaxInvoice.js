// pos/sale/issueTaxInvoice — ออกเลขใบกำกับภาษีเต็มรูปให้บิล 1 ใบ (ก้อน 5 · DEV-0001 · Pack เคาะ 2026-11-06 ข้อ ②)
//
// สัญญา: shopchamp-center/api/sale.issueTaxInvoice.yaml · route POST /pos/sale/issue-tax-invoice · ยังไม่ deploy
// รูป: factory (deps) => handler(req, res) · deps: now · ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
//
// แทนทางเดิมที่แอปเขียนฐานตรง (main3 src/screens/BillHistoryScreen.js:508-553 · แอปใหม่ก่อนก้อนนี้ :417-462):
//   transaction อ่าน taxId/{shop.shopId} {month, receipts} → เลข YYYYMM+6 หลักจากนาฬิกาเครื่อง → update bill {taxNumber, taxCustomer}
//   ช่องโหว่เดิม: ดูว่าบิลมีเลขแล้วจากค่าบนจอ (ไม่อ่านบิลใน transaction) ⇒ 2 เครื่องกดพร้อมกันได้ 2 เลข ใบหลังทับใบแรก (RT-03)
//                 นาฬิกาเครื่องเพี้ยน = หัวเลขผิดเดือน/เริ่มนับ 1 ซ้ำ (RT-01) · เทียบเดือนไม่เทียบปี (RT-13)
//
// ลำดับ (อ่านทั้งหมดก่อนเขียน · transaction เดียว · ด่านที่ปัดได้อยู่ก่อนเขียน ⇒ ปัดแล้วตัวนับไม่ขยับ):
//   1. นอก transaction: callerAccess (401/403) · SaleIssueTaxInvoiceRequest (400) · สิทธิ์ '118' (403 right_required) · อ่านนาฬิกาครั้งเดียว
//   2. อ่าน shop · bill · taxId/{shop.shopId}
//   3. ตัดสินด้วย logic.planTaxNumber (อ่านบิลใน transaction):
//        มีเลขแล้ว = reuse (ไม่แตะตัวนับ · ลูกค้าต่างจากเดิม = เขียน taxCustomer ใหม่แบบจอพิมพ์ซ้ำของแอปเก่า :511)
//        บิลยกเลิก = 409 bill_void · ไม่มีบิล = 404 · บิลร้านอื่น = 409
//   4. ออกใหม่: logic.nextCounter({receiptPattern:'month'}) ด้วยเวลา server · counter-broken = หา floorRun จาก bill.taxNumber ของรอบนี้
//   5. เขียน: taxId (merge {month, receipts, serverKey, serverRun}) · bill {taxNumber, taxCustomer, taxIssuedAt, taxIssuedBy{Id,Name}}
//
// กันทำซ้ำ: กุญแจคือตัวบิลเอง · บิลละเลขเดียว ⇒ ยิงซ้ำ/กดซ้ำ/2 เครื่องพร้อมกัน = ได้เลขเดิม (transaction อ่านบิลก่อนตัดสิน)
// แอปเก่าที่ยังออกเลขเองเขียน taxId {month, receipts} ใน transaction ของมัน ⇒ doc เดียวกัน = Firestore เรียงให้ ไม่ชนกัน
//   ตัวใหม่เขียน month/receipts ความหมายเดิมทุกครั้ง (แอปเก่านับต่อได้) + serverKey/serverRun ที่แอปเก่าไม่ลบ (update ไม่ลบ field อื่น)
// เครื่องพิมพ์: แอปเช็คก่อนเรียก (app src/print/policy.js › taxInvoicePrintable · P-04) · server ไม่เห็นเครื่องพิมพ์ ⇒ printerReady:true
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { SaleIssueTaxInvoiceRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminTrail, adminFlag, resolveShopRef, checkOwnedDoc } = require("../_shared/auth");
const { SHOP_TZ } = require("../_shared/billClock");

const TAX_RIGHT = "118"; // ปุ่มใบกำกับภาษีบนจอประวัติบิล (main3 src/screens/BillHistoryScreen.js:98-106 · แอปใหม่ :65)
const TAX_PATTERN = "month"; // เลขใบกำกับเป็นรายเดือนเสมอ (docNumber.js พฤติกรรมเดิม ④)

class Refusal extends Error {
  constructor(d, logDetail) { super(d.error); this.deny = d; this.logDetail = logDetail; }
}
const refuse = (status, error, logDetail, message) => { throw new Refusal(deny(status, error, message), logDetail); };
const dataOf = (snap) => (snap && snap.exists ? snap.data() : undefined);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** ลูกค้า 2 ก้อนเหมือนกันไหม (เทียบทุกช่องที่ schema รับ · ไม่สนลำดับ key) */
function sameCustomer(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

// ลำดับสูงสุดของเลขใบกำกับที่ออกไปแล้วในรอบนี้ (ใช้เมื่อ receipts อ่านไม่ได้ · ต้องมี index bill(shopId, taxNumber) ก่อนใช้จริง)
async function findTaxFloorRun(tx, { billShopId, now }) {
  const p = logic.periodOf(TAX_PATTERN, now, SHOP_TZ);
  if (!p.ok) return null;
  const sample = logic.formatDocNumber(TAX_PATTERN, p.key, 1);
  if (!sample) return null;
  const head = sample.slice(0, -6);
  const q = db.collection("bill").where("shopId", "==", billShopId)
    .where("taxNumber", ">=", head + "000000").where("taxNumber", "<=", head + "999999");
  const snap = await tx.get(q);
  let max = 0;
  for (const d of (snap && snap.docs) || []) {
    const tn = d.data() && d.data().taxNumber;
    if (typeof tn === "string" && tn.length === head.length + 6 && tn.startsWith(head)) {
      const run = Number(tn.slice(head.length));
      if (Number.isSafeInteger(run) && run > max) max = run;
    }
  }
  return max;
}

function issueTaxInvoice(deps) {
  return async function handler(req, res) {
    const body = req && isObj(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(SaleIssueTaxInvoiceRequest, body, res);
    if (!input) return;
    if (!hasRight(access, TAX_RIGHT)) return sendDeny(res, deny(403, "right_required"));

    try {
      const now = await readNow(deps);
      const shopDocId = access.shopId;
      const trail = adminTrail(access);

      const out = await db.runTransaction(async (tx) => {
        const shopSnap = await tx.get(db.collection("shop").doc(shopDocId));
        const shop = dataOf(shopSnap);
        if (shop === undefined) refuse(404, "shop_not_found");
        const shopRef = await resolveShopRef({ db, shopDocId, shop });
        // ตัวนับอยู่ที่ taxId/{shop.shopId} แบบแอปเก่า (BillHistoryScreen.js:431 `shopId` = field ของร้าน) · ไม่มี field = doc id
        const counterId = shopRef.shopId || shopDocId;
        const billRef = db.collection("bill").doc(input.billId);
        const counterRef = db.collection("taxId").doc(counterId);
        const [billSnap, counterSnap] = await Promise.all([tx.get(billRef), tx.get(counterRef)]);
        const bill = dataOf(billSnap);

        const own = checkOwnedDoc("bill", bill, shopRef);
        if (!own.ok) throw new Refusal(own);
        const plan = logic.planTaxNumber({ bill, printerReady: true });
        if (plan.action === "refuse") {
          if (plan.reason === "bill-void") refuse(409, "bill_void", undefined, "บิลนี้ถูกยกเลิกแล้ว ออกใบกำกับภาษีไม่ได้");
          refuse(404, "bill_not_found");
        }
        if (plan.action === "reuse") {
          const changed = !sameCustomer(bill.taxCustomer, input.taxCustomer);
          if (changed) tx.update(billRef, { taxCustomer: input.taxCustomer, ...trail });
          return { reused: true, taxNumber: plan.taxNumber, customerUpdated: changed };
        }

        const stored = dataOf(counterSnap) === undefined ? null : dataOf(counterSnap);
        let num = logic.nextCounter({ receiptPattern: TAX_PATTERN, stored, now, tz: SHOP_TZ });
        if (!num.ok && num.reason === "counter-broken") {
          const floorRun = await findTaxFloorRun(tx, { billShopId: counterId, now });
          if (floorRun !== null) num = logic.nextCounter({ receiptPattern: TAX_PATTERN, stored, now, tz: SHOP_TZ, floorRun });
        }
        if (!num.ok) refuse(500, "counter_failed", { reason: num.reason, counter: stored });

        tx.set(counterRef, { ...num.write, ...trail }, { merge: true });
        tx.update(billRef, {
          taxNumber: num.receiptNumber,
          taxCustomer: input.taxCustomer,
          taxIssuedAt: now,
          taxIssuedById: input.staffId,
          taxIssuedByName: input.staffName,
          ...trail,
        });
        return { reused: false, taxNumber: num.receiptNumber, customerUpdated: false };
      });

      return ok(res, {
        billId: input.billId,
        taxNumber: out.taxNumber,
        reused: out.reused,
        customerUpdated: out.customerUpdated,
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof Refusal) {
        if (e.logDetail) console.error("pos sale.issueTaxInvoice", e.deny.error, JSON.stringify(e.logDetail).slice(0, 4000));
        return sendDeny(res, e.deny);
      }
      return internalError(res, e);
    }
  };
}

module.exports = { issueTaxInvoice, sameCustomer };

// pos/sale/amendRules — ด่านแบบ pure ของ sale.amend (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.amend.yaml ข้อ 5 (ล็อกทั้งใบ) และข้อ 7 (โครงใบใหม่)
// ⚠️ สัญญาบอกว่าสำเนาเดียวของด่านล็อกควรอยู่ที่ logic.billEdit.amendLocks (ยังไม่มีโมดูลนี้)
//   ⇒ ไฟล์นี้เป็นตัวชั่วคราวฝั่ง server · ย้ายเข้า @shopchamp/logic แล้วให้ไฟล์นี้ re-export เมื่อแอปต้องใช้ซ่อนปุ่ม
// ทุกฟังก์ชันไม่แก้ของที่ส่งเข้ามา · ❌ ไม่ throw · ค่าจากฐานอ่านด้วย money.toNumber (บิลเก่ามีตัวเลขเป็นข้อความ)
"use strict";

const { toNumber } = require("@shopchamp/logic");

const CREDIT_IDS = new Set(["3", "035"]); // เงินเซ็นรุ่นปัจจุบัน 3 · รหัสเก่า '035' (schema CREDIT_PAYMENT_ID · bill.ts BillPaymentLegacyString)
const MONEY_EPS = 0.005; // สัญญาข้อ 7: Σ(amount−change) ≠ moneyMustPaid (±0.005)
const QTY_SCALE = 10000; // qty ทศนิยมได้ไม่เกิน 4 ตำแหน่ง (schema SaleQty)

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
const positive = (v) => toNumber(v) > 0;
const objs = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && typeof x === "object") : []);
const qtyKey = (v) => Math.round(toNumber(v) * QTY_SCALE);
const satang = (v) => Math.round(toNumber(v) * 100);

function isCreditPayment(p) {
  return !!p && typeof p === "object" && p.id !== undefined && p.id !== null && CREDIT_IDS.has(String(p.id));
}

/**
 * amendLocks(bill) → ['tax_invoice' | 'member' | 'promotion', ...] (ว่าง = แก้ได้) · เรียงตามที่สัญญาเขียน
 *   tax_invoice  taxNumber มีค่า
 *   member       member.id · ช่องเงินเซ็น (3 / '035') · gainPoint · usedPoint · pointDiscount.value · pointToItem
 *   promotion    campaign ไม่ว่าง · lucky ไม่ว่าง
 */
function amendLocks(bill) {
  const b = bill && typeof bill === "object" ? bill : {};
  const out = [];
  if (nonEmptyString(b.taxNumber) || (typeof b.taxNumber === "number" && b.taxNumber !== 0)) out.push("tax_invoice");
  const member = b.member && typeof b.member === "object" ? b.member : {};
  const pointDiscount = b.pointDiscount && typeof b.pointDiscount === "object" ? b.pointDiscount : {};
  if (
    nonEmptyString(member.id) ||
    (Array.isArray(b.payment) && b.payment.some(isCreditPayment)) ||
    positive(b.gainPoint) ||
    positive(b.usedPoint) ||
    positive(pointDiscount.value) ||
    nonEmptyArray(b.pointToItem)
  ) out.push("member");
  if (nonEmptyArray(b.campaign) || nonEmptyArray(b.lucky)) out.push("promotion");
  return out;
}

/** Σ(amount − change) ของช่องจ่าย เป็นบาท */
function paidNet(payment) {
  return objs(payment).reduce((s, p) => s + toNumber(p.amount) - toNumber(p.change), 0);
}

/** ช่องจ่ายรูปเทียบได้ · เรียงตาม id ⇒ ลำดับต่างแต่ของเท่ากัน = ไม่เปลี่ยน */
function paymentKey(payment) {
  return objs(payment)
    .map((p) => `${String(p.id)}=${satang(toNumber(p.amount) - toNumber(p.change))}`)
    .sort()
    .join("|");
}

/**
 * checkAmendShape(oldBill, input) → null (ผ่าน) | 'line_mismatch' | 'qty_increase' | 'net_increase' | 'payment_mismatch' | 'nothing_changed'
 *   เรียงด่านตามสัญญาข้อ 7 · input ผ่าน SaleAmendRequest แล้ว (fromIndex ไม่ซ้ำ · ไม่มีเงินเซ็น)
 */
function checkAmendShape(oldBill, input) {
  const oldLines = Array.isArray(oldBill && oldBill.product) ? oldBill.product : [];
  for (const line of input.product) {
    const old = oldLines[line.fromIndex];
    if (!old || typeof old !== "object" || String(old.id) !== String(line.id)) return "line_mismatch";
  }
  for (const line of input.product) {
    if (qtyKey(line.qty) > qtyKey(oldLines[line.fromIndex].qty)) return "qty_increase";
  }
  const oldMust = toNumber(oldBill.moneyMustPaid);
  const newMust = toNumber(input.moneyMustPaid);
  if (newMust > oldMust + MONEY_EPS) return "net_increase";
  if (Math.abs(paidNet(input.payment) - newMust) > MONEY_EPS) return "payment_mismatch";

  const sameLines =
    input.product.length === oldLines.length &&
    input.product.every((l) => qtyKey(l.qty) === qtyKey(oldLines[l.fromIndex].qty));
  if (sameLines && paymentKey(input.payment) === paymentKey(oldBill.payment)) return "nothing_changed";
  return null;
}

/** refundDue = moneyMustPaid เดิม − ใหม่ · ปัดสตางค์ · ต่ำสุด 0 */
function refundDueOf(oldBill, newMust) {
  const s = satang(toNumber(oldBill && oldBill.moneyMustPaid)) - satang(newMust);
  return s > 0 ? s / 100 : 0;
}

module.exports = { amendLocks, checkAmendShape, refundDueOf, paidNet, isCreditPayment, CREDIT_IDS, MONEY_EPS };

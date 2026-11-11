// pos/scango/_core.js — ของร่วมของเส้นขาเข้าจาก ScanGo (auth 'partner') · ไม่ใช่ handler · ไม่ถูก route
//
// ซองคำตอบ = respond.js (ok / fail) · ปัดระหว่างทาง = throw Refusal แล้ว wrap() แปลงเป็นคำตอบ
// ตรวจรูปคำขอเอง (strict ระดับบนสุด · ช่องเกิน = 400 invalid_request) · ร้าน = body.externalId (= shopId ของ Shopchamp)
// ใบสั่ง = scangoOrder/{orderRef} (doc id = orderRef ของ ScanGo ตรง ๆ) · ใบของร้านอื่น = 404 order_not_found (ไม่บอกว่ามีใบ)
"use strict";

const { db } = require("../../firebase");
const { deny, sendDeny, internalError } = require("../_shared/respond");

const ORDERS = "scangoOrder";
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL = Object.freeze(["delivered", "failed", "cancelled"]);

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (status, code, message, extra) => { throw new Refusal(deny(status, code, message, extra)); };
const bad = (message) => refuse(400, "invalid_request", message);

const str = (v) => (v == null ? "" : String(v).trim());
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);

function wrap(run) {
  return async function handler(req, res) {
    try {
      return await run(req, res);
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

function bodyOf(req) {
  const b = req ? req.body : undefined;
  if (b === undefined || b === null) return {};
  if (!isObj(b)) bad("คำขอต้องเป็น object");
  return b;
}
function onlyKeys(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`ไม่รับช่อง: ${extra.join(", ")}`);
}
function idOf(v, label) {
  if (typeof v !== "string" || !ID_RE.test(v)) bad(`${label} ต้องเป็นรหัส A-Z a-z 0-9 _ - ยาว 1-128 ตัว`);
  return v;
}
/** ช่องข้อความที่ไม่บังคับ (at · eventId · reason) — ไม่ใช่ข้อความ / ยาวเกิน = 400 */
function optText(b, k, max) {
  if (!has(b, k) || b[k] === null || b[k] === undefined) return "";
  if (typeof b[k] !== "string" || b[k].length > max) bad(`${k} ต้องเป็นข้อความไม่เกิน ${max} ตัว`);
  return b[k].trim();
}

/** loadShop(shopId) → shop data · ไม่มี = 404 shop_not_found */
async function loadShop(shopId) {
  const snap = await db.collection("shop").doc(shopId).get();
  if (!snap.exists) refuse(404, "shop_not_found", "ไม่พบร้านนี้ในระบบ");
  return snap.data() || {};
}

/** loadProducts(shopId, ids) → Map id → {id, ...data} เฉพาะ doc ที่มีจริงและเป็นของร้านนี้ (ร้านอื่น = เหมือนไม่มี) */
async function loadProducts(shopId, ids) {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x !== "" && !x.includes("/")))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 100) {
    const refs = uniq.slice(i, i + 100).map((id) => db.collection("stock").doc(id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s, j) => {
      if (!s || !s.exists) return;
      const d = s.data() || {};
      if (d.shopId !== shopId) return;
      out.set(refs[j].id, { ...d, id: refs[j].id });
    });
  }
  return out;
}

const orderRefOf = (orderRef) => db.collection(ORDERS).doc(orderRef);
/** runTx(fn) — db.runTransaction (Refusal ที่โยนในนั้นหลุดออกมาให้ wrap แปลงเป็นคำตอบ) */
const runTx = (fn) => db.runTransaction(fn);

/** loadShopOrder(shopId, orderRef) → {ref, data} · ไม่มี/ร้านอื่น = 404 order_not_found */
async function loadShopOrder(shopId, orderRef, tx) {
  const ref = orderRefOf(orderRef);
  const snap = tx ? await tx.get(ref) : await ref.get();
  const data = snap && snap.exists ? snap.data() || {} : null;
  if (!data || data.shopId !== shopId) refuse(404, "order_not_found", "ไม่พบออเดอร์นี้");
  return { ref, data };
}

const isTerminal = (d) => TERMINAL.includes(str(d && d.state));

/** patch ลบเบอร์ลูกค้า (เห็นเฉพาะช่วงใบยังวิ่ง) */
function redactPhonePatch(d) {
  const c = isObj(d && d.customer) ? d.customer : {};
  return { customer: { ...c, phone: null } };
}

module.exports = {
  ORDERS, ID_RE, TERMINAL, Refusal, refuse, bad, str, isObj, has, wrap, bodyOf, onlyKeys, idOf, optText,
  loadShop, loadProducts, orderRefOf, runTx, loadShopOrder, isTerminal, redactPhonePatch,
};

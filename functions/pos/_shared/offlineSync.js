// pos/_shared/offlineSync.js — "บิลนี้ขายตอนเน็ตหลุดแล้วส่งขึ้นทีหลัง" ตัดสินและประทับที่ server (ก้อน 4 · DEV-0001)
//
// ยกจากพี่น้อง `claude/_shared/offlineSync.js` (resolveOfflineSync · stampOfflineFields) แล้วแก้ตาม decision บ้านนี้:
//   · ถอดเงื่อนไข "ร้านเปิดสวิตช์ในฐาน" (Pack เลือก 1-1 + offline §8 ทาง 1: ขายออฟไลน์ได้ทุกร้าน ไม่มีสวิตช์)
//     ⇒ ป้ายนับว่าจริงเมื่อ ① flag === true ② ผู้ส่งผ่าน requireShopAccess แล้ว (handler ส่ง trusted:true เมื่อมี req.shopAccess)
//   · ตัดเลขคิวชั่วคราว (offlineQue) ของร้านอาหาร · offlineRef (≤40) เป็นของ server เสมอ
//   · ไม่ประทับ `timestamp` (สัญญา sale.create: "❌ ไม่เขียน timestamp" · เวลาบิลอยู่ที่ dateTime ซึ่ง handler ตั้งเอง)
//
// ช่วงเวลา: soldAt ย้อนได้ 4 วัน (เพดานเปิดแอปออฟไลน์ 3 วัน + ส่วนเผื่อ) · ล่วงหน้าได้ 5 นาที (นาฬิกาเครื่องเพี้ยน)
//   ขอบรวม: ย้อนพอดี 4 วัน และล่วงหน้าพอดี 5 นาที = ยังอยู่ในช่วง (ตามพี่น้อง `>=` `<=`)
//   นอกช่วง / อ่านไม่ออก = ❌ ไม่ปัดการขาย · ใช้ now + soldAtClamped:true (บิลลงวันซิงก์)
// pure: ไม่อ่านนาฬิกาเอง ไม่แตะฐาน ไม่ log
"use strict";

const OFFLINE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const OFFLINE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const OFFLINE_REF_MAX_LEN = 40; // ตรงกับ SaleCreateRequest.offlineRef (max 40)
// ISO ที่ JSON.stringify(Date) ผลิต + offset · หลวมกว่านี้ = new Date("2026") ผ่าน
const OFFLINE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ช่องที่ server เป็นเจ้าของบนเอกสารบิล · ผู้ส่งแนบมาเอง = ตัดทิ้งเสมอ
const OFFLINE_OWNED_FIELDS = ["offline", "soldAt", "offlineSync", "syncedAt", "soldAtClamped", "offlineRef"];

/** ISO string → ms · ไม่ใช่ ISO มีโซน = NaN */
function soldAtMs(raw) {
  if (typeof raw !== "string" || !OFFLINE_ISO_RE.test(raw)) return NaN;
  return new Date(raw).getTime();
}

/**
 * resolveOfflineSync({flag, soldAt, trusted, now})
 * @param {*} p.flag     body.offline (เชื่อเฉพาะ === true)
 * @param {*} p.soldAt   body.soldAt (ISO มีโซน)
 * @param {boolean} p.trusted  ผ่าน requireShopAccess แล้ว (เชื่อเฉพาะ === true) · handler: `trusted: !!req.shopAccess`
 * @param {Date} p.now   เวลา server ของคำขอ (readNow)
 * @returns {{offlineSync:boolean, soldAt:Date, soldAtClamped:boolean, ignored:null|'not_trusted'}}
 *   ไม่ใช่ offline ⇒ soldAt = now (ผู้เรียกใช้ตัวแปรเดียวต่อได้ทั้ง 2 ทาง)
 */
function resolveOfflineSync({ flag, soldAt, trusted, now } = {}) {
  const off = { offlineSync: false, soldAt: now, soldAtClamped: false, ignored: null };
  if (flag !== true) return off;
  if (trusted !== true) return { ...off, ignored: "not_trusted" };
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const ms = soldAtMs(soldAt);
  const inRange = Number.isFinite(nowMs) && Number.isFinite(ms)
    && ms <= nowMs + OFFLINE_FUTURE_SKEW_MS && ms >= nowMs - OFFLINE_MAX_AGE_MS;
  if (!inRange) return { offlineSync: true, soldAt: now, soldAtClamped: true, ignored: null };
  return { offlineSync: true, soldAt: new Date(ms), soldAtClamped: false, ignored: null };
}

/** offlineRef ที่เก็บได้: string trim แล้วไม่ว่าง ≤ 40 · อย่างอื่น = null */
function offlineRefOf(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= OFFLINE_REF_MAX_LEN ? t : null;
}

/**
 * stampOfflineFields(data, offline, syncedAt, {ref}) — แก้ `data` (ก้อนบิลที่จะเขียน) ในที่ แล้วคืนตัวเดิม
 *   ตัดช่องตระกูล offline ของผู้ส่งทิ้งเสมอ · ได้สิทธิ์ = ประทับ offlineSync:true soldAt syncedAt offlineRef? soldAtClamped?
 *   ไม่ได้สิทธิ์ = ไม่มีช่องตระกูลนี้เลย (รูปบิลออนไลน์เดิมทุกไบต์)
 * @param {Date} syncedAt เวลา server (ไม่ใช่ soldAt)
 */
function stampOfflineFields(data, offline, syncedAt, { ref } = {}) {
  for (const f of OFFLINE_OWNED_FIELDS) delete data[f];
  if (!offline || offline.offlineSync !== true) return data;
  data.offlineSync = true;
  data.soldAt = offline.soldAt;
  data.syncedAt = syncedAt;
  if (offline.soldAtClamped) data.soldAtClamped = true;
  const cleanRef = offlineRefOf(ref);
  if (cleanRef) data.offlineRef = cleanRef;
  return data;
}

module.exports = {
  resolveOfflineSync,
  stampOfflineFields,
  offlineRefOf,
  soldAtMs,
  OFFLINE_OWNED_FIELDS,
  OFFLINE_FUTURE_SKEW_MS,
  OFFLINE_MAX_AGE_MS,
  OFFLINE_REF_MAX_LEN,
};

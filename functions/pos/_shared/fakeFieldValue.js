// pos/_shared/fakeFieldValue.js — FieldValue ปลอมสำหรับฐานปลอมในเทส pos (DEV-0007) · ไม่ใช่ handler · ไม่ถูก route
//
// handler อ่าน FieldValue จาก functions/firebase (ดู _shared/stockJournal.js) ⇒ เทสที่แทน functions/firebase ต้องส่ง FieldValue ด้วย
// ตัวแทนเป็น object ธรรมดา (เทียบ JSON ได้) รูปเดียวกับที่ harness ของสัญญา (shopchamp-center/gate/api-harness.js) ใช้:
//   serverTimestamp() → {__fv__:"serverTimestamp"} · increment(n) → {__fv__:"increment", by:n}
// applyWrite(prev, data, {op, merge, commitTime}) = ผลของการเขียน 1 ครั้งแบบ Firestore:
//   serverTimestamp = commitTime (เวลา commit ของ tx นั้น · ทุกช่องใน commit เดียวกันได้ค่าเดียวกัน)
//   increment = ค่าเดิม (ไม่ใช่เลข = 0) + by
//   update = ทับรายช่องบนสุด · set merge = รวมลึกเฉพาะ map (object ธรรมดา) · set = แทนทั้ง doc
"use strict";

const FieldValue = Object.freeze({
  serverTimestamp: () => ({ __fv__: "serverTimestamp" }),
  increment: (by) => ({ __fv__: "increment", by }),
});

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
const isFv = (v) => isPlain(v) && typeof v.__fv__ === "string";

function resolve(prev, v, commitTime, deep) {
  if (isFv(v)) {
    if (v.__fv__ === "serverTimestamp") return new Date(commitTime.getTime());
    if (v.__fv__ === "increment") return (typeof prev === "number" ? prev : 0) + v.by;
    throw new Error(`fakeFieldValue: ไม่รู้จัก ${v.__fv__}`);
  }
  if (deep && isPlain(v)) {
    const base = isPlain(prev) ? { ...prev } : {};
    for (const [k, x] of Object.entries(v)) base[k] = resolve(base[k], x, commitTime, true);
    return base;
  }
  if (isPlain(v)) {
    // map ใหม่ทั้งก้อน (update / set ไม่ merge) · FieldValue ข้างในยังคิดจากค่าว่าง
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolve(undefined, x, commitTime, false);
    return out;
  }
  return v;
}

function applyWrite(prev, data, { op, merge, commitTime }) {
  const t = commitTime instanceof Date ? commitTime : new Date();
  if (op === "set" && !merge) return resolve(undefined, data, t, false);
  if (op === "set" && merge) return resolve(prev, data, t, true);
  // update: ทับรายช่องบนสุด
  const out = { ...(prev || {}) };
  for (const [k, x] of Object.entries(data || {})) out[k] = resolve(out[k], x, t, false);
  return out;
}

module.exports = { FieldValue, applyWrite, isFv };

// pos/_shared/stockJournal.js — เวลา commit ของ stock + สมุดเคลื่อนไหวสต๊อกรายวันต่อร้าน (DEV-0007)
//
// ① serverTime() — updateTime ของ stock doc = FieldValue.serverTimestamp() (เวลา commit จริง)
//   เหตุ: เครื่องซิงก์ด้วย `stock where shopId == … and updateTime > lastSync` และ lastSync = updateTime สูงสุดที่เคยได้
//     (`shopchamp_app/src/hook/useLocalStock.js:538-560` · แอปเก่า main3 รูปเดียวกัน `:560-580`)
//   เดิม handler ใช้ deps.now ที่อ่านก่อนเริ่ม transaction ⇒ tx ที่ช้า/ถูก retry commit ทีหลังด้วยเวลาที่เก่ากว่า lastSync ของเครื่องที่ซิงก์ไประหว่างนั้น
//     ⇒ เครื่องนั้นไม่เห็นการเปลี่ยนนี้อีกเลย (เทส pos/stock/syncTime.test.js พิสูจน์ 2 ทิศ)
//   serverTimestamp = เวลา commit ⇒ query ที่อ่าน ณ เวลา R เห็นทุก commit ที่ ≤ R และ commit ถัดไปได้เวลา > R เสมอ
//   ชนิดที่เก็บ = Firestore Timestamp เท่าเดิม (Date ที่เขียนก็กลายเป็น Timestamp) · แอปเก่าเขียน serverTimestamp() อยู่แล้วทุกจุด
// ② makeJournal() — สมุด `stockJournal/{shopDocId}_{YYYYMMDD}_{kind}_{part}` เขียนใน transaction เดียวกับการเปลี่ยน stock
//   รูป doc (schema StockJournal):
//     { shopId: <shop doc id>, day: 'YYYYMMDD' (วันธุรกิจตาม shop.cutOff ของเวลา server) , kind, part,
//       qty: { <stock doc id>: increment(ผลต่างของช่อง stock ที่เขียนจริง) }, events: increment(1), updateTime: serverTimestamp }
//   · qty = after − before ของแต่ละ stock doc ที่ถูกเขียน (หน่วยเดียวกับช่อง stock ใน doc นั้น · สินค้าผูกกลุ่มทุกตัวขยับเท่ายอดหน่วยเล็กสุด)
//     before อ่านด้วย logic.toNumber (ตัวหนังสือ/NaN = 0 · สูตรเดียวกับที่ตัดสต๊อก) · ผลต่าง 0 = ไม่ลง
//   · kind = sale void receive receiveEdit adjust requisition create delete link · amend = void + sale ของใบใหม่
//     delete = ยอดคงเหลือที่ออกจากคลังตอนลบ (−stock ของตัวที่ลบ · ช่อง stock ไม่ได้เปลี่ยน) + ยอดที่ย้ายไปหน่วยที่เหลือของกลุ่มผูก
//     link = แปลงหน่วยตอนสร้าง/เลิกผูกกลุ่ม (ไม่ใช่ของเข้าออกจริง แต่ให้ start + Σqty = ยอดปลายวัน ต่อ doc)
//   · set merge + increment = เขียนบอด ไม่อ่าน doc สมุด ⇒ ไม่เพิ่ม read และไม่ชนกันระหว่าง tx ที่อ่าน (เขียนต่อ doc ~ไม่กี่ครั้ง/วินาที ต่ำกว่าเพดาน)
//   · กันนับซ้ำ = ใช้ด่านเดิมของ handler: สมุดเขียนเฉพาะตอน handler เขียน stock จริง (ส่งซ้ำ/duplicate/unchanged ไม่ถึงจุดเขียน)
//     tx ที่ Firestore retry = รันฟังก์ชันใหม่ทั้งก้อน · เขียนจริงครั้งเดียวตอน commit
//   · แยก doc ตามชนิด (และ part สำหรับชนิดที่ทำทีละมากได้) กันเพดาน 1 MiB: ราว 29-45 ไบต์ต่อสินค้า (id 20-36 ตัว)
//     ⇒ ~23,000 สินค้าต่อ doc · ร้าน p90 5,119 สินค้าเต็มชนิดละ ~230 KB · receive adjust create แบ่ง 4 part (~93,000 ต่อวัน ≥ เพดานร้าน 50,000)
// ❌ ไม่ require SDK ตัวจริง · FieldValue มาจาก ../../firebase (harness/เทสแทนของปลอม)
"use strict";

const logic = require("@shopchamp/logic");
const { billDateOf } = require("./billClock");

const COLLECTION = "stockJournal";
const KINDS = Object.freeze(["sale", "void", "receive", "receiveEdit", "adjust", "requisition", "create", "delete", "link"]);
// ชนิดที่ 1 วันแตะสินค้าทั้งร้านได้ (นับสต๊อกทั้งร้าน · รับเข้าล็อตใหญ่ · เปิดร้านเพิ่มสินค้าทีละมาก) = แบ่ง part ตาม hash ของ id
const PARTS = Object.freeze({ receive: 4, adjust: 4, create: 4 });

function fieldValue() {
  const fb = require("../../firebase");
  // functions/firebase.js ถูกแช่แข็ง (legacy-freeze) ⇒ ไม่เพิ่ม export · ตัวจริงเอาจาก admin.firestore.FieldValue · harness/เทสส่ง FieldValue ปลอมตรง
  const fv = fb && (fb.FieldValue || (fb.admin && fb.admin.firestore && fb.admin.firestore.FieldValue));
  if (!fv || typeof fv.serverTimestamp !== "function" || typeof fv.increment !== "function") {
    throw new Error("functions/firebase ไม่มี FieldValue (serverTimestamp/increment)");
  }
  return fv;
}

/** updateTime ของ stock doc = เวลา commit (ดูหัวไฟล์ ①) */
const serverTime = () => fieldValue().serverTimestamp();

/** วันธุรกิจของร้าน ณ เวลา server (รูป YYYYMMDD เหมือน bill.billDate) · อ่านไม่ได้ = วันปฏิทินไทย */
function journalDayOf(now, cutOff) {
  const r = logic.businessDayOf(now, cutOff);
  return r.ok ? r.key : billDateOf(now);
}

// FNV-1a 32 bit · เสถียรทุกเครื่อง ⇒ สินค้าเดิมลง part เดิมเสมอ
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const partOf = (kind, id) => {
  const n = PARTS[kind] || 1;
  return n === 1 ? 0 : hash32(String(id)) % n;
};
const journalDocId = (shopDocId, day, kind, part) => `${shopDocId}_${day}_${kind}_${part}`;

/**
 * makeJournal({shopDocId, now, cutOff}) → {day, move, add, has, entries, write}
 *   move(kind, id, before, after) — ลงผลต่างของช่อง stock (after − before)
 *   add(kind, id, delta)          — ลงผลต่างตรง ๆ (ใช้กับ delete ที่ช่อง stock ไม่เปลี่ยน)
 *   write(tx, db, trail)          — เขียนทุก doc ที่มีรายการ (เรียกหลังอ่านครบ · ใน tx เดียวกับ stock) · คืนจำนวน doc
 *     trail = adminTrail(access) · ทีมงานทำ = {byAdmin:true, adminUid:<คนล่าสุด>} + adminEvents increment(1)
 *     (doc รวมยอด ⇒ byAdmin แปลว่า "ทีมงานเคยแตะสมุดนี้" · นับครั้งที่ adminEvents)
 */
function makeJournal({ shopDocId, now, cutOff }) {
  if (typeof shopDocId !== "string" || !shopDocId) throw new Error("stockJournal: ไม่มี shopDocId");
  const day = journalDayOf(now, cutOff);
  const rows = new Map(); // `${kind}\u0000${part}` → {kind, part, qty: Map(id → delta)}
  const add = (kind, id, delta) => {
    if (!KINDS.includes(kind)) throw new Error(`stockJournal: ไม่รู้จักชนิด ${kind}`);
    if (typeof id !== "string" || !id) return false;
    const d = logic.roundStock(delta);
    if (!Number.isFinite(d) || d === 0) return false;
    const part = partOf(kind, id);
    const key = `${kind}\u0000${part}`;
    if (!rows.has(key)) rows.set(key, { kind, part, qty: new Map() });
    const q = rows.get(key).qty;
    const next = logic.roundStock((q.get(id) || 0) + d);
    if (next === 0) q.delete(id);
    else q.set(id, next);
    return true;
  };
  const move = (kind, id, before, after) => add(kind, id, logic.toNumber(after) - logic.toNumber(before));
  const entries = () => [...rows.values()].filter((r) => r.qty.size).map((r) => ({ kind: r.kind, part: r.part, qty: Object.fromEntries(r.qty) }));
  const write = (tx, db, trail) => {
    const list = entries();
    if (!list.length) return 0;
    const fv = fieldValue();
    for (const r of list) {
      const qty = {};
      for (const [id, d] of Object.entries(r.qty)) qty[id] = fv.increment(d);
      const doc = {
        shopId: shopDocId,
        day,
        kind: r.kind,
        part: r.part,
        qty,
        events: fv.increment(1),
        updateTime: fv.serverTimestamp(),
      };
      if (trail && trail.byAdmin === true) Object.assign(doc, trail, { adminEvents: fv.increment(1) });
      tx.set(db.collection(COLLECTION).doc(journalDocId(shopDocId, day, r.kind, r.part)), doc, { merge: true });
    }
    return list.length;
  };
  return { day, move, add, entries, write, has: () => entries().length > 0 };
}

module.exports = { COLLECTION, KINDS, PARTS, serverTime, journalDayOf, journalDocId, partOf, hash32, makeJournal };

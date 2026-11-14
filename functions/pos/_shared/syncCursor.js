// pos/_shared/syncCursor.js — ตัวช่วยกลางของเส้น "ดึงเฉพาะที่เปลี่ยน + แบ่งหน้า" (DEV-0010 คลื่น 2)
//   ใช้ที่ stock.sync (pos/stock/syncRead.js) และ member.indexSync (pos/member/read.js) · ยกจาก syncRead.js เดิมทั้งก้อน ไม่เปลี่ยนพฤติกรรม stock
//
// query: <coll> where shopId == K (คีย์เดียว) | shopId in [K1, K2] (ร้านที่ต้องอ่าน 2 คีย์) and updateTime > FLOOR
//        orderBy updateTime, __name__ startAfter(Timestamp, id) limit n+1
//   - cursor = "1|<seconds>|<nanos>|<doc id>" ของ doc สุดท้ายที่อ่าน · server สร้าง แอปเก็บเฉย ๆ
//     ⇒ หลาย doc ที่เขียนใน transaction/batch เดียวได้ updateTime เดียวกันเป๊ะ ข้ามรอยต่อหน้าไม่หาย (เทียบคู่ เวลา+id)
//     ⇒ เวลาละเอียดเท่าที่ Firestore เก็บ (ไม่ปัดเป็น ms) · หน้าเต็มไปด้วย doc เวลาเดียวกันก็เดินต่อได้ ไม่วน
//   - FLOOR = new Date(2011,0,1) เวลาไทย (ค่าตั้งต้น watermark ของแอปเดิม · `>` แบบเดิม) ⇒ กรองเหลือเฉพาะ doc ที่ updateTime เป็นเวลาจริง
//   - เรียง/กรองซ้ำในโค้ด: ฐานจริงเรียงและตัดมาแล้ว (ไม่มีผล) · กันฐานที่ไม่เรียงให้ (harness) และ doc ร้านอื่น/เวลาไม่ใช่เวลาจริง
// ❌ ไม่ require SDK ตัวจริง · Timestamp รับจากผู้เรียก (admin ของ ../../firebase)
"use strict";

// new Date(2011, 0, 1) บนเครื่องเวลาไทย = ค่าตั้งต้น watermark ของแอปเดิม (`useLocalStock.js:244-246`)
const FLOOR_MS = Date.parse("2010-12-31T17:00:00.000Z");
const DOC_ID_MAX = 128; // เท่า stock/_shared.js · _shared/auth.js
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= DOC_ID_MAX && !v.includes("/") && v !== "." && v !== "..";

/** Timestamp ของ Firestore (มี seconds nanoseconds) หรือ Date → {s, n} · อย่างอื่น = null */
function tsKey(v) {
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) return null;
    const s = Math.floor(ms / 1000);
    return { s, n: (ms - s * 1000) * 1e6 };
  }
  if (v && typeof v === "object" && Number.isInteger(v.seconds) && Number.isInteger(v.nanoseconds)) return { s: v.seconds, n: v.nanoseconds };
  return null;
}
const cmpKey = (a, b) => (a.s - b.s) || (a.n - b.n) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Timestamp จริงของ SDK (เทียบละเอียดถึง nanos) · ไม่มี (ฐานปลอมของ harness) = Date */
function toTimestamp(k, admin) {
  const T = admin && admin.firestore && admin.firestore.Timestamp;
  return T ? new T(k.s, k.n) : new Date(k.s * 1000 + Math.floor(k.n / 1e6));
}

const encodeCursor = (k) => `1|${k.s}|${k.n}|${k.id}`;
function parseCursor(raw) {
  const m = /^1\|(-?\d{1,12})\|(\d{1,9})\|(.+)$/.exec(raw);
  if (!m || !validDocId(m[3])) return null;
  return { s: Number(m[1]), n: Number(m[2]), id: m[3] };
}

/** toPlain(v) — เวลา (Timestamp มี toDate / Date) → ISO ทั้งก้อน · ค่าอื่นคงเดิม */
function toPlain(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "object" && typeof v.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
    return out;
  }
  return v;
}

/**
 * readChangedPage({db, admin, coll, keys, cursor, limit}) — อ่านหน้าหนึ่งของ doc ที่เปลี่ยนหลัง cursor
 *   keys: คีย์ร้าน 1-2 ตัว (1 = `==` · 2 = `in`) · cursor: ผลของ parseCursor หรือ null (= ตั้งแต่ต้น)
 *   คืน {page:[{id, d, k}], hasMore} · k = {s, n, id} ใช้ encodeCursor ได้
 */
async function readChangedPage({ db, admin, coll, keys, cursor, limit }) {
  const ks = [...new Set(keys)];
  let q = ks.length === 1
    ? db.collection(coll).where("shopId", "==", ks[0])
    : db.collection(coll).where("shopId", "in", ks);
  q = q.where("updateTime", ">", new Date(FLOOR_MS)).orderBy("updateTime").orderBy("__name__");
  if (cursor) q = q.startAfter(toTimestamp(cursor, admin), cursor.id);
  const snap = await q.limit(limit + 1).get();
  const rows = (snap.docs || [])
    .map((s) => ({ id: s.id, d: s.data() || {} }))
    .map((r) => ({ ...r, k: tsKey(r.d.updateTime) }))
    .filter((r) => r.k !== null && ks.includes(r.d.shopId) && r.k.s * 1000 + r.k.n / 1e6 > FLOOR_MS)
    .map((r) => ({ ...r, k: { ...r.k, id: r.id } }))
    .filter((r) => !cursor || cmpKey(r.k, cursor) > 0)
    .sort((a, b) => cmpKey(a.k, b.k));
  return { page: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** nextCursorOf(page, cursor, rawCursor) — cursor ของ doc สุดท้ายที่อ่าน · หน้าว่าง = cursor เดิม · ไม่มีเลย = null */
function nextCursorOf(page, cursor, rawCursor) {
  const last = page[page.length - 1];
  return last ? encodeCursor(last.k) : cursor ? rawCursor : null;
}

module.exports = { FLOOR_MS, tsKey, cmpKey, toTimestamp, encodeCursor, parseCursor, toPlain, readChangedPage, nextCursorOf, validDocId };

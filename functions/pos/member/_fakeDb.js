// pos/member/_fakeDb.js — Firestore ปลอมสำหรับเทสข้าง handler ของก้อน 9b (ไม่ใช่ handler · ไม่มี route)
//
// ต่างจากฐานปลอมของ harness: การเขียน **ลงฐานจริงตอน commit** ⇒ เทสลำดับ (ส่งซ้ำ · ตัด 2 รอบ · ลบแล้วลบซ้ำ) ได้
//   transaction: อ่านหลังเขียนใน transaction เดียว = throw (Firestore ปัดแบบนี้) · ล้มกลางทาง = ไม่ลงอะไรเลย
//   ใช้: const F = makeFakeDb(seed); require.cache[firebase] = {exports:{db:F.db}} · F.data · F.log
// ❌ ไม่แตะ Firestore จริง
"use strict";

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
const msOf = (x) => (x instanceof Date ? x.getTime() : x && typeof x.toMillis === "function" ? x.toMillis() : undefined);

function makeFakeDb(seed) {
  const data = clone(seed || {});
  const log = [];
  let auto = 0;
  const get = (c, id) => (data[c] || {})[id];
  const snap = (c, id) => { const d = get(c, id); return { exists: d !== undefined, id, data: () => clone(d) }; };
  const docRef = (c, id) => ({ kind: "doc", c, id, path: `${c}/${id}`, get: async () => snap(c, id) });
  const runQuery = (q) => {
    let ids = Object.keys(data[q.c] || {});
    for (const [f, op, v] of q.filters) {
      ids = ids.filter((id) => {
        const dv = get(q.c, id)[f];
        const a = msOf(dv), b = msOf(v);
        const x = a !== undefined && b !== undefined ? a : dv, y = a !== undefined && b !== undefined ? b : v;
        if (op === "==") return x === y;
        throw new Error(`fakeDb: op ${op} ยังไม่รองรับ`);
      });
    }
    if (q.lim != null) ids = ids.slice(0, q.lim);
    const docs = ids.map((id) => snap(q.c, id));
    return { empty: docs.length === 0, size: docs.length, docs };
  };
  const query = (c, filters = [], lim = null) => ({
    kind: "query", c, filters, lim,
    where: (f, op, v) => query(c, [...filters, [f, op, v]], lim),
    limit: (n) => query(c, filters, n),
    get: async () => runQuery({ c, filters, lim }),
    count: () => ({ get: async () => { const n = runQuery({ c, filters, lim }).size; return { data: () => ({ count: n }) }; } }),
  });
  const apply = (w) => {
    data[w.c] = data[w.c] || {};
    if (w.op === "set") data[w.c][w.id] = clone(w.v);
    else if (w.op === "update") {
      if (data[w.c][w.id] === undefined) throw new Error(`fakeDb: update ${w.c}/${w.id} ที่ไม่มี (Firestore NOT_FOUND)`);
      data[w.c][w.id] = { ...data[w.c][w.id], ...clone(w.v) };
    } else if (w.op === "delete") delete data[w.c][w.id];
    log.push({ op: w.op, path: `${w.c}/${w.id}`, v: w.v });
  };
  const db = {
    collection: (c) => ({
      doc: (id) => docRef(c, id !== undefined ? id : `auto${++auto}`),
      where: (f, op, v) => query(c).where(f, op, v),
      limit: (n) => query(c).limit(n),
      get: async () => runQuery({ c, filters: [], lim: null }),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id || "(query)"} หลังเขียน (Firestore ปัด)`);
          return r.kind === "query" ? runQuery(r) : snap(r.c, r.id);
        },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); return tx; },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); return tx; },
        delete: (r) => { writes.push({ op: "delete", c: r.c, id: r.id }); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) apply(w);
      return out;
    },
    batch: () => {
      const writes = [];
      const b = {
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); return b; },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); return b; },
        commit: async () => { if (writes.length > 500) throw new Error("fakeDb: batch เกิน 500"); for (const w of writes) apply(w); b.size = writes.length; },
      };
      return b;
    },
  };
  return { db, data, log };
}

/** installFakeDb(seed) — แทน functions/firebase ใน require.cache · คืน F (ใช้ F.reset(seed) เปลี่ยนฐานระหว่างเทส) */
function installFakeDb(path, seed) {
  const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  let cur = makeFakeDb(seed);
  const proxyDb = new Proxy({}, { get: (_, k) => cur.db[k] });
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: proxyDb, admin: {} } };
  return {
    get data() { return cur.data; },
    get log() { return cur.log; },
    reset(s) { cur = makeFakeDb(s); },
  };
}

module.exports = { makeFakeDb, installFakeDb };

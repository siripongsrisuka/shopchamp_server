// pos/scango/shop/_testDb.js — Firestore ปลอมของเทส scango/shop (ไม่ใช่ handler · ไม่มี route · ไม่ใช่ไฟล์เทส)
//   รองรับ: doc().get · where (== · in) · orderBy (ช่องใด ๆ / '__name__') · startAfter (id เมื่อเรียง __name__) · limit
//   transaction: อ่านหลังเขียน = throw · update ช่องแบบจุด ('scango.enabled') ลงชั้นลึก · ล้มกลางทาง = ไม่ลงอะไร
//   นับการอ่าน doc (F.reads) ⇒ เทสเพดานอ่านได้
// ❌ ไม่แตะ Firestore จริง
"use strict";

const path = require("path");

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
const ms = (v) => (v instanceof Date ? v.getTime() : v);

function makeDb(seed) {
  const data = clone(seed || {});
  const log = [];
  const st = { reads: 0 };
  const snap = (c, id) => { st.reads++; const d = (data[c] || {})[id]; return { exists: d !== undefined, id, data: () => clone(d) }; };
  const run = (q) => {
    let ids = Object.keys(data[q.c] || {});
    for (const [f, op, v] of q.filters) {
      ids = ids.filter((id) => {
        const dv = data[q.c][id][f];
        if (op === "==") return dv === v;
        if (op === "in") { if (!Array.isArray(v) || v.length > 30) throw new Error("fakeDb: in ต้องเป็น array ≤30"); return v.includes(dv); }
        throw new Error(`fakeDb: op ${op} ยังไม่รองรับ`);
      });
    }
    if (q.order) {
      const [f, dir] = q.order;
      const key = (id) => (f === "__name__" ? id : ms(data[q.c][id][f]));
      ids.sort((a, b) => { const x = key(a), y = key(b); const r = x < y ? -1 : x > y ? 1 : 0; return dir === "desc" ? -r : r; });
      if (q.after !== undefined) {
        if (f !== "__name__") throw new Error("fakeDb: startAfter รองรับเฉพาะ __name__");
        ids = ids.filter((id) => id > q.after);
      }
    } else if (q.after !== undefined) throw new Error("fakeDb: startAfter ต้องมี orderBy");
    if (q.lim != null) ids = ids.slice(0, q.lim);
    const docs = ids.map((id) => snap(q.c, id));
    return { empty: !docs.length, size: docs.length, docs };
  };
  const query = (q) => ({
    kind: "query",
    where: (f, op, v) => query({ ...q, filters: [...q.filters, [f, op, v]] }),
    orderBy: (f, dir) => query({ ...q, order: [f, dir || "asc"] }),
    startAfter: (v) => query({ ...q, after: v }),
    limit: (n) => query({ ...q, lim: n }),
    get: async () => run(q),
  });
  const docRef = (c, id) => ({ kind: "doc", c, id, get: async () => snap(c, id) });
  const setDeep = (obj, dotted, v) => {
    const parts = dotted.split(".");
    let o = obj;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== "object") o[p] = {}; o = o[p]; }
    o[parts[parts.length - 1]] = clone(v);
  };
  const apply = (w) => {
    data[w.c] = data[w.c] || {};
    if (w.op === "update") {
      if (data[w.c][w.id] === undefined) throw new Error(`fakeDb: update ${w.c}/${w.id} ที่ไม่มี`);
      for (const [k, v] of Object.entries(w.v)) setDeep(data[w.c][w.id], k, v);
    } else if (w.op === "set") data[w.c][w.id] = clone(w.v);
    log.push({ op: w.op, path: `${w.c}/${w.id}`, v: clone(w.v) });
  };
  const db = {
    collection: (c) => ({
      doc: (id) => docRef(c, id),
      where: (f, op, v) => query({ c, filters: [] }).where(f, op, v),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error("fakeDb: อ่านหลังเขียน");
          return r.kind === "query" ? r.get() : snap(r.c, r.id);
        },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); return tx; },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) apply(w);
      return out;
    },
  };
  return { db, data, log, st };
}

/** installFakeDb() — แทน functions/firebase ใน require.cache (เรียกก่อน require handler) · F.reset(seed) เปลี่ยนฐาน */
function installFakeDb() {
  const fbAbs = require.resolve(path.join(__dirname, "..", "..", "..", "firebase"));
  let cur = makeDb({});
  const proxy = new Proxy({}, { get: (_, k) => cur.db[k] });
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: proxy, admin: {} } };
  return {
    get data() { return cur.data; },
    get log() { return cur.log; },
    get reads() { return cur.st.reads; },
    reset(seed) { cur = makeDb(seed); },
  };
}

/** call(handlerFactory, deps, body, access) → res ปลอม {code, body} */
async function call(factory, deps, body, access) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await factory(deps)({ body, shopAccess: access }, res);
  return res;
}

module.exports = { installFakeDb, makeDb, call };

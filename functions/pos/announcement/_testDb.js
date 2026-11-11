// pos/announcement/_testDb.js — ฐานปลอมที่เขียนลงจริงสำหรับเทสประกาศถึงร้าน (DEV-0003 0e) · ไม่ใช่ handler · ไม่ถูก route
//   ใช้ใน office/announcement.test.js และ announcement/announcement.test.js
//   รองรับ: doc get/set(merge)/create/update/delete · sub-collection · where (== <= >= array-contains · ช่องมีจุด) · orderBy · limit · count
//           getAll · runTransaction (get ได้ทั้ง doc และ query · เขียนตอนจบ) · batch · FieldValue ปลอม (_shared/fakeFieldValue)
//   install(seed) แทน functions/firebase ใน require.cache แล้วล้าง cache ของไฟล์ที่ส่งมา
"use strict";

const path = require("path");
const { FieldValue, applyWrite } = require("../_shared/fakeFieldValue");

const msOf = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  return undefined;
};
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function memDb(clock) {
  const store = new Map();
  const writes = [];
  const at = (data, field) => field.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);
  const cmp = (dv, op, value) => {
    const a = msOf(dv), b = msOf(value);
    if (op === "array-contains") return Array.isArray(dv) && dv.includes(value);
    if (a !== undefined && b !== undefined) { dv = a; value = b; } else if (a !== undefined || b !== undefined) return false;
    if (dv === undefined) return false;
    switch (op) {
      case "==": return dv === value;
      case "<=": return dv <= value;
      case ">=": return dv >= value;
      case "<": return dv < value;
      case ">": return dv > value;
      default: throw new Error(`testDb: where ${op}`);
    }
  };
  const docsIn = (coll) => {
    const depth = coll.split("/").length + 1;
    return [...store.entries()]
      .filter(([p]) => p.startsWith(coll + "/") && p.split("/").length === depth)
      .map(([p, d]) => ({ id: p.slice(coll.length + 1), exists: true, ref: docRef(p), data: () => clone(d) }));
  };
  const query = (coll, st) => {
    const s = st || { filters: [], order: null, limit: null };
    const run = () => {
      let docs = docsIn(coll);
      for (const [f, op, v] of s.filters) docs = docs.filter((d) => cmp(at(d.data(), f), op, v));
      if (s.order) {
        const [f, dir] = s.order;
        docs = docs.filter((d) => at(d.data(), f) !== undefined)
          .sort((x, y) => { const p = msOf(at(x.data(), f)) ?? at(x.data(), f); const q = msOf(at(y.data(), f)) ?? at(y.data(), f); return (p < q ? -1 : p > q ? 1 : 0) * (dir === "desc" ? -1 : 1); });
      }
      if (s.limit !== null) docs = docs.slice(0, s.limit);
      return docs;
    };
    return {
      where: (f, op, v) => query(coll, { ...s, filters: [...s.filters, [f, op, v]] }),
      orderBy: (f, dir) => query(coll, { ...s, order: [f, dir || "asc"] }),
      limit: (n) => query(coll, { ...s, limit: n }),
      count: () => ({ get: async () => { const n = run().length; return { data: () => ({ count: n }) }; } }),
      get: async () => { const docs = run(); return { docs, size: docs.length, empty: !docs.length }; },
    };
  };
  let auto = 0;
  const now = () => (clock ? clock() : new Date());
  const put = (p, op, data, opts) => {
    writes.push({ op, path: p, data: clone(data), merge: !!(opts && opts.merge) });
    if (op === "delete") { store.delete(p); return; }
    if (op === "create" && store.has(p)) throw new Error("ALREADY_EXISTS " + p);
    if (op === "update" && !store.has(p)) throw new Error("NOT_FOUND " + p);
    store.set(p, applyWrite(store.get(p), data, { op: op === "create" ? "set" : op, merge: !!(opts && opts.merge), commitTime: now() }));
  };
  function docRef(p) {
    const id = p.split("/").pop();
    return {
      id, path: p,
      get: async () => ({ exists: store.has(p), id, data: () => clone(store.get(p)) }),
      set: async (d, o) => put(p, "set", d, o),
      create: async (d) => put(p, "create", d),
      update: async (d) => put(p, "update", d),
      delete: async () => put(p, "delete"),
      collection: (sub) => collRef(`${p}/${sub}`),
    };
  }
  function collRef(c) {
    const q = query(c);
    return { ...q, path: c, doc: (id) => docRef(`${c}/${id === undefined ? `auto${++auto}` : id}`) };
  }
  const writer = () => {
    const q = [];
    const w = {
      set: (ref, d, o) => { q.push(() => put(ref.path, "set", d, o)); return w; },
      create: (ref, d) => { q.push(() => put(ref.path, "create", d)); return w; },
      update: (ref, d) => { q.push(() => put(ref.path, "update", d)); return w; },
      delete: (ref) => { q.push(() => put(ref.path, "delete")); return w; },
      flush: async () => { for (const f of q) f(); },
    };
    return w;
  };
  const db = {
    collection: (c) => collRef(c),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch: () => { const w = writer(); w.commit = w.flush; return w; },
    runTransaction: async (fn) => {
      const w = writer();
      w.get = (ref) => ref.get();
      const out = await fn(w);
      await w.flush();
      return out;
    },
  };
  return { db, store, writes };
}

/** install(seed, files, clock) → mem · seed = {path: data} · files = path ของ handler (absolute) ที่ต้องโหลดใหม่ */
function install(seed, files, clock) {
  const mem = memDb(clock);
  for (const [p, d] of Object.entries(seed || {})) mem.store.set(p, structuredClone(d));
  const fbAbs = require.resolve("../../firebase");
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: mem.db, admin: {}, bucket: {}, FieldValue } };
  const here = path.resolve(__dirname, "..");
  for (const f of [path.join(here, "office/_officeStore.js"), path.join(here, "announcement/_viewer.js"), ...(files || [])]) delete require.cache[require.resolve(f)];
  return mem;
}

function makeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

module.exports = { memDb, install, makeRes };

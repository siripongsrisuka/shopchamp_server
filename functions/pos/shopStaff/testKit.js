// pos/shopStaff/testKit.js — ของเทสของโดเมนร้านและพนักงาน (ก้อน 9c · DEV-0001) · ใช้ในไฟล์ *.test.js เท่านั้น
//
// ① ฐานปลอมแบบมีสถานะ: transaction อ่านครบก่อนเขียน (อ่านหลังเขียน = throw แบบ Firestore) · commit แล้วค่าเปลี่ยนจริง
//    ⇒ พิสูจน์สิ่งที่ harness ของสัญญาวัดไม่ได้ (harness บันทึกการเขียนแต่ไม่ลงฐาน): 2 เครื่องแก้ต่อกัน · ส่งซ้ำหลังสำเร็จ · ลำดับหลายขั้น
// ② ก่อนแม่ผูก export (schema index · logic index · vendor tarball) ของใน @shopchamp/* ที่ติดตั้งยังไม่มีของ 9c
//    ⇒ ถ้า export ที่ต้องใช้ยังไม่มี: build schema จาก src ของ shopchamp-center ด้วย esbuild ลง require.cache · logic ใช้ src ของ center
//    หลังแม่ผูกแล้ว ทางนี้ไม่ทำงาน (ใช้ของที่ติดตั้งตามปกติ)
// ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const path = require("path");
const fs = require("fs");

const CENTER = path.resolve(__dirname, "../../../../shopchamp-center");
const SCHEMA_FILES = ["entities/checkIn", "entities/checkInHistory", "entities/expense", "entities/expenseReport", "entities/profile", "entities/buildings", "requests/shopStaff"];

function ensureSchema() {
  const installed = require("@shopchamp/schema");
  if (installed.ShopUpdateRequest && installed.CheckIn) return installed;
  const esbuild = require(require.resolve("esbuild", { paths: [CENTER] }));
  const src = path.join(CENTER, "packages/schema/src");
  const entry = [`export * from ${JSON.stringify(path.join(src, "index"))};`, ...SCHEMA_FILES.map((f) => `export * from ${JSON.stringify(path.join(src, f))};`)].join("\n");
  const out = esbuild.buildSync({ stdin: { contents: entry, resolveDir: src, loader: "ts" }, bundle: true, platform: "node", format: "cjs", external: ["zod"], write: false });
  const abs = require.resolve("@shopchamp/schema");
  const m = new module.constructor(abs, module);
  m.filename = abs;
  m.paths = module.constructor._nodeModulePaths(path.dirname(abs));
  m._compile(out.outputFiles[0].text, abs);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: m.exports };
  return m.exports;
}

function ensureLogic() {
  const installed = require("@shopchamp/logic");
  if (installed.expenseMonthLabel) return installed;
  const merged = { ...installed, ...require(path.join(CENTER, "packages/logic/src/expenseReport.js")) };
  const abs = require.resolve("@shopchamp/logic");
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: merged };
  return merged;
}

/** makeStore() → {db, data, log, reset(seed)} ฐานปลอมแบบมีสถานะ */
function makeStore() {
  const store = { data: {}, log: [] };
  let auto = 0;
  const clone = (v) => (v === undefined ? undefined : structuredClone(v)); // คง Date ไว้เป็น Date (แบบ Timestamp ที่ SDK คืน)
  const coll = (c) => (store.data[c] = store.data[c] || {});
  const snapOf = (c, id) => { const d = coll(c)[id]; return { exists: d !== undefined, id, data: () => clone(d) }; };
  const ref = (c, id) => ({ c, id, path: `${c}/${id}`, get: async () => snapOf(c, id) });
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, [...filters, [f, op, v]], lim),
    limit: (n) => query(c, filters, n),
    get: async () => {
      let ids = Object.keys(coll(c)).filter((id) => filters.every(([f, op, v]) => op === "==" && coll(c)[id][f] === v));
      if (lim != null) ids = ids.slice(0, lim);
      return { docs: ids.map((id) => snapOf(c, id)), empty: ids.length === 0, size: ids.length };
    },
  });
  const apply = (w) => {
    const c = coll(w.c);
    if (w.op === "delete") delete c[w.id];
    else if (w.op === "set") c[w.id] = clone(w.v);
    else if (w.op === "update") { if (c[w.id] === undefined) throw new Error(`update ${w.c}/${w.id} ที่ไม่มี (Firestore ปัด)`); c[w.id] = { ...c[w.id], ...clone(w.v) }; }
  };
  store.db = {
    collection: (c) => ({ doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`), where: (f, op, v) => query(c, [[f, op, v]], null) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        // doc ref = snapshot · query (ไม่มี c/id) = ผล query แบบ Firestore tx.get(query)
        get: async (r) => { if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id} หลังเขียน (Firestore ปัด)`); return r && r.c !== undefined && r.id !== undefined ? snapOf(r.c, r.id) : r.get(); },
        set: (r, v) => { writes.push({ op: "set", c: r.c, id: r.id, v }); return tx; },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); return tx; },
        delete: (r) => { writes.push({ op: "delete", c: r.c, id: r.id }); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) apply(w);
      store.log.push(...writes);
      return out;
    },
  };
  store.reset = (seed) => { store.data = clone(seed || {}); store.log = []; };
  return store;
}

/** install(store) — แทน functions/firebase ด้วยฐานปลอม · เรียกก่อน require handler */
function install(store) {
  const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: store.db, admin: {} } };
  ensureSchema();
  ensureLogic();
}

/** caller(handler) → async (body, req) => res */
function caller(handler) {
  return async (body, req) => {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ body, ...(req || {}) }, res);
    return res;
  };
}

module.exports = { makeStore, install, caller, ensureSchema, ensureLogic, CENTER, exists: fs.existsSync };

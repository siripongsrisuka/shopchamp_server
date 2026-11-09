// pos/stock/stockTestKit.js — ของร่วมของเทส pos/stock/*.test.js (ก้อน 9a · DEV-0001) · ไม่ใช่ handler · ไม่ถูก route
//
// 1. installStockSchemas(): คำขอ Stock*Request ยังไม่อยู่ใน vendor tarball ของ @shopchamp/schema จนกว่าแม่จะ export + build ใหม่
//    ⇒ ถ้า package ยังไม่มี ให้ build `shopchamp-center/packages/schema/src/requests/stock.ts` ด้วย esbuild แล้วเติมเข้า exports
//    ของ package ตัวเดียวกับที่ handler require (ไม่แตะไฟล์ใน node_modules) · package มีแล้ว = ไม่ทำอะไร (ใช้ของจริง)
// 2. makeDb(): Firestore ปลอมที่เข้มกว่า harness ของสัญญา
//    · ปัดการอ่านหลังเขียนใน transaction เดียว (กฎของ Firestore) · commit แล้วค่าเปลี่ยนจริง ⇒ ยิงซ้ำเห็นผลรอบแรก
//    · บันทึกทุกการเขียนใน LOG
// 3. loadHandler(rel, fnName): แทน functions/firebase ใน require.cache ก่อนโหลด handler (ไม่แตะฐานจริง)
// 4. FieldValue ปลอม (DEV-0007 · ../_shared/fakeFieldValue.js): serverTimestamp = เวลา commit จาก commitClock() · increment บวกจริง
//    hooks.beforeCommit(): เรียกหลัง fn ของ tx จบ ก่อนลงค่า = ช่องให้เทสแทรก "tx อื่น commit + เครื่องซิงก์" กลางทาง (syncTime.test.js)
"use strict";

const path = require("path");
const fs = require("fs");
const FV = require("../_shared/fakeFieldValue");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const CENTER = path.resolve(FUNCTIONS, "..", "..", "shopchamp-center");

function installStockSchemas() {
  const pkg = require("@shopchamp/schema");
  if (pkg.StockReceiveRequest) return "package";
  const src = path.join(CENTER, "packages", "schema", "src", "requests", "stock.ts");
  if (!fs.existsSync(src)) throw new Error(`stockTestKit: ไม่พบ ${src}`);
  const esbuild = require(require.resolve("esbuild", { paths: [CENTER] }));
  const out = esbuild.buildSync({
    entryPoints: [src],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    nodePaths: [path.join(CENTER, "packages", "schema", "node_modules"), path.join(CENTER, "node_modules")],
    logLevel: "error",
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  Object.assign(pkg, m.exports);
  return "source";
}

let DATA = {};
let LOG = [];
// เวลา commit ปลอม: เริ่ม 1 นาทีหลังนาฬิกาของคำขอ (call() ใช้ 2026-11-10T03:00Z) และเดินหน้า 1 ms ทุก commit
let CLOCK_MS = Date.parse("2026-11-10T03:01:00.000Z");
const hooks = { beforeCommit: null };
const commitClock = () => new Date(++CLOCK_MS);
function reset(data) {
  DATA = JSON.parse(JSON.stringify(data || {}), (k, v) => (v && typeof v === "object" && v.__date__ ? new Date(v.__date__) : v));
  LOG = [];
  hooks.beforeCommit = null;
}
const data = () => DATA;
const log = () => LOG;

// ตัวนับ id อัตโนมัติอยู่ระดับไฟล์: loadHandler สร้างฐานปลอมใหม่ทุกครั้ง ⇒ ตัวนับต่อฐานทำให้ doc() ไม่ระบุ id ชนกันข้าม handler (บิลทับกัน)
let auto = 0;
function makeDb() {
  const getDoc = (c, id) => (DATA[c] || {})[id];
  const snapOf = (c, id) => {
    const d = getDoc(c, id);
    return { exists: d !== undefined, id, data: () => d };
  };
  const applyWrite = (w, commitTime) => {
    DATA[w.c] = DATA[w.c] || {};
    if (w.op === "delete") delete DATA[w.c][w.id];
    else DATA[w.c][w.id] = FV.applyWrite(DATA[w.c][w.id], w.v, { op: w.op, merge: w.merge, commitTime });
  };
  const query = (c, filters, lim) => ({
    __query: true,
    c,
    where: (f, op, v) => query(c, [...filters, [f, op, v]], lim),
    select: () => query(c, filters, lim),
    orderBy: () => query(c, filters, lim), // DEV-0008: handler ที่อ่านเรียงเองหลังได้ผล ⇒ kit ไม่ต้องเรียง (limit ตัดก่อนเรียงได้ เทสต้องให้ limit ไม่ตัดจริง)
    limit: (n) => query(c, filters, n),
    count: () => ({ get: async () => ({ data: () => ({ count: run(c, filters, lim).length }) }) }),
    get: async () => {
      const docs = run(c, filters, lim);
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
  });
  const run = (c, filters, lim) => {
    let ids = Object.keys(DATA[c] || {});
    for (const [f, op, v] of filters) {
      ids = ids.filter((id) => {
        const x = DATA[c][id][f];
        if (op === "==") return x === v;
        if (op === "in") return Array.isArray(v) && v.includes(x);
        if (op === ">=") return x >= v;
        if (op === "<=") return x <= v;
        if (op === "array-contains") return Array.isArray(x) && x.includes(v);
        throw new Error(`stockTestKit: where ${op} ยังไม่รองรับ`);
      });
    }
    if (lim != null) ids = ids.slice(0, lim);
    return ids.map((id) => snapOf(c, id));
  };
  const ref = (c, id) => ({ c, id, path: `${c}/${id}`, get: async () => snapOf(c, id) });
  const writer = (sink) => ({
    set: (r, v, o) => { sink.push({ op: "set", c: r.c, id: r.id, v, merge: !!(o && o.merge) }); },
    update: (r, v) => { sink.push({ op: "update", c: r.c, id: r.id, v }); },
    create: (r, v) => { sink.push({ op: "set", c: r.c, id: r.id, v }); },
    delete: (r) => { sink.push({ op: "delete", c: r.c, id: r.id }); },
  });
  return {
    collection: (c) => ({
      doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`),
      where: (f, op, v) => query(c, [[f, op, v]], null),
      limit: (n) => query(c, [], n),
      get: async () => query(c, [], null).get(),
      add: async (v) => {
        const id = `auto${++auto}`;
        applyWrite({ op: "set", c, id, v }, commitClock());
        LOG.push({ op: "add", c, id, v });
        return { id };
      },
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const w = writer(writes);
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}${r.id ? "/" + r.id : ""} หลังเขียน (Firestore ปัด)`);
          if (r.__query) return r.get();
          return snapOf(r.c, r.id);
        },
        ...w,
      };
      const out = await fn(tx);
      if (typeof hooks.beforeCommit === "function") { const h = hooks.beforeCommit; hooks.beforeCommit = null; await h(); }
      const t = commitClock();
      for (const x of writes) { applyWrite(x, t); LOG.push(x); }
      return out;
    },
    batch: () => {
      const writes = [];
      return {
        ...writer(writes),
        commit: async () => { const t = commitClock(); for (const x of writes) { applyWrite(x, t); LOG.push(x); } },
      };
    },
  };
}

function loadHandler(rel, fnName) {
  installStockSchemas();
  const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {}, bucket: {}, FieldValue: FV.FieldValue } };
  const abs = require.resolve(path.join(FUNCTIONS, "pos", "stock", rel));
  delete require.cache[abs];
  return require(abs)[fnName];
}

function makeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

async function call(factory, body, reqExtra, now) {
  const handler = factory({ now: () => new Date(now || "2026-11-10T03:00:00.000Z") });
  const res = makeRes();
  await handler({ body, ...(reqExtra || {}) }, res);
  return res;
}

const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const ADMIN = { shopAccess: { shopId: "shopA", uid: "u-admin", role: "owner", rights: [], byAdmin: true } };
const staff = (rights) => ({ shopAccess: { shopId: "shopA", uid: "u-staff", role: "staff", rights } });

module.exports = { installStockSchemas, reset, data, log, makeDb, loadHandler, makeRes, call, OWNER, ADMIN, staff, hooks, commitClock };

// เทส DEV-0010 · stock.linkList · stock.receiveList · stock.supplierList (pos/stock/listRead.js) · รัน: node --test pos/stock/listRead.test.js
//   ฐานปลอมในไฟล์นี้ทำตัวแบบ Firestore จริงในส่วนที่ handler พึ่ง: where == · orderBy(dateTime desc, __name__ desc) · startAfter(Timestamp, id)
//   · limit · Timestamp ละเอียดนาโนวินาที (harness ของสัญญาไม่เรียง/ไม่ startAfter ⇒ การแบ่งหน้าจริงพิสูจน์ที่นี่) · นับค่าอ่าน
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FUNCTIONS = path.resolve(__dirname, "..", "..");

// คำขออยู่ใน vendor @shopchamp/schema 0.1.29 · ขาดตัวไหน = ตกทันที (ไม่ build จาก src ของ center แทน)
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  const missing = ["StockLinkListRequest", "StockReceiveListRequest", "StockSupplierListRequest"].filter((k) => !pkg[k]);
  if (missing.length) throw new Error(`vendor @shopchamp/schema ไม่มี ${missing.join(" ")} · bump + vendor ใหม่`);
}

class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)); }
}
const tsOfIso = (iso, extraNanos) => {
  const ms = Date.parse(iso);
  const s = Math.floor(ms / 1000);
  return new Timestamp(s, (ms - s * 1000) * 1e6 + (extraNanos || 0));
};
const key = (v) => {
  if (v instanceof Timestamp) return [v.seconds, v.nanoseconds];
  if (v instanceof Date) { const ms = v.getTime(); const s = Math.floor(ms / 1000); return [s, (ms - s * 1000) * 1e6]; }
  return null;
};
const cmpT = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

let DATA = {};
let READS = 0;
let QUERIES = [];
function makeDb() {
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const query = (c, st) => ({
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f, dir) => query(c, { ...st, order: [...st.order, [f, dir || "asc"]] }),
    startAfter: (...vals) => query(c, { ...st, after: vals }),
    limit: (n) => query(c, { ...st, limit: n }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let rows = Object.keys(DATA[c] || {}).map((id) => ({ id, d: DATA[c][id] }));
      for (const [f, op, v] of st.filters) {
        if (op !== "==") throw new Error(`ฐานปลอม: where ${op} ยังไม่รองรับ`);
        rows = rows.filter((r) => r.d[f] === v);
      }
      const ord = st.order.length ? st.order : [["__name__", "asc"]];
      // orderBy ช่องไหน = doc ที่ไม่มีช่องนั้นไม่มา (แบบ Firestore) · ฐานปลอมเทียบได้แค่เวลา
      for (const [f] of ord) if (f !== "__name__") rows = rows.filter((r) => key(r.d[f]) !== null);
      const cmpRow = (a, b) => {
        for (const [f, dir] of ord) {
          const sign = dir === "desc" ? -1 : 1;
          if (f === "__name__") { if (a.id !== b.id) return (a.id < b.id ? -1 : 1) * sign; continue; }
          const c2 = cmpT(key(a.d[f]), key(b.d[f]));
          if (c2) return c2 * sign;
        }
        return 0;
      };
      rows.sort(cmpRow);
      if (st.after) {
        assert.deepEqual(st.order, [["dateTime", "desc"], ["__name__", "desc"]], "startAfter ต้องคู่กับ orderBy(dateTime desc, __name__ desc)");
        assert.ok(st.after[0] instanceof Timestamp, "cursor ต้องเป็น Timestamp ของ SDK (ไม่ปัดเป็น Date ms)");
        const pivot = { id: st.after[1], d: { dateTime: st.after[0] } };
        rows = rows.filter((r) => cmpRow(r, pivot) > 0);
      }
      if (st.limit != null) rows = rows.slice(0, st.limit);
      READS += Math.max(1, rows.length);
      const docs = rows.map((r) => snapOf(c, r.id));
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  return {
    collection: (c) => ({
      doc: (id) => ({ id, get: async () => { READS += 1; return snapOf(c, id); } }),
      where: (f, op, v) => query(c, { filters: [[f, op, v]], order: [], after: null, limit: null }),
    }),
  };
}

function load(fn) {
  installSchemas();
  const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: { firestore: { Timestamp } } } };
  for (const m of ["./listRead", "./syncRead"]) delete require.cache[require.resolve(m)];
  return require("./listRead")[fn];
}
const NOW = new Date("2026-11-14T03:00:00.000Z");
async function call(fn, body, reqExtra) {
  const handler = load(fn)({ now: () => NOW });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  READS = 0;
  QUERIES = [];
  await handler({ body, ...(reqExtra === undefined ? OWNER : reqExtra) }, res);
  return res;
}
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const STAFF = (rights) => ({ shopAccess: { shopId: "shopA", uid: "u-s", role: "staff", rights } });
const WATCHER = { shopAccess: { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true } };
const ROOT = { shopAccess: { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true, root: true } };
const PREMIUM = [{ type: "premium", expire: tsOfIso("2027-01-01T00:00:00.000Z") }];
const EXPIRED = [{ type: "premium", expire: tsOfIso("2026-01-01T00:00:00.000Z") }];
const T = (m, extraNanos) => tsOfIso(`2026-11-10T03:${String(m).padStart(2, "0")}:00.000Z`, extraNanos);
const R = (x) => ({ shopId: "shopA", product: [{ id: "p1", name: "น้ำ", qty: 1, cost: 4 }], createName: "เจ้าของ", totalQty: 1, totalCost: 4, ...x });

function seed(colls, shopX) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านเอ", vip: PREMIUM, ...(shopX || {}) }, shopB: { shopId: "shopB", name: "ร้านบี", vip: PREMIUM } },
    stockLink: {}, supplier: {}, importProduct: {},
    ...colls,
  };
}
async function receiveAll(limit) {
  const pages = [];
  let c;
  for (let i = 0; i < 30; i++) {
    const r = await call("receiveList", { shopId: "shopA", ...(limit ? { limit } : {}), ...(c ? { cursor: c } : {}) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    pages.push({ ...r.body, reads: READS });
    c = r.body.nextCursor;
    if (!c) break;
  }
  return pages;
}

// ── linkList ────────────────────────────────────────────────────────────────
const LINKS = () => ({
  l2: { shopId: "shopA", stockGroupName: "น้ำแพ็ก", stockLink: [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }], timestamp: T(2), upgrade: true, byAdmin: true, adminUid: "u-company" },
  l1: { shopId: "shopA", stockGroupName: "ขนมลัง", stockLink: [{ id: "p3", linkMultiply: 12 }], timestamp: T(1) },
  lb: { shopId: "shopB", stockGroupName: "ของร้านบี", stockLink: [], timestamp: T(1) },
});

test("linkList: เจ้าของ → doc เต็ม + id เรียง doc id · เวลา ISO · ตัดรอยทีมงาน · ร้านอื่นไม่ปน · ค่าอ่าน = shop 1 + doc ที่ได้", async () => {
  seed({ stockLink: LINKS() });
  const r = await call("linkList", { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.links.map((x) => x.id), ["l1", "l2"]);
  const l2 = r.body.links[1];
  assert.equal(l2.timestamp, "2026-11-10T03:02:00.000Z");
  assert.deepEqual(l2.stockLink, [{ id: "p1", linkMultiply: 1 }, { id: "p2", linkMultiply: 6 }]);
  assert.equal(l2.upgrade, true);
  assert.equal("byAdmin" in l2 || "adminUid" in l2, false, "ตัดรอยทีมงาน");
  assert.equal(r.body.byAdmin, undefined);
  assert.equal(READS, 1 + 2);
  const q = QUERIES.find((x) => x.c === "stockLink");
  assert.deepEqual(q.filters, [["shopId", "==", "shopA"]]);
  assert.equal(q.limit, null, "ไม่ limit แบบแอปเดิม");
});

test("linkList: ร้านที่ช่อง shopId ≠ doc id → ค้นด้วยช่อง shopId ของร้าน", async () => {
  seed({ stockLink: { ...LINKS(), lo: { shopId: "oldField", stockGroupName: "ของเก่า", stockLink: [], timestamp: T(1) } } }, { shopId: "oldField" });
  const r = await call("linkList", { shopId: "shopA" });
  assert.deepEqual(r.body.links.map((x) => x.id), ["lo"]);
});

test("linkList: สิทธิ์ 101 ผ่าน · ไม่มี 101 = 403 right_required · watcher ผ่าน · ทีมงาน byAdmin", async () => {
  seed({ stockLink: LINKS() });
  assert.equal((await call("linkList", { shopId: "shopA" }, STAFF(["101"]))).code, 200);
  const no = await call("linkList", { shopId: "shopA" }, STAFF(["100", "114", "115"]));
  assert.deepEqual([no.code, no.body.error, no.body.links], [403, "right_required", undefined]);
  assert.equal(READS, 0, "ปัดก่อนอ่านฐาน");
  assert.equal((await call("linkList", { shopId: "shopA" }, WATCHER)).code, 200);
  const root = await call("linkList", { shopId: "shopA" }, ROOT);
  assert.equal(root.body.byAdmin, true);
});

test("linkList: พรีเมี่ยมหมด → 403 premium_required ไม่อ่าน stockLink (เมนูผูกสต๊อกเป็นพรีเมี่ยม)", async () => {
  seed({ stockLink: LINKS() }, { vip: EXPIRED });
  const r = await call("linkList", { shopId: "shopA" });
  assert.deepEqual([r.code, r.body.error], [403, "premium_required"]);
  assert.equal(QUERIES.length, 0);
});

test("linkList · supplierList · receiveList: 🔒 ร้านอื่น 403 wrong_shop · ไม่มีด่าน 401 · ช่องเกิน 400", async () => {
  seed({ stockLink: LINKS() });
  for (const fn of ["linkList", "supplierList", "receiveList"]) {
    const w = await call(fn, { shopId: "shopB" });
    assert.deepEqual([w.code, w.body.error], [403, "wrong_shop"], fn);
    const n = await call(fn, { shopId: "shopA" }, {});
    assert.deepEqual([n.code, n.body.error], [401, "no_shop_access"], fn);
    const x = await call(fn, { shopId: "shopA", extra: 1 });
    assert.deepEqual([x.code, x.body.error], [400, "invalid_request"], fn);
    assert.equal(READS, 0, `${fn} ปัดก่อนอ่านฐาน`);
  }
});

// ── supplierList ─────────────────────────────────────────────────────────────
const SUPS = () => ({
  s2: { vender_Name: "ร้านส่ง", sale_Name: "สมชาย", tel: "081", lineId: "", detail: "", shopId: "shopA", dateTime: T(2), id: "s2", updateTime: T(3), updatedBy: "u-owner" },
  s1: { vender_Name: "โรงงาน", sale_Name: "", tel: "", lineId: "", detail: "", shopId: "shopA", dateTime: T(1), id: "s1" },
  sb: { vender_Name: "ของร้านบี", shopId: "shopB", dateTime: T(1) },
});

test("supplierList: เจ้าของ → doc เต็ม + id เรียง doc id · เวลา ISO · ตัด updatedBy · ร้านอื่นไม่ปน", async () => {
  seed({ supplier: SUPS() });
  const r = await call("supplierList", { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.suppliers.map((x) => x.id), ["s1", "s2"]);
  assert.deepEqual(r.body.suppliers[1], { vender_Name: "ร้านส่ง", sale_Name: "สมชาย", tel: "081", lineId: "", detail: "", shopId: "shopA", dateTime: "2026-11-10T03:02:00.000Z", id: "s2", updateTime: "2026-11-10T03:03:00.000Z" });
  assert.equal(READS, 1 + 2);
});

test("supplierList: สิทธิ์ 101 หรือ 115 ผ่าน (จอคู่ค้าใต้ตั้งค่า · จอรับเข้าสินค้า) · ไม่มีทั้งคู่ 403 · ไม่ต้องพรีเมี่ยม", async () => {
  seed({ supplier: SUPS() }, { vip: EXPIRED });
  assert.equal((await call("supplierList", { shopId: "shopA" }, STAFF(["101"]))).code, 200);
  assert.equal((await call("supplierList", { shopId: "shopA" }, STAFF(["115"]))).code, 200);
  const no = await call("supplierList", { shopId: "shopA" }, STAFF(["100", "114"]));
  assert.deepEqual([no.code, no.body.error], [403, "right_required"]);
});

// ── receiveList ──────────────────────────────────────────────────────────────
test("receiveList: หน้าแรกไม่ส่ง limit = 30 ใบใหม่สุด · อ่าน 30 เป๊ะ (ไม่อ่านเผื่อ) · orderBy dateTime desc, __name__ desc", async () => {
  const imp = {};
  for (let i = 1; i <= 35; i++) imp[`r${String(i).padStart(2, "0")}`] = R({ dateTime: T(i) });
  imp.rb = R({ shopId: "shopB", dateTime: T(59) });
  seed({ importProduct: imp });
  const r = await call("receiveList", { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.receipts.length, 30);
  assert.equal(r.body.receipts[0].id, "r35");
  assert.equal(r.body.receipts[29].id, "r06");
  assert.equal(r.body.receipts[0].dateTime, "2026-11-10T03:35:00.000Z");
  assert.deepEqual(r.body.receipts[0].product, [{ id: "p1", name: "น้ำ", qty: 1, cost: 4 }]);
  assert.match(r.body.nextCursor, /^1\|\d+\|\d+\|r06$/);
  assert.equal(READS, 1 + 30, "shop 1 + 30 ใบ = เท่าแอปเดิม + ด่าน");
  const q = QUERIES.find((x) => x.c === "importProduct");
  assert.deepEqual(q.order, [["dateTime", "desc"], ["__name__", "desc"]]);
  assert.equal(q.limit, 30);
  assert.equal(q.after, null);
});

test("receiveList: เดินต่อจากใบสุดท้ายครบทุกใบ ไม่ซ้ำ ไม่หาย · หน้าไม่เต็ม = nextCursor null", async () => {
  const imp = {};
  for (let i = 1; i <= 7; i++) imp[`r${i}`] = R({ dateTime: T(i) });
  seed({ importProduct: imp });
  const pages = await receiveAll(3);
  assert.deepEqual(pages.map((p) => p.receipts.map((x) => x.id)), [["r7", "r6", "r5"], ["r4", "r3", "r2"], ["r1"]]);
  assert.equal(pages[2].nextCursor, null);
  assert.deepEqual(pages.map((p) => p.reads), [4, 4, 2]);
});

test("receiveList: หน้าเต็มพอดีใบสุดท้าย → หน้าถัดไปว่าง (อ่าน 1) nextCursor null", async () => {
  seed({ importProduct: { a: R({ dateTime: T(1) }), b: R({ dateTime: T(2) }) } });
  const pages = await receiveAll(2);
  assert.deepEqual(pages.map((p) => [p.receipts.map((x) => x.id), p.nextCursor === null]), [[["b", "a"], false], [[], true]]);
});

test("receiveList: หลายใบเวลาเท่ากันเป๊ะข้ามรอยต่อหน้า · เวลาต่างกันต่ำกว่า ms · ไม่หาย ไม่ซ้ำ ไม่วน", async () => {
  const same = T(7, 123456);
  seed({ importProduct: {
    a: R({ dateTime: same }), b: R({ dateTime: same }), c: R({ dateTime: same }), d: R({ dateTime: same }),
    x: R({ dateTime: T(7, 123000) }), y: R({ dateTime: T(7, 123999) }), z: R({ dateTime: T(1) }),
  } });
  const pages = await receiveAll(2);
  const ids = pages.flatMap((p) => p.receipts.map((x) => x.id));
  assert.deepEqual(ids, ["y", "d", "c", "b", "a", "x", "z"], "y ช้ากว่าก้อนเวลาเดียวกัน 543 ns · x เร็วกว่า 456 ns");
});

test("receiveList: cursor ที่ไม่ได้มาจาก server → 400 · ร้านช่อง shopId ≠ doc id ค้นด้วยช่อง", async () => {
  seed({ importProduct: { a: R({ dateTime: T(1) }), o: R({ shopId: "oldField", dateTime: T(2) }) } }, { shopId: "oldField" });
  const bad = await call("receiveList", { shopId: "shopA", cursor: "2026-11-10T03:00:00.000Z" });
  assert.deepEqual([bad.code, bad.body.error], [400, "invalid_request"]);
  const r = await call("receiveList", { shopId: "shopA" });
  assert.deepEqual(r.body.receipts.map((x) => x.id), ["o"]);
});

test("receiveList: สิทธิ์ 101 ผ่าน · 115 อย่างเดียวไม่ผ่าน (จอประวัติอยู่ใต้ตั้งค่าเท่านั้น) · ไม่ต้องพรีเมี่ยม · watcher ผ่าน", async () => {
  seed({ importProduct: { a: R({ dateTime: T(1) }) } }, { vip: EXPIRED });
  assert.equal((await call("receiveList", { shopId: "shopA" }, STAFF(["101"]))).code, 200);
  const no = await call("receiveList", { shopId: "shopA" }, STAFF(["115", "114", "100"]));
  assert.deepEqual([no.code, no.body.error], [403, "right_required"]);
  assert.equal((await call("receiveList", { shopId: "shopA" }, WATCHER)).code, 200);
});

// คู่เทียบ (ตรวจ 2026-11-14 ด้วยการแก้โค้ดชั่วคราวแล้วรัน): อ่านเผื่อ limit+1 = แดง 2 · cursor ปัดเป็น ms = แดง 1 · supplierList ไม่ตรวจสิทธิ์ = แดง 1

// เทส DEV-0010 · stock.sync + stock.findBarcode (pos/stock/syncRead.js) · รัน: node --test pos/stock/syncRead.test.js
//   ฐานปลอมในไฟล์นี้ทำตัวแบบ Firestore จริงในส่วนที่ handler พึ่ง: where == / > · orderBy(updateTime, __name__) · startAfter(Timestamp, id)
//   · limit · Timestamp ละเอียดนาโนวินาที (harness ของสัญญาไม่เรียง/ไม่ startAfter ⇒ การแบ่งหน้าจริงพิสูจน์ที่นี่)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FUNCTIONS = path.resolve(__dirname, "..", "..");

// คำขอ DEV-0010 อยู่ใน vendor @shopchamp/schema 0.1.28 แล้ว ⇒ ใช้ vendor ปกติ · ขาดตัวไหน = ตกทันที (ไม่ build จาก src ของ center แทน)
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  const missing = ["StockSyncRequest", "StockFindBarcodeRequest"].filter((k) => !pkg[k]);
  if (missing.length) throw new Error(`vendor @shopchamp/schema ไม่มี ${missing.join(" ")} · bump + vendor ใหม่`);
}

class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
}
const tsOfIso = (iso, extraNanos) => {
  const ms = Date.parse(iso);
  const s = Math.floor(ms / 1000);
  return new Timestamp(s, (ms - s * 1000) * 1e6 + (extraNanos || 0));
};
// ค่าเวลา → [s, n] เทียบได้ (Timestamp / Date) · อย่างอื่น = null (Firestore เทียบช่วงข้ามชนิดไม่ได้ ⇒ ไม่เข้าเงื่อนไข)
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
    orderBy: (f) => query(c, { ...st, order: [...st.order, f] }),
    startAfter: (...vals) => query(c, { ...st, after: vals }),
    limit: (n) => query(c, { ...st, limit: n }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let rows = Object.keys(DATA[c] || {}).map((id) => ({ id, d: DATA[c][id] }));
      for (const [f, op, v] of st.filters) {
        rows = rows.filter((r) => {
          const x = r.d[f];
          if (op === "==") return x === v;
          if (op === ">") { const a = key(x), b = key(v); return !!a && !!b && cmpT(a, b) > 0; }
          throw new Error(`ฐานปลอม: where ${op} ยังไม่รองรับ`);
        });
      }
      const ord = st.order.length ? st.order : ["__name__"];
      const cmpRow = (a, b) => {
        for (const f of ord) {
          if (f === "__name__") { if (a.id !== b.id) return a.id < b.id ? -1 : 1; continue; }
          const c2 = cmpT(key(a.d[f]), key(b.d[f]));
          if (c2) return c2;
        }
        return 0;
      };
      rows.sort(cmpRow);
      if (st.after) {
        assert.deepEqual(st.order, ["updateTime", "__name__"], "startAfter ต้องคู่กับ orderBy(updateTime, __name__)");
        assert.ok(st.after[0] instanceof Timestamp, "cursor ต้องเป็น Timestamp ของ SDK (ไม่ปัดเป็น Date ms)");
        const pivot = { id: st.after[1], d: { updateTime: st.after[0] } };
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
  const abs = require.resolve("./syncRead");
  delete require.cache[abs];
  return require(abs)[fn];
}
async function call(fn, body, reqExtra) {
  const handler = load(fn)({});
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  READS = 0;
  QUERIES = [];
  await handler({ body, ...(reqExtra === undefined ? OWNER : reqExtra) }, res);
  return res;
}
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const CASHIER = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const WATCHER = { shopAccess: { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true } };
const T = (m, extraNanos) => tsOfIso(`2026-11-10T03:${String(m).padStart(2, "0")}:00.000Z`, extraNanos);
const P = (x) => ({ shopId: "shopA", name: "n", price: 10, cost: 4, stock: 5, barcode: "", ...x });

function seed(stock, shopX) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านเอ", ...(shopX || {}) }, shopB: { shopId: "shopB", name: "ร้านบี" } },
    stock,
    product: {},
  };
}
async function syncAll(limit, cursor) {
  const pages = [];
  let c = cursor;
  for (let i = 0; i < 20; i++) {
    const r = await call("sync", { shopId: "shopA", limit, ...(c ? { cursor: c } : {}) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    pages.push(r.body);
    c = r.body.nextCursor;
    if (!r.body.hasMore) break;
  }
  return { pages, cursor: c };
}

test("sync: โหลดทั้งร้านแบ่ง 2 หน้า · ได้ครบทุกตัว เรียงตามเวลาแก้ · หน้าสุดท้าย hasMore false", async () => {
  seed({ p1: P({ updateTime: T(1) }), p2: P({ updateTime: T(2) }), p3: P({ updateTime: T(3) }), p4: P({ updateTime: T(4) }), p5: P({ updateTime: T(5) }) });
  const { pages } = await syncAll(3);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].items.map((x) => x.id), ["p1", "p2", "p3"]);
  assert.equal(pages[0].hasMore, true);
  assert.deepEqual(pages[1].items.map((x) => x.id), ["p4", "p5"]);
  assert.equal(pages[1].hasMore, false);
  assert.match(pages[1].nextCursor, /^1\|\d+\|\d+\|p5$/);
  const q = QUERIES.find((x) => x.c === "stock");
  assert.deepEqual(q.order, ["updateTime", "__name__"]);
  assert.deepEqual(q.filters.map((f) => f.slice(0, 2)), [["shopId", "=="], ["updateTime", ">"]]);
  assert.equal(q.limit, 4, "อ่าน limit+1 ดูว่ามีหน้าต่อไหม");
});

test("sync: หลาย doc updateTime เท่ากันเป๊ะ (เขียนใน transaction เดียว) ข้ามรอยต่อหน้า ไม่หาย ไม่ซ้ำ", async () => {
  const same = T(7, 123456);
  seed({ a: P({ updateTime: same }), b: P({ updateTime: same }), c: P({ updateTime: same }), d: P({ updateTime: same }), e: P({ updateTime: same }), z: P({ updateTime: T(1) }) });
  const { pages } = await syncAll(2);
  const ids = pages.flatMap((p) => p.items.map((x) => x.id));
  assert.deepEqual(ids, ["z", "a", "b", "c", "d", "e"]);
});

test("sync: เวลาต่างกันระดับต่ำกว่ามิลลิวินาที · cursor ไม่ปัดเป็น ms (ไม่ข้ามตัวที่ช้ากว่าไม่ถึง 1 ms · ไม่วนหน้าเดิม)", async () => {
  seed({ a: P({ updateTime: T(7, 100) }), b: P({ updateTime: T(7, 900000) }), c: P({ updateTime: T(7, 500) }) });
  const r1 = await call("sync", { shopId: "shopA", limit: 1 });
  assert.deepEqual(r1.body.items.map((x) => x.id), ["a"]);
  const r2 = await call("sync", { shopId: "shopA", limit: 1, cursor: r1.body.nextCursor });
  assert.deepEqual(r2.body.items.map((x) => x.id), ["c"], "c ช้ากว่า a 400 ns ต้องมาก่อน b");
  const r3 = await call("sync", { shopId: "shopA", limit: 1, cursor: r2.body.nextCursor });
  assert.deepEqual(r3.body.items.map((x) => x.id), ["b"]);
  assert.equal(r3.body.hasMore, false);
});

test("sync: ส่ง cursor = เฉพาะตัวที่เปลี่ยนหลังจุดนั้น · ไม่มีอะไรเปลี่ยน = items ว่าง cursor เดิม", async () => {
  seed({ p1: P({ updateTime: T(1) }), p2: P({ updateTime: T(2) }) });
  const { cursor } = await syncAll(500);
  const idle = await call("sync", { shopId: "shopA", cursor });
  assert.deepEqual([idle.body.items, idle.body.deletedIds, idle.body.nextCursor, idle.body.hasMore], [[], [], cursor, false]);
  DATA.stock.p1 = P({ updateTime: T(9), price: 99 });
  const r = await call("sync", { shopId: "shopA", cursor });
  assert.deepEqual(r.body.items.map((x) => [x.id, x.price]), [["p1", 99]]);
  assert.match(r.body.nextCursor, /\|p1$/);
});

test("sync: ตัวที่ลบ (deleted true · sku 'delete') มาแค่ id ใน deletedIds · cursor เดินผ่านตัวที่ลบ", async () => {
  seed({ p1: P({ updateTime: T(1) }), p2: P({ updateTime: T(2), deleted: true, name: "ลับ" }), p3: P({ updateTime: T(3), sku: "delete" }) });
  const r = await call("sync", { shopId: "shopA" });
  assert.deepEqual(r.body.items.map((x) => x.id), ["p1"]);
  assert.deepEqual(r.body.deletedIds, ["p2", "p3"]);
  assert.match(r.body.nextCursor, /\|p3$/);
  assert.ok(!JSON.stringify(r.body).includes("ลับ"));
});

test("sync: doc เต็ม + id · ตัดรอยทีมงาน · cost ยังอยู่ · เวลาทุกช่อง (ซ้อนด้วย) เป็น ISO", async () => {
  seed({
    p1: P({
      updateTime: T(1), timestamp: T(0), cost: 7.5, linkDetail: [{ id: "x", linkMultiply: 2 }],
      expReport: [{ date: T(3), qty: 1 }], promotion: { status: true, startDate: new Date("2026-11-01T00:00:00.000Z") },
      createdBy: { staffId: "u", staffName: "s" }, updatedBy: { staffId: "u" }, deletedBy: null, deletedAt: null, byAdmin: true, adminUid: "adm",
    }),
  });
  const r = await call("sync", { shopId: "shopA" });
  const it = r.body.items[0];
  assert.equal(it.id, "p1");
  assert.equal(it.cost, 7.5);
  assert.equal(it.updateTime, "2026-11-10T03:01:00.000Z");
  assert.equal(it.timestamp, "2026-11-10T03:00:00.000Z");
  assert.equal(it.expReport[0].date, "2026-11-10T03:03:00.000Z");
  assert.equal(it.promotion.startDate, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(it.linkDetail, [{ id: "x", linkMultiply: 2 }]);
  for (const f of ["createdBy", "updatedBy", "deletedBy", "deletedAt", "byAdmin", "adminUid"]) assert.ok(!(f in it), f);
});

test("sync: ร้านอื่นไม่ปน · ร้านที่ช่อง shopId ≠ doc id ค้นด้วยช่อง shopId แบบแอปเดิม", async () => {
  seed({ p1: P({ updateTime: T(1) }), b1: P({ shopId: "shopB", updateTime: T(2) }), o1: P({ shopId: "legacyField", updateTime: T(3) }) });
  const r = await call("sync", { shopId: "shopA" });
  assert.deepEqual(r.body.items.map((x) => x.id), ["p1"]);
  DATA.shop.shopA.shopId = "legacyField";
  const r2 = await call("sync", { shopId: "shopA" });
  assert.deepEqual(r2.body.items.map((x) => x.id), ["o1"]);
  delete DATA.shop.shopA.shopId;
  const r3 = await call("sync", { shopId: "shopA" });
  assert.deepEqual(r3.body.items.map((x) => x.id), ["p1"], "ร้านไม่มีช่อง shopId = ใช้ doc id");
});

test("sync: ประชากรเท่าแอปเดิม · updateTime = ค่าตั้งต้น 2011-01-01 เวลาไทย / สตริง / ไม่มี = ไม่มา", async () => {
  seed({
    p1: P({ updateTime: T(1) }),
    init: P({ updateTime: new Date("2010-12-31T17:00:00.000Z") }),
    after: P({ updateTime: new Date("2010-12-31T17:00:00.001Z") }),
    str: P({ updateTime: "2026-11-10" }),
    none: P({}),
  });
  const r = await call("sync", { shopId: "shopA" });
  assert.deepEqual(r.body.items.map((x) => x.id), ["after", "p1"]);
});

test("sync: ค่าอ่าน = shop 1 + doc ที่ได้ (+1 ตัวดูหน้าต่อ)", async () => {
  seed({ p1: P({ updateTime: T(1) }), p2: P({ updateTime: T(2) }), p3: P({ updateTime: T(3) }) });
  await call("sync", { shopId: "shopA", limit: 2 });
  assert.equal(READS, 1 + 3);
});

test("sync 🔒: ไม่มีด่านร้าน 401 · ร้านอื่น 403 · cursor ปลอม/limit เกิน 400 · ไม่อ่าน stock เลย", async () => {
  seed({ p1: P({ updateTime: T(1) }) });
  const cases = [
    [{ shopId: "shopA" }, {}, 401, "no_shop_access"],
    [{ shopId: "shopB" }, OWNER, 403, "wrong_shop"],
    [{ shopId: "shopA", cursor: "2026-11-10T03:00:00Z" }, OWNER, 400, "invalid_request"],
    [{ shopId: "shopA", cursor: "1|1|1|a/b" }, OWNER, 400, "invalid_request"],
    [{ shopId: "shopA", limit: 1001 }, OWNER, 400, "invalid_request"],
  ];
  for (const [body, req, code, error] of cases) {
    const r = await call("sync", body, req);
    assert.deepEqual([r.code, r.body.error], [code, error], JSON.stringify(body));
    assert.ok(!("items" in r.body));
    assert.equal(QUERIES.length, 0);
  }
});

test("sync: แคชเชียร์ (ไม่มีเลขสิทธิ์สต๊อก) และ watcher อ่านได้ · แบบแอปเดิม", async () => {
  seed({ p1: P({ updateTime: T(1) }) });
  for (const req of [CASHIER, WATCHER]) {
    const r = await call("sync", { shopId: "shopA" }, req);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.map((x) => x.id), ["p1"]);
  }
});

test("findBarcode: เจอในร้าน → ตัวที่ไม่ลบทั้งหมด เรียง doc id · ร้านอื่นบาร์โค้ดเดียวกันไม่ปน · ไม่อ่านคลังกลาง", async () => {
  seed({
    p2: P({ barcode: "885", name: "สอง", updateTime: T(1), byAdmin: true }),
    p1: P({ barcode: "885", name: "หนึ่ง", updateTime: T(1) }),
    p3: P({ barcode: "885", deleted: true }),
    p4: P({ barcode: "885", sku: "delete" }),
    b1: P({ shopId: "shopB", barcode: "885" }),
    p5: P({ barcode: "999" }),
  });
  DATA.product = { c1: { barcode: "885", name: "กลาง", unit: "ชิ้น", imageId: "", createdBy2: "shopZ" } };
  const r = await call("findBarcode", { shopId: "shopA", barcode: "885", catalog: true });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.stock.map((x) => x.id), ["p1", "p2"]);
  assert.equal(r.body.stock[0].updateTime, "2026-11-10T03:01:00.000Z");
  assert.ok(!("byAdmin" in r.body.stock[1]));
  assert.deepEqual(r.body.catalog, []);
  assert.ok(!QUERIES.some((q) => q.c === "product"), "เจอในร้านแล้วไม่อ่านคลังกลาง");
});

test("findBarcode: ไม่เจอในร้าน + catalog true → คลังกลาง 1 ตัว (id barcode imageId name unit) · ไม่ส่งรอยร้านผู้สร้าง", async () => {
  seed({ p1: P({ barcode: "111" }) });
  DATA.product = { c2: { barcode: "885", name: "สอง", unit: "ขวด", imageId: "https://x/2.jpg", createdBy2: "shopZ" }, c1: { barcode: "885", name: "หนึ่ง", unit: "ชิ้น", imageId: "" } };
  const r = await call("findBarcode", { shopId: "shopA", barcode: "885", catalog: true });
  assert.deepEqual(r.body.stock, []);
  assert.deepEqual(r.body.catalog, [{ id: "c1", barcode: "885", imageId: "", name: "หนึ่ง", unit: "ชิ้น" }]);
  const q = QUERIES.find((x) => x.c === "product");
  assert.equal(q.limit, 1);
});

test("findBarcode: ไม่เจอ + ไม่ส่ง catalog → ไม่อ่านคลังกลาง (ค่าอ่านไม่เกินของเดิม)", async () => {
  seed({});
  DATA.product = { c1: { barcode: "885", name: "x", unit: "y", imageId: "" } };
  const r = await call("findBarcode", { shopId: "shopA", barcode: "885" });
  assert.deepEqual([r.code, r.body.stock, r.body.catalog], [200, [], []]);
  assert.ok(!QUERIES.some((q) => q.c === "product"));
  assert.equal(READS, 1 + 1);
});

test("findBarcode: ร้านที่ช่อง shopId ≠ doc id ค้นด้วยช่อง shopId · บาร์โค้ดเลขในฐานไม่ตรงสตริง (แบบเดิม)", async () => {
  seed({ o1: P({ shopId: "legacyField", barcode: "885" }), n1: P({ shopId: "legacyField", barcode: 885 }) }, { shopId: "legacyField" });
  const r = await call("findBarcode", { shopId: "shopA", barcode: "885" });
  assert.deepEqual(r.body.stock.map((x) => x.id), ["o1"]);
});

test("findBarcode 🔒: ไม่มีด่านร้าน 401 · ร้านอื่น 403 · บาร์โค้ดว่าง 400 · ไม่อ่าน stock", async () => {
  seed({ p1: P({ barcode: "885" }) });
  for (const [body, req, code, error] of [
    [{ shopId: "shopA", barcode: "885" }, {}, 401, "no_shop_access"],
    [{ shopId: "shopB", barcode: "885" }, OWNER, 403, "wrong_shop"],
    [{ shopId: "shopA", barcode: "" }, OWNER, 400, "invalid_request"],
  ]) {
    const r = await call("findBarcode", body, req);
    assert.deepEqual([r.code, r.body.error], [code, error]);
    assert.ok(!("stock" in r.body));
    assert.equal(QUERIES.length, 0);
  }
  const c = await call("findBarcode", { shopId: "shopA", barcode: "885" }, CASHIER);
  assert.deepEqual(c.body.stock.map((x) => x.id), ["p1"], "แคชเชียร์สแกนได้แบบเดิม");
});

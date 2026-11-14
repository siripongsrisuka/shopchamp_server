// เทส DEV-0010 · promotion.list (pos/promotion/list.js) · รัน: node --test pos/promotion/list.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FUNCTIONS = path.resolve(__dirname, "..", "..");

function installSchemas() {
  if (!require("@shopchamp/schema").PromotionListRequest) throw new Error("vendor @shopchamp/schema ไม่มี PromotionListRequest · bump + vendor ใหม่");
}

class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)); }
}
const ts = (iso) => { const ms = Date.parse(iso); return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); };

let DATA = {};
let READS = 0;
let QUERIES = [];
function makeDb() {
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const query = (c, st) => ({
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    limit: (n) => query(c, { ...st, limit: n }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let rows = Object.keys(DATA[c] || {}).map((id) => ({ id, d: DATA[c][id] }));
      for (const [f, op, v] of st.filters) {
        if (op !== "==") throw new Error(`ฐานปลอม: where ${op} ยังไม่รองรับ`);
        rows = rows.filter((r) => r.d[f] === v);
      }
      if (st.limit != null) rows = rows.slice(0, st.limit);
      READS += Math.max(1, rows.length);
      return { docs: rows.map((r) => snapOf(c, r.id)) };
    },
  });
  return {
    collection: (c) => ({
      doc: (id) => ({ id, get: async () => { READS += 1; return snapOf(c, id); } }),
      where: (f, op, v) => query(c, { filters: [[f, op, v]], limit: null }),
    }),
  };
}

async function call(body, reqExtra) {
  installSchemas();
  const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: { firestore: { Timestamp } } } };
  for (const m of ["./list", "../stock/syncRead"]) delete require.cache[require.resolve(m)];
  const handler = require("./list").list({ now: () => new Date("2026-11-14T03:00:00.000Z") });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  READS = 0;
  QUERIES = [];
  await handler({ body, ...(reqExtra === undefined ? OWNER : reqExtra) }, res);
  return res;
}
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const CASHIER = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const WATCHER = { shopAccess: { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true } };
const ROOT = { shopAccess: { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true, root: true } };
const PREMIUM = [{ type: "premium", expire: ts("2027-01-01T00:00:00.000Z") }];
const EXPIRED = [{ type: "premium", expire: ts("2026-01-01T00:00:00.000Z") }];
const PROMO = (x) => ({
  shopId: "shopA", name: "ซื้อ 2 ลด 10", status: true, type: "discount", products: [{ id: "p1", qty: 2 }], day: [1, 2, 3], hour: [9, 10],
  startDate: ts("2026-11-01T00:00:00.000Z"), endDate: ts("2026-12-01T00:00:00.000Z"), timestamp: ts("2026-10-31T00:00:00.000Z"), ...x,
});
function seed(promotion, shopX) {
  DATA = { shop: { shopA: { shopId: "shopA", vip: PREMIUM, ...(shopX || {}) }, shopB: { shopId: "shopB", vip: PREMIUM } }, promotion };
}

test("promotion.list: เจ้าของ → doc เต็ม + id เรียง doc id · เวลาทุกช่อง ISO (updatedAt อยู่) · ตัดรอยผู้แก้/ทีมงาน · ร้านอื่นไม่ปน · ค่าอ่าน shop 1 + doc", async () => {
  seed({
    m2: PROMO({ updatedAt: ts("2026-11-05T03:00:00.000Z"), updatedBy: "u-owner", byAdmin: false, adminUid: null, slot: [], reward: [{ at: ts("2026-11-02T00:00:00.000Z") }] }),
    m1: PROMO({ name: "โปรเก่า", status: false }),
    mb: PROMO({ shopId: "shopB" }),
  });
  const r = await call({ shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.promotions.map((x) => x.id), ["m1", "m2"]);
  const m2 = r.body.promotions[1];
  assert.equal(m2.startDate, "2026-11-01T00:00:00.000Z");
  assert.equal(m2.endDate, "2026-12-01T00:00:00.000Z");
  assert.equal(m2.updatedAt, "2026-11-05T03:00:00.000Z", "แอปใช้เป็น baseUpdatedAt ตอนแก้");
  assert.deepEqual(m2.reward, [{ at: "2026-11-02T00:00:00.000Z" }]);
  assert.deepEqual([m2.products, m2.day, m2.hour, m2.slot], [[{ id: "p1", qty: 2 }], [1, 2, 3], [9, 10], []]);
  for (const k of ["updatedBy", "byAdmin", "adminUid"]) assert.equal(k in m2, false, `ตัด ${k}`);
  assert.equal(r.body.byAdmin, undefined);
  assert.equal(READS, 1 + 2);
  assert.deepEqual(QUERIES.map((q) => [q.c, q.filters, q.limit]), [["promotion", [["shopId", "==", "shopA"]], null]]);
});

test("promotion.list: ร้านที่ช่อง shopId ≠ doc id → ค้นด้วยช่อง shopId ของร้าน", async () => {
  seed({ m1: PROMO({}), mo: PROMO({ shopId: "oldField" }) }, { shopId: "oldField" });
  const r = await call({ shopId: "shopA" });
  assert.deepEqual(r.body.promotions.map((x) => x.id), ["mo"]);
});

test("promotion.list: แคชเชียร์ไม่มีเลขสิทธิ์ → 200 (คิดโปรในตะกร้า) · watcher 200 · ทีมงาน byAdmin", async () => {
  seed({ m1: PROMO({}) });
  assert.equal((await call({ shopId: "shopA" }, CASHIER)).code, 200);
  assert.equal((await call({ shopId: "shopA" }, WATCHER)).code, 200);
  assert.equal((await call({ shopId: "shopA" }, ROOT)).body.byAdmin, true);
});

test("promotion.list: พรีเมี่ยมหมด → 403 premium_required ไม่อ่าน promotion (แอปเดิมไม่โหลด)", async () => {
  seed({ m1: PROMO({}) }, { vip: EXPIRED });
  const r = await call({ shopId: "shopA" });
  assert.deepEqual([r.code, r.body.error, r.body.promotions], [403, "premium_required", undefined]);
  assert.equal(QUERIES.length, 0);
});

test("promotion.list: 🔒 ร้านอื่น 403 wrong_shop · ไม่มีด่าน 401 · ช่องเกิน 400 · ไม่อ่านฐาน", async () => {
  seed({ m1: PROMO({}) });
  const w = await call({ shopId: "shopB" });
  assert.deepEqual([w.code, w.body.error], [403, "wrong_shop"]);
  const n = await call({ shopId: "shopA" }, {});
  assert.deepEqual([n.code, n.body.error], [401, "no_shop_access"]);
  const x = await call({ shopId: "shopA", limit: 5 });
  assert.deepEqual([x.code, x.body.error], [400, "invalid_request"]);
  assert.equal(READS, 0);
});

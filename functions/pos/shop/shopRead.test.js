// เทส DEV-0010 คลื่น 2 กลุ่ม shop/system · รัน: node --test pos/shop/shopRead.test.js
//   ของที่ชุด case ของสัญญาวัดไม่ได้: harness เทียบ body แบบบางส่วน (ช่องเกินในแถวของ array ไม่ฟ้อง) · ไม่เรียง · ไม่ select
//   ⇒ ที่นี่พิสูจน์: แถว findByTel/notification มีแค่ช่องที่ประกาศ · limit 20/30 · เรียงล่าสุดก่อน · select · enterShop/shopCreate คืน shop + profile
// ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const CENTER = path.resolve(FUNCTIONS, "..", "..", "shopchamp-center");
const NEW_SCHEMAS = ["ShopGetRequest", "ShopFindByTelRequest", "CompanyCatalogRequest", "NotificationListRequest"];

// คำขอใหม่ยังไม่อยู่ใน vendor tarball (แม่ bump รวม) ⇒ build จาก src ของ center แล้วเติมเฉพาะตัวที่ขาด
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  if (NEW_SCHEMAS.every((k) => pkg[k])) return;
  const src = path.join(CENTER, "packages", "schema", "src", "requests", "shopRead.ts");
  if (!fs.existsSync(src)) throw new Error(`ไม่พบ ${src}`);
  const esbuild = require(require.resolve("esbuild", { paths: [CENTER] }));
  const out = esbuild.buildSync({
    entryPoints: [src], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error",
    nodePaths: [path.join(CENTER, "packages", "schema", "node_modules"), path.join(CENTER, "node_modules")],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  for (const k of NEW_SCHEMAS) if (!pkg[k]) pkg[k] = m.exports[k];
}

// ── ฐานปลอม (มีสถานะ · transaction ลงจริงตอนจบ) ──
let DATA = {};
let QUERIES = [];
let READS = [];
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const coll = (c) => (DATA[c] = DATA[c] || {});
const snapOf = (c, id, fields) => {
  const d = coll(c)[id];
  const data = () => {
    if (d === undefined) return undefined;
    if (!fields) return clone(d);
    const o = {};
    for (const f of fields) if (d[f] !== undefined) o[f] = clone(d[f]);
    return o;
  };
  return { exists: d !== undefined, id, data };
};
const ms = (v) => (v instanceof Date ? v.getTime() : v);
function query(c, st) {
  return {
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f, dir) => query(c, { ...st, order: [f, dir || "asc"] }),
    limit: (n) => query(c, { ...st, limit: n }),
    select: (...fields) => query(c, { ...st, select: fields }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let ids = Object.keys(coll(c)).filter((id) => st.filters.every(([f, op, v]) => op === "==" && coll(c)[id][f] === v));
      if (st.order) {
        const [f, dir] = st.order;
        ids = ids.filter((id) => coll(c)[id][f] !== undefined);
        ids.sort((a, b) => (ms(coll(c)[a][f]) - ms(coll(c)[b][f])) * (dir === "desc" ? -1 : 1));
      }
      if (st.limit != null) ids = ids.slice(0, st.limit);
      const docs = ids.map((id) => snapOf(c, id, st.select));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}
const fakeDb = {
  collection: (c) => ({
    doc: (id) => ({ c, id, get: async () => { READS.push(`${c}/${id}`); return snapOf(c, id); } }),
    where: (f, op, v) => query(c, { filters: [[f, op, v]] }),
  }),
  runTransaction: async (fn) => {
    const writes = [];
    const tx = {
      get: async (r) => snapOf(r.c, r.id),
      set: (r, v) => { writes.push(["set", r, v]); return tx; },
      update: (r, v) => { writes.push(["update", r, v]); return tx; },
    };
    const out = await fn(tx);
    for (const [op, r, v] of writes) coll(r.c)[r.id] = op === "set" ? clone(v) : { ...coll(r.c)[r.id], ...clone(v) };
    return out;
  },
};
const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {} } };
installSchemas();

const { get } = require("./get");
const { findByTel, LIMIT: FIND_LIMIT } = require("./findByTel");
const { appShopView, APP_EXTRA_FIELDS } = require("./_appView");
const { list, LIMIT: NOTI_LIMIT } = require("../notification/list");
const { catalog } = require("../company/catalog");
const { profileManage } = require("../shopStaff/profileManage");
const { shopCreate } = require("../company/shopCreate");
const { SHOP_FIELDS } = require("../profile/loading");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const call = async (h, body, req) => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ body, ...(req || {}) }, res);
  return res;
};
const PREM = [{ type: "premium", expire: new Date("2027-01-31T17:00:00.000Z") }, { type: "staff", expire: new Date("2027-01-31T17:00:00.000Z") }];
const HR = [
  { id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active", password: "1234" },
  { id: "u-noti", name: "แจ้งเตือน", position: [], status: "active", rights: ["109"], password: "" },
];
const SHOP_A = {
  shopId: "shopA", name: "ร้านทดสอบ", tel: "0811111111", logo: "https://img/a.png", vip: PREM, humanResource: HR,
  line: { channelAccessToken: "tok-A" }, taxCustomer: [{ id: "t1" }], lineNoti: [{ id: "ln" }], lineUsers: [{ id: "lu" }], scango: { enabled: true },
  attendance: { x: 1 }, destinationAddress: { lat: 1 }, cutOff: new Date("2010-12-31T17:00:00.000Z"),
};
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };

test("appShopView: ช่อง = SHOP_FIELDS + id + staff + 6 ช่องที่แอปอ่าน (Pack ข้อ 7) · ไม่มีช่องอื่น · เวลาเป็น ISO", () => {
  const v = appShopView("shopA", SHOP_A);
  const allowed = new Set([...SHOP_FIELDS, "id", "staff", ...APP_EXTRA_FIELDS]);
  for (const k of Object.keys(v)) assert.ok(allowed.has(k), `ช่อง ${k} หลุด`);
  assert.equal(v.humanResource[0].password, "1234");
  assert.equal(v.line.channelAccessToken, "tok-A");
  assert.deepEqual(v.scango, { enabled: true });
  assert.equal(v.cutOff, "2010-12-31T17:00:00.000Z");
  assert.equal("attendance" in v, false);
  assert.equal(v.id, "shopA");
});

test("shop.get: อ่าน shop doc ครั้งเดียว · คืน appShopView", async () => {
  DATA = { shop: { shopA: SHOP_A } };
  const r = await call(get({}), { shopId: "shopA" }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.shop, appShopView("shopA", SHOP_A));
});

test("ด่านจริง + handler: shop.get · notification.list · company.catalog อ่าน shop doc รวม 1 ครั้ง (ด่านแนบ doc ให้ handler)", async () => {
  const { makeRequireShopAccess } = require("../_shared/auth");
  const mw = makeRequireShopAccess({ db: fakeDb, now: () => NOW, log: () => {} });
  const viaGate = async (h, body) => {
    const req = { body, auth: { uid: "u-owner" } };
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    assert.equal(nexted, true, `ด่านปัด ${JSON.stringify(res.body)}`);
    await h(req, res);
    return res;
  };
  const shopReads = () => READS.filter((x) => x === "shop/shopA").length;
  DATA = { shop: { shopA: SHOP_A }, admin: { hardware: { items: [] } } };
  READS = [];
  const r1 = await viaGate(get({}), { shopId: "shopA" });
  assert.equal(r1.code, 200);
  assert.deepEqual(r1.body.shop, appShopView("shopA", SHOP_A));
  assert.equal(shopReads(), 1);
  READS = [];
  const r2 = await viaGate(list({ now: () => NOW }), { shopId: "shopA" });
  assert.equal(r2.code, 200);
  assert.equal(shopReads(), 1);
  READS = [];
  const r3 = await viaGate(catalog({}), { shopId: "shopA", kind: "hardware" });
  assert.equal(r3.code, 200);
  assert.equal(shopReads(), 1);
});

test("shop.findByTel: แถวมีแค่ {id, shopId, name, logo} · limit 20 · ไม่มีช่องลับ", async () => {
  const shops = {};
  for (let i = 0; i < 25; i++) shops[`s${String(i).padStart(2, "0")}`] = { shopId: `f${i}`, name: `ร้าน ${i}`, tel: "0899999999", humanResource: [{ id: "x", password: "9" }], line: { channelAccessToken: "t" } };
  DATA = { shop: shops };
  QUERIES = [];
  const r = await call(findByTel({}), { tel: "0899999999" }, { auth: { uid: "u-any" } });
  assert.equal(r.code, 200);
  assert.equal(FIND_LIMIT, 20);
  assert.equal(r.body.shops.length, 20);
  assert.equal(QUERIES[0].limit, 20);
  for (const s of r.body.shops) assert.deepEqual(Object.keys(s).sort(), ["id", "logo", "name", "shopId"]);
});

test("notification.list: ล่าสุดก่อน · 30 ใบ · select ช่องที่ใช้ · แถวไม่มีช่องอื่น", async () => {
  const noti = {};
  for (let i = 0; i < 35; i++) noti[`n${i}`] = { shopId: "shopA", heading: `h${i}`, notificationContent: `c${i}`, categoryId: i % 7, timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)), recipients: ["u-owner"], token: "x" };
  noti.other = { shopId: "shopB", heading: "x", timestamp: new Date(Date.UTC(2026, 10, 9)) };
  DATA = { shop: { shopA: SHOP_A }, notification: noti };
  QUERIES = [];
  const r = await call(list({ now: () => NOW }), { shopId: "shopA" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(NOTI_LIMIT, 30);
  assert.equal(r.body.rows.length, 30);
  assert.equal(r.body.rows[0].id, "n34");
  assert.equal(r.body.rows[29].id, "n5");
  assert.equal(r.body.rows[0].timestamp, new Date(Date.UTC(2026, 10, 1, 0, 34)).toISOString());
  for (const row of r.body.rows) assert.deepEqual(Object.keys(row).sort(), ["categoryId", "heading", "id", "notificationContent", "timestamp"]);
  const q = QUERIES.find((x) => x.c === "notification");
  assert.deepEqual(q.order, ["timestamp", "desc"]);
  assert.equal(q.limit, 30);
  assert.ok(Array.isArray(q.select) && !q.select.includes("recipients"));
});

test("company.catalog: package ไม่มีช่อง admin · ช่องนอกรายการไม่ออก", async () => {
  DATA = { shop: { shopA: SHOP_A }, admin: { package: { value: [{ id: 1 }], payment: {}, packageLink: "l", admin: ["u-company"], internalNote: "x" } } };
  const r = await call(catalog({}), { shopId: "shopA", kind: "package" }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(Object.keys(r.body.catalog).sort(), ["packageLink", "payment", "value"]);
});

test("profile.manage enterShop: คืน shop (appShopView ของร้านที่อ่านใน transaction) · ของเดิมคงอยู่", async () => {
  DATA = { shop: { shopA: SHOP_A }, profile: { "u-owner": { name: "ก", port: [], currentLogin: { shopId: "", rights: [], printer: [] } } }, watcher: { roster: { uids: [], rootUids: [] } } };
  const r = await call(profileManage({ now: () => NOW }), { op: "enterShop", shopId: "shopA" }, { auth: { uid: "u-owner" } });
  assert.equal(r.code, 200);
  assert.equal(r.body.access.role, "owner");
  assert.equal(r.body.currentLogin.shopId, "shopA");
  assert.deepEqual(r.body.shop, appShopView("shopA", SHOP_A));
});

test("profile.manage op อื่น (leaveShop) ไม่มี shop ในคำตอบ", async () => {
  DATA = { profile: { "u-owner": { name: "ก", port: [], currentLogin: { shopId: "shopA", rights: [], printer: [] } } } };
  const r = await call(profileManage({ now: () => NOW }), { op: "leaveShop" }, { auth: { uid: "u-owner" } });
  assert.equal(r.code, 200);
  assert.equal("shop" in r.body, false);
});

test("company.shopCreate: คืน shop + profile{port,currentLogin} ตามที่เขียน · ส่งซ้ำคืนของในฐาน", async () => {
  DATA = { shopchamShopId: { numOfStore: { total: 100 } }, profile: { u1: { name: "ก", port: [{ shopId: "old", shopName: "เก่า" }] } } };
  const h = shopCreate({ now: () => NOW });
  const body = { name: "ร้านใหม่", tel: "0812345678", smartAddress: [1, 2, "3", "10200"], posId: "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b", uniqueId: "d", deviceName: "", requestId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" };
  const r1 = await call(h, { ...body }, { auth: { uid: "u1" } });
  assert.equal(r1.code, 200);
  const sid = r1.body.shopId;
  assert.deepEqual(r1.body.shop, appShopView(sid, DATA.shop[sid]));
  assert.equal(r1.body.shop.name, "ร้านใหม่");
  assert.equal(r1.body.shop.humanResource[0].id, "u1");
  assert.deepEqual(r1.body.profile.port, JSON.parse(JSON.stringify(DATA.profile.u1.port)));
  assert.equal(r1.body.profile.port.length, 2);
  assert.deepEqual(r1.body.profile.currentLogin, JSON.parse(JSON.stringify(DATA.profile.u1.currentLogin)));
  assert.equal(r1.body.profile.currentLogin.shopId, DATA.shop[sid].shopId);
  const r2 = await call(h, { ...body }, { auth: { uid: "u1" } });
  assert.equal(r2.body.duplicate, true);
  assert.deepEqual(r2.body.shop, r1.body.shop);
  assert.deepEqual(r2.body.profile, r1.body.profile);
});

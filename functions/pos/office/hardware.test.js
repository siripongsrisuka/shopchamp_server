// เทส pos/office/hardware.js — หน้า "อุปกรณ์ที่ขาย" ของ shopchampoffice (DEV-0003 0d)
//   ① hwCatalog: แถว + ราคา/limit ทั้งข้อความเดิมและตัวเลข · หมวดพร้อมตัวนับ · ค่าส่งจาก logic · canEdit ตามระดับ · คนนอก 403 · doc หาย 503
//   ② hwItemSave: สร้าง (uuid ต่อท้าย) · แก้ (คงช่องอื่น) · price/limit เก็บเป็น string · กติการูป · หมวดต้องมีอยู่ · 404
//   ③ hwArrange / hwCategoryArrange: เรียงใหม่ · ไม่ครบ/เกิน = 409 arrange_mismatch
//   ④ หมวด: สร้าง/แก้ · ลบได้เมื่อไม่มีสินค้า (มี = 409 category_in_use)
//   ⑤ hwShippingSave · ทุกการเขียน: admin[] คงเดิม · รอยใน hardwareCatalogLog · watcher 403 ไม่เขียน · field เกิน 400
//   รัน: node --test functions/pos/office/hardware.test.js (จาก shopchamp_server) · ❌ ไม่แตะ Firestore จริง (แทน functions/firebase ใน require.cache)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

// ── ฐานปลอมที่เขียนลงจริง (transaction เขียนตอนจบ · create ซ้ำ = ล้ม) ─────────
function memDb() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const snap = (p, id) => ({ exists: store.has(p), id, data: () => clone(store.get(p)) });
  const docRef = (coll, id) => {
    const p = `${coll}/${id}`;
    return {
      id, path: p,
      get: async () => snap(p, id),
      set: async (d) => { store.set(p, clone(d)); },
      create: async (d) => { if (store.has(p)) throw new Error("ALREADY_EXISTS " + p); store.set(p, clone(d)); },
      update: async (d) => { if (!store.has(p)) throw new Error("NOT_FOUND " + p); store.set(p, { ...store.get(p), ...clone(d) }); },
      delete: async () => { store.delete(p); },
    };
  };
  const ops = { set: 0, update: 0, create: 0 };
  const db = {
    collection: (c) => ({ doc: (id) => docRef(c, id) }),
    runTransaction: async (fn) => {
      const q = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, d) => { ops.set++; q.push(() => ref.set(d)); return tx; },
        create: (ref, d) => { ops.create++; q.push(() => ref.create(d)); return tx; },
        update: (ref, d) => { ops.update++; q.push(() => ref.update(d)); return tx; },
        delete: (ref) => { q.push(() => ref.delete()); return tx; },
      };
      const out = await fn(tx);
      for (const op of q) await op();
      return out;
    },
  };
  return { db, store, ops };
}

let M = {};
let mem;
function fresh(seed) {
  mem = memDb();
  for (const [p, d] of Object.entries(seed || {})) mem.store.set(p, structuredClone(d));
  const fbAbs = require.resolve("../../firebase");
  const { FieldValue } = require("../_shared/fakeFieldValue");
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: mem.db, admin: {}, bucket: {}, FieldValue } };
  for (const f of ["./_officeStore", "./hardware"]) delete require.cache[require.resolve(f)];
  M = require("./hardware");
}

const ROOT = "rootUid000000000000000001";
const WATCH = "watchUid00000000000000001";
const OUT = "outUid0000000000000000001";
const NOW = new Date("2026-11-11T03:00:00.000Z");
const STAMP = "2026-11-11T03-00-00-000Z";
const IMG = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/equipment%2Foffice_abc.jpg?alt=media";
const OLD_IMG = "https://firebasestorage.googleapis.com/v0/b/other.appspot.com/o/old.jpg";

const roster = {
  uids: [ROOT, WATCH], rootUids: [ROOT],
  people: [{ uid: ROOT, email: "root@shopchamp.test", name: "Root", level: "root" }, { uid: WATCH, email: "watch@shopchamp.test", name: "Watch", level: "watcher" }],
  count: 2, rootCount: 1, rosterSha: "a".repeat(64), via: "center-script",
};
const hw = (over) => ({
  admin: ["adminUidA", "adminUidB"],
  value: [
    { id: "h1", name: "เครื่องพิมพ์", price: "1500", limit: "5", detail: "80mm", status: true, imageId: OLD_IMG, categoryId: "c1", extra: "keep" },
    { id: "h2", name: "ลิ้นชัก", price: "990.5", limit: "", detail: "", status: false, imageId: "" },
    { id: "h3", name: "กระดาษ", price: 25, limit: 999, detail: "", status: true, imageId: "", categoryId: "c2" },
  ],
  categories: [{ id: "c1", name: "เครื่องพิมพ์", active: true }, { id: "c2", name: "วัสดุ", active: false }, { id: "c3", name: "ว่าง", active: true }],
  ...(over || {}),
});
const seed = (over, extra) => ({ "watcher/roster": roster, "admin/hardware": hw(over), ...(extra || {}) });

async function call(name, body, uid) {
  let code = 0; let out = null;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  const email = uid === ROOT ? "root@shopchamp.test" : uid ? `${uid.slice(0, 5)}@shopchamp.test` : null;
  await M[name]({ now: () => new Date(NOW.getTime()) })({ body, auth: uid ? { uid, email } : undefined }, res);
  return { code, body: out };
}
const doc = () => mem.store.get("admin/hardware");
const logs = () => [...mem.store.entries()].filter(([k]) => k.startsWith("hardwareCatalogLog/"));
const snapshot = () => JSON.stringify([...mem.store.entries()]);
const item = (over) => ({ name: "สแกนเนอร์", price: 1200, limit: null, detail: "USB", status: true, imageId: "", categoryId: "c1", ...(over || {}) });

// ── ① hwCatalog ─────────────────────────────────────────────────────────────
test("hwCatalog: watcher เห็นแถว/หมวด/ค่าส่ง canEdit false · ไม่เขียน", async () => {
  fresh(seed());
  const before = snapshot();
  const r = await call("hwCatalog", {}, WATCH);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.canEdit, false);
  assert.deepEqual(r.body.items.map((x) => x.id), ["h1", "h2", "h3"]);
  assert.deepEqual(r.body.items[0], { id: "h1", name: "เครื่องพิมพ์", price: 1500, priceText: "1500", limit: 5, limitText: "5", detail: "80mm", status: true, imageId: OLD_IMG, categoryId: "c1" });
  assert.equal(r.body.items[1].price, 990.5);
  assert.equal(r.body.items[1].limit, 999, "limit '' = ค่าตั้งต้น 999");
  assert.equal(r.body.items[1].limitText, "");
  assert.equal(r.body.items[1].categoryId, null);
  assert.equal(r.body.items[2].priceText, "25");
  assert.deepEqual(r.body.categories, [{ id: "c1", name: "เครื่องพิมพ์", active: true, count: 1 }, { id: "c2", name: "วัสดุ", active: false, count: 1 }, { id: "c3", name: "ว่าง", active: true, count: 0 }]);
  assert.deepEqual(r.body.shipping, { fee: 100, freeFrom: 4000, isDefault: true });
  assert.equal(snapshot(), before);
});

test("hwCatalog: root canEdit true · ค่าส่งจาก doc · คนนอก 403 · ไม่ login 401 · doc หาย 503 · field เกิน 400", async () => {
  fresh(seed({ shipping: { fee: 50, freeFrom: null } }));
  const r = await call("hwCatalog", {}, ROOT);
  assert.equal(r.body.canEdit, true);
  assert.deepEqual(r.body.shipping, { fee: 50, freeFrom: null, isDefault: false });
  assert.equal((await call("hwCatalog", {}, OUT)).body.error, "office_no_access");
  assert.equal((await call("hwCatalog", {}, null)).code, 401);
  assert.equal((await call("hwCatalog", { x: 1 }, ROOT)).code, 400);
  fresh({ "watcher/roster": roster });
  const m = await call("hwCatalog", {}, ROOT);
  assert.equal(m.code, 503);
  assert.equal(m.body.error, "hardware_config_unavailable");
});

// ── ② hwItemSave ────────────────────────────────────────────────────────────
test("hwItemSave สร้าง: uuid ต่อท้าย · price/limit เป็น string · admin[] คงเดิม · รอย 1 ใบ", async () => {
  fresh(seed());
  const r = await call("hwItemSave", item({ price: 1200.5 }), ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
  const d = doc();
  assert.equal(d.value.length, 4);
  assert.deepEqual(d.value[3], { id: r.body.id, name: "สแกนเนอร์", price: "1200.5", limit: "999", detail: "USB", status: true, imageId: "", categoryId: "c1" });
  assert.deepEqual(d.admin, ["adminUidA", "adminUidB"]);
  assert.equal(d.updatedBy, "root@shopchamp.test");
  assert.equal(d.updatedByUid, ROOT);
  assert.equal(mem.ops.set, 0, "ไม่ set ทั้ง doc");
  const L = logs();
  assert.equal(L.length, 1);
  assert.equal(L[0][0], `hardwareCatalogLog/${STAMP}_${ROOT}_itemSave`);
  assert.equal(L[0][1].before, null);
  assert.equal(L[0][1].after.id, r.body.id);
});

test("hwItemSave แก้: คงช่องอื่นของแถว · รูปเดิม (URL รูปอื่น) ส่งกลับมาได้ · limit เป็น string", async () => {
  fresh(seed());
  const r = await call("hwItemSave", { id: "h1", name: " เครื่องพิมพ์ใหม่ ", price: 1600, limit: 3, detail: "", status: false, imageId: OLD_IMG, categoryId: null }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, id: "h1", created: false });
  const row = doc().value[0];
  assert.deepEqual(row, { id: "h1", name: "เครื่องพิมพ์ใหม่", price: "1600", limit: "3", detail: "", status: false, imageId: OLD_IMG, categoryId: null, extra: "keep" });
  assert.equal(doc().value.length, 3);
  assert.equal(logs()[0][1].before.name, "เครื่องพิมพ์");
  // เปลี่ยนเป็นรูปใหม่ใน equipment/ ได้
  fresh(seed());
  assert.equal((await call("hwItemSave", { id: "h1", ...item({ imageId: IMG }) }, ROOT)).code, 200);
  assert.equal(doc().value[0].imageId, IMG);
});

test("hwItemSave: กติการูป · หมวดไม่มี 409 · id ไม่มี 404 · ราคาผิด/ขาดช่อง/field เกิน 400 · ไม่เขียนอะไร", async () => {
  fresh(seed());
  const before = snapshot();
  const cases = [
    [item({ imageId: OLD_IMG }), 400, "invalid_request"], // รูปอื่นบนแถวใหม่
    [{ id: "h2", ...item({ imageId: "https://evil.example/equipment%2Fx.jpg" }) }, 400, "invalid_request"],
    [item({ imageId: IMG + "x".repeat(1000) }), 400, "invalid_request"],
    [item({ categoryId: "nope" }), 409, "hw_category_not_found"],
    [{ id: "zz", ...item() }, 404, "hw_item_not_found"],
    [item({ price: 0 }), 400, "invalid_request"],
    [item({ price: 1.234 }), 400, "invalid_request"],
    [item({ price: "100" }), 400, "invalid_request"],
    [item({ price: 10000001 }), 400, "invalid_request"],
    [item({ limit: 0 }), 400, "invalid_request"],
    [item({ limit: 10000 }), 400, "invalid_request"],
    [item({ limit: 2.5 }), 400, "invalid_request"],
    [item({ name: "  " }), 400, "invalid_request"],
    [item({ name: "x".repeat(201) }), 400, "invalid_request"],
    [item({ detail: "x".repeat(2001) }), 400, "invalid_request"],
    [item({ status: "true" }), 400, "invalid_request"],
    [(() => { const b = item(); delete b.detail; return b; })(), 400, "invalid_request"],
    [item({ passkey: {} }), 400, "invalid_request"],
  ];
  for (const [body, code, error] of cases) {
    const r = await call("hwItemSave", body, ROOT);
    assert.equal(r.code, code, JSON.stringify(body) + " → " + JSON.stringify(r.body));
    assert.equal(r.body.error, error);
  }
  assert.equal(snapshot(), before);
});

test("hwItemSave: เพดานราคา 1e7 และทศนิยม 2 ตำแหน่งผ่าน", async () => {
  fresh(seed());
  assert.equal((await call("hwItemSave", item({ price: 10000000 }), ROOT)).code, 200);
  fresh(seed());
  assert.equal((await call("hwItemSave", item({ price: 0.07 }), ROOT)).code, 200);
  assert.equal(doc().value[3].price, "0.07");
});

// ── ③ จัดเรียง ─────────────────────────────────────────────────────────────
test("hwArrange: เรียง value ใหม่ (แถวคงเนื้อเดิม) · ไม่ครบ/เกิน/ซ้ำ ปัด", async () => {
  fresh(seed());
  const r = await call("hwArrange", { orderedIds: ["h3", "h1", "h2"] }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 3);
  assert.deepEqual(doc().value.map((x) => x.id), ["h3", "h1", "h2"]);
  assert.equal(doc().value[1].extra, "keep");
  assert.deepEqual(doc().admin, ["adminUidA", "adminUidB"]);
  assert.deepEqual(logs()[0][1].before, ["h1", "h2", "h3"]);
  fresh(seed());
  const before = snapshot();
  assert.equal((await call("hwArrange", { orderedIds: ["h3", "h1"] }, ROOT)).body.error, "arrange_mismatch");
  assert.equal((await call("hwArrange", { orderedIds: ["h3", "h1", "h2", "h9"] }, ROOT)).body.error, "arrange_mismatch");
  assert.equal((await call("hwArrange", { orderedIds: ["h3", "h1", "h9"] }, ROOT)).code, 409);
  assert.equal((await call("hwArrange", { orderedIds: ["h1", "h1", "h2"] }, ROOT)).code, 400);
  assert.equal((await call("hwArrange", { orderedIds: "h1" }, ROOT)).code, 400);
  assert.equal((await call("hwArrange", { orderedIds: ["h3", "h1", "h2"] }, WATCH)).body.error, "root_required");
  assert.equal(snapshot(), before);
});

test("hwCategoryArrange: เรียงหมวด · ไม่ตรง 409", async () => {
  fresh(seed());
  const r = await call("hwCategoryArrange", { orderedIds: ["c3", "c1", "c2"] }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(doc().categories.map((c) => c.id), ["c3", "c1", "c2"]);
  assert.deepEqual(doc().value, hw().value, "แถวสินค้าไม่แตะ");
  fresh(seed());
  assert.equal((await call("hwCategoryArrange", { orderedIds: ["c1", "c2"] }, ROOT)).body.error, "arrange_mismatch");
  assert.equal(logs().length, 0);
});

// ── ④ หมวด ─────────────────────────────────────────────────────────────────
test("hwCategorySave: สร้าง (doc ไม่มี categories ก็ได้) · แก้ · 404 · 400", async () => {
  fresh(seed({ categories: undefined }));
  delete mem.store.get("admin/hardware").categories;
  const r = await call("hwCategorySave", { name: " ลิ้นชัก ", active: true }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.deepEqual(doc().categories, [{ id: r.body.id, name: "ลิ้นชัก", active: true }]);
  assert.equal(doc().value.length, 3);
  fresh(seed());
  const u = await call("hwCategorySave", { id: "c2", name: "วัสดุสิ้นเปลือง", active: true }, ROOT);
  assert.deepEqual(u.body, { ok: true, id: "c2", created: false });
  assert.deepEqual(doc().categories[1], { id: "c2", name: "วัสดุสิ้นเปลือง", active: true });
  assert.equal(logs()[0][0], `hardwareCatalogLog/${STAMP}_${ROOT}_categorySave`);
  fresh(seed());
  assert.equal((await call("hwCategorySave", { id: "cx", name: "x", active: true }, ROOT)).body.error, "hw_category_not_found");
  assert.equal((await call("hwCategorySave", { name: "x".repeat(61), active: true }, ROOT)).code, 400);
  assert.equal((await call("hwCategorySave", { name: "x" }, ROOT)).code, 400);
  assert.equal((await call("hwCategorySave", { name: "x", active: true, sort: 1 }, ROOT)).code, 400);
  assert.equal((await call("hwCategorySave", { name: "x", active: true }, WATCH)).code, 403);
  assert.equal(logs().length, 0);
});

test("hwCategoryDelete: มีสินค้าใช้ 409 category_in_use (รวมแถวปิดขาย) · ไม่มี 404 · ว่าง = ลบได้", async () => {
  fresh(seed());
  const before = snapshot();
  const u = await call("hwCategoryDelete", { id: "c2" }, ROOT);
  assert.equal(u.code, 409);
  assert.equal(u.body.error, "category_in_use");
  assert.equal(u.body.count, 1);
  assert.equal((await call("hwCategoryDelete", { id: "cx" }, ROOT)).code, 404);
  assert.equal((await call("hwCategoryDelete", { id: "c3" }, WATCH)).code, 403);
  assert.equal((await call("hwCategoryDelete", {}, ROOT)).code, 400);
  assert.equal(snapshot(), before);
  const r = await call("hwCategoryDelete", { id: "c3" }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(doc().categories.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(doc().admin, ["adminUidA", "adminUidB"]);
  assert.equal(logs()[0][1].after, null);
});

// ── ⑤ ค่าส่ง ───────────────────────────────────────────────────────────────
test("hwShippingSave: เก็บ {fee, freeFrom} · null = ไม่มีส่งฟรี · ผิดรูป 400 · watcher 403 · doc หาย 503", async () => {
  fresh(seed());
  const r = await call("hwShippingSave", { fee: 80, freeFrom: 3000 }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.shipping, { fee: 80, freeFrom: 3000, isDefault: false });
  assert.deepEqual(doc().shipping, { fee: 80, freeFrom: 3000 });
  assert.deepEqual(doc().value, hw().value);
  assert.deepEqual(doc().admin, ["adminUidA", "adminUidB"]);
  assert.equal(logs()[0][1].before, null);
  fresh(seed({ shipping: { fee: 80, freeFrom: 3000 } }));
  const n = await call("hwShippingSave", { fee: 0, freeFrom: null }, ROOT);
  assert.deepEqual(n.body.shipping, { fee: 0, freeFrom: null, isDefault: false });
  assert.deepEqual(logs()[0][1].before, { fee: 80, freeFrom: 3000 });
  fresh(seed());
  const before = snapshot();
  for (const b of [{ fee: -1, freeFrom: null }, { fee: 100001, freeFrom: null }, { fee: 10.5, freeFrom: null }, { fee: 100 }, { fee: 100, freeFrom: 10000001 }, { fee: 100, freeFrom: "4000" }, { fee: 100, freeFrom: null, x: 1 }]) {
    assert.equal((await call("hwShippingSave", b, ROOT)).code, 400, JSON.stringify(b));
  }
  assert.equal((await call("hwShippingSave", { fee: 100, freeFrom: null }, WATCH)).code, 403);
  assert.equal((await call("hwShippingSave", { fee: 100, freeFrom: null }, OUT)).body.error, "office_no_access");
  assert.equal(snapshot(), before);
  fresh({ "watcher/roster": roster });
  assert.equal((await call("hwShippingSave", { fee: 100, freeFrom: null }, ROOT)).code, 503);
  assert.equal(logs().length, 0);
});

test("ทุกการเขียน: watcher 403 root_required · คนนอก 403 · ไม่เขียนอะไร", async () => {
  fresh(seed());
  const before = snapshot();
  const writes = [
    ["hwItemSave", item()], ["hwArrange", { orderedIds: ["h1", "h2", "h3"] }], ["hwCategorySave", { name: "x", active: true }],
    ["hwCategoryArrange", { orderedIds: ["c1", "c2", "c3"] }], ["hwCategoryDelete", { id: "c3" }], ["hwShippingSave", { fee: 1, freeFrom: null }],
  ];
  for (const [name, body] of writes) {
    assert.equal((await call(name, body, WATCH)).body.error, "root_required", name);
    assert.equal((await call(name, body, OUT)).body.error, "office_no_access", name);
    assert.equal((await call(name, body, null)).code, 401, name);
  }
  assert.equal(snapshot(), before);
  assert.equal(mem.ops.update + mem.ops.create + mem.ops.set, 0);
});

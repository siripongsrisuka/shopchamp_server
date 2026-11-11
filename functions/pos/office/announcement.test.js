// เทส pos/office/announcement.js — หน้า "ประกาศถึงร้าน" ของ shopchampoffice (DEV-0003 0e)
//   ① annSave: สร้าง (id = clientRequestId · กดซ้ำไม่เขียนซ้ำ · คนอื่นใช้ id เดิม = 409) · แก้ (kind ล็อก · ยกเลิกแล้ว 409) · รูปผิด 400 · ประเภทร้านต้องมีอยู่
//   ② annList: แยกแท็บ · สถานะตามเวลา · ตัวนับ · สถิติจาก seen · canEdit
//   ③ annCancel: ชั่วคราว → cancelled · ถาวร → active false · ซ้ำ = already
//   ④ ประเภทร้าน: สร้าง (order ต่อท้าย) · ชื่อซ้ำ 409 · ลบเมื่อไม่มีใครใช้ (ร้าน/ประกาศที่ยังแสดง = 409) · ติดป้ายร้าน · หาร้านด้วยเลขร้าน
//   ⑤ ทุกการเขียน: officeAudit ใน transaction เดียว · watcher 403 ไม่เขียน · ช่องเกิน 400
//   รัน: node --test functions/pos/office/announcement.test.js (จาก shopchamp_server) · ❌ ไม่แตะ Firestore จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { install, makeRes } = require("../announcement/_testDb");

const ROOT = "rootUid000000000000000001";
const WATCH = "watchUid00000000000000001";
const OUT = "outUid0000000000000000001";
const NOW = new Date("2026-11-11T03:00:00.000Z");
const IMG = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/announcement%2F202611%2Fa.jpg?alt=media";
const roster = {
  uids: [ROOT, WATCH], rootUids: [ROOT],
  people: [{ uid: ROOT, email: "root@shopchamp.test", name: "Root", level: "root" }, { uid: WATCH, email: "watch@shopchamp.test", name: "Watch", level: "watcher" }],
  count: 2, rootCount: 1, rosterSha: "a".repeat(64), via: "center-script",
};
const actor = { uid: ROOT, email: "root@shopchamp.test", name: "Root" };
const audience = (shops, people = "all") => ({ people, shops: { shopIds: [], plans: { has: [], missing: [] }, categoryIds: [], ...shops } });
const camp = (over) => ({
  kind: "campaign", title: "ข่าว", body: "", images: [], buttonText: "", buttonUrl: "", channels: { banner: true, popup: true, inbox: true }, bannerSticky: false,
  audience: audience({ mode: "all" }), startAt: new Date("2026-11-10T00:00:00Z"), endAt: new Date("2026-11-20T00:00:00Z"), status: "live",
  createdBy: actor, createdAt: new Date("2026-11-09T00:00:00Z"), updatedAt: new Date("2026-11-09T00:00:00Z"), ...(over || {}),
});
const ever = (over) => ({ ...camp(), startAt: undefined, endAt: undefined, status: undefined, kind: "evergreen", trigger: { type: "newShop", days: 30 }, active: true, ...(over || {}) });

let M;
let mem;
function fresh(seed) {
  const s = { "watcher/roster": roster, ...(seed || {}) };
  mem = install(s, [path.join(__dirname, "announcement.js")], () => NOW);
  M = require("./announcement");
}
async function call(fn, uid, body) {
  const res = makeRes();
  await M[fn]({ now: () => NOW })({ body, ...(uid ? { auth: { uid, email: uid === ROOT ? "root@shopchamp.test" : "x@shopchamp.test" } } : {}) }, res);
  return res;
}
const audits = () => [...mem.store.entries()].filter(([k]) => k.startsWith("officeAudit/")).map(([, v]) => v);
const saveBody = (over) => ({
  clientRequestId: "req-0000000001", kind: "campaign", title: " ข่าวใหม่ ", body: "สวัสดี {ชื่อร้าน}", images: [IMG], buttonText: "ดู", buttonUrl: "https://shopchamp.co",
  channels: { banner: true, popup: true }, bannerSticky: true, audience: { people: "owner", shops: { mode: "list", shopIds: ["wJNgra1ik0pzRQFlZNOD"] } },
  startAt: "2026-11-11T00:00:00.000Z", endAt: "2026-11-30T00:00:00.000Z", ...(over || {}),
});

test("annSave สร้าง → doc id = clientRequestId · รูปเต็ม · audit · กดซ้ำไม่เขียนซ้ำ", async () => {
  fresh();
  const r = await call("annSave", ROOT, saveBody());
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, id: "req-0000000001", created: true });
  const d = mem.store.get("announcement/req-0000000001");
  assert.equal(d.title, "ข่าวใหม่");
  assert.equal(d.status, "live");
  assert.deepEqual(d.channels, { banner: true, popup: true, inbox: false });
  assert.deepEqual(d.audience.shops, { mode: "list", shopIds: ["wJNgra1ik0pzRQFlZNOD"], plans: { has: [], missing: [] }, categoryIds: [] });
  assert.ok(d.startAt instanceof Date && d.createdAt instanceof Date);
  assert.deepEqual(d.createdBy, actor);
  assert.equal(audits().length, 1);
  assert.equal(audits()[0].action, "ann.create");
  const again = await call("annSave", ROOT, saveBody());
  assert.deepEqual(again.body, { ok: true, id: "req-0000000001", created: false });
  assert.equal(audits().length, 1, "กดซ้ำไม่เขียน");
});

test("annSave: id ที่คนอื่นสร้างไว้ = 409 request_id_taken · ประเภทร้านไม่มี = 409 · รูปผิด/ช่องเกิน = 400 · watcher 403", async () => {
  fresh({ "announcement/req-0000000001": camp({ createdBy: { uid: "other", email: "", name: "" } }) });
  assert.equal((await call("annSave", ROOT, saveBody())).body.error, "request_id_taken");
  fresh();
  const cat = await call("annSave", ROOT, saveBody({ audience: { people: "all", shops: { mode: "filter", categoryIds: ["nope"] } } }));
  assert.equal(cat.code, 409);
  assert.equal(cat.body.error, "ann_category_not_found");
  for (const b of [saveBody({ images: ["https://evil.example/a.jpg"] }), saveBody({ passkey: {} }), saveBody({ endAt: "2026-11-01T00:00:00Z", startAt: "2026-10-01T00:00:00Z" }), "x"]) {
    const r = await call("annSave", ROOT, b);
    assert.equal(r.code, 400);
    assert.equal(r.body.error, "invalid_request");
  }
  assert.equal((await call("annSave", WATCH, saveBody())).body.error, "root_required");
  assert.equal((await call("annSave", OUT, saveBody())).body.error, "office_no_access");
  assert.equal((await call("annSave", null, saveBody())).code, 401);
  assert.equal(mem.writes.length, 0);
});

test("annSave แก้: ทับช่องเนื้อหา คง createdBy · เปลี่ยน kind 409 · ยกเลิกแล้ว 409 · ไม่มี 404 · ถาวรเปิดกลับล้างรอยยกเลิก", async () => {
  fresh({ "announcement/a1": camp(), "announcement/a2": camp({ status: "cancelled" }), "announcement/e1": ever({ active: false, cancelledAt: NOW }) });
  const b = saveBody({ id: "a1", title: "แก้แล้ว" });
  delete b.clientRequestId;
  const r = await call("annSave", ROOT, b);
  assert.deepEqual(r.body, { ok: true, id: "a1", created: false });
  const d = mem.store.get("announcement/a1");
  assert.equal(d.title, "แก้แล้ว");
  assert.deepEqual(d.createdBy, actor);
  assert.deepEqual(d.updatedBy, actor);
  assert.equal((await call("annSave", ROOT, { ...b, id: "a2" })).body.error, "announcement_cancelled");
  assert.equal((await call("annSave", ROOT, { ...b, id: "zz" })).body.error, "announcement_not_found");
  const eb = { id: "a1", kind: "evergreen", title: "x", channels: { inbox: true }, audience: { people: "all", shops: { mode: "all" } }, trigger: { type: "newShop" } };
  assert.equal((await call("annSave", ROOT, eb)).body.error, "kind_locked");
  const re = await call("annSave", ROOT, { ...eb, id: "e1", active: true });
  assert.equal(re.code, 200, JSON.stringify(re.body));
  assert.equal(mem.store.get("announcement/e1").active, true);
  assert.equal(mem.store.get("announcement/e1").cancelledAt, null);
});

test("annList: แยกแท็บ · สถานะตามเวลา · ตัวนับ · สถิติจาก seen (ถาวรนับช่องบนสุด) · watcher canEdit false", async () => {
  fresh({
    "announcement/a1": camp(),
    "announcement/a1/seen/u1": { readAt: NOW, popupSeenAt: NOW },
    "announcement/a1/seen/u2": { popupSeenAt: NOW, bannerViews: 2 },
    "announcement/a2": camp({ startAt: new Date("2026-12-01T00:00:00Z"), endAt: new Date("2026-12-10T00:00:00Z"), status: "scheduled", createdAt: new Date("2026-11-10T00:00:00Z") }),
    "announcement/a3": camp({ status: "live", endAt: new Date("2026-11-10T12:00:00Z"), createdAt: new Date("2026-11-08T00:00:00Z") }),
    "announcement/a4": camp({ status: "cancelled", createdAt: new Date("2026-11-07T00:00:00Z") }),
    "announcement/e1": ever(),
  });
  const r = await call("annList", WATCH, { kind: "campaign" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.canEdit, false);
  assert.deepEqual(r.body.items.map((x) => [x.id, x.status]), [["a2", "scheduled"], ["a1", "live"], ["a3", "ended"], ["a4", "cancelled"]]);
  assert.deepEqual(r.body.counts, { campaign: 4, evergreen: 1, all: 4, live: 1, scheduled: 1, ended: 1, cancelled: 1 });
  assert.deepEqual(r.body.items[1].stats, { read: 1, popupSeen: 2 });
  assert.equal(r.body.items[1].startAt, "2026-11-10T00:00:00.000Z");
  assert.equal(r.body.items[1].seen, undefined);
  const e = await call("annList", ROOT, { kind: "evergreen" });
  assert.equal(e.body.canEdit, true);
  assert.deepEqual(e.body.items.map((x) => [x.id, x.status, x.active, x.startAt]), [["e1", "live", true, null]]);
  assert.equal((await call("annList", ROOT, {})).code, 400);
  assert.equal((await call("annList", OUT, { kind: "campaign" })).body.error, "office_no_access");
});

test("annCancel: ชั่วคราว → status cancelled · ถาวร → active false · ซ้ำ = already ไม่เขียน", async () => {
  fresh({ "announcement/a1": camp(), "announcement/e1": ever() });
  assert.deepEqual((await call("annCancel", ROOT, { id: "a1" })).body, { ok: true, id: "a1", status: "cancelled", already: false });
  assert.equal(mem.store.get("announcement/a1").status, "cancelled");
  assert.deepEqual(mem.store.get("announcement/a1").cancelledBy, actor);
  await call("annCancel", ROOT, { id: "e1" });
  assert.equal(mem.store.get("announcement/e1").active, false);
  const n = mem.writes.length;
  assert.equal((await call("annCancel", ROOT, { id: "a1" })).body.already, true);
  assert.equal(mem.writes.length, n);
  assert.equal((await call("annCancel", ROOT, { id: "zz" })).body.error, "announcement_not_found");
  assert.equal((await call("annCancel", WATCH, { id: "e1" })).body.error, "root_required");
  assert.equal(audits().filter((a) => a.action === "ann.cancel").length, 2);
});

test("ประเภทร้าน: สร้าง (order ต่อท้าย) · ชื่อซ้ำ 409 · แก้ · list พร้อมตัวนับ · ลบเมื่อไม่มีใครใช้", async () => {
  fresh({ "shopCategory/c1": { name: "กาแฟ", order: 0, active: true }, "shopCategoryTag/s1": { categoryIds: ["c1"], updatedAt: NOW } });
  const c = await call("annCategorySave", ROOT, { name: " ร้านอาหาร ", active: true });
  assert.equal(c.body.created, true);
  const made = mem.store.get(`shopCategory/${c.body.id}`);
  assert.deepEqual({ name: made.name, order: made.order, active: made.active }, { name: "ร้านอาหาร", order: 1, active: true });
  assert.equal((await call("annCategorySave", ROOT, { name: "กาแฟ ", active: true })).body.error, "duplicate_name");
  assert.equal((await call("annCategorySave", ROOT, { id: "c1", name: "กาแฟสด", active: false })).body.created, false);
  assert.equal(mem.store.get("shopCategory/c1").name, "กาแฟสด");
  assert.equal((await call("annCategorySave", ROOT, { id: "zz", name: "x", active: true })).body.error, "ann_category_not_found");
  const l = await call("annCategoryList", WATCH, {});
  assert.deepEqual(l.body.categories.map((x) => [x.name, x.count]), [["กาแฟสด", 1], ["ร้านอาหาร", 0]]);
  const inUse = await call("annCategoryDelete", ROOT, { id: "c1" });
  assert.equal(inUse.code, 409);
  assert.deepEqual([inUse.body.error, inUse.body.shops, inUse.body.announcements], ["category_in_use", 1, 0]);
  assert.deepEqual((await call("annCategoryDelete", ROOT, { id: c.body.id })).body, { ok: true, id: c.body.id, deleted: true });
  assert.equal(mem.store.has(`shopCategory/${c.body.id}`), false);
});

test("ลบประเภท: ประกาศที่ยังแสดงใช้อยู่ = 409 · ใบที่จบ/ยกเลิกแล้วไม่กันลบ", async () => {
  const f = audience({ mode: "filter", categoryIds: ["c1"] });
  fresh({ "shopCategory/c1": { name: "กาแฟ", order: 0, active: true }, "announcement/a1": camp({ audience: f }) });
  assert.equal((await call("annCategoryDelete", ROOT, { id: "c1" })).body.announcements, 1);
  fresh({ "shopCategory/c1": { name: "กาแฟ", order: 0, active: true }, "announcement/a1": camp({ audience: f, status: "cancelled" }), "announcement/a2": camp({ audience: f, endAt: new Date("2026-11-10T12:00:00Z") }), "announcement/e1": ever({ audience: f, active: false }) });
  assert.equal((await call("annCategoryDelete", ROOT, { id: "c1" })).code, 200);
});

test("annShopFind: เลขร้านตัวเลข/ข้อความ · รหัส doc ตรงตัว · ป้ายประเภท · annShopTagSet เขียนป้าย + audit", async () => {
  fresh({
    "shop/wJNgra1ik0pzRQFlZNOD": { name: "TEST Shopchamp", scShopId: 57325 },
    "shop/s2": { name: "ร้านข้อความ", scShopId: "57325" },
    "shopCategory/c1": { name: "กาแฟ", order: 0, active: false },
    "shopCategoryTag/s2": { categoryIds: ["c1"] },
  });
  const f = await call("annShopFind", WATCH, { q: " 57325 " });
  assert.deepEqual(f.body.shops, [{ shopId: "wJNgra1ik0pzRQFlZNOD", scShopId: 57325, name: "TEST Shopchamp", categoryIds: [] }, { shopId: "s2", scShopId: "57325", name: "ร้านข้อความ", categoryIds: ["c1"] }]);
  assert.equal((await call("annShopFind", WATCH, { q: "wJNgra1ik0pzRQFlZNOD" })).body.shops.length, 1);
  assert.equal((await call("annShopFind", WATCH, { q: "ไม่มี" })).body.shops.length, 0);
  const t = await call("annShopTagSet", ROOT, { shopId: "wJNgra1ik0pzRQFlZNOD", categoryIds: ["c1"] });
  assert.deepEqual(t.body, { ok: true, shopId: "wJNgra1ik0pzRQFlZNOD", categoryIds: ["c1"] });
  assert.deepEqual(mem.store.get("shopCategoryTag/wJNgra1ik0pzRQFlZNOD").categoryIds, ["c1"]);
  assert.equal(audits()[0].action, "ann.shop.tag");
  assert.equal((await call("annShopTagSet", ROOT, { shopId: "nope", categoryIds: [] })).body.error, "shop_not_found");
  assert.equal((await call("annShopTagSet", ROOT, { shopId: "s2", categoryIds: ["zz"] })).body.error, "ann_category_not_found");
  assert.equal((await call("annShopTagSet", ROOT, { shopId: "s2", categoryIds: ["c1", "c1"] })).code, 400);
  assert.equal((await call("annShopTagSet", WATCH, { shopId: "s2", categoryIds: [] })).body.error, "root_required");
});

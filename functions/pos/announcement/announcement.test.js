// เทส pos/announcement/{feed,seen}.js — แอปอ่าน/บันทึกประกาศถึงร้าน (DEV-0003 0e)
//   ① feed: คัดร้าน (all/list/filter แพ็กเกจ+ประเภทจาก shopCategoryTag) · คัดคน (เจ้าของ/ทุกคน) · ช่องตาม seen · ถาวรต่อรอบ + แทนข้อความ
//           ซื้อแพ็กเกจ (fulfilledAt ก่อน timestamp) · ไม่อ่าน packageOrder เมื่อไม่มีประกาศ purchased · watcher อ่านได้แต่ไม่เห็น
//   ② seen: ครั้งแรกเท่านั้น · ถาวรต่อรอบ + ช่องบนสุด · ไม่เห็น = 404 · bannerView +1 เฉพาะแบนเนอร์ที่เห็นจริง · watcher 403
//   ③ ครบวง: เห็นแบนเนอร์ 3 ครั้ง → หาย · อ่าน → unreadCount ลด · ปิดป๊อปอัป → ไม่ขึ้นอีก
//   รัน: node --test functions/pos/announcement/announcement.test.js (จาก shopchamp_server) · ❌ ไม่แตะ Firestore จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { install, makeRes } = require("./_testDb");

const NOW = new Date("2026-11-11T03:00:00.000Z"); // 10:00 ไทย
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const OWNER = "oZlTxlxRjaRdmMoH4aXOORiBBK73";
const STAFF = "staffUid0000000000000001";
const actor = { uid: "rootUid000000000000000001", email: "root@shopchamp.test", name: "Root" };
const aud = (shops, people = "all") => ({ people, shops: { shopIds: [], plans: { has: [], missing: [] }, categoryIds: [], ...shops } });
const camp = (over) => ({
  kind: "campaign", title: "สวัสดี {ชื่อร้าน}", body: "เนื้อหา", images: ["https://x/a.jpg"], buttonText: "", buttonUrl: "", channels: { banner: true, popup: true, inbox: true }, bannerSticky: false,
  audience: aud({ mode: "all" }), startAt: new Date("2026-11-10T00:00:00Z"), endAt: new Date("2026-11-20T00:00:00Z"), status: "live",
  createdBy: actor, createdAt: new Date("2026-11-09T00:00:00Z"), updatedAt: new Date("2026-11-09T00:00:00Z"), ...(over || {}),
});
const ever = (trigger, over) => {
  const a = { ...camp({ title: "{แพ็กเกจ} หมด {วันหมดอายุ} เหลือ {เหลือวัน} วัน" }), kind: "evergreen", trigger, active: true, createdAt: new Date("2026-10-01T00:00:00Z"), ...(over || {}) };
  delete a.startAt; delete a.endAt; delete a.status;
  return a;
};
const shop = (over) => ({
  name: "TEST Shopchamp", scShopId: 57325, dateTime: new Date("2026-11-01T02:00:00Z"),
  humanResource: [{ id: OWNER, position: ["001"], status: "active" }, { id: STAFF, position: ["002"], status: "active" }],
  vip: [{ type: "premium", expire: new Date("2026-11-15T10:00:00Z") }, { type: "staff", expire: new Date("2010-12-31T17:00:00Z") }],
  ...(over || {}),
});

let F;
let Sn;
let mem;
function fresh(seed) {
  mem = install({ [`shop/${SHOP}`]: shop(), ...(seed || {}) }, [path.join(__dirname, "feed.js"), path.join(__dirname, "seen.js")], () => NOW);
  F = require("./feed");
  Sn = require("./seen");
}
const access = (uid, extra) => ({ shopAccess: { shopId: SHOP, uid, role: uid === OWNER ? "owner" : "staff", rights: [], ...(extra || {}) } });
async function feed(uid = OWNER, extra) {
  const res = makeRes();
  await F.feed({ now: () => NOW })({ body: { shopId: SHOP }, ...access(uid, extra) }, res);
  return res;
}
async function seen(body, uid = OWNER, extra) {
  const res = makeRes();
  await Sn.seen({ now: () => NOW })({ body: { shopId: SHOP, ...body }, ...access(uid, extra) }, res);
  return res;
}
const ids = (list) => list.map((x) => x.id);

test("feed: คัดร้าน all/list/filter · คัดคน · ข้อความแทนแล้ว · ยกเลิก/ยังไม่ถึงเวลา/ร้านอื่น ไม่ขึ้น", async () => {
  fresh({
    "announcement/all": camp(),
    "announcement/list": camp({ audience: aud({ mode: "list", shopIds: [SHOP] }), startAt: new Date("2026-11-10T01:00:00Z") }),
    "announcement/other": camp({ audience: aud({ mode: "list", shopIds: ["s2"] }) }),
    "announcement/owner": camp({ audience: aud({ mode: "all" }, "owner"), startAt: new Date("2026-11-10T02:00:00Z") }),
    "announcement/prem": camp({ audience: aud({ mode: "filter", plans: { has: ["premium"], missing: ["staff"] } }), startAt: new Date("2026-11-10T03:00:00Z") }),
    "announcement/staffpkg": camp({ audience: aud({ mode: "filter", plans: { has: ["staff"] } }) }),
    "announcement/cat": camp({ audience: aud({ mode: "filter", categoryIds: ["c1"] }), startAt: new Date("2026-11-10T04:00:00Z") }),
    "announcement/cat2": camp({ audience: aud({ mode: "filter", categoryIds: ["c2"] }) }),
    "announcement/cancel": camp({ status: "cancelled" }),
    "announcement/later": camp({ startAt: new Date("2026-11-12T00:00:00Z") }),
    ["shopCategoryTag/" + SHOP]: { categoryIds: ["c1"] },
  });
  const r = await feed();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(ids(r.body.inbox), ["cat", "prem", "owner", "list", "all"]);
  assert.deepEqual(ids(r.body.banners), ids(r.body.inbox));
  assert.equal(r.body.unreadCount, 5);
  assert.equal(r.body.inbox[0].title, "สวัสดี TEST Shopchamp");
  assert.deepEqual(Object.keys(r.body.inbox[0]).sort(), ["bannerSticky", "body", "buttonText", "buttonUrl", "cycleKey", "endAt", "id", "images", "kind", "readAt", "startAt", "title"]);
  const s = await feed(STAFF);
  assert.deepEqual(ids(s.body.inbox), ["cat", "prem", "list", "all"], "พนักงานไม่เห็นใบเจ้าของ");
  const w = await feed("watchUid00000000000000001", { watcher: true, readOnly: true, role: "owner" });
  assert.equal(w.code, 200);
  assert.deepEqual(w.body.inbox, [], "ทีมงานไม่มีแถวในร้าน = ไม่เห็น");
});

test("feed: seen ตัดช่อง — อ่านแล้วแบนเนอร์หาย · เห็นครบ 3 หาย · ปัก = ไม่หาย · ป๊อปอัปครั้งเดียว · หมดเวลาเหลือกล่องข่าว", async () => {
  fresh({
    "announcement/a": camp(),
    ["announcement/a/seen/" + OWNER]: { readAt: NOW },
    "announcement/b": camp({ bannerSticky: true }),
    ["announcement/b/seen/" + OWNER]: { readAt: NOW, bannerViews: 5, popupSeenAt: NOW },
    "announcement/c": camp(),
    ["announcement/c/seen/" + OWNER]: { bannerViews: 3 },
    "announcement/d": camp({ endAt: new Date("2026-11-11T00:00:00Z") }),
  });
  const r = await feed();
  assert.deepEqual(ids(r.body.banners).sort(), ["b"]);
  assert.deepEqual(ids(r.body.popups).sort(), ["a", "c"]);
  assert.deepEqual(ids(r.body.inbox).sort(), ["a", "b", "c", "d"]);
  assert.equal(r.body.unreadCount, 2);
  assert.equal(r.body.inbox.find((x) => x.id === "a").readAt, NOW.toISOString());
});

test("feed ถาวร: แพ็กเกจใกล้หมด · ร้านใหม่ · รอบใหม่ป๊อปอัปขึ้นใหม่ · ไม่อ่าน packageOrder ถ้าไม่มีใบ purchased", async () => {
  fresh({
    "announcement/end": ever({ type: "packageEnding", days: 7, plan: "any" }),
    ["announcement/end/seen/" + OWNER]: { cycles: { "packageEnding:any:premium:2026-10-15": { popupSeenAt: NOW } } },
    "announcement/new": ever({ type: "newShop", days: 30 }, { title: "ยินดีต้อนรับ {ชื่อร้าน}" }),
    "announcement/exp": ever({ type: "packageExpired", days: 30, plan: "staff" }),
    "announcement/off": ever({ type: "newShop", days: 30 }, { active: false }),
  });
  const r = await feed();
  assert.deepEqual(ids(r.body.inbox).sort(), ["end", "new"]);
  const end = r.body.popups.find((x) => x.id === "end");
  assert.equal(end.cycleKey, "packageEnding:any:premium:2026-11-15");
  assert.equal(end.title, "พรีเมี่ยม หมด 15 พ.ย. 2569 เหลือ 4 วัน");
  assert.equal(end.startAt, null);
  assert.equal(r.body.inbox.find((x) => x.id === "new").title, "ยินดีต้อนรับ TEST Shopchamp");
  assert.equal(mem.writes.length, 0, "feed ไม่เขียน");
});

test("feed ถาวร purchased: เวลาใบ = fulfilledAt ก่อน timestamp · ชื่อแพ็กเกจจาก admin/package · ใบไม่ success ไม่นับ", async () => {
  const pkg = { value: [{ name: "พรีเมี่ยม", type: "premium", status: true, price: [{ id: "1", price: 299, save: 0, day: "1 เดือน" }] }] };
  const order = (over) => ({ shopId: SHOP, status: "success", packageId: ["1"], timestamp: new Date("2026-10-01T00:00:00Z"), ...(over || {}) });
  const a = ever({ type: "purchased", days: 7 }, { title: "ขอบคุณที่ซื้อ {แพ็กเกจ} ใช้ได้ถึง {วันหมดอายุ}" });
  fresh({ "announcement/p": a, "admin/package": pkg, "packageOrder/o1": order({ fulfilledAt: new Date("2026-11-09T00:00:00Z") }), "packageOrder/o2": order({ status: "order", timestamp: new Date("2026-11-10T00:00:00Z") }) });
  const r = await feed();
  assert.equal(r.body.inbox.length, 1, JSON.stringify(r.body));
  assert.equal(r.body.inbox[0].title, "ขอบคุณที่ซื้อ พรีเมี่ยม ใช้ได้ถึง 15 พ.ย. 2569");
  assert.equal(r.body.inbox[0].cycleKey, `purchased:${Date.parse("2026-11-09T00:00:00Z")}`);
  // care อนุมัติ (ไม่มี fulfilledAt) = ใช้ timestamp · เก่ากว่า 7 วัน = ไม่เข้า
  fresh({ "announcement/p": a, "admin/package": pkg, "packageOrder/o1": order() });
  assert.equal((await feed()).body.inbox.length, 0);
  fresh({ "announcement/p": a, "admin/package": pkg, "packageOrder/o1": order({ timestamp: new Date("2026-11-08T00:00:00Z") }) });
  assert.equal((await feed()).body.inbox.length, 1);
});

test("feed: shopId ไม่ตรงร้านที่ผ่านด่าน 403 · ช่องเกิน 400 · ไม่มี shopAccess 401", async () => {
  fresh();
  const res = makeRes();
  await F.feed({ now: () => NOW })({ body: { shopId: "s2" }, ...access(OWNER) }, res);
  assert.equal(res.body.error, "wrong_shop");
  const r2 = makeRes();
  await F.feed({ now: () => NOW })({ body: { shopId: SHOP, all: true }, ...access(OWNER) }, r2);
  assert.equal(r2.body.error, "invalid_request");
  const r3 = makeRes();
  await F.feed({ now: () => NOW })({ body: { shopId: SHOP } }, r3);
  assert.equal(r3.code, 401);
});

test("seen popup/read: ครั้งแรกเท่านั้น · ไม่เห็น = 404 · watcher 403", async () => {
  fresh({ "announcement/a": camp(), "announcement/o": camp({ audience: aud({ mode: "list", shopIds: ["s2"] }) }) });
  const r = await seen({ kind: "popup", id: "a" });
  assert.deepEqual(r.body, { ok: true, id: "a", kind: "popup", already: false, cycleKey: null });
  assert.equal(mem.store.get(`announcement/a/seen/${OWNER}`).popupSeenAt.getTime(), NOW.getTime());
  const n = mem.writes.length;
  assert.equal((await seen({ kind: "popup", id: "a" })).body.already, true);
  assert.equal(mem.writes.length, n, "ครั้งที่ 2 ไม่เขียน");
  assert.equal((await seen({ kind: "read", id: "a" })).body.already, false);
  assert.equal((await seen({ kind: "read", id: "o" })).body.error, "announcement_not_found");
  assert.equal((await seen({ kind: "read", id: "zz" })).body.error, "announcement_not_found");
  assert.equal((await seen({ kind: "read", id: "a" }, "watchUid00000000000000001", { watcher: true, readOnly: true, role: "owner" })).body.error, "watcher_read_only");
  assert.equal((await seen({ kind: "like", id: "a" })).code, 400);
});

test("seen ถาวร: เขียนต่อรอบที่ server คิดเอง (ไม่เชื่อ cycleKey ของแอป) + ช่องบนสุดครั้งแรก", async () => {
  fresh({ "announcement/e": ever({ type: "packageEnding", days: 7 }), ["announcement/e/seen/" + OWNER]: { popupSeenAt: new Date("2026-10-01T00:00:00Z") } });
  const r = await seen({ kind: "popup", id: "e", cycleKey: "ของแอป" });
  assert.equal(r.body.cycleKey, "packageEnding:any:premium:2026-11-15");
  const d = mem.store.get(`announcement/e/seen/${OWNER}`);
  assert.equal(d.cycles["packageEnding:any:premium:2026-11-15"].popupSeenAt.getTime(), NOW.getTime());
  assert.equal(d.popupSeenAt.getTime(), Date.parse("2026-10-01T00:00:00Z"), "ช่องบนสุดคงครั้งแรก");
  assert.equal((await seen({ kind: "popup", id: "e" })).body.already, true);
  // ร้านไม่เข้าเงื่อนไขแล้ว = 404
  fresh({ "announcement/e": ever({ type: "packageEnding", days: 2 }) });
  assert.equal((await seen({ kind: "read", id: "e" })).body.error, "announcement_not_found");
});

test("seen bannerView: +1 เฉพาะแบนเนอร์ที่เห็นจริง · ซ้ำตัดทิ้ง · ไม่มีอะไรนับ = ไม่เขียน", async () => {
  fresh({ "announcement/a": camp(), "announcement/i": camp({ channels: { inbox: true } }), "announcement/e": ever({ type: "newShop", days: 30 }) });
  const r = await seen({ kind: "bannerView", ids: ["a", "a", "i", "zz", "e"] });
  assert.deepEqual(r.body, { ok: true, kind: "bannerView", counted: 2 });
  assert.equal(mem.store.get(`announcement/a/seen/${OWNER}`).bannerViews, 1);
  assert.equal(mem.store.get(`announcement/e/seen/${OWNER}`).cycles.newShop.bannerViews, 1);
  assert.equal(mem.store.has(`announcement/i/seen/${OWNER}`), false);
  const n = mem.writes.length;
  assert.equal((await seen({ kind: "bannerView", ids: ["i"] })).body.counted, 0);
  assert.equal(mem.writes.length, n);
  assert.equal((await seen({ kind: "bannerView", ids: [] })).code, 400);
});

test("ครบวง: เข้าหน้าแรก 3 ครั้ง → แบนเนอร์หาย · ปิดป๊อปอัป → ไม่ขึ้นอีก · อ่าน → unreadCount ลด", async () => {
  fresh({ "announcement/a": camp() });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(ids((await feed()).body.banners), ["a"], `รอบ ${i + 1}`);
    await seen({ kind: "bannerView", ids: ["a"] });
  }
  let r = await feed();
  assert.deepEqual(r.body.banners, []);
  assert.deepEqual(ids(r.body.popups), ["a"]);
  await seen({ kind: "popup", id: "a" });
  r = await feed();
  assert.deepEqual(r.body.popups, []);
  assert.equal(r.body.unreadCount, 1);
  await seen({ kind: "read", id: "a" });
  r = await feed();
  assert.equal(r.body.unreadCount, 0);
  assert.deepEqual(ids(r.body.inbox), ["a"]);
});

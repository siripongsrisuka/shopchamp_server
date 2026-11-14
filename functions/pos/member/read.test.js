// เทส DEV-0010 · member.indexSync member.list member.get member.paidHistory (pos/member/read.js) + staff.profiles (pos/shopStaff/staffProfiles.js)
//   รัน: node --test pos/member/read.test.js
//   ฐานปลอมทำตัวแบบ Firestore ในส่วนที่ handler พึ่ง: where == / in / > / >= · orderBy(updateTime, __name__) / orderBy(__name__)
//   · startAfter · limit · select · Timestamp ละเอียดนาโนวินาที (harness ของสัญญาไม่เรียง/ไม่ startAfter ⇒ การแบ่งหน้าจริงพิสูจน์ที่นี่)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const CENTER = path.resolve(FUNCTIONS, "..", "..", "shopchamp-center");
const NAMES = ["MemberIndexSyncRequest", "MemberListRequest", "MemberGetRequest", "MemberPaidHistoryRequest", "StaffProfilesRequest"];

// คำขอใหม่ยังไม่อยู่ใน vendor tarball (แม่ bump รวม) ⇒ build จาก src ของ center แล้วเติมเฉพาะตัวที่ขาด
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  if (NAMES.every((n) => pkg[n])) return;
  const src = path.join(CENTER, "packages", "schema", "src", "requests", "memberRead.ts");
  if (!fs.existsSync(src)) throw new Error(`ไม่พบ ${src}`);
  const esbuild = require(require.resolve("esbuild", { paths: [CENTER] }));
  const out = esbuild.buildSync({
    entryPoints: [src], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error",
    nodePaths: [path.join(CENTER, "packages", "schema", "node_modules"), path.join(CENTER, "node_modules")],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  for (const k of NAMES) if (!pkg[k]) pkg[k] = m.exports[k];
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
const key = (v) => {
  if (v instanceof Timestamp) return [v.seconds, v.nanoseconds];
  if (v instanceof Date) { const ms = v.getTime(); const s = Math.floor(ms / 1000); return [s, (ms - s * 1000) * 1e6]; }
  return null;
};
const cmpT = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

let DATA = {};
let READS = 0;
let QUERIES = [];
let WRITES = 0;
function makeDb() {
  const snapOf = (c, id, fields) => {
    const d = (DATA[c] || {})[id];
    let out = d;
    if (d && fields) { out = {}; for (const f of fields) if (d[f] !== undefined) out[f] = d[f]; }
    return { exists: d !== undefined, id, data: () => out };
  };
  const query = (c, st) => ({
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f) => query(c, { ...st, order: [...st.order, f] }),
    startAfter: (...vals) => query(c, { ...st, after: vals }),
    limit: (n) => query(c, { ...st, limit: n }),
    select: (...fields) => query(c, { ...st, select: fields }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let rows = Object.keys(DATA[c] || {}).map((id) => ({ id, d: DATA[c][id] }));
      for (const [f, op, v] of st.filters) {
        rows = rows.filter((r) => {
          const x = r.d[f];
          if (op === "==") return x === v;
          if (op === "in") { assert.ok(Array.isArray(v) && v.length >= 2 && v.length <= 30, "in ต้องมี 2-30 ค่า"); return v.includes(x); }
          if (op === ">" || op === ">=") { const a = key(x), b = key(v); return !!a && !!b && (op === ">" ? cmpT(a, b) > 0 : cmpT(a, b) >= 0); }
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
        if (st.after.length === 2) {
          assert.deepEqual(st.order, ["updateTime", "__name__"]);
          assert.ok(st.after[0] instanceof Timestamp, "cursor ต้องเป็น Timestamp ของ SDK");
          const pivot = { id: st.after[1], d: { updateTime: st.after[0] } };
          rows = rows.filter((r) => cmpRow(r, pivot) > 0);
        } else {
          assert.deepEqual(st.order, ["__name__"]);
          rows = rows.filter((r) => r.id > st.after[0]);
        }
      }
      if (st.limit != null) rows = rows.slice(0, st.limit);
      READS += Math.max(1, rows.length);
      const docs = rows.map((r) => snapOf(c, r.id, st.select));
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  const base = { filters: [], order: [], after: null, limit: null, select: null };
  return {
    collection: (c) => ({
      doc: (id) => ({ id, get: async () => { READS += 1; return snapOf(c, id); }, set: async () => { WRITES += 1; }, update: async () => { WRITES += 1; } }),
      where: (f, op, v) => query(c, { ...base, filters: [[f, op, v]] }),
    }),
    runTransaction: async () => { WRITES += 1; throw new Error("ห้ามเขียน"); },
    batch: () => { WRITES += 1; throw new Error("ห้ามเขียน"); },
  };
}

const NOW = new Date("2026-11-14T05:00:00.000Z");
function load(file, fn) {
  installSchemas();
  const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: { firestore: { Timestamp } } } };
  for (const rel of [file, "../_shared/syncCursor"]) { const abs = require.resolve(rel); delete require.cache[abs]; }
  return require(require.resolve(file))[fn];
}
async function call(file, fn, body, reqExtra) {
  const handler = load(file, fn)({ now: () => NOW });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  READS = 0;
  QUERIES = [];
  WRITES = 0;
  await handler({ body, ...(reqExtra === undefined ? OWNER : reqExtra) }, res);
  assert.equal(WRITES, 0, "อ่านอย่างเดียว");
  return res;
}
const M = (fn, body, req) => call("./read", fn, body, req);
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const CASHIER = { shopAccess: { shopId: "shopA", uid: "u-cash", role: "staff", rights: ["100"] } };
const MEMBER_STAFF = { shopAccess: { shopId: "shopA", uid: "u-m", role: "staff", rights: ["107"] } };
const SETTING_STAFF = { shopAccess: { shopId: "shopA", uid: "u-s", role: "staff", rights: ["101"] } };
const WATCHER = { shopAccess: { shopId: "shopA", uid: "u-w", role: "owner", rights: [], watcher: true, readOnly: true } };
const T = (m, extraNanos) => tsOfIso(`2026-11-10T03:${String(m).padStart(2, "0")}:00.000Z`, extraNanos);
const L = (shopId, x) => ({ shopId, members: [{ id: "m1", name: "ก", tel: "081" }], ...x });

function seed(x, shopX) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านเอ", ...(shopX || {}) }, shopB: { shopId: "shopB", name: "ร้านบี" } },
    memberList: {}, member: {}, paidHistory: {}, profile: {},
    ...x,
  };
}

// ── member.indexSync ──
async function syncAll(limit, cursor) {
  const pages = [];
  let c = cursor;
  for (let i = 0; i < 20; i++) {
    const r = await M("indexSync", { shopId: "shopA", ...(limit ? { limit } : {}), ...(c ? { cursor: c } : {}) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    pages.push(r.body);
    c = r.body.nextCursor;
    if (!r.body.hasMore) break;
  }
  return { pages, cursor: c };
}

test("indexSync: โหลดทั้งร้านแบ่งหน้า · doc เวลาเดียวกันเป๊ะข้ามรอยต่อไม่หาย · ร้านอื่นไม่ปน · ISO", async () => {
  const same = T(5, 777);
  seed({ memberList: { Ashop: L("shopA", { updateTime: same }), Bshop: L("shopA", { updateTime: same }), Cshop: L("shopA", { updateTime: same }), Zshop: L("shopA", { updateTime: T(1) }), AshopB: L("shopB", { updateTime: T(2) }) } });
  const { pages } = await syncAll(2);
  assert.deepEqual(pages.flatMap((p) => p.lists.map((l) => l.id)), ["Zshop", "Ashop", "Bshop", "Cshop"]);
  assert.equal(pages[0].lists[0].updateTime, "2026-11-10T03:01:00.000Z");
  assert.deepEqual(pages[0].lists[0].members, [{ id: "m1", name: "ก", tel: "081" }]);
  assert.equal(pages[0].lists[0].shopId, "shopA");
  const q = QUERIES.find((x) => x.c === "memberList");
  assert.deepEqual(q.filters.map((f) => f.slice(0, 2)), [["shopId", "=="], ["updateTime", ">"]], "ร้านทั่วไปคีย์เดียว = query แบบเดิม");
  assert.deepEqual(q.order, ["updateTime", "__name__"]);
});

test("indexSync: ส่ง cursor = เฉพาะ doc ที่เปลี่ยนหลังจุดนั้น · ไม่มีอะไรเปลี่ยน = ว่าง cursor เดิม · ค่าอ่าน shop 1 + query ขั้นต่ำ 1", async () => {
  seed({ memberList: { Ashop: L("shopA", { updateTime: T(1) }), Bshop: L("shopA", { updateTime: T(2) }) } });
  const { cursor } = await syncAll();
  const idle = await M("indexSync", { shopId: "shopA", cursor });
  assert.deepEqual([idle.body.lists, idle.body.nextCursor, idle.body.hasMore], [[], cursor, false]);
  assert.equal(READS, 1 + 1);
  DATA.memberList.Ashop = L("shopA", { updateTime: T(9), members: [{ id: "m9", name: "ใหม่", tel: "089" }] });
  const r = await M("indexSync", { shopId: "shopA", cursor });
  assert.deepEqual(r.body.lists.map((l) => [l.id, l.members[0].name]), [["Ashop", "ใหม่"]]);
});

test("indexSync: ร้านที่ช่อง shopId ≠ doc id อ่านทั้ง 2 คีย์ (แบบ memberShopKeys ของแอป) ใน query เดียว · คีย์อื่นไม่ปน", async () => {
  seed({ memberList: { AoldF: L("oldF", { updateTime: T(1) }), BshopA: L("shopA", { updateTime: T(2) }), Cother: L("other", { updateTime: T(3) }) } }, { shopId: "oldF" });
  const r = await M("indexSync", { shopId: "shopA" });
  assert.deepEqual(r.body.lists.map((l) => l.id), ["AoldF", "BshopA"]);
  const q = QUERIES.find((x) => x.c === "memberList");
  assert.deepEqual(q.filters[0], ["shopId", "in", ["oldF", "shopA"]]);
});

test("indexSync: updateTime ไม่ใช่เวลา / ค่าตั้งต้น 2011 = ไม่มา · ร้านยังไม่มีดัชนี = lists ว่าง nextCursor null", async () => {
  seed({ memberList: { Ashop: L("shopA", { updateTime: "2026" }), Bshop: L("shopA", { updateTime: new Date("2010-12-31T17:00:00.000Z") }) } });
  const r = await M("indexSync", { shopId: "shopA" });
  assert.deepEqual([r.body.lists, r.body.nextCursor, r.body.hasMore], [[], null, false]);
});

test("indexSync: แคชเชียร์ไม่มีเลขสิทธิ์ และ watcher อ่านได้ (จอขายของทุกคน)", async () => {
  seed({ memberList: { Ashop: L("shopA", { updateTime: T(1) }) } });
  for (const req of [CASHIER, WATCHER]) {
    const r = await M("indexSync", { shopId: "shopA" }, req);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.lists.length, 1);
  }
});

test("indexSync 🔒: ไม่มีด่าน 401 · ร้านอื่น 403 · cursor ปลอม / limit เกิน 400 · ไม่ query เลย", async () => {
  seed({ memberList: { Ashop: L("shopA", { updateTime: T(1) }) } });
  for (const [body, req, code, error] of [
    [{ shopId: "shopA" }, {}, 401, "no_shop_access"],
    [{ shopId: "shopB" }, OWNER, 403, "wrong_shop"],
    [{ shopId: "shopA", cursor: "2026-11-10" }, OWNER, 400, "invalid_request"],
    [{ shopId: "shopA", limit: 101 }, OWNER, 400, "invalid_request"],
  ]) {
    const r = await M("indexSync", body, req);
    assert.deepEqual([r.code, r.body.error], [code, error], JSON.stringify(body));
    assert.ok(!("lists" in r.body));
    assert.equal(QUERIES.length, 0);
  }
});

// ── member.list ──
const MB = (shopId, x) => ({ shopId, name: "n", tel: "08", point: 1, credit: 0, creditArray: [], bought: [{ year: "2026", buy: 10 }], timestamp: T(0), lastTime: T(1), letter: "A", createdByUid: "u", ...x });

test("list: ช่องที่จอใช้ + id · เวลา ISO · ตัด letter shopId createdByUid · เรียง doc id · ร้านอื่นไม่ปน", async () => {
  seed({ member: { m2: MB("shopA", { name: "สอง", creditArray: [{ remainCredit: 5, date: T(3) }] }), m1: MB("shopA", { name: "หนึ่ง" }), b1: MB("shopB") } });
  const r = await M("list", { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows.map((x) => x.id), ["m1", "m2"]);
  assert.deepEqual(Object.keys(r.body.rows[0]).sort(), ["bought", "credit", "creditArray", "id", "lastTime", "name", "point", "tel", "timestamp"]);
  assert.equal(r.body.rows[0].timestamp, "2026-11-10T03:00:00.000Z");
  assert.equal(r.body.rows[1].creditArray[0].date, "2026-11-10T03:03:00.000Z");
  assert.deepEqual([r.body.nextCursor, r.body.hasMore], ["m2", false]);
  const q = QUERIES.find((x) => x.c === "member");
  assert.deepEqual(q.select.sort(), ["bought", "credit", "creditArray", "lastTime", "name", "point", "shopId", "tel", "timestamp"]);
  assert.equal(READS, 1 + 2, "shop 1 + สมาชิก 2 (ไม่อ่านเผื่อ)");
});

test("list: แบ่งหน้าด้วย doc id · หน้าเต็มพอดี hasMore true · หน้าถัดไปได้ที่เหลือ", async () => {
  seed({ member: { m1: MB("shopA"), m2: MB("shopA"), m3: MB("shopA") } });
  const p1 = await M("list", { shopId: "shopA", limit: 2 });
  assert.deepEqual([p1.body.rows.map((x) => x.id), p1.body.nextCursor, p1.body.hasMore], [["m1", "m2"], "m2", true]);
  const p2 = await M("list", { shopId: "shopA", limit: 2, cursor: "m2" });
  assert.deepEqual([p2.body.rows.map((x) => x.id), p2.body.nextCursor, p2.body.hasMore], [["m3"], "m3", false]);
  const p3 = await M("list", { shopId: "shopA", limit: 2, cursor: "m3" });
  assert.deepEqual([p3.body.rows, p3.body.nextCursor, p3.body.hasMore], [[], "m3", false]);
});

test("list: ร้านที่ช่อง shopId ≠ doc id ได้ทั้งสมาชิกเก่า (ถือช่อง) และที่เพิ่มผ่าน API (ถือ doc id) · ไม่ซ้ำ", async () => {
  seed({ member: { o1: MB("oldF"), n1: MB("shopA"), x1: MB("other") } }, { shopId: "oldF" });
  const r = await M("list", { shopId: "shopA" });
  assert.deepEqual(r.body.rows.map((x) => x.id), ["n1", "o1"]);
});

test("list: สิทธิ์ 107 หรือ 101 (2 ทางเข้าจอสมาชิก) · watcher ผ่าน · แคชเชียร์ไม่มีทั้งคู่ 403 ไม่อ่านสมาชิก", async () => {
  seed({ member: { m1: MB("shopA") } });
  for (const req of [MEMBER_STAFF, SETTING_STAFF, WATCHER]) assert.equal((await M("list", { shopId: "shopA" }, req)).code, 200);
  const r = await M("list", { shopId: "shopA" }, CASHIER);
  assert.deepEqual([r.code, r.body.error], [403, "right_required"]);
  assert.equal(READS, 0);
});

test("list 🔒: ร้านอื่น 403 · cursor มี / 400 · limit เกิน 400 · ไม่อ่านฐาน", async () => {
  seed({ member: { m1: MB("shopA") } });
  for (const [body, code, error] of [
    [{ shopId: "shopB" }, 403, "wrong_shop"],
    [{ shopId: "shopA", cursor: "a/b" }, 400, "invalid_request"],
    [{ shopId: "shopA", limit: 3001 }, 400, "invalid_request"],
  ]) {
    const r = await M("list", body);
    assert.deepEqual([r.code, r.body.error], [code, error], JSON.stringify(body));
    assert.equal(READS, 0);
  }
});

// ── member.get ──
test("get: สมาชิกของร้าน → doc ทั้งก้อน + id (แอปกระจายเข้า currentMember · Pack ข้อ 7) · เวลา ISO · แคชเชียร์ได้ · ร้านช่อง ≠ doc id ได้ทั้ง 2 คีย์", async () => {
  seed({ member: { m1: MB("shopA", { creditArray: [{ remainCredit: 3, date: T(2) }], extraFromOldApp: { x: 1 } }), o1: MB("oldF") } });
  const r = await M("get", { shopId: "shopA", memberId: "m1" }, CASHIER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.member, {
    shopId: "shopA", name: "n", tel: "08", point: 1, credit: 0, creditArray: [{ remainCredit: 3, date: "2026-11-10T03:02:00.000Z" }],
    bought: [{ year: "2026", buy: 10 }], timestamp: "2026-11-10T03:00:00.000Z", lastTime: "2026-11-10T03:01:00.000Z", letter: "A", createdByUid: "u",
    extraFromOldApp: { x: 1 }, id: "m1",
  });
  assert.equal(READS, 2);
  DATA.shop.shopA.shopId = "oldF";
  assert.equal((await M("get", { shopId: "shopA", memberId: "o1" })).body.member.id, "o1");
  assert.equal((await M("get", { shopId: "shopA", memberId: "m1" })).body.member.id, "m1");
});

test("get 🔒: สมาชิกร้านอื่น = 404 member_not_found เท่ากับไม่มี (ไม่บอกว่ามีอยู่) · ร้านอื่นใน body 403", async () => {
  seed({ member: { b1: MB("shopB", { name: "ลับ" }) } });
  for (const id of ["b1", "nope"]) {
    const r = await M("get", { shopId: "shopA", memberId: id });
    assert.deepEqual([r.code, r.body.error], [404, "member_not_found"]);
    assert.ok(!JSON.stringify(r.body).includes("ลับ"));
  }
  const w = await M("get", { shopId: "shopB", memberId: "b1" });
  assert.deepEqual([w.code, w.body.error], [403, "wrong_shop"]);
});

// ── member.paidHistory ──
const PH = (shopId, memberId, ts, x) => ({ shopId, memberId, paid: 100, existCredit: 50, timestamp: ts, billDate: "x", staffName: "s", ...x });

test("paidHistory: 365 วัน · กรองร้าน (ของเดิมไม่กรอง) · เรียงใหม่ก่อน · ช่องที่จอใช้ + id · ISO", async () => {
  seed({ paidHistory: {
    p1: PH("shopA", "m1", tsOfIso("2026-11-01T00:00:00.000Z"), { paid: 10 }),
    p2: PH("shopA", "m1", tsOfIso("2026-11-10T00:00:00.000Z"), { paid: 20 }),
    old: PH("shopA", "m1", tsOfIso("2025-11-14T04:59:59.000Z")),
    edge: PH("shopA", "m1", tsOfIso("2025-11-14T05:00:00.000Z"), { paid: 5 }),
    other: PH("shopB", "m1", tsOfIso("2026-11-05T00:00:00.000Z"), { paid: 999 }),
    m2: PH("shopA", "m2", tsOfIso("2026-11-05T00:00:00.000Z")),
  } });
  const r = await M("paidHistory", { shopId: "shopA", memberId: "m1" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows.map((x) => [x.id, x.paid]), [["p2", 20], ["p1", 10], ["edge", 5]]);
  assert.deepEqual(r.body.rows[0], { paid: 20, existCredit: 50, timestamp: "2026-11-10T00:00:00.000Z", id: "p2" });
  const q = QUERIES.find((x) => x.c === "paidHistory");
  assert.deepEqual(q.filters.map((f) => f.slice(0, 2)), [["memberId", "=="], ["timestamp", ">="]], "query เดิม · index เดิม");
  assert.ok(!JSON.stringify(r.body).includes("999"));
});

test("paidHistory: ร้านช่อง ≠ doc id ได้ทั้ง 2 คีย์ · สิทธิ์ 107/101 · แคชเชียร์ 403", async () => {
  seed({ paidHistory: { a: PH("oldF", "m1", tsOfIso("2026-11-01T00:00:00.000Z")), b: PH("shopA", "m1", tsOfIso("2026-11-02T00:00:00.000Z")) } }, { shopId: "oldF" });
  const r = await M("paidHistory", { shopId: "shopA", memberId: "m1" }, SETTING_STAFF);
  assert.deepEqual(r.body.rows.map((x) => x.id), ["b", "a"]);
  assert.equal((await M("paidHistory", { shopId: "shopA", memberId: "m1" }, MEMBER_STAFF)).code, 200);
  const c = await M("paidHistory", { shopId: "shopA", memberId: "m1" }, CASHIER);
  assert.deepEqual([c.code, c.body.error], [403, "right_required"]);
});

test("paidHistory 🔒: ไม่มีด่าน 401 · ร้านอื่น 403 · memberId มี / 400", async () => {
  seed({});
  for (const [body, req, code, error] of [
    [{ shopId: "shopA", memberId: "m1" }, {}, 401, "no_shop_access"],
    [{ shopId: "shopB", memberId: "m1" }, OWNER, 403, "wrong_shop"],
    [{ shopId: "shopA", memberId: "a/b" }, OWNER, 400, "invalid_request"],
  ]) {
    const r = await M("paidHistory", body, req);
    assert.deepEqual([r.code, r.body.error], [code, error]);
    assert.equal(READS, 0);
  }
});

// ── staff.profiles ──
const SP = (body, req) => call("../shopStaff/staffProfiles", "staffProfiles", body, req);

test("staff.profiles: คนใน humanResource ที่มี doc profile → 4 ช่อง · คนไม่มี doc = ไม่มี key (จอทิ้งแบบเดิม) · ไม่ซ้ำ · คนนอกร้านไม่อ่าน", async () => {
  seed({ profile: {
    u1: { email: "a@x", name: "เอ", imageId: "i", tel: "081", currentLogin: { shopId: "shopA" }, port: [] },
    u2: { name: "บี", tel: "082" },
    outsider: { name: "นอก", email: "o@x" },
  } }, { humanResource: [{ id: "u1", status: "active", password: "1" }, { id: "u2", status: "inactive" }, { id: "u3", status: "active" }, { id: "u1" }, { id: "a/b" }, null] });
  const r = await SP({ shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.profiles, { u1: { email: "a@x", name: "เอ", imageId: "i", tel: "081" }, u2: { name: "บี", tel: "082" } });
  assert.equal(READS, 1 + 3, "shop 1 + พนักงานไม่ซ้ำ 3 คน (เดิม = จำนวนพนักงาน)");
});

test("staff.profiles: สิทธิ์ 101 · watcher ผ่าน · พนักงานมีแค่ 107 → 403 ไม่อ่าน profile · ร้านอื่น 403 · body มี ids 400", async () => {
  seed({ profile: { u1: { name: "เอ" } } }, { humanResource: [{ id: "u1" }] });
  for (const req of [SETTING_STAFF, WATCHER]) assert.equal((await SP({ shopId: "shopA" }, req)).code, 200);
  for (const [body, req, code, error] of [
    [{ shopId: "shopA" }, MEMBER_STAFF, 403, "right_required"],
    [{ shopId: "shopB" }, OWNER, 403, "wrong_shop"],
    [{ shopId: "shopA", ids: ["outsider"] }, OWNER, 400, "invalid_request"],
    [{ shopId: "shopA" }, {}, 401, "no_shop_access"],
  ]) {
    const r = await SP(body, req);
    assert.deepEqual([r.code, r.body.error], [code, error], JSON.stringify(body));
    assert.equal(READS, 0);
  }
});

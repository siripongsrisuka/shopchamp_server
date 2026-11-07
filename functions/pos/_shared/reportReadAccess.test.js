// เทสโหมด reportReadAccess (legacy owner-web parity ชั่วคราว · Pack เคาะ 2026-11-07 · lanes/dev/source/owner-web-census.md)
//   กติกา: ลูกค้าที่ใช้อยู่ได้สิทธิ์ดูรายงานบนเว็บเท่าวันนี้ ⇒ ผล = ด่านปกติ ∪ กติกาเว็บ live (แถวที่มี 107 / owner / position 001 · ไม่ดู status/แพ็กเกจ)
//   ครอบ: ตัวตัดสิน pure · middleware ตัวจริง · openReport (ด่านในตัว handler) · ทะเบียน route (reportRead เฉพาะ report.*) · เส้นเขียนไม่เปลี่ยน
//   รัน: node --test pos/_shared/reportReadAccess.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ── Firestore ปลอม (doc get + where/limit) · แทน functions/firebase ก่อนโหลด report handler ──
let DATA = {};
const fakeDb = {
  collection: (c) => ({
    doc: (id) => ({ id, get: async () => ({ exists: (DATA[c] || {})[id] !== undefined, id, data: () => (DATA[c] || {})[id] }) }),
    where: (f, op, v) => {
      const q = { lim: null };
      const api = {
        limit: (n) => { q.lim = n; return api; },
        get: async () => {
          let docs = Object.entries(DATA[c] || {}).filter(([, d]) => d && d[f] === v).map(([id, d]) => ({ id, exists: true, data: () => d }));
          if (q.lim != null) docs = docs.slice(0, q.lim);
          return { docs, empty: !docs.length, size: docs.length };
        },
      };
      return api;
    },
  }),
};
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {} } };

const A = require("./auth");
const { openReport } = require("../report/_reportShared");
const { ROUTES } = require("../routes");
const { checkRegistry } = require("../app");
const { PUBLIC_ROUTES } = require("../public-routes");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), valueOf: () => d.getTime() }; };
const FUTURE = ts("2027-01-01T00:00:00Z");
const PAST = ts("2026-01-01T00:00:00Z");
const ROSTER = { uids: ["u-root", "u-watch"], rootUids: ["u-root"] };

/** ร้านที่มีทุกรูปที่ census เจอ · vip staff หมด/ไม่หมดตามที่ส่ง */
function shop(staffVip) {
  return {
    shopId: "shopA",
    vip: [{ type: "staff", expire: staffVip }],
    humanResource: [
      { id: "u-owner", position: ["001"], status: "active" },
      { id: "u-s106", position: ["002"], status: "active", rights: ["106"] }, // ผ่านด่านปกติ · ไม่มี 107
      { id: "u-s107", position: ["002"], status: "active", rights: ["107"] }, // census: right_required (มีแค่ 107)
      { id: "u-s102", position: ["002"], status: "active", rights: ["102", "107"] }, // census: เสียรายงานยอดขาย
      { id: "u-off107", position: ["002"], status: "inActive", rights: ["107"] }, // census: row inActive
      { id: "u-offOwnerFlag", position: ["002"], status: "inActive", owner: true },
      { id: "u-offPosStr", position: "001", status: "inActive" },
      { id: "u-off106", position: ["002"], status: "inActive", rights: ["106", "117"] }, // เว็บ live ไม่ให้ (ไม่มี 107/owner/001) ⇒ ยังปัด
      { id: "u-noRight", position: ["002"], status: "active", rights: ["116"] },
      { id: "u-offNoRight", position: ["002"], status: "inActive", rights: ["116"] },
    ],
  };
}
const ALL_UIDS = ["u-owner", "u-s106", "u-s107", "u-s102", "u-off107", "u-offOwnerFlag", "u-offPosStr", "u-off106", "u-noRight", "u-offNoRight", "u-root", "u-watch", "u-stranger", ""];
const strict = (s, uid) => A.resolveShopAccess({ shopDocId: "shopA", shop: s, uid, now: NOW, roster: ROSTER });
const report = (s, uid) => A.resolveReportReadAccess({ shopDocId: "shopA", shop: s, uid, now: NOW, roster: ROSTER });

test("ไม่ลดใคร: ทุกคนที่ผ่านด่านปกติ ได้ access เดิมทุกไบต์ในโหมดรายงาน (แพ็กเกจพนักงานยังไม่หมด + หมด)", async () => {
  for (const vip of [FUTURE, PAST]) {
    for (const uid of ALL_UIDS) {
      const s = await strict(shop(vip), uid);
      const r = await report(shop(vip), uid);
      if (s.ok) assert.deepEqual(r, s, `${uid} vip ${vip === PAST ? "หมด" : "ยังไม่หมด"}`);
    }
  }
});

test("กติกาเว็บ live: แถวที่มี 107 / owner / position 001 ผ่านแม้ inActive · ได้ legacyReport + readOnly", async () => {
  const s = shop(FUTURE);
  const off107 = await report(s, "u-off107");
  assert.deepEqual(off107, { ok: true, access: { shopId: "shopA", uid: "u-off107", role: "staff", rights: ["107"], legacyReport: true, readOnly: true } });
  for (const uid of ["u-offOwnerFlag", "u-offPosStr"]) {
    const r = await report(s, uid);
    assert.deepEqual([r.ok, r.access.role, r.access.legacyReport, r.access.readOnly], [true, "owner", true, true], uid);
    assert.equal((await strict(s, uid)).ok, false, `${uid} ด่านปกติปัด (คุมว่าเทสวัดของที่ต่างจริง)`);
  }
});

test("แพ็กเกจพนักงานหมด: พนักงาน active ที่มี 107 ผ่านโหมดรายงาน · ด่านปกติปัด inactive", async () => {
  const s = shop(PAST);
  assert.deepEqual((await strict(s, "u-s107")).extra, { reason: "inactive" });
  const r = await report(s, "u-s107");
  assert.equal(r.ok, true);
  assert.equal(r.access.legacyReport, true);
  // พนักงานที่มีแค่ 106 แต่แพ็กเกจหมด: เว็บ live ไม่ให้ (ไม่มี 107) ⇒ ยังปัดเหมือนวันนี้
  assert.deepEqual([(await report(s, "u-s106")).ok, (await report(s, "u-s106")).extra.reason], [false, "inactive"]);
});

test("ยังปัด: inActive ที่ไม่มี 107/owner/001 · คนนอก · uid ว่าง (reason เดิม)", async () => {
  const s = shop(FUTURE);
  for (const [uid, reason] of [["u-off106", "inactive"], ["u-offNoRight", "inactive"], ["u-stranger", "not_a_member"], ["", "not_a_member"]]) {
    const r = await report(s, uid);
    assert.deepEqual([r.ok, r.error, r.extra && r.extra.reason], [false, "not_shop_member", reason], uid);
  }
});

test("root / watcher เหมือนวันนี้ · watcher ที่เป็นพนักงาน inActive มี 107 ยังได้ access แบบ watcher (ด่านปกติชนะ)", async () => {
  const s = shop(FUTURE);
  assert.equal((await report(s, "u-root")).access.root, true);
  assert.equal((await report(s, "u-watch")).access.watcher, true);
  s.humanResource.push({ id: "u-watch", position: ["002"], status: "inActive", rights: ["107"] });
  const w = await report(s, "u-watch");
  assert.equal(w.access.watcher, true);
  assert.equal(w.access.legacyReport, undefined);
});

test("legacyGrant: รูปเพี้ยนไม่โยน · rights ต้องเป็นสตริง '107' ตรงตัว (เหมือนเว็บ live includes)", () => {
  assert.equal(A.legacyReportGrant(null, "u"), null);
  assert.equal(A.legacyReportGrant({ humanResource: "x" }, "u"), null);
  assert.equal(A.legacyReportGrant({ humanResource: [null, 3, { id: "u", rights: [107] }] }, "u"), null);
  assert.equal(A.legacyReportGrant({ humanResource: [{ id: "u", position: 1 }] }, "u"), null);
  assert.ok(A.legacyReportGrant({ humanResource: [{ id: "u", rights: ["107"] }] }, "u"));
  assert.equal(A.legacyReportGrant({ humanResource: [{ id: "u", owner: false, position: ["002"] }] }, "u"), null);
});

test("reportRights: เติม 107 ให้ทุกชุดสิทธิ์ของรายงาน · ไม่ซ้ำ · ชุดว่างคงว่าง", () => {
  assert.deepEqual(A.reportRights(["117", "106"]), ["117", "106", "107"]);
  assert.deepEqual(A.reportRights(["102", "106"]), ["102", "106", "107"]);
  assert.deepEqual(A.reportRights(["106", "107"]), ["106", "107"]);
  assert.deepEqual(A.reportRights([]), []);
  assert.deepEqual(A.reportRights(undefined), []);
});

test("🔒 access legacyReport บนเส้นเขียน = 403 watcher_read_only (callerAccess ค่าตั้งต้น)", async () => {
  const r = await report(shop(FUTURE), "u-off107");
  const req = { shopAccess: r.access };
  assert.deepEqual([A.callerAccess(req, "shopA").error], ["watcher_read_only"]);
  assert.equal(A.callerAccess(req, "shopA", { read: true }).ok, true);
});

// ── middleware ตัวจริง ──────────────────────────────────────────────────────────
function res() { return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
async function runMw(mw, uid) {
  const r = res();
  const req = { body: { shopId: "shopA" }, auth: { uid } };
  let nexted = false;
  await mw(req, r, () => { nexted = true; });
  return { r, req, nexted };
}

test("middleware: requireReportReadAccess ให้ inActive ที่มี 107 ผ่าน · requireShopAccess (เส้นเขียน) ยังปัด", async () => {
  DATA = { shop: { shopA: shop(FUTURE) }, watcher: { roster: ROSTER } };
  const quiet = { db: fakeDb, now: () => NOW, log: () => {} };
  const rep = await runMw(A.makeRequireReportReadAccess(quiet), "u-off107");
  assert.equal(rep.nexted, true);
  assert.equal(rep.req.shopAccess.legacyReport, true);
  const wr = await runMw(A.makeRequireShopAccess(quiet), "u-off107");
  assert.deepEqual([wr.nexted, wr.r.code, wr.r.body.error, wr.r.body.reason], [false, 403, "not_shop_member", "inactive"]);
  const no = await runMw(A.makeRequireReportReadAccess(quiet), "u-off106");
  assert.deepEqual([no.nexted, no.r.code], [false, 403]);
});

// ── openReport (ด่านในตัว handler) ─────────────────────────────────────────────
async function open(access, rights, s) {
  DATA = { shop: { shopA: s || shop(FUTURE) } };
  const r = res();
  const ctx = await openReport({ body: { shopId: "shopA" }, shopAccess: access }, r, { safeParse: (b) => ({ success: true, data: b }) }, { rights });
  return { ctx, r };
}

test("openReport: 107 ใช้แทน 106/117/102 · legacyReport inActive ผ่าน · ตรวจซ้ำกับ doc ที่อ่านจริง", async () => {
  const s107 = { shopId: "shopA", uid: "u-s107", role: "staff", rights: ["107"] };
  for (const need of [["117", "106"], ["102", "106"], ["106"]]) assert.ok((await open(s107, need)).ctx, need.join(","));
  const s116 = { shopId: "shopA", uid: "u-noRight", role: "staff", rights: ["116"] };
  assert.deepEqual([(await open(s116, ["106"])).r.body.error], ["right_required"]);

  const legacy = (await report(shop(FUTURE), "u-off107")).access;
  assert.ok((await open(legacy, ["117", "106"])).ctx, "inActive + legacyReport ผ่าน");
  // ไม่มี legacyReport (access แบบปกติ) + แถว inActive = ปัด inactive เหมือนเดิม
  const plain = { shopId: "shopA", uid: "u-off107", role: "staff", rights: ["107"] };
  assert.deepEqual([(await open(plain, ["106"])).r.body.reason], ["inactive"]);
  // doc เปลี่ยนระหว่างด่าน (แถวหายไป) ⇒ legacyReport ปัด
  const gone = shop(FUTURE);
  gone.humanResource = gone.humanResource.filter((p) => p.id !== "u-off107");
  const g = await open(legacy, ["106"], gone);
  assert.deepEqual([g.ctx, g.r.code, g.r.body.reason], [null, 403, "not_a_member"]);
});

// ── ทะเบียน route ───────────────────────────────────────────────────────────────
test("ทะเบียน: route report.* ทุกตัว (7) ใช้ reportRead · route อื่นไม่มีสักตัว · ผูกที่อื่น = สร้าง app ไม่ได้", () => {
  const rr = ROUTES.filter((r) => r.access === "reportRead").map((r) => r.contract).sort();
  assert.deepEqual(rr, ROUTES.filter((r) => /^report\./.test(r.contract)).map((r) => r.contract).sort());
  assert.equal(rr.length, 7);
  assert.ok(ROUTES.filter((r) => r.access === "reportRead").every((r) => r.fn === "pos_heavy" && r.auth === "shop"));
  const sneaky = ROUTES.map((r) => (r.contract === "member.update" ? { ...r, access: "reportRead" } : r));
  assert.throws(() => checkRegistry(sneaky, PUBLIC_ROUTES), /ใช้ access reportRead ได้เฉพาะ route report\.\*/);
  const typo = ROUTES.map((r) => (r.contract === "report.breakdown" ? { ...r, access: "reportread" } : r));
  assert.throws(() => checkRegistry(typo, PUBLIC_ROUTES), /access ไม่รู้จัก/);
});

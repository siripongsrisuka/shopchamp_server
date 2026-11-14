// เทส DEV-0010 · staff.checkInStatus (checkInStatus.js) + expense.list / expenseReport.list (expenseRead.js) · รัน: node --test pos/shopStaff/staffExpenseRead.test.js
//   harness ของสัญญาไม่เรียง/ไม่กรองช่วง/ไม่ดูรูป query ⇒ ที่นี่พิสูจน์: รูป query ที่ส่งถึง Firestore (where · orderBy · limit · select)
//   · ฐานปลอมที่เรียง+ตัดแบบ Firestore จริง · ช่วง 6 เดือนตามนาฬิกาไทยข้ามปี/ข้ามเที่ยงคืน · ไม่อ่านใบเมื่อด่านปัด
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FUNCTIONS = path.resolve(__dirname, "..", "..");
const NEW = ["StaffCheckInStatusRequest", "ExpenseListRequest", "ExpenseReportListRequest"];

// คำขอ DEV-0010 อยู่ใน vendor @shopchamp/schema 0.1.28 แล้ว ⇒ ใช้ vendor ปกติ · ขาดตัวไหน = ตกทันที (ไม่ build จาก src ของ center แทน)
function installSchemas() {
  const pkg = require("@shopchamp/schema");
  const missing = NEW.filter((k) => !pkg[k]);
  if (missing.length) throw new Error(`vendor @shopchamp/schema ไม่มี ${missing.join(" ")} · bump + vendor ใหม่`);
}

const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime() }; };
const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : null);
const cmpV = (a, b) => {
  const x = ms(a), y = ms(b);
  if (x !== null && y !== null) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
};

let DATA = {};
let READS = 0;
let QUERIES = [];
let DOC_GETS = [];
function makeDb() {
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const query = (c, st) => ({
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f, dir) => query(c, { ...st, order: [...st.order, [f, dir || "asc"]] }),
    select: (...fields) => query(c, { ...st, select: fields }),
    limit: (n) => query(c, { ...st, limit: n }),
    get: async () => {
      QUERIES.push({ c, ...st });
      let rows = Object.keys(DATA[c] || {}).map((id) => ({ id, d: DATA[c][id] }));
      for (const [f, op, v] of st.filters) {
        rows = rows.filter((r) => {
          const x = r.d[f];
          if (x === undefined) return false;
          if (op === "==") return cmpV(x, v) === 0 && typeof x === typeof v;
          if (op === ">=") return typeof x === typeof v && cmpV(x, v) >= 0;
          if (op === "<=") return typeof x === typeof v && cmpV(x, v) <= 0;
          throw new Error(`ฐานปลอม: where ${op} ยังไม่รองรับ`);
        });
      }
      // Firestore: เรียงตาม orderBy แล้วต่อด้วย __name__ ทิศเดียวกับตัวสุดท้าย
      const ord = st.order;
      const lastDir = ord.length ? ord[ord.length - 1][1] : "asc";
      rows.sort((a, b) => {
        for (const [f, dir] of ord) { const c2 = cmpV(a.d[f], b.d[f]); if (c2) return dir === "desc" ? -c2 : c2; }
        const n = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return lastDir === "desc" ? -n : n;
      });
      if (st.limit != null) rows = rows.slice(0, st.limit);
      READS += Math.max(1, rows.length);
      const docs = rows.map((r) => {
        if (!st.select) return snapOf(c, r.id);
        const pick = {};
        for (const f of st.select) if (r.d[f] !== undefined) pick[f] = r.d[f];
        return { exists: true, id: r.id, data: () => pick };
      });
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  return {
    collection: (c) => ({
      doc: (id) => ({ id, path: `${c}/${id}`, get: async () => { READS += 1; DOC_GETS.push(`${c}/${id}`); return snapOf(c, id); } }),
      where: (f, op, v) => query(c, { filters: [[f, op, v]], order: [], limit: null, select: null }),
    }),
  };
}

function load(file, fn) {
  installSchemas();
  const fbAbs = require.resolve(path.join(FUNCTIONS, "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
  const abs = require.resolve(file);
  delete require.cache[abs];
  return require(abs)[fn];
}
async function call(file, fn, body, req, nowIso) {
  const handler = load(file, fn)({ now: () => new Date(nowIso || "2026-11-14T03:00:00.000Z") });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  READS = 0;
  QUERIES = [];
  DOC_GETS = [];
  await handler({ body, ...req }, res);
  return res;
}

const VIP = (premiumIso, staffIso) => [{ type: "premium", expire: ts(premiumIso) }, { type: "staff", expire: ts(staffIso) }];
const HR = [
  { id: "u-owner", position: ["001"], status: "active" },
  { id: "u-staff", position: [], status: "active", rights: ["103", "131"] },
  { id: "u-weak", position: [], status: "active", rights: ["100"] },
];

// ───────── staff.checkInStatus ─────────
const CI = "./checkInStatus";
const H = (day, uid) => ({ id: `shopA${uid || "u-staff"}`, shopId: "shopA", profileId: uid || "u-staff", clockIn: ts(`2026-10-${String(day).padStart(2, "0")}T01:00:00.000Z`), clockOut: ts(`2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`), billDate: "x" });
function ciSeed(vip, hist) {
  DATA = {
    shop: { shopA: { shopId: "shopA", humanResource: HR, vip: vip || VIP("2027-01-01", "2027-01-01") } },
    watcher: { roster: { uids: [], rootUids: [] } },
    checkIn: { "shopAu-staff": { clockIn: ts("2026-11-14T01:00:00.000Z"), clockOut: ts("2026-11-14T01:00:00.000Z"), shopId: "shopA", profileId: "u-staff", id: "", billDate: "20261114", requestId: "r", staffName: "บี" } },
    checkInHistory: hist,
  };
}

test("checkInStatus: query ประวัติรูปเดียวกับแอปเดิม (id == shop doc id + uid · clockIn desc · limit 10) · ได้ 10 ใบล่าสุดจากฐานที่ seed สลับลำดับ", async () => {
  const hist = {};
  for (const d of [3, 15, 7, 1, 12, 9, 2, 14, 5, 11, 8, 4, 13]) hist[`h${d}`] = H(d);
  hist.other = H(30, "u-weak");
  ciSeed(null, hist);
  const r = await call(CI, "checkInStatus", { shopId: "shopA" }, { auth: { uid: "u-staff" } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.history.map((x) => x.id), ["h15", "h14", "h13", "h12", "h11", "h9", "h8", "h7", "h5", "h4"]);
  assert.equal(r.body.current.id, "shopAu-staff");
  assert.equal(r.body.current.clockIn, "2026-11-14T01:00:00.000Z");
  assert.equal(r.body.current.requestId, undefined);
  const q = QUERIES.find((x) => x.c === "checkInHistory");
  assert.deepEqual(q.filters, [["id", "==", "shopAu-staff"]]);
  assert.deepEqual(q.order, [["clockIn", "desc"]]);
  assert.equal(q.limit, 10);
  assert.ok(DOC_GETS.includes("checkIn/shopAu-staff"));
});

test("checkInStatus: ด่านปัด (ไม่มีสิทธิ์ 103) = ไม่อ่านใบลงเวลาเลย", async () => {
  ciSeed(null, { h1: H(1, "u-weak") });
  const r = await call(CI, "checkInStatus", { shopId: "shopA" }, { auth: { uid: "u-weak" } });
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "right_required");
  assert.equal(QUERIES.length, 0);
  assert.ok(!DOC_GETS.some((p) => p.startsWith("checkIn/")));
});

test("checkInStatus: แพ็กเกจพนักงานหมด · แถว active → 200 (AC-82) · ไม่ใช่สมาชิก → 403 not_shop_member", async () => {
  ciSeed(VIP("2027-01-01", "2026-01-01"), {});
  const ok = await call(CI, "checkInStatus", { shopId: "shopA" }, { auth: { uid: "u-staff" } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.current.id, "shopAu-staff");
  const no = await call(CI, "checkInStatus", { shopId: "shopA" }, { auth: { uid: "u-stranger" } });
  assert.equal(no.code, 403);
  assert.equal(no.body.error, "not_shop_member");
});

// ───────── expense.list ─────────
const EX = "./expenseRead";
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };

test("expense.list: where shopId == ช่องร้าน · select เฉพาะช่องที่จอใช้ · เรียง doc id · ไม่ส่งช่องอื่น", async () => {
  DATA = {
    shop: { shopA: { shopId: "fieldA", humanResource: HR, vip: VIP("2027-01-01", "2027-01-01") } },
    expense: {
      z1: { shopId: "fieldA", name: "ไฟ", category: ["c"], price: "5", priceStatus: true, timestamp: ts("2026-11-01T00:00:00.000Z"), updatedBy: "u-owner", id: "" },
      a1: { shopId: "fieldA", name: "น้ำ", category: [], price: "", priceStatus: false, timestamp: ts("2026-10-01T00:00:00.000Z") },
      x1: { shopId: "shopA", name: "doc id ไม่ใช่ช่องร้าน", category: [], price: "", priceStatus: false, timestamp: ts("2026-10-01T00:00:00.000Z") },
    },
  };
  const r = await call(EX, "expenseList", { shopId: "shopA" }, OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((x) => x.id), ["a1", "z1"]);
  assert.deepEqual(Object.keys(r.body.items[1]).sort(), ["category", "id", "name", "price", "priceStatus", "timestamp"]);
  assert.equal(r.body.items[1].timestamp, "2026-11-01T00:00:00.000Z");
  const q = QUERIES.find((x) => x.c === "expense");
  assert.deepEqual(q.filters, [["shopId", "==", "fieldA"]]);
  assert.deepEqual([...q.select].sort(), ["category", "name", "price", "priceStatus", "shopId", "timestamp"]);
  assert.equal(q.limit, null, "ไม่ limit แบบแอปเดิม");
});

// ───────── expenseReport.list ─────────
const REP = (shop, month) => ({ id: `${shop}${month}`, shopId: shop, month, name: `n${month}`, expenses: [{ id: `r${month}`, price: "1", timestamp: ts("2026-01-01T00:00:00.000Z") }], deleted: [{ id: "x" }], totalExpense: 0 });
function repSeed(months) {
  DATA = { shop: { shopA: { shopId: "shopA", humanResource: HR, vip: VIP("2027-12-01", "2027-12-01") } }, expenseReport: {} };
  for (const m of months) DATA.expenseReport[`shopA${m}`] = REP("shopA", m);
  DATA.expenseReport.shopB202611 = REP("shopB", "202611");
}

test("expenseReport.list: query ช่วง 6 เดือน (shopId == · month >= เก่าสุด · month <= เดือนนี้ · month desc) · อ่านไม่เกิน 6 doc แม้ร้านมีหลายปี", async () => {
  const all = [];
  for (let y = 2023; y <= 2026; y++) for (let m = 1; m <= 12; m++) all.push(`${y}${String(m).padStart(2, "0")}`);
  repSeed(all);
  const r = await call(EX, "expenseReportList", { shopId: "shopA" }, OWNER, "2026-11-14T03:00:00.000Z");
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.months, ["202611", "202610", "202609", "202608", "202607", "202606"]);
  assert.deepEqual(r.body.reports.map((x) => x.month), r.body.months);
  assert.equal(r.body.reports[0].deleted, undefined);
  assert.equal(r.body.reports[0].expenses[0].timestamp, "2026-01-01T00:00:00.000Z");
  const q = QUERIES.find((x) => x.c === "expenseReport");
  assert.deepEqual(q.filters, [["shopId", "==", "shopA"], ["month", ">=", "202606"], ["month", "<=", "202611"]]);
  assert.deepEqual(q.order, [["month", "desc"]]);
  assert.ok(READS <= 1 + 6, `อ่าน ${READS}`);
});

test("expenseReport.list: ข้ามปี (ก.พ.) และนาฬิกาไทย (30 พ.ย. 17:30Z = 1 ธ.ค. ไทย)", async () => {
  repSeed(["202509", "202508", "202602"]);
  const a = await call(EX, "expenseReportList", { shopId: "shopA" }, OWNER, "2026-02-10T03:00:00.000Z");
  assert.deepEqual(a.body.months, ["202602", "202601", "202512", "202511", "202510", "202509"]);
  assert.deepEqual(a.body.reports.map((x) => x.month), ["202602", "202509"]);
  repSeed(["202612", "202606"]);
  const b = await call(EX, "expenseReportList", { shopId: "shopA" }, OWNER, "2026-11-30T17:30:00.000Z");
  assert.equal(b.body.months[0], "202612");
  assert.deepEqual(b.body.reports.map((x) => x.month), ["202612"], "202606 หลุดช่วงเมื่อเดือนไทยขึ้น ธ.ค.");
});

test("expenseReport.list: ส่ง month = อ่าน doc เดียว ไม่ query", async () => {
  repSeed(["202611"]);
  const r = await call(EX, "expenseReportList", { shopId: "shopA", month: "202611" }, OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.reports.map((x) => x.id), ["shopA202611"]);
  assert.equal(QUERIES.length, 0);
  assert.deepEqual(DOC_GETS, ["shop/shopA", "expenseReport/shopA202611"]);
});

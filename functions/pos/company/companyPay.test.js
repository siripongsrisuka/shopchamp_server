// เทสชำระเงินอัตโนมัติ posxpay ของใบสั่งซื้อบริษัท (DEV-0003 U2/U3) — payRequest · payStatus · _payCheck · paySweep
//   รัน: node --test functions/pos/company/companyPay.test.js   (จากโฟลเดอร์ shopchamp_server)
//   ❌ ไม่ออกเน็ต: provider ถูกแทนด้วย deps.createQR/deps.inquiry และ http ของ posxpayClient ถูกตั้งให้โยนถ้ามีใครยิง (_setHttp)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache (ฐานปลอมเก็บผลเขียนจริง ⇒ เดินหลายขั้นต่อกันได้ ต่างจาก harness)
//   ⚠️ schema 0.1.22 / logic U1 อยู่ที่ center · ถ้า node_modules ยังไม่มี (แม่ยังไม่ vendor) เทสโหลด build ของ center แทน (แบบ fulfill.test.js)
//   ชุด case ของสัญญา (harness) อยู่ที่ shopchamp-center/api/company.payRequest.yaml / company.payStatus.yaml · ไฟล์นี้วัดสิ่งที่ harness วัดไม่ได้:
//     หลายขั้นต่อกัน (request → waiting → paid → poll ซ้ำ) · QR รุ่นก่อนจ่าย · sweep (query field · lease · นับ) · กันซ้ำจริงบนฐานเดียว
"use strict";
process.env.TZ = "Asia/Bangkok";
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// ── Firestore ปลอม: doc get/set/update · where ==/in/>=/<= ต่อกันได้ + orderBy + limit + select · runTransaction (เขียนหลัง fn จบ) · batch ──
let DATA = {};
let WRITES = [];
let QUERIES = [];
const getColl = (c) => (DATA[c] = DATA[c] || {});
const msOf = (v) => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : null);
function ref(c, id) {
  const r = {
    id, path: `${c}/${id}`,
    get: async () => ({ exists: getColl(c)[id] !== undefined, id, data: () => getColl(c)[id] }),
    set: async (v) => { WRITES.push({ op: "set", path: r.path, data: v }); getColl(c)[id] = { ...v }; },
    update: async (v) => { WRITES.push({ op: "update", path: r.path, data: v }); getColl(c)[id] = { ...(getColl(c)[id] || {}), ...v }; },
  };
  return r;
}
let auto = 0;
function query(c, state) {
  const st = state || { filters: [], lim: null, order: null };
  const cmp = (dv, op, v) => {
    const a = msOf(dv), b = msOf(v);
    if (a !== null && b !== null && (dv instanceof Date || v instanceof Date)) { dv = a; v = b; }
    if (op === "==") return dv === v;
    if (op === "in") return Array.isArray(v) && v.includes(dv);
    if (op === ">=") return dv >= v;
    if (op === "<=") return dv <= v;
    if (op === ">") return dv > v;
    if (op === "<") return dv < v;
    throw new Error(`fake db: op ${op} ไม่รองรับ`);
  };
  const run = async () => {
    QUERIES.push({ coll: c, filters: st.filters.map(([f, op]) => [f, op]), order: st.order });
    let docs = Object.entries(getColl(c)).filter(([, d]) => d && st.filters.every(([f, op, v]) => cmp(d[f], op, v)));
    if (st.order) docs.sort(([, a], [, b]) => ((msOf(a[st.order[0]]) || 0) - (msOf(b[st.order[0]]) || 0)) * (st.order[1] === "desc" ? -1 : 1));
    docs = docs.map(([id, d]) => ({ id, exists: true, data: () => d, get: (k) => d[k] }));
    if (st.lim != null) docs = docs.slice(0, st.lim);
    return { empty: !docs.length, size: docs.length, docs };
  };
  const api = {
    where: (f, op, v) => query(c, { ...st, filters: [...st.filters, [f, op, v]] }),
    orderBy: (f, dir) => query(c, { ...st, order: [f, dir || "asc"] }),
    limit: (n) => query(c, { ...st, lim: n }),
    select: () => api,
    get: run,
  };
  return api;
}
const fakeDb = {
  collection: (c) => ({ doc: (id) => ref(c, id === undefined ? `auto${++auto}` : id), where: (f, op, v) => query(c).where(f, op, v), orderBy: (f, d) => query(c).orderBy(f, d) }),
  runTransaction: async (fn) => {
    const queued = [];
    const tx = { get: (r) => r.get(), set: (r, v) => { queued.push(() => r.set(v)); return tx; }, update: (r, v) => { queued.push(() => r.update(v)); return tx; } };
    const out = await fn(tx);
    for (const q of queued) await q();
    return out;
  },
  batch: () => { const ops = []; const b = { set: (r, v) => { ops.push(() => r.set(v)); return b; }, commit: async () => { for (const o of ops) await o(); } }; return b; },
};
const { FieldValue } = require("../_shared/fakeFieldValue");
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {}, FieldValue } };

// logic / schema: ใช้ตัวที่ติดตั้ง · ยังไม่มีของ DEV-0003 = ใช้ build ของ center แทน (บอกไว้ที่หัวไฟล์)
const CENTER = path.resolve(__dirname, "../../../../shopchamp-center");
const logicAbs = require.resolve("@shopchamp/logic");
if (typeof require("@shopchamp/logic").companyVipRenewal !== "function") {
  const src = path.join(CENTER, "packages/logic/src/index.js");
  assert.ok(fs.existsSync(src), "ไม่พบ center packages/logic และ node_modules ยังไม่มี companyVipRenewal");
  require.cache[logicAbs] = { id: logicAbs, filename: logicAbs, loaded: true, exports: require(src) };
}
const schemaAbs = require.resolve("@shopchamp/schema");
if (!require("@shopchamp/schema").CompanyPayRequestRequest) {
  const dist = path.join(CENTER, "packages/schema/dist/index.cjs");
  assert.ok(fs.existsSync(dist), "ไม่พบ center packages/schema/dist และ node_modules ยังไม่มี CompanyPayRequestRequest (รัน tsup ใน packages/schema)");
  const built = require(dist);
  assert.ok(built.CompanyPayRequestRequest, "dist ของ center ยังไม่มี CompanyPayRequestRequest · build ใหม่");
  require.cache[schemaAbs] = { id: schemaAbs, filename: schemaAbs, loaded: true, exports: built };
}

// 🔴 กันออกเน็ต: ใครเรียก http ของ posxpayClient = เทสล้มทันที
const PXP = require("../gateway/providers/posxpay");
PXP._setHttp((cfg) => { throw new Error(`เทสยิงเน็ต ${cfg.method} ${cfg.url}`); });
after(() => PXP._resetHttp());

const PC = require("./_payCheck");
const { payRequest } = require("./payRequest");
const { payStatus } = require("./payStatus");
const SW = require("./paySweep");
const { ROUTES } = require("../routes");
const WL = require("../workloads");

const NOW = new Date("2026-11-10T03:00:00.000Z"); // 10 พ.ย. 2026 10:00 ไทย
const MIN = 60000;
const UP = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const UH = "1c6b7a2e-4f3d-4c1b-8a9e-2d3c4b5a6f70";
const UI = "5d2e9f10-7a6b-4c8d-9e0f-1a2b3c4d5e6f";
const US = "7e8f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ENV = { COMPANY_POSXPAY_TOKEN: "tok-ห้ามหลุด", COMPANY_POSXPAY_SERIAL: "SER-1" };
const QR = "00020101021230830016A0000006770101120115TEST5802TH53037645406350.006304ABCD";
const PACKAGE_DOC = { value: [{ name: "พรีเมี่ยม", type: "premium", status: true, price: [{ id: "1", price: 350, save: 0, day: "1 เดือน" }, { id: "2", price: 3500, save: 700, day: "12 เดือน" }] }], admin: ["u-company"] };
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const WATCHER = { shopAccess: { shopId: "shopA", uid: "u-watch", role: "owner", rights: [], watcher: true, readOnly: true } };

function setup(over) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านทดสอบ", vip: [], currentPackage: [], imageMore: 0 }, shopB: { shopId: "shopB", name: "ร้านอื่น", vip: [] } },
    admin: { package: PACKAGE_DOC },
    packageOrder: { [UP]: { shopId: "shopA", profileId: "u-owner", net: 350, status: "order", packageId: ["1"], orderUUID: UP } },
    hardwareOrder: { [UH]: { shopId: "shopA", profileId: "u-owner", net: 1705, status: "order", orderUUID: UH } },
    imageOrder: { [UI]: { shopId: "shopA", profileId: "u-owner", net: 300, qty: 3000, status: "order", orderUUID: UI } },
    stockOrder: { [US]: { shopId: "shopA", profileId: "u-owner", price: 100, qty: 1000, id: 2, status: "order", orderUUID: US } },
    ...(over || {}),
  };
  WRITES = []; QUERIES = []; auto = 0;
}

// provider ปลอม: บันทึกการเรียก · inquiry ตอบตามตารางต่อ providerRef (หรือค่าเดียว)
let CALLS;
let PXREF = 1468843;
function fakeProvider({ create, inquiry } = {}) {
  CALLS = { createQR: [], inquiry: [], push: [] };
  return {
    env: ENV,
    now: () => NOW,
    createQR: async (args) => { CALLS.createQR.push(args); if (create === "down") return { ok: false, error: { code: "posxpay_http_500", message: "PosXPay HTTP 500" } }; const providerRef = String(PXREF++); return { ok: true, data: { providerRef, chargeId: providerRef, qrPayload: QR, qrKind: "text" } }; },
    inquiry: async (args) => {
      CALLS.inquiry.push(args);
      const a = typeof inquiry === "function" ? inquiry(args) : inquiry;
      if (a === "down") return { ok: false, error: { code: "posxpay_timeout", message: "PosXPay request timed out" } };
      if (!a || a === "waiting") return { ok: true, data: { state: "waiting", amountPaid: null, raw: {} } };
      if (a === "closed" || a === "error") return { ok: true, data: { state: a, amountPaid: null, raw: {} } };
      // {paid: บาท} = ตอบ success แล้วเทียบ expectedAmount เอง (เหมือน provider จริง)
      const paid = Number(a.paid);
      const match = Math.round(paid * 100) === Math.round(Number(args.expectedAmount) * 100);
      return { ok: true, data: { state: match ? "paid" : "amount_mismatch", amountPaid: paid, raw: {} } };
    },
    push: async (m) => { CALLS.push.push(m); return { sent: 1 }; },
  };
}
async function call(handler, req, body) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ ...req, body }, res);
  return res;
}
const reqBody = (kind, u, shopId = "shopA") => ({ shopId, kind, orderUUID: u });
const payDoc = (kind, u) => DATA.companyPay && DATA.companyPay[`${kind}-${u}`];

beforeEach(() => setup());

// ── ① config ──
test("companyPayConfig: ไม่มี secret = deny 503 company_pay_unconfigured บอกชื่อที่ขาด · มีครบ = ok (ไม่ยิงเน็ต)", () => {
  assert.deepEqual(PC.companyPayConfig({}), { ok: false, status: 503, error: "company_pay_unconfigured", message: "ระบบชำระเงินอัตโนมัติยังไม่ได้ตั้งค่า กรุณาติดต่อทีมงาน", extra: { missing: ["COMPANY_POSXPAY_TOKEN", "COMPANY_POSXPAY_SERIAL"] } });
  assert.deepEqual(PC.companyPayConfig({ COMPANY_POSXPAY_TOKEN: "t" }).extra.missing, ["COMPANY_POSXPAY_SERIAL"]);
  assert.deepEqual(PC.companyPayConfig({ COMPANY_POSXPAY_TOKEN: " t ", COMPANY_POSXPAY_SERIAL: "s" }), { ok: true, serial: "s", token: "t" });
  assert.deepEqual(PC.SECRETS, WL.COMPANY_PAY_SECRETS, "ชื่อ secret ที่โค้ดอ่าน = ที่ผูกกับ function");
});

// ── ② payRequest ──
test("payRequest 4 ชนิด: ยอดจากใบ (net · stock ใช้ price) · ref1 <kind>:<uuid> ref2 shopchamp · doc companyPay/<kind>-<uuid> status request expireAt +15 นาที · ไม่แตะใบ/ร้าน", async () => {
  const deps = fakeProvider();
  const h = payRequest(deps);
  const want = { package: [UP, 35000], hardware: [UH, 170500], image: [UI, 30000], stock: [US, 10000] };
  for (const [kind, [u, satang]] of Object.entries(want)) {
    const r = await call(h, OWNER, reqBody(kind, u));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.kind, r.body.orderUUID, r.body.amountSatang, r.body.amount, r.body.qrPayload, r.body.qrKind, r.body.expireAt, r.body.reused], [true, kind, u, satang, satang / 100, QR, "text", "2026-11-10T03:15:00.000Z", false]);
    const d = payDoc(kind, u);
    assert.deepEqual([d.kind, d.orderUUID, d.shopId, d.orderShopId, d.amountSatang, d.amount, d.status, d.ref1, d.ref2, d.attempts, d.requestCount, d.priorRefs, d.requestedBy, d.leaseUntil], [kind, u, "shopA", "shopA", satang, satang / 100, "request", `${kind}:${u}`, "shopchamp", 0, 1, [], "u-owner", null]);
    assert.ok(d.createdAt instanceof Date && d.createdAt.getTime() === NOW.getTime(), "createdAt = now (sweep query ใช้ช่องนี้)");
    assert.equal(d.expireAt.getTime(), NOW.getTime() + 15 * MIN);
    assert.match(d.providerRef, /^\d{7}$/, "providerRef = orderId ของ posxpay เก็บเป็นข้อความ");
    assert.equal(d.qrPayload, QR);
    assert.equal(JSON.stringify(d).includes(ENV.COMPANY_POSXPAY_TOKEN), false, "token ไม่ลง doc");
  }
  assert.equal(CALLS.createQR.length, 4);
  assert.deepEqual(CALLS.createQR.map((c) => [c.amount, c.ref1, c.ref2, c.config.serial, c.config.token, c.channel.channelId]), [[350, `package:${UP}`, "shopchamp", "SER-1", "tok-ห้ามหลุด", "posxpayPromptPay"], [1705, `hardware:${UH}`, "shopchamp", "SER-1", "tok-ห้ามหลุด", "posxpayPromptPay"], [300, `image:${UI}`, "shopchamp", "SER-1", "tok-ห้ามหลุด", "posxpayPromptPay"], [100, `stock:${US}`, "shopchamp", "SER-1", "tok-ห้ามหลุด", "posxpayPromptPay"]]);
  assert.deepEqual(WRITES.map((w) => w.path), [`companyPay/package-${UP}`, `companyPay/hardware-${UH}`, `companyPay/image-${UI}`, `companyPay/stock-${US}`], "เขียนแค่ doc จ่าย");
  assert.equal(DATA.packageOrder[UP].status, "order");
  assert.deepEqual(DATA.shop.shopA.vip, []);
});

test("payRequest: QR ที่ยังไม่หมดอายุ = คืนเดิม ไม่ยิงซ้ำ · หมดอายุแล้ว = ออกใหม่ ref เดิมไป priorRefs · doc paid = 409 already_paid", async () => {
  const deps = fakeProvider();
  const h = payRequest(deps);
  const first = await call(h, OWNER, reqBody("package", UP));
  const ref1 = payDoc("package", UP).providerRef;
  // กดซ้ำทันที (now เท่าเดิม) = QR เดิม
  const again = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([again.code, again.body.reused, again.body.qrPayload, again.body.expireAt], [200, true, first.body.qrPayload, first.body.expireAt]);
  assert.equal(CALLS.createQR.length, 1);
  assert.equal(WRITES.length, 1);
  // เลยหมดอายุ 16 นาที = ออกใหม่
  deps.now = () => new Date(NOW.getTime() + 16 * MIN);
  const re = await call(h, OWNER, reqBody("package", UP));
  const d = payDoc("package", UP);
  assert.deepEqual([re.code, re.body.reused, CALLS.createQR.length, d.requestCount, d.providerRef !== ref1, d.priorRefs.map((p) => [p.providerRef, p.status])], [200, false, 2, 2, true, [[ref1, "request"]]]);
  assert.equal(re.body.expireAt, new Date(NOW.getTime() + 31 * MIN).toISOString());
  // จ่ายแล้ว = ปัด
  DATA.companyPay[`package-${UP}`].status = "paid";
  const paid = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([paid.code, paid.body.error, CALLS.createQR.length], [409, "already_paid", 2]);
});

test("payRequest: ไม่มี secret = 503 ไม่ยิง ไม่เขียน · posxpay ล่ม = 502 ไม่เขียน · ใบร้านอื่น 409 · ใบเปิดแล้ว 409 · watcher 403 · wrong_shop 403 · kind แปลก 400", async () => {
  const deps = fakeProvider();
  const noSecret = await call(payRequest({ ...deps, env: {} }), OWNER, reqBody("package", UP));
  assert.deepEqual([noSecret.code, noSecret.body.error, noSecret.body.missing, CALLS.createQR.length, WRITES.length], [503, "company_pay_unconfigured", ["COMPANY_POSXPAY_TOKEN", "COMPANY_POSXPAY_SERIAL"], 0, 0]);
  const down = await call(payRequest(fakeProvider({ create: "down" })), OWNER, reqBody("package", UP));
  assert.deepEqual([down.code, down.body.error, down.body.code, CALLS.createQR.length, WRITES.length, payDoc("package", UP)], [502, "provider_error", "posxpay_http_500", 1, 0, undefined]);
  const h = payRequest(fakeProvider());
  const other = await call(h, { shopAccess: { shopId: "shopB", uid: "u-b", role: "owner", rights: [] } }, reqBody("package", UP, "shopB"));
  assert.deepEqual([other.code, other.body.error], [409, "order_other_shop"]);
  DATA.packageOrder[UP].status = "success";
  const opened = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([opened.code, opened.body.error], [409, "order_already_fulfilled"]);
  DATA.packageOrder[UP].status = "cancel";
  assert.equal((await call(h, OWNER, reqBody("package", UP))).body.error, "order_cancelled");
  DATA.packageOrder[UP].status = "order";
  assert.deepEqual([(await call(h, WATCHER, reqBody("package", UP))).code, (await call(h, OWNER, reqBody("package", UP, "shopB"))).body.error, (await call(h, OWNER, { ...reqBody("package", UP), kind: "software" })).code, (await call(h, OWNER, { ...reqBody("package", UP), amount: 1 })).code], [403, "wrong_shop", 400, 400]);
  assert.equal(CALLS.createQR.length, 0, "ทางปัดทั้งหมดไม่ยิง");
  assert.equal(WRITES.length, 0);
});

// ── ③ payStatus / checkCompanyPay — หลายขั้นต่อกันบนฐานเดียว ──
test("เส้นหลัก: request → waiting → เงินเข้า 350 → fulfill(auto) เปิดแพ็กเกจ + push 1 ครั้ง → poll ซ้ำ 2 ครั้ง = ไม่ถาม posxpay ไม่เปิดซ้ำ ไม่ push ซ้ำ", async () => {
  let provider = "waiting";
  const deps = fakeProvider({ inquiry: () => provider });
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  const h = payStatus(deps);
  const w = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([w.code, w.body.state, w.body.final, w.body.transient, w.body.amount, w.body.expireAt], [200, "waiting", false, undefined, 350, "2026-11-10T03:15:00.000Z"]);
  assert.deepEqual([payDoc("package", UP).status, payDoc("package", UP).attempts, CALLS.inquiry.length, CALLS.push.length], ["request", 1, 1, 0]);
  assert.deepEqual(CALLS.inquiry[0].providerRef, payDoc("package", UP).providerRef);
  assert.equal(CALLS.inquiry[0].expectedAmount, 350);
  assert.equal("providerRef" in w.body, false, "ไม่คืนเลขของผู้ให้บริการให้จอ");

  provider = { paid: 350 };
  const p = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([p.code, p.body.state, p.body.final, p.body.fulfilled, p.body.paidSatang], [200, "paid", true, { duplicate: false, status: "success" }, 35000]);
  const o = DATA.packageOrder[UP];
  assert.deepEqual([o.status, o.approveId, o.paidVia, o.payment], ["success", "system:posxpay", "auto", { provider: "posxpay", providerRef: payDoc("package", UP).providerRef, paidSatang: 35000 }]);
  assert.deepEqual([DATA.shop.shopA.IsVip, DATA.shop.shopA.currentPackage, DATA.shop.shopA.vip.map((v) => v.type)], [true, [1], ["premium"]]);
  const d = payDoc("package", UP);
  assert.deepEqual([d.status, d.paidSatang, d.providerRefPaid, d.fulfilled.duplicate, d.fulfilled.status, d.attempts, d.leaseUntil], ["paid", 35000, d.providerRef, false, "success", 2, null]);
  assert.deepEqual(CALLS.push.map((m) => [m.heading, m.to]), [["อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!", { kind: "people", ids: ["u-owner"] }]]);
  const writesBefore = WRITES.length;
  const vipExpire = DATA.shop.shopA.vip[0].expire.getTime();

  for (let i = 0; i < 2; i++) {
    const again = await call(h, OWNER, reqBody("package", UP));
    assert.deepEqual([again.code, again.body.state, again.body.final, again.body.fulfilled], [200, "paid", true, { duplicate: false, status: "success" }]);
  }
  assert.deepEqual([CALLS.inquiry.length, CALLS.push.length, WRITES.length, DATA.shop.shopA.vip[0].expire.getTime(), DATA.shop.shopA.currentPackage], [2, 1, writesBefore, vipExpire, [1]], "จบแล้ว = ไม่ถาม ไม่เขียน ไม่ต่ออายุซ้ำ ไม่ push ซ้ำ");
});

test("ยอดไม่ตรง: provider ตอบ amount_mismatch → problem ไม่เปิดของ ไม่ push · ชั้นสอง: provider ตอบ paid ตรง doc แต่ใบจริงยอดอื่น → fulfill ปัด amount_mismatch → problem", async () => {
  const deps = fakeProvider({ inquiry: { paid: 1 } }); // จ่ายมา 1 บาท
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  const r = await call(payStatus(deps), OWNER, reqBody("package", UP));
  assert.deepEqual([r.code, r.body.state, r.body.final, r.body.reason, r.body.paidSatang], [200, "problem", true, "amount_mismatch", 100]);
  const d = payDoc("package", UP);
  assert.deepEqual([d.status, d.problem.code, d.problem.extra, d.paidSatang, d.providerRefPaid], ["problem", "amount_mismatch", { expectedSatang: 35000, paidSatang: 100 }, 100, d.providerRef]);
  assert.deepEqual([DATA.packageOrder[UP].status, DATA.shop.shopA.vip, CALLS.push.length], ["order", [], 0]);
  // problem เป็นสถานะจบ: poll ซ้ำไม่ถามอีก · ขอ QR ใหม่ถูกปัด (ทีมงานตัดสิน)
  const again = await call(payStatus(deps), OWNER, reqBody("package", UP));
  assert.deepEqual([again.body.state, again.body.reason, CALLS.inquiry.length], ["problem", "amount_mismatch", 1]);
  assert.deepEqual((await call(payRequest(deps), OWNER, reqBody("package", UP))).body.error, "company_pay_problem");

  // ชั้นสอง: doc บอก 35000 · provider ตอบ paid 350 (ตรง doc) · แต่ใบจริงถูกแก้เป็น 3500
  setup();
  const deps2 = fakeProvider({ inquiry: { paid: 350 } });
  await call(payRequest(deps2), OWNER, reqBody("package", UP));
  DATA.packageOrder[UP].net = 3500;
  const r2 = await call(payStatus(deps2), OWNER, reqBody("package", UP));
  assert.deepEqual([r2.body.state, r2.body.reason, DATA.packageOrder[UP].status, DATA.shop.shopA.vip.length, CALLS.push.length], ["problem", "amount_mismatch", "order", 0, 0]);
  assert.deepEqual(payDoc("package", UP).problem.extra, { kind: "package", orderUUID: UP, expectedSatang: 350000, paidSatang: 35000 });
});

test("เงินเข้าแต่ใบถูกยกเลิก → fulfill ปัด order_cancelled → problem (ไม่เงียบ · ใบ/ร้านไม่ถูกแตะ)", async () => {
  const deps = fakeProvider({ inquiry: { paid: 350 } });
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  DATA.packageOrder[UP].status = "cancel";
  const r = await call(payStatus(deps), OWNER, reqBody("package", UP));
  assert.deepEqual([r.body.state, r.body.reason, payDoc("package", UP).status, payDoc("package", UP).problem.code, payDoc("package", UP).paidSatang, DATA.shop.shopA.vip, CALLS.push.length], ["problem", "order_cancelled", "problem", "order_cancelled", 35000, [], 0]);
});

test("ใบเปิดไว้ก่อน (อนุมัติมือ) + เงินเข้า → fulfill duplicate → doc paid · ไม่เขียนใบ/ร้าน · ไม่ push", async () => {
  const deps = fakeProvider({ inquiry: { paid: 350 } });
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  DATA.packageOrder[UP] = { ...DATA.packageOrder[UP], status: "success", approveId: "staff-1" };
  const n = WRITES.length;
  const r = await call(payStatus(deps), OWNER, reqBody("package", UP));
  assert.deepEqual([r.body.state, r.body.fulfilled, payDoc("package", UP).status, payDoc("package", UP).fulfilled.duplicate, CALLS.push.length], ["paid", { duplicate: true, status: "success" }, "paid", true, 0]);
  assert.deepEqual(WRITES.slice(n).map((w) => w.path), [`companyPay/package-${UP}`]);
  assert.equal(DATA.packageOrder[UP].approveId, "staff-1");
});

test("posxpay ล่ม = transient: state waiting · status ยัง request · เขียนแค่ attempts/lastError · ไม่ push · พอฟื้นแล้วจ่าย = paid ตามปกติ · ค่าที่ไม่รู้จัก = transient", async () => {
  let mode = "down";
  const deps = fakeProvider({ inquiry: () => mode });
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  const h = payStatus(deps);
  const r = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([r.code, r.body.state, r.body.transient, r.body.reason, r.body.final], [200, "waiting", true, "posxpay_timeout", false]);
  let d = payDoc("package", UP);
  assert.deepEqual([d.status, d.attempts, d.lastError.code, DATA.packageOrder[UP].status, CALLS.push.length], ["request", 1, "posxpay_timeout", "order", 0]);
  mode = "error";
  const e = await call(h, OWNER, reqBody("package", UP));
  assert.deepEqual([e.body.state, e.body.transient, e.body.reason, payDoc("package", UP).status, payDoc("package", UP).attempts], ["waiting", true, "provider_unknown_state", "request", 2]);
  mode = { paid: 350 };
  const p = await call(h, OWNER, reqBody("package", UP));
  d = payDoc("package", UP);
  assert.deepEqual([p.body.state, d.status, d.attempts, DATA.packageOrder[UP].status, CALLS.push.length], ["paid", "paid", 3, "success", 1]);
});

test("closed · expired · QR รุ่นก่อนจ่าย (เงินเข้าใบเก่าหลังขอใหม่) → เปิดของด้วย ref เก่า", async () => {
  // closed
  const dc = fakeProvider({ inquiry: "closed" });
  await call(payRequest(dc), OWNER, reqBody("package", UP));
  const c = await call(payStatus(dc), OWNER, reqBody("package", UP));
  assert.deepEqual([c.body.state, c.body.final, payDoc("package", UP).status, DATA.packageOrder[UP].status], ["closed", true, "closed", "order"]);
  // ขอใหม่ได้หลัง closed
  const re = await call(payRequest(dc), OWNER, reqBody("package", UP));
  assert.deepEqual([re.code, re.body.reused, payDoc("package", UP).status, payDoc("package", UP).priorRefs.length], [200, false, "request", 1]);

  // expired: เลย 15 นาที ยัง pending
  setup();
  const de = fakeProvider({ inquiry: "waiting" });
  await call(payRequest(de), OWNER, reqBody("package", UP));
  de.now = () => new Date(NOW.getTime() + 16 * MIN);
  const ex = await call(payStatus(de), OWNER, reqBody("package", UP));
  assert.deepEqual([ex.body.state, ex.body.final, payDoc("package", UP).status, payDoc("package", UP).expiredAt.getTime()], ["expired", false, "expired", NOW.getTime() + 16 * MIN]);
  // expired แล้วเงินเข้าทีหลัง (sweep/poll) = เปิดของ
  const dl = { ...de, ...fakeProvider({ inquiry: { paid: 350 } }), now: () => new Date(NOW.getTime() + 60 * MIN) };
  const late = await call(payStatus(dl), OWNER, reqBody("package", UP));
  assert.deepEqual([late.body.state, DATA.packageOrder[UP].status, CALLS.push.length], ["paid", "success", 1]);

  // QR รุ่นก่อนจ่าย: ขอใบแรก (ref A) → หมดอายุ → ขอใบใหม่ (ref B) → posxpay บอก A success · B pending
  setup();
  const table = {};
  const dp = fakeProvider({ inquiry: (args) => table[args.providerRef] || "waiting" });
  await call(payRequest(dp), OWNER, reqBody("package", UP));
  const refA = payDoc("package", UP).providerRef;
  dp.now = () => new Date(NOW.getTime() + 20 * MIN);
  await call(payRequest(dp), OWNER, reqBody("package", UP));
  const refB = payDoc("package", UP).providerRef;
  assert.notEqual(refA, refB);
  table[refA] = { paid: 350 };
  const r = await call(payStatus(dp), OWNER, reqBody("package", UP));
  assert.deepEqual([r.body.state, payDoc("package", UP).providerRefPaid, DATA.packageOrder[UP].payment.providerRef, CALLS.inquiry.map((x) => x.providerRef)], ["paid", refA, refA, [refB, refA]], "ถาม ref ปัจจุบันก่อน แล้วรุ่นก่อน · เปิดของด้วย ref ที่จ่ายจริง");
});

test("payStatus ด่าน: ไม่มี doc 404 · doc ร้านอื่น 409 · ไม่มี secret + doc รอ = 503 ไม่ยิง · ไม่มี secret + doc จบ = ตอบจาก doc · watcher 403", async () => {
  const deps = fakeProvider({ inquiry: { paid: 350 } });
  const h = payStatus(deps);
  assert.deepEqual([(await call(h, OWNER, reqBody("package", UP))).code, (await call(h, OWNER, reqBody("package", UP))).body.error], [404, "company_pay_not_found"]);
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  const other = await call(h, { shopAccess: { shopId: "shopB", uid: "u-b", role: "owner", rights: [] } }, reqBody("package", UP, "shopB"));
  assert.deepEqual([other.code, other.body.error, "state" in other.body], [409, "company_pay_other_shop", false]);
  const ns = await call(payStatus({ ...deps, env: {} }), OWNER, reqBody("package", UP));
  assert.deepEqual([ns.code, ns.body.error, CALLS.inquiry.length, payDoc("package", UP).status], [503, "company_pay_unconfigured", 0, "request"]);
  assert.deepEqual([(await call(h, WATCHER, reqBody("package", UP))).code, CALLS.inquiry.length], [403, 0]);
  await call(h, OWNER, reqBody("package", UP)); // paid
  const fin = await call(payStatus({ ...deps, env: {} }), OWNER, reqBody("package", UP));
  assert.deepEqual([fin.code, fin.body.state, CALLS.inquiry.length], [200, "paid", 1]);
});

test("checkCompanyPay โดยตรง (ทางที่ office/sweep เรียก): รูปคำขอผิด 400 · คืน push ให้ผู้เรียกส่งเอง", async () => {
  const deps = fakeProvider({ inquiry: { paid: 300 } });
  await call(payRequest(deps), OWNER, reqBody("image", UI));
  for (const bad of [{ kind: "x", orderUUID: UI, now: NOW, env: ENV }, { kind: "image", orderUUID: "a/b", now: NOW, env: ENV }, { kind: "image", orderUUID: UI, now: "today", env: ENV }]) {
    await assert.rejects(PC.checkCompanyPay(bad), (e) => e instanceof PC.Refusal && e.deny.status === 400);
  }
  const r = await PC.checkCompanyPay({ kind: "image", orderUUID: UI, now: NOW, env: ENV, deps });
  assert.deepEqual([r.state, r.final, r.docId, r.amountSatang, r.fulfilled, r.push.heading, DATA.shop.shopA.imageMore, CALLS.push.length], ["paid", true, `image-${UI}`, 30000, { duplicate: false, status: "success" }, "เพิ่มพื้นที่เก็บไฟล์ 3000 รูปภาพเรียบร้อย", 3000, 0]);
});

// ── ④ sweep ──
test("sweep: query ใช้ช่อง createdAt ที่ payRequest เขียนจริง · เลือกเฉพาะ request/expired < 24 ชม. · ข้าม paid/เก่ากว่า 24 ชม./ที่ถูก lease · เปิดของ + push · ปลด lease · log สรุป", async () => {
  const deps = fakeProvider({ inquiry: (a) => (a.providerRef === "PAYME" ? { paid: 350 } : "waiting") });
  // ใบที่จะจ่าย: สร้างผ่าน payRequest จริง (ไม่เขียน seed มือ ⇒ ถ้า payRequest เปลี่ยนชื่อช่อง เทสนี้แดง)
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  DATA.companyPay[`package-${UP}`].providerRef = "PAYME";
  await call(payRequest(deps), OWNER, reqBody("image", UI)); // ยังรอ
  const mk = (id, over) => { DATA.companyPay[id] = { ...DATA.companyPay[`image-${UI}`], ...over }; };
  mk(`hardware-${UH}`, { kind: "hardware", orderUUID: UH, amountSatang: 170500, providerRef: "OLD", createdAt: new Date(NOW.getTime() - 25 * 60 * MIN), status: "request" }); // เก่ากว่า 24 ชม.
  mk(`stock-${US}`, { kind: "stock", orderUUID: US, amountSatang: 10000, providerRef: "P", status: "paid" }); // จบแล้ว
  mk("package-leased", { kind: "package", orderUUID: "leased", providerRef: "L", status: "request", leaseUntil: new Date(NOW.getTime() + 5 * MIN), leaseBy: "other" });
  mk("package-exp", { kind: "package", orderUUID: "exp", providerRef: "E", status: "expired", expireAt: new Date(NOW.getTime() - 5 * MIN) });
  QUERIES = [];
  const logs = [];
  const out = await SW.sweepCompanyPay({ now: new Date(NOW.getTime() + 2 * MIN), env: ENV, deps, log: (l) => logs.push(l), leaseBy: "me" });
  assert.deepEqual(QUERIES.map((q) => [q.coll, q.filters, q.order]).filter((q) => q[0] === "companyPay"), [["companyPay", [["createdAt", ">="]], ["createdAt", "asc"]]], "query ชี้ช่อง createdAt");
  assert.equal(SW.QUERY_FIELD, "createdAt");
  assert.ok(Object.keys(DATA.companyPay[`package-${UP}`]).includes(SW.QUERY_FIELD), "payRequest เขียนช่องที่ query ใช้");
  const { ms, ...rest } = out;
  assert.deepEqual(rest, { ok: true, unconfigured: false, scanned: 5, candidates: 4, checked: 3, paid: 1, closed: 0, expired: 1, problem: 0, waiting: 1, transient: 0, leased: 1, skipped: 0, errors: 0, pushes: 1 });
  assert.deepEqual([DATA.packageOrder[UP].status, payDoc("package", UP).status, CALLS.push.length, payDoc("image", UI).status, payDoc("image", UI).attempts], ["success", "paid", 1, "request", 1]);
  assert.deepEqual(CALLS.inquiry.map((x) => x.providerRef).sort(), ["E", "PAYME", payDoc("image", UI).providerRef].sort(), "ไม่ถามใบที่ lease อยู่ · ใบ paid · ใบเก่ากว่า 24 ชม.");
  assert.deepEqual([payDoc("image", UI).leaseUntil, DATA.companyPay["package-exp"].leaseUntil, DATA.companyPay["package-leased"].leaseBy], [null, null, "other"], "ปลด lease ของตัวเอง · ไม่แตะ lease ของคนอื่น");
  assert.ok(logs.some((l) => l.startsWith("companyPaySweep {") && l.includes('"candidates":4') && l.includes('"paid":1')), logs.join("\n"));
});

test("sweep: ไม่มี secret = log ดัง + unconfigured ไม่แตะฐาน ไม่ยิง · ใบหนึ่งพัง (kind แปลก) ไม่หยุดใบอื่น · ไม่มีงานก็ยัง log 0", async () => {
  const deps = fakeProvider({ inquiry: { paid: 350 } });
  await call(payRequest(deps), OWNER, reqBody("package", UP));
  QUERIES = [];
  const logs = [];
  const nc = await SW.sweepCompanyPay({ now: NOW, env: {}, deps, log: (l) => logs.push(l) });
  assert.deepEqual([nc.ok, nc.unconfigured, QUERIES.length, CALLS.inquiry.length, logs.length > 0 && /unconfigured/.test(logs[0])], [false, true, 0, 0, true]);
  DATA.companyPay["bad-1"] = { ...DATA.companyPay[`package-${UP}`], kind: "software", orderUUID: "x", createdAt: new Date(NOW.getTime() - MIN) };
  const out = await SW.sweepCompanyPay({ now: NOW, env: ENV, deps, log: (l) => logs.push(l) });
  assert.deepEqual([out.candidates, out.checked, out.paid, out.errors, DATA.companyPay["bad-1"].leaseUntil, DATA.packageOrder[UP].status], [2, 1, 1, 1, null, "success"]);
  const empty = await SW.sweepCompanyPay({ now: new Date(NOW.getTime() + 48 * 60 * MIN), env: ENV, deps, log: (l) => logs.push(l) });
  assert.deepEqual([empty.scanned, empty.candidates], [0, 0]);
  assert.ok(logs[logs.length - 1].includes('"scanned":0'), "รอบว่างก็ต้องพิมพ์สรุป");
});

// ── ⑤ ผูกเข้าระบบ ──
test("route + function: 2 เส้นอยู่ pos auth shop · secret 2 ตัวผูกทั้ง pos และ companyPaySweep · ตารางสถานะที่ _payCheck ประกาศ", () => {
  const rows = ROUTES.filter((r) => /^company\.pay/.test(r.contract));
  assert.deepEqual(rows.map((r) => [r.contract, r.path, r.fn, r.auth, typeof r.load()]), [["company.payRequest", "/company/pay-request", "pos", "shop", "function"], ["company.payStatus", "/company/pay-status", "pos", "shop", "function"]]);
  for (const s of PC.SECRETS) {
    assert.ok(WL.FUNCTION_CONFIG.pos.secrets.includes(s), `pos ไม่ได้ผูก ${s}`);
    assert.ok(WL.SWEEP_CONFIG.secrets.includes(s), `companyPaySweep ไม่ได้ผูก ${s}`);
  }
  assert.deepEqual([WL.SWEEP_SCHEDULE.schedule, WL.SWEEP_SCHEDULE.timeZone, WL.SWEEP_CONFIG.maxInstances], ["every 5 minutes", "Asia/Bangkok", 1]);
  assert.deepEqual([...PC.STATES], ["request", "paid", "closed", "expired", "problem"]);
  assert.deepEqual([[...PC.OPEN_STATES], [...PC.FINAL_STATES], PC.REF2, PC.EXPIRE_MS], [["request", "expired"], ["paid", "closed", "problem"], "shopchamp", 15 * MIN]);
  assert.match(fs.readFileSync(path.join(__dirname, "../../index.js"), "utf8"), /^exports\.companyPaySweep = posFunctions\.companyPaySweep;$/m);
});

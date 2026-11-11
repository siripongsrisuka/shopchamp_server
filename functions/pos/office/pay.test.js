// เทส pos/office/pay.js — หน้า "ชำระเงิน" ของ shopchampoffice (DEV-0003 U4)
//   ① payList: ใบรอตรวจ 4 ชนิด + companyPay · problem บนสุด · ใบจ่ายที่ใบเปิดของแล้วอ่านทีละ doc · watcher ดูได้ · คนนอก 403
//   ② payRecheck: เรียก checkCompanyPay ด้วย signature ตรงเป๊ะ ({kind, orderUUID, now, env}) · ส่ง push ที่ได้ · watcher 403
//   ③ orderApprove: fulfill via manual · actor = ผู้กด · push หลังสำเร็จ · duplicate ไม่ส่ง · ใบยกเลิก/เปิดแล้วปัดก่อนเรียก fulfill
//      + ตัวจริงของ _fulfill.js (ชนิดพื้นที่รูป) บนฐานปลอมที่เขียนลงจริง
//   ④ orderCancel: เฉพาะ status order · เงินเข้าแล้วปัด · เขียนใบ + audit ใน transaction เดียว · push ตาม care / silent ไม่ส่ง
//   รัน: node --test functions/pos/office/pay.test.js (จาก shopchamp_server) · ❌ ไม่แตะ Firestore/Auth จริง (แทน functions/firebase ใน require.cache)
//   ไม่มี passkey แล้ว (Pack ถอด 2026-11-11): ส่งช่อง passkey มา = 400 invalid_request ไม่เรียก fulfill ไม่เขียนอะไร
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ── ฐานปลอมที่เขียนลงจริง (where == / >= · orderBy · limit · transaction) ──────
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
  const coll = (c) => {
    let n = 0;
    const q = (st) => {
      const api = {
        where: (f, op, v) => q({ ...st, filters: [...st.filters, [f, op, v]] }),
        orderBy: (f, dir) => q({ ...st, order: [f, dir || "asc"] }),
        limit: (k) => q({ ...st, lim: k }),
        select: () => api,
        get: async () => {
          const ok = (d, [f, op, v]) => {
            const x = d[f];
            if (op === "==") return x === v;
            if (op === ">=") return x !== undefined && x !== null && x >= v;
            if (op === "in") return v.includes(x);
            throw new Error("op " + op);
          };
          let docs = [...store.entries()].filter(([p]) => p.startsWith(c + "/") && p.split("/").length === 2)
            .filter(([, d]) => st.filters.every((fl) => ok(d, fl)))
            .map(([p, d]) => ({ id: p.split("/")[1], exists: true, data: () => clone(d) }));
          if (st.order) {
            const [f, dir] = st.order;
            docs.sort((a, b) => (a.data()[f] - b.data()[f]) * (dir === "desc" ? -1 : 1));
          }
          if (st.lim != null) docs = docs.slice(0, st.lim);
          return { empty: !docs.length, size: docs.length, docs };
        },
      };
      return api;
    };
    const base = q({ filters: [], order: null, lim: null });
    return { doc: (id) => docRef(c, id || `auto${++n}`), where: base.where, orderBy: base.orderBy, limit: base.limit, get: base.get };
  };
  const db = {
    collection: coll,
    runTransaction: async (fn) => {
      const ops = [];
      const creates = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, d) => { ops.push(() => ref.set(d)); return tx; },
        create: (ref, d) => { creates.push(ref.path); ops.push(() => ref.create(d)); return tx; },
        update: (ref, d) => { ops.push(() => ref.update(d)); return tx; },
        delete: (ref) => { ops.push(() => ref.delete()); return tx; },
      };
      const out = await fn(tx);
      for (const p of creates) if (store.has(p)) throw new Error("ALREADY_EXISTS " + p);
      for (const op of ops) await op();
      return out;
    },
    batch: () => {
      const ops = [];
      const b = { set: (r, d) => { ops.push(() => r.set(d)); return b; }, update: (r, d) => { ops.push(() => r.update(d)); return b; }, commit: async () => { for (const o of ops) await o(); } };
      return b;
    },
  };
  return { db, store };
}

let M = {};
let mem;
function fresh(seed) {
  mem = memDb();
  for (const [p, d] of Object.entries(seed || {})) mem.store.set(p, structuredClone(d));
  const fbAbs = require.resolve("../../firebase");
  const { FieldValue } = require("../_shared/fakeFieldValue");
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: mem.db, admin: {}, bucket: {}, FieldValue } };
  for (const f of ["./_officeStore", "./pay", "../company/_fulfill", "../company/_orders"]) delete require.cache[require.resolve(f)];
  M = require("./pay");
}

const ROOT = "rootUid000000000000000001";
const WATCH = "watchUid00000000000000001";
const OUT = "outUid0000000000000000001";
const NOW = new Date("2026-11-10T03:00:00.000Z");
const ago = (min) => new Date(NOW.getTime() - min * 60000);

const baseSeed = () => ({
  "watcher/roster": {
    uids: [ROOT, WATCH], rootUids: [ROOT],
    people: [{ uid: ROOT, email: "root@shopchamp.test", name: "พี่ Root", level: "root" }, { uid: WATCH, email: "watch@shopchamp.test", name: "Watch", level: "watcher" }],
    count: 2, rootCount: 1, rosterSha: "a".repeat(64), via: "center-script",
  },
});
// รูปเดิมที่จอรุ่นก่อนส่ง ไว้พิสูจน์ว่าตอนนี้ถูกปัด
const oldPasskey = { origin: "http://localhost:5173", authResp: { id: "credRoot1", rawId: "credRoot1", type: "public-key", response: { clientDataJSON: "eyJ0", authenticatorData: "SZYN", signature: "MEUC" }, clientExtensionResults: {} } };
const snapshot = () => new Map([...mem.store.entries()].map(([k, v]) => [k, structuredClone(v)]));

let calls;
function deps(extra) {
  calls = { push: [], fulfill: [], check: [] };
  return {
    now: () => new Date(NOW.getTime()),
    push: async (m) => { calls.push.push(m); return { sent: 1 }; },
    ...(extra || {}),
  };
}
async function call(name, body, uid, extra) {
  let code = 0; let out = null;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  const email = uid === ROOT ? "root@shopchamp.test" : uid ? `${uid.slice(0, 5)}@shopchamp.test` : null;
  await M[name](deps(extra))({ body, auth: uid ? { uid, email } : undefined }, res);
  return { code, body: out };
}
const audits = () => [...mem.store.entries()].filter(([k]) => k.startsWith("officeAudit/")).map(([, v]) => v);

const pkgOrder = (over) => ({ shopId: "shopA", shopName: "ร้าน A", profileId: "buyer1", profileName: "คุณซื้อ", tel: "081", timestamp: ago(30), imageId: "https://slip/a.jpg", net: 350, status: "order", packageId: ["11"], orderNumber: "P0001", ...(over || {}) });

// ── ① payList ───────────────────────────────────────────────────────────────
test("payList: รวมใบรอตรวจ 4 ชนิด + companyPay · problem บนสุด · ใบจ่ายที่เปิดของแล้วอ่านใบมาแสดงสถานะ · watcher ดูได้ canAct false", async () => {
  fresh({
    ...baseSeed(),
    "packageOrder/p1": pkgOrder(),
    "packageOrder/p2": pkgOrder({ timestamp: ago(5), net: 3500, orderNumber: "P0002" }),
    "packageOrder/done1": pkgOrder({ status: "success" }),
    "imageOrder/i1": { shopId: "57325", shopName: "ร้าน B", profileId: "b2", timestamp: ago(10), imageId: "https://slip/i.jpg", net: 100, qty: 1000, status: "order" },
    "stockOrder/s1": { shopId: "57325", shopName: "ร้าน B", timestamp: ago(60), imageId: "x", price: 200, qty: 2000, id: 4, status: "order" },
    "hardwareOrder/h1": { shopId: "shopA", shopName: "ร้าน A", timestamp: ago(90), net: 1070, status: "checked", product: [{ name: "เครื่องพิมพ์", qty: 1 }] },
    // จ่าย QR แล้ว แต่ใบยังไม่เปิดของ = problem
    "companyPay/package-p1": { kind: "package", orderUUID: "p1", status: "paid", amountSatang: 35000, providerRef: "R1", updatedAt: ago(2) },
    // รอจ่าย
    "companyPay/image-i1": { kind: "image", orderUUID: "i1", status: "request", amountSatang: 10000, updatedAt: ago(9) },
    // จ่ายแล้วได้ของแล้ว (ใบไม่อยู่ในกองรอตรวจ)
    "companyPay/package-done1": { kind: "package", orderUUID: "done1", status: "paid", amountSatang: 35000, updatedAt: ago(20) },
    // problem ที่ U2 ตั้ง (เก่ากว่าหน้าต่าง 7 วัน ก็ยังต้องขึ้น)
    "companyPay/hardware-h1": { kind: "hardware", orderUUID: "h1", status: "problem", problem: { code: "amount_mismatch", message: "ยอดที่จ่ายไม่เท่ายอดของใบ" }, amountSatang: 100, paidSatang: 90, updatedAt: new Date("2026-10-01T00:00:00Z") },
    // จ่ายแล้วแต่นอกหน้าต่าง = ไม่ขึ้น
    "companyPay/package-old": { kind: "package", orderUUID: "old", status: "paid", amountSatang: 1, updatedAt: new Date("2026-10-01T00:00:00Z") },
  });
  const r = await call("payList", {}, WATCH);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.canAct, false);
  const keys = r.body.rows.map((x) => x.key);
  // problem 2 ตัวบนสุด (ใหม่ก่อน: p1 ใบสั่ง 30 นาทีก่อน · h1 ใบสั่ง 90 นาทีก่อน)
  assert.deepEqual(keys.slice(0, 2), ["package:p1", "hardware:h1"]);
  assert.ok(!keys.includes("package:old"));
  assert.equal(r.body.counts.problem, 2);
  const p1 = r.body.rows[0];
  assert.equal(p1.channel, "posxpay");
  assert.equal(p1.payState, "paid");
  assert.equal(p1.goodsState, "waiting");
  assert.equal(p1.amountSatang, 35000);
  assert.equal(p1.slipUrl, "https://slip/a.jpg");
  const h1 = r.body.rows[1];
  assert.equal(h1.goodsState, "delivered");
  assert.equal(h1.payProblem, "amount_mismatch");
  assert.equal(h1.paidSatang, 90);
  const done = r.body.rows.find((x) => x.key === "package:done1");
  assert.equal(done.goodsState, "delivered");
  assert.equal(done.problem, false);
  const p2 = r.body.rows.find((x) => x.key === "package:p2");
  assert.equal(p2.channel, "slip");
  assert.equal(p2.payState, "slip");
  assert.equal(r.body.rows.find((x) => x.key === "image:i1").payState, "waiting");
  const s1 = r.body.rows.find((x) => x.key === "stock:s1");
  assert.equal(s1.amountSatang, 20000, "ชุดสินค้าใช้ช่อง price");
  assert.deepEqual(s1.detail, { qty: 2000, packId: 4 });
  assert.equal(audits().length, 0, "อ่านอย่างเดียว");
});

test("payList: กรองชนิด · limit ไม่ตัด problem · root canAct true · คนนอก 403 · ไม่ login 401 · field เกิน 400", async () => {
  fresh({
    ...baseSeed(),
    "packageOrder/p1": pkgOrder(),
    "packageOrder/p2": pkgOrder({ timestamp: ago(1) }),
    "packageOrder/p3": pkgOrder({ timestamp: ago(2) }),
    "imageOrder/i1": { shopId: "x", timestamp: ago(1), net: 100, qty: 1000, status: "order" },
    "companyPay/package-p1": { kind: "package", orderUUID: "p1", status: "problem", updatedAt: ago(1) },
  });
  const r = await call("payList", { kinds: ["package"], limit: 1 }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.canAct, true);
  assert.deepEqual(r.body.rows.map((x) => x.key), ["package:p1"]);
  assert.equal(r.body.truncated, true);
  assert.equal(r.body.counts.total, 3);
  assert.equal((await call("payList", {}, OUT)).body.error, "office_no_access");
  assert.equal((await call("payList", {}, undefined)).code, 401);
  assert.equal((await call("payList", { kinds: ["car"] }, ROOT)).code, 400);
  assert.equal((await call("payList", { foo: 1 }, ROOT)).code, 400);
  assert.equal((await call("payList", { limit: 0 }, ROOT)).code, 400);
});

test("payList: ใบที่ยอดหาย = amountSatang null (ไม่ใช่ ฿0)", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder({ net: undefined }) });
  const r = await call("payList", {}, ROOT);
  assert.equal(r.body.rows[0].amountSatang, null);
  assert.equal(r.body.rows[0].amount, null);
});

test("payList: ใบ QR ที่ยังไม่มีสลิป (U2b payMethod qr · imageId '') = QR รอจ่าย ไม่ใช่สลิปรออนุมัติ · แนบสลิปแล้ว (payMethod slip) = แถวสลิป · ใบเดิมไม่มีช่อง = slip", async () => {
  fresh({
    ...baseSeed(),
    "packageOrder/q1": pkgOrder({ imageId: "", payMethod: "qr" }),                               // ร้านกด QR แล้วยังไม่ขอ QR (ไม่มี companyPay)
    "packageOrder/q2": pkgOrder({ imageId: "", payMethod: "qr", timestamp: ago(3) }),            // ขอ QR แล้ว รอจ่าย
    "stockOrder/q3": { shopId: "57325", shopName: "ร้าน B", timestamp: ago(4), imageId: "https://slip/q3.jpg", payMethod: "slip", slipAttachedAt: ago(1), price: 150, qty: 1500, id: 3, status: "order" },
    "packageOrder/p1": pkgOrder({ timestamp: ago(5) }),
    "companyPay/package-q2": { kind: "package", orderUUID: "q2", status: "request", amountSatang: 35000, updatedAt: ago(2) },
  });
  const r = await call("payList", {}, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const row = (k) => r.body.rows.find((x) => x.key === k);
  const q1 = row("package:q1");
  assert.equal(q1.payState, "waiting");
  assert.equal(q1.channel, "posxpay");
  assert.equal(q1.payMethod, "qr");
  assert.equal(q1.slipUrl, null);
  assert.equal(q1.payStatus, null, "ยังไม่มีใบจ่าย · จอไม่โชว์ปุ่มตรวจผู้ให้บริการ");
  assert.equal(q1.problem, false);
  assert.equal(q1.orderStatus, "order", "root ยังอนุมัติมือได้");
  const q2 = row("package:q2");
  assert.equal(q2.payState, "waiting");
  assert.equal(q2.payStatus, "request");
  assert.equal(q2.payMethod, "qr");
  const q3 = row("stock:q3");
  assert.equal(q3.payState, "slip");
  assert.equal(q3.channel, "slip");
  assert.equal(q3.payMethod, "slip");
  assert.equal(q3.slipUrl, "https://slip/q3.jpg");
  const p1 = row("package:p1");
  assert.equal(p1.payState, "slip");
  assert.equal(p1.payMethod, "slip", "ใบเดิมไม่มีช่อง payMethod = สลิป");
  assert.equal(r.body.counts.slip, 2);
  assert.equal(r.body.counts.waiting, 2);
});

// ── ② payRecheck ────────────────────────────────────────────────────────────
test("payRecheck: เรียก checkCompanyPay({kind, orderUUID, now, env}) ตรงเป๊ะ · ได้ของ = ส่ง push ที่คืนมา · audit ok", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  const push = { to: { kind: "people", ids: ["buyer1"] }, heading: "อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!", content: "x" };
  let arg;
  const env = { COMPANY_POSXPAY_TOKEN: "t" };
  const r = await call("payRecheck", { kind: "package", orderUUID: "p1" }, ROOT, {
    env,
    checkCompanyPay: async (a) => { arg = a; return { state: "paid", fulfilled: { duplicate: false, status: "success" }, push }; },
  });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(arg).sort(), ["env", "kind", "now", "orderUUID"]);
  assert.equal(arg.kind, "package");
  assert.equal(arg.orderUUID, "p1");
  assert.ok(arg.now instanceof Date && arg.now.getTime() === NOW.getTime());
  assert.equal(arg.env, env);
  assert.equal(r.body.state, "paid");
  assert.equal(r.body.opened, true);
  assert.deepEqual(calls.push, [push]);
  assert.equal(audits().find((a) => a.action === "pay.recheck").result, "ok");
});

test("payRecheck: ยังรอ = 200 request ไม่ส่ง push · duplicate ไม่ส่งซ้ำ · ตัวตรวจปัด (Refusal) = ส่งต่อรหัส + audit rejected · watcher 403", async () => {
  fresh(baseSeed());
  const w = await call("payRecheck", { kind: "image", orderUUID: "i1" }, ROOT, { checkCompanyPay: async () => ({ state: "request", final: false }) });
  assert.equal(w.body.state, "request");
  assert.equal(w.body.opened, false);
  assert.equal(calls.push.length, 0);
  const d = await call("payRecheck", { kind: "image", orderUUID: "i1" }, ROOT, {
    checkCompanyPay: async () => ({ state: "paid", fulfilled: { duplicate: true, status: "success" }, push: null }),
  });
  assert.equal(d.body.duplicate, true);
  assert.equal(calls.push.length, 0);
  const err = Object.assign(new Error("no_pay"), { deny: { ok: false, status: 404, error: "pay_not_found", message: "ไม่มีใบจ่าย" } });
  const x = await call("payRecheck", { kind: "image", orderUUID: "i1" }, ROOT, { checkCompanyPay: async () => { throw err; } });
  assert.equal(x.code, 404);
  assert.equal(x.body.error, "pay_not_found");
  assert.ok(audits().some((a) => a.action === "pay.recheck" && a.result === "rejected" && a.rejectCode === "pay_not_found"));
  let called = false;
  const wr = await call("payRecheck", { kind: "image", orderUUID: "i1" }, WATCH, { checkCompanyPay: async () => { called = true; return { state: "paid" }; } });
  assert.equal(wr.code, 403);
  assert.equal(wr.body.error, "root_required");
  assert.equal(called, false);
  const bad = await call("payRecheck", { kind: "image", orderUUID: "a/b" }, ROOT, { checkCompanyPay: async () => ({ state: "waiting" }) });
  assert.equal(bad.code, 400);
});

test("payRecheck: ตัวตรวจคืนค่าผิดรูป = 500 (ไม่เดาว่าสำเร็จ)", async () => {
  fresh(baseSeed());
  const r = await call("payRecheck", { kind: "image", orderUUID: "i1" }, ROOT, { checkCompanyPay: async () => ({}) });
  assert.equal(r.code, 500);
});

// ── ③ orderApprove ──────────────────────────────────────────────────────────
test("orderApprove: fulfill via manual actor = ชื่อในทะเบียน · ส่ง push · audit ok ไม่มีรหัสกุญแจ", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  const push = { to: { kind: "people", ids: ["buyer1"] }, heading: "อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!", content: "กรุณากดอัปเดต ข้อมูล 1 ครั้งค่ะ" };
  let arg;
  const fulfill = async (a) => { arg = a; return { ok: true, duplicate: false, kind: a.kind, orderUUID: a.orderUUID, status: "success", effects: { vip: 1 }, push }; };
  const r = await call("orderApprove", { kind: "package", orderUUID: "p1" }, ROOT, { fulfill });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(arg, { kind: "package", orderUUID: "p1", via: "manual", actor: { uid: ROOT, name: "พี่ Root" }, now: NOW });
  assert.deepEqual(calls.push, [push]);
  assert.equal(r.body.status, "success");
  assert.equal(r.body.approveName, "พี่ Root");
  const a = audits().find((x) => x.action === "order.approve");
  assert.equal(a.result, "ok");
  assert.equal(a.passkeyCredentialId, null);
});

test("orderApprove: ใบยกเลิก/เปิดแล้ว/ไม่มี = ปัดก่อนเรียก fulfill · ใบไม่เปลี่ยน", async () => {
  fresh({ ...baseSeed(), "packageOrder/c1": pkgOrder({ status: "cancel" }), "packageOrder/s1": pkgOrder({ status: "success" }) });
  let called = 0;
  const fulfill = async () => { called += 1; return {}; };
  assert.equal((await call("orderApprove", { kind: "package", orderUUID: "c1" }, ROOT, { fulfill })).body.error, "order_cancelled");
  assert.equal((await call("orderApprove", { kind: "package", orderUUID: "s1" }, ROOT, { fulfill })).body.error, "order_already_opened");
  assert.equal((await call("orderApprove", { kind: "package", orderUUID: "nope" }, ROOT, { fulfill })).code, 404);
  assert.equal(called, 0);
  assert.equal(mem.store.get("packageOrder/c1").status, "cancel");
  assert.equal(mem.store.get("packageOrder/s1").status, "success");
});

test("orderApprove: fulfill ปัด (Refusal ของ pos/company) = ส่งต่อรหัส + audit rejected · ไม่ส่ง push · duplicate ไม่ส่ง push", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  const err = Object.assign(new Error("shop_not_found"), { deny: { ok: false, status: 404, error: "shop_not_found", message: "ไม่พบร้าน" } });
  const r = await call("orderApprove", { kind: "package", orderUUID: "p1" }, ROOT, { fulfill: async () => { throw err; } });
  assert.equal(r.code, 404);
  assert.equal(r.body.error, "shop_not_found");
  assert.equal(calls.push.length, 0);
  assert.ok(audits().some((a) => a.action === "order.approve" && a.result === "rejected" && a.rejectCode === "shop_not_found" && a.passkeyCredentialId === null));
  const d = await call("orderApprove", { kind: "package", orderUUID: "p1" }, ROOT, {
    fulfill: async () => ({ ok: true, duplicate: true, status: "success", push: { to: { kind: "people", ids: ["x"] }, heading: "h", content: "c" } }),
  });
  assert.equal(d.code, 200);
  assert.equal(d.body.duplicate, true);
  assert.equal(calls.push.length, 0);
});

test("orderApprove: watcher 403 · ส่งช่อง passkey (จอรุ่นก่อน) = 400 invalid_request · ไม่เรียก fulfill · ไม่เขียนอะไร", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  let called = 0;
  const fulfill = async () => { called += 1; return { duplicate: false }; };
  const before = snapshot();
  const w = await call("orderApprove", { kind: "package", orderUUID: "p1" }, WATCH, { fulfill });
  assert.equal(w.code, 403);
  assert.equal(w.body.error, "root_required");
  const pk = await call("orderApprove", { kind: "package", orderUUID: "p1", passkey: oldPasskey }, ROOT, { fulfill });
  assert.equal(pk.code, 400);
  assert.equal(pk.body.error, "invalid_request");
  assert.equal(called, 0);
  assert.equal(calls.push.length, 0);
  assert.deepEqual(new Map(mem.store), before, "ใบ · audit ไม่เปลี่ยน");
});

test("orderApprove + _fulfill.js ตัวจริง (พื้นที่รูป): shop.imageMore เพิ่ม · ใบ success + approveName · push ข้อความ care", async () => {
  fresh({
    ...baseSeed(),
    "shop/docB": { shopId: "57325", name: "ร้าน B", imageMore: 500 },
    "imageOrder/i1": { shopId: "57325", shopName: "ร้าน B", profileId: "b2", timestamp: ago(10), imageId: "https://slip/i.jpg", net: 100, qty: 1000, status: "order" },
  });
  const r = await call("orderApprove", { kind: "image", orderUUID: "i1" }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(mem.store.get("shop/docB").imageMore, 1500);
  const o = mem.store.get("imageOrder/i1");
  assert.equal(o.status, "success");
  assert.equal(o.approveId, ROOT);
  assert.equal(o.approveName, "พี่ Root");
  assert.equal(o.paidVia, "manual");
  assert.equal(calls.push.length, 1);
  assert.equal(calls.push[0].heading, "เพิ่มพื้นที่เก็บไฟล์ 1000 รูปภาพเรียบร้อย");
});

// ── ④ orderCancel ───────────────────────────────────────────────────────────
test("orderCancel: status cancel + ผู้ยกเลิก + audit ใน transaction · push ตาม care · silent ไม่ส่ง", async () => {
  fresh({ ...baseSeed(), "imageOrder/i1": { shopId: "x", profileId: "b2", net: 100, qty: 1000, status: "order" } });
  const r = await call("orderCancel", { kind: "image", orderUUID: "i1" }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const o = mem.store.get("imageOrder/i1");
  assert.equal(o.status, "cancel");
  assert.equal(o.cancelId, ROOT);
  assert.equal(o.cancelName, "พี่ Root");
  assert.deepEqual(calls.push, [{ to: { kind: "people", ids: ["b2"] }, heading: "ยกเลิกการซื้อพื้นที่เก็บไฟล์", content: "หลักฐานการชำระเงินไม่ถูกต้อง" }]);
  assert.equal(audits().find((a) => a.action === "order.cancel").result, "ok");

  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  const s = await call("orderCancel", { kind: "package", orderUUID: "p1", silent: true }, ROOT);
  assert.equal(s.code, 200);
  assert.equal(s.body.notified, false);
  assert.equal(calls.push.length, 0);
  assert.equal(mem.store.get("packageOrder/p1").status, "cancel");
});

test("orderCancel: เงินเข้าแล้ว (companyPay paid/problem) = 409 pay_received ก่อนเข้า transaction · ใบไม่ใช่ order = 409 · watcher 403", async () => {
  fresh({
    ...baseSeed(),
    "packageOrder/p1": pkgOrder(),
    "companyPay/package-p1": { kind: "package", orderUUID: "p1", status: "paid", updatedAt: ago(1) },
    "packageOrder/s1": pkgOrder({ status: "success" }),
  });
  const r = await call("orderCancel", { kind: "package", orderUUID: "p1" }, ROOT);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "pay_received");
  assert.equal(mem.store.get("packageOrder/p1").status, "order");
  assert.equal((await call("orderCancel", { kind: "package", orderUUID: "s1" }, ROOT)).body.error, "order_not_cancellable");
  assert.equal((await call("orderCancel", { kind: "package", orderUUID: "s1" }, WATCH)).body.error, "root_required");
});

test("orderCancel: เงินเข้าหลังตรวจรอบแรก ก่อน transaction (เห็นใน transaction) = 409 pay_received ไม่เขียนใบ · audit rejected", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  // เงินเข้าตรงช่องระหว่างตรวจรอบแรกกับ transaction ⇒ ต้องเห็นจากการอ่านใน transaction เท่านั้น
  const realTx = mem.db.runTransaction;
  mem.db.runTransaction = async (fn) => {
    mem.store.set("companyPay/package-p1", { kind: "package", orderUUID: "p1", status: "paid", updatedAt: NOW });
    return realTx(fn);
  };
  const r = await call("orderCancel", { kind: "package", orderUUID: "p1" }, ROOT);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "pay_received");
  assert.equal(mem.store.get("packageOrder/p1").status, "order");
  assert.ok(audits().some((a) => a.action === "order.cancel" && a.result === "rejected" && a.rejectCode === "pay_received"));
});

test("orderCancel: ส่งช่อง passkey (จอรุ่นก่อน) = 400 invalid_request · ใบยังเป็น order · ไม่ส่ง push · ไม่เขียน audit", async () => {
  fresh({ ...baseSeed(), "packageOrder/p1": pkgOrder() });
  const before = snapshot();
  const r = await call("orderCancel", { kind: "package", orderUUID: "p1", passkey: oldPasskey }, ROOT);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "invalid_request");
  assert.equal(calls.push.length, 0);
  assert.deepEqual(new Map(mem.store), before);
});

// ── ของร่วม ─────────────────────────────────────────────────────────────────
test("ตารางชนิด = KINDS ของ _fulfill.js · ข้อความยกเลิกครบ 4 ชนิด", () => {
  fresh({});
  const { KINDS } = require("../company/_fulfill");
  assert.equal(M.KIND_SPEC, KINDS);
  assert.deepEqual(Object.keys(M.CANCEL_PUSH).sort(), Object.keys(KINDS).sort());
  assert.ok(path.basename(__filename) === "pay.test.js");
});

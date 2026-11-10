// เทสโดเมนบริษัท (ก้อน 9d · DEV-0001) · ของที่ชุด case ของสัญญา company.*.yaml คุมไม่ได้
//   รัน: node --test functions/pos/company/company.test.js
//   ⚠️ ก่อนแม่ผูก @shopchamp/schema + @shopchamp/logic รุ่นที่มีของโดเมนนี้ ต้องรันผ่าน preload ที่ชี้ไปตัวที่ build จาก center (ดู 9d-company.md §เทส)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
process.env.TZ = "Asia/Bangkok";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

// ── Firestore ปลอมแบบเล็ก: เขียนลงฐานจริงของเทส (ต่างจาก harness) ⇒ ตรวจผลหลายขั้นได้ ──
let DATA = {};
let WRITES = [];
let CREATED = {}; // path → Timestamp ปลอมของ snap.createTime (Admin SDK ตั้งให้ทุก doc · harness ไม่มี)
const getColl = (c) => (DATA[c] = DATA[c] || {});
function ref(c, id) {
  const r = {
    id, path: `${c}/${id}`,
    get: async () => ({ exists: getColl(c)[id] !== undefined, id, data: () => getColl(c)[id], ...(CREATED[`${c}/${id}`] ? { createTime: CREATED[`${c}/${id}`] } : {}) }),
    set: async (v) => { WRITES.push({ op: "set", path: r.path }); getColl(c)[id] = v; },
    update: async (v) => { WRITES.push({ op: "update", path: r.path }); getColl(c)[id] = { ...(getColl(c)[id] || {}), ...v }; },
    delete: async () => { WRITES.push({ op: "delete", path: r.path }); delete getColl(c)[id]; },
  };
  return r;
}
let auto = 0;
const fakeDb = {
  collection: (c) => ({
    doc: (id) => ref(c, id === undefined ? `auto${++auto}` : id),
    where: (f, op, v) => {
      const q = { lim: null };
      const run = async () => { let docs = Object.entries(getColl(c)).filter(([, d]) => d && d[f] === v).map(([id, d]) => ({ id, exists: true, data: () => d })); if (q.lim != null) docs = docs.slice(0, q.lim); return { empty: !docs.length, size: docs.length, docs }; };
      const api = { limit: (n) => { q.lim = n; return api; }, get: run };
      return api;
    },
  }),
  runTransaction: async (fn) => {
    const queued = [];
    const tx = {
      get: (r) => r.get(),
      set: (r, v) => { queued.push(() => r.set(v)); return tx; },
      update: (r, v) => { queued.push(() => r.update(v)); return tx; },
      delete: (r) => { queued.push(() => r.delete()); return tx; },
    };
    const out = await fn(tx);
    for (const q of queued) await q();
    return out;
  },
};
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: fakeDb, admin: {} } };

const T = require("./shopTemplate");
const { deleteAccount } = require("./deleteAccount");
const { packageOrder } = require("./packageOrder");
const { shopCreate, derivedId } = require("./shopCreate");
const { scanLoginApprove } = require("./scanLoginApprove");
const { INITIAL_RIGHTS } = require("../_shared/auth");

const NOW = new Date("2026-11-10T03:00:00.000Z");
async function call(handler, req) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
}

// ── ① แม่แบบร้านเทียบกับ main3 ตัวต่อตัว ──
const APP = path.resolve(__dirname, "../../../../shopchamp_app");
function loadOld(name, cache = {}) {
  if (cache[name]) return cache[name];
  // ไม่ส่ง GIT_DIR/GIT_INDEX_FILE ของ hook ต่อ: ตอน pre-commit จาก worktree ค่านี้ชี้ repo server ⇒ อ่าน main3 ของแอปไม่เจอ
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"]) delete env[k];
  let src = execFileSync("git", ["-C", APP, "show", `main3:src/config/${name}.js`], { encoding: "utf8", env });
  const deps = [];
  src = src.replace(/^import\s+(\w+)\s+from\s+["']\.\/(\w+)["'];?\s*$/gm, (_, v, f) => { deps.push([v, f]); return ""; });
  src = src.replace(/export default/, "module.exports =");
  const mod = { exports: {} };
  const args = deps.map(([v]) => v);
  // eslint-disable-next-line no-new-func
  new Function("module", ...args, src)(mod, ...deps.map(([, f]) => loadOld(f, cache)));
  cache[name] = mod.exports;
  return mod.exports;
}
const hasApp = fs.existsSync(path.join(APP, ".git"));
const plain = (v) => JSON.parse(JSON.stringify(v));

test("shopTemplate: ส่วนคงที่ = initialShop ของ main3 ทุก field (ไม่นับ dateTime cutOff)", { skip: !hasApp && "ไม่มี repo แอปในบ้านนี้" }, () => {
  const old = loadOld("initialShop");
  const { dateTime, cutOff, ...rest } = old;
  assert.deepEqual(plain(T.staticShopPart()), plain(rest));
  assert.equal(cutOff.toISOString(), T.OLD_EPOCH_ISO); // new Date(2011,0,1) ใต้ TZ ไทย
  assert.ok(dateTime instanceof Date);
});

test("shopTemplate: initialPos initialShift initialVip initialRights = main3", { skip: !hasApp && "ไม่มี repo แอปในบ้านนี้" }, () => {
  assert.deepEqual(plain(T.initialPos()), plain(loadOld("initialPos")));
  assert.deepEqual(plain(T.initialShift()), plain(loadOld("initialShift")));
  assert.deepEqual(plain(T.initialVip()), plain(loadOld("initialVip")));
  assert.deepEqual([...INITIAL_RIGHTS], loadOld("initialRights"));
});

test("buildNewShop: ประกอบแบบเดียวกับ NewShopScreen.js:66-120 · ค่าที่มาจากผู้ใช้มีแค่ชื่อ เบอร์ ที่อยู่ ข้อมูลเครื่อง", { skip: !hasApp && "ไม่มี repo แอปในบ้านนี้" }, () => {
  const input = { name: "ร้าน", tel: "0812345678", smartAddress: [10, 1001, "100101", "10200"], posId: "p-1", uniqueId: "dev", deviceName: "Tab", requestId: "r-1" };
  const b = T.buildNewShop({ shopDocId: "S1", shiftId: "H1", uid: "u1", profile: { name: "ก", email: "e", imageId: "i" }, input, scShopId: 7, now: NOW });
  // รายชื่อ field ระดับบน = ของเดิม (initialShop + ที่ NewShopScreen ใส่เพิ่ม: id shopId) + ใหม่ 2 ตัว
  const oldKeys = new Set([...Object.keys(loadOld("initialShop")), "id", "shopId"]);
  const newKeys = Object.keys(b.shop).filter((k) => !oldKeys.has(k)).sort();
  assert.deepEqual(newKeys, ["createRequestId", "createdVia"]);
  assert.deepEqual(b.shop.humanResource, [{ id: "u1", position: ["001"], status: "active", name: "ก", imageId: "i", email: "e", rights: [...INITIAL_RIGHTS] }]);
  assert.equal(b.shop.POSs.length, 1);
  assert.deepEqual({ ...b.shop.POSs[0] }, { ...T.initialPos(), shiftId: "H1", uniqueId: "dev", id: "p-1", deviceName: "Tab", name: "แคชเชียร์ 1" });
  assert.deepEqual(b.shop.vip.map((v) => v.type), T.VIP_TYPES);
  assert.ok(b.shop.vip.every((v) => v.expire.toISOString() === T.OLD_EPOCH_ISO), "ร้านใหม่ไม่ได้แพ็กเกจฟรี (freeTrial ถูก comment ในของเดิม)");
  for (const k of ["notiShift", "notiCancelBill", "notiImport", "notiStock", "notiSummary", "notiCheckin", "notiRequisition"]) assert.deepEqual(b.shop[k], ["u1"]);
  assert.deepEqual(b.shop.notiStaff, []); // ของเดิมไม่ใส่ notiStaff notiCredit
  assert.deepEqual(b.shift, { ...T.initialShift(), id: "H1", posId: "p-1", shopId: "S1" });
  assert.deepEqual(b.currentLogin, { shopId: "S1", rights: [...INITIAL_RIGHTS] });
  // แม่แบบใหม่ทุกครั้ง ไม่ถือ reference ร่วม
  const b2 = T.buildNewShop({ shopDocId: "S2", shiftId: "H2", uid: "u2", profile: {}, input, scShopId: 8, now: NOW });
  b2.shop.position[0].rights.push("x");
  assert.notEqual(T.staticShopPart().position[0].rights.at(-1), "x");
  assert.equal(b2.shop.humanResource[0].name, "");
});

test("derivedId: 20 ตัว [A-Za-z0-9] คงที่ต่อคำขอ · ต่างชนิดต่าง id", () => {
  const a = derivedId("shop", "u", "r"), b = derivedId("shop", "u", "r");
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9]{20}$/);
  assert.notEqual(a, derivedId("shift", "u", "r"));
  assert.notEqual(a, derivedId("shop", "u2", "r"));
});

// ── ② ลบบัญชี: ทางที่ stub ของ harness ทำไม่ได้ (error ที่มี code) ──
const delReq = () => ({ auth: { uid: "u1" }, headers: { authorization: "Bearer t" }, body: { confirm: true } });
const verifyOk = async () => ({ uid: "u1", auth_time: Math.floor(NOW.getTime() / 1000) - 30 });

test("deleteAccount: Auth ไม่มีผู้ใช้แล้ว (auth/user-not-found) = ถือว่าลบแล้ว → 200 done", async () => {
  DATA = { profile: { u1: { name: "x" } } }; WRITES = [];
  const notFound = async () => { const e = new Error("gone"); e.code = "auth/user-not-found"; throw e; };
  const r = await call(deleteAccount({ now: () => NOW, verifyIdToken: verifyOk, deleteAuthUser: notFound }), delReq());
  assert.equal(r.code, 200);
  assert.equal(DATA.deletedUser.u1.status, "done");
  assert.equal(DATA.deletedUser.u1.isDeleteSuccess, true);
  assert.equal(DATA.profile.u1, undefined);
});

test("deleteAccount: ลบ Auth ล้ม แล้วลองใหม่สำเร็จ → บันทึกจบที่ done · profile ลบครั้งเดียว", async () => {
  DATA = { profile: { u1: { name: "x" } } }; WRITES = [];
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error("internal"); };
  const h = deleteAccount({ now: () => NOW, verifyIdToken: verifyOk, deleteAuthUser: flaky });
  const r1 = await call(h, delReq());
  assert.equal(r1.code, 502);
  assert.equal(DATA.deletedUser.u1.status, "auth_failed");
  const r2 = await call(h, delReq());
  assert.equal(r2.code, 200);
  assert.equal(DATA.deletedUser.u1.status, "done");
  assert.equal(DATA.deletedUser.u1.profileDeleted, true); // รอบ 2 ไม่มี profile ให้ลบแล้ว แต่รอบ 1 ลบไปแล้ว ⇒ บันทึกต้องไม่ทับเป็น false (ตรวจซ้ำ 9d)
  assert.equal(WRITES.filter((w) => w.op === "delete").length, 1);
});

test("deleteAccount: ไม่แตะเอกสารของร้านเลย (shop bill member taxId)", async () => {
  DATA = { profile: { u1: { name: "x", port: [{ shopId: "S" }] } }, shop: { S: { humanResource: [{ id: "u1" }] } }, bill: { b: { shopId: "S" } } }; WRITES = [];
  await call(deleteAccount({ now: () => NOW, verifyIdToken: verifyOk, deleteAuthUser: async () => {} }), delReq());
  assert.deepEqual(WRITES.map((w) => w.path.split("/")[0]).filter((c) => c !== "deletedUser" && c !== "profile"), []);
  assert.deepEqual(DATA.shop.S.humanResource, [{ id: "u1" }]);
});

test("deleteAccount: ต้องตรวจ token ถูกเพิกถอน (verifyIdToken ส่ง checkRevoked = true) · token ที่ถูกเพิกถอนแล้ว = 401", async () => {
  DATA = { profile: { u1: { name: "x" } } }; WRITES = [];
  const args = [];
  // token ถูกเพิกถอน: ตรวจแบบดูการเพิกถอนแล้วล้ม · ตรวจแบบไม่ดูจะผ่าน (ลายเซ็นยังถูก) — แบบเดียวกับ Admin SDK
  const revoked = async (t, checkRevoked) => {
    args.push([t, checkRevoked]);
    if (checkRevoked === true) { const e = new Error("revoked"); e.code = "auth/id-token-revoked"; throw e; }
    return verifyOk();
  };
  let deleted = 0;
  const r = await call(deleteAccount({ now: () => NOW, verifyIdToken: revoked, deleteAuthUser: async () => { deleted++; } }), delReq());
  assert.equal(r.code, 401);
  assert.equal(r.body.error, "no_auth");
  assert.deepEqual(args, [["t", true]]);
  assert.equal(deleted, 0);
  assert.deepEqual(WRITES, []);
});

// ── ②ข QR เข้าเว็บ: อายุตัดสินจาก snap.createTime (server ตั้ง) ไม่ใช่ field ที่เว็บเขียนเอง ──
const tsOf = (iso) => { const ms = Date.parse(iso); return { toMillis: () => ms, toDate: () => new Date(ms) }; };
const QR = "AbCdEfGhIjKlMnOpQrSt";
const scanReq = () => ({ auth: { uid: "u1" }, body: { docId: QR } });

test("scanLoginApprove: doc เกิดมา 20 นาที (createTime) แต่ field timestamp อ้างว่าเพิ่งเปิด → 410 ไม่เขียน", async () => {
  DATA = { loginByScan: { [QR]: { uid: "", docId: QR, timestamp: tsOf("2026-11-10T02:59:00.000Z") } } }; WRITES = [];
  CREATED = { [`loginByScan/${QR}`]: tsOf("2026-11-10T02:40:00.000Z") };
  const r = await call(scanLoginApprove({ now: () => NOW }), scanReq());
  CREATED = {};
  assert.equal(r.code, 410);
  assert.equal(r.body.error, "scan_expired");
  assert.deepEqual(WRITES, []);
});

test("scanLoginApprove: doc เกิดมา 1 นาที (createTime) และ field ตรง → 200 เขียน uid · ขอบ 10:00 พอดีผ่าน 10:01 ไม่ผ่าน", async () => {
  const run = async (createdIso) => {
    DATA = { loginByScan: { [QR]: { uid: "", docId: QR, timestamp: tsOf("2026-11-10T02:59:00.000Z") } } }; WRITES = [];
    CREATED = { [`loginByScan/${QR}`]: tsOf(createdIso) };
    const r = await call(scanLoginApprove({ now: () => NOW }), scanReq());
    CREATED = {};
    return r;
  };
  const fresh = await run("2026-11-10T02:59:00.000Z");
  assert.equal(fresh.code, 200);
  assert.equal(DATA.loginByScan[QR].uid, "u1");
  assert.equal((await run("2026-11-10T02:50:00.000Z")).code, 200);
  assert.equal((await run("2026-11-10T02:49:59.000Z")).code, 410);
});

// ── ③ ใบสั่งซื้อ: ส่งซ้ำหลังราคาเปลี่ยน ต้องได้ใบเดิม ไม่ใช่ 409 ──
test("packageOrder: กดครั้งแรกสำเร็จ แล้วราคาในฐานเปลี่ยนก่อนเครื่องส่งซ้ำ → ส่งซ้ำได้ duplicate ใบเดิม", async () => {
  const UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  DATA = {
    shop: { A: { shopId: "A", name: "ร้าน" } },
    profile: { u1: { name: "ก", tel: "0" } },
    admin: { package: { value: [{ name: "พรีเมี่ยม", status: true, price: [{ id: "1", price: 299, save: 0 }] }] }, packageNumber: { value: 5 } },
  };
  const h = packageOrder({ now: () => NOW });
  const body = { shopId: "A", packageIds: ["1"], slipUrl: "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/packageOrder%2Fs.jpg?alt=media", expectedNet: 299, orderUUID: UUID };
  const req = { shopAccess: { shopId: "A", uid: "u1", role: "owner", rights: [] }, body };
  const r1 = await call(h, req);
  assert.equal(r1.code, 200);
  assert.equal(r1.body.orderNumber, "202611000006");
  DATA.admin.package.value[0].price[0].price = 399;
  const r2 = await call(h, { ...req, body: { ...body } });
  assert.equal(r2.code, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.orderNumber, "202611000006");
  assert.equal(DATA.admin.packageNumber.value, 6, "ตัวนับไม่ขยับรอบส่งซ้ำ");
  assert.equal(Object.keys(DATA.notification).length, 1, "notification ใบเดียว");
});

// ── ③a' ใบ QR (DEV-0003 U2b · schema 0.1.23 payMethod): สร้างไม่มีสลิป → แนบสลิปเข้าใบเดิม → เงินเข้าแล้วแนบไม่ได้ ──
const QR_DATA = () => ({
  shop: { A: { shopId: "A", name: "ร้าน" } },
  profile: { u1: { name: "ก", tel: "0" } },
  admin: { package: { value: [{ name: "พรีเมี่ยม", status: true, price: [{ id: "1", price: 299, save: 0 }] }] }, packageNumber: { value: 5 } },
});
const QR_UUID = "7d9f1c2e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const QR_SLIP = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/packageOrder%2Fqr-later.jpg?alt=media";
const qrReq = (body) => ({ shopAccess: { shopId: "A", uid: "u1", role: "owner", rights: [] }, body: { shopId: "A", packageIds: ["1"], expectedNet: 299, orderUUID: QR_UUID, ...body } });

test("packageOrder qr: ใบ QR เขียน imageId '' payMethod qr · ส่งซ้ำแบบสลิป = แนบสลิปเข้าใบเดิม (duplicate slipAttached · ไม่ออกเลข ไม่มี noti ใบ 2) · ส่งซ้ำแบบ qr หลังแนบ = duplicate ธรรมดา", async () => {
  DATA = QR_DATA(); WRITES = [];
  const h = packageOrder({ now: () => NOW });
  const a = await call(h, qrReq({ payMethod: "qr" }));
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.equal(a.body.duplicate, false);
  const o1 = DATA.packageOrder[QR_UUID];
  assert.equal(o1.imageId, "");
  assert.equal(o1.payMethod, "qr");
  assert.equal(o1.status, "order");
  assert.equal(DATA.admin.packageNumber.value, 6);

  // ร้านเปลี่ยนใจ: อัปสลิปแล้วส่ง orderUUID เดิม (ไม่ส่ง payMethod = รูปเดิมของแอป)
  const b = await call(h, qrReq({ slipUrl: QR_SLIP }));
  assert.equal(b.code, 200, JSON.stringify(b.body));
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.slipAttached, true);
  assert.equal(b.body.orderNumber, a.body.orderNumber);
  const o2 = DATA.packageOrder[QR_UUID];
  assert.equal(o2.imageId, QR_SLIP);
  assert.equal(o2.payMethod, "slip");
  assert.equal(o2.slipAttachedAt.getTime(), NOW.getTime());
  assert.equal(o2.orderNumber, o1.orderNumber, "เลขใบเดิม");
  assert.equal(DATA.admin.packageNumber.value, 6, "ตัวนับไม่ขยับ");
  assert.equal(Object.keys(DATA.notification).length, 1, "notification ใบเดียว");
  assert.deepEqual(WRITES.filter((w) => w.path === `packageOrder/${QR_UUID}`).map((w) => w.op), ["set", "update"]);

  // แนบแล้ว ส่งซ้ำอีกรอบ (สลิปใหม่ หรือ qr) = duplicate ธรรมดา ไม่เขียนทับ
  const n = WRITES.length;
  const c = await call(h, qrReq({ slipUrl: QR_SLIP.replace("qr-later", "another") }));
  assert.equal(c.code, 200);
  assert.equal(c.body.duplicate, true);
  assert.equal(c.body.slipAttached, undefined);
  const d = await call(h, qrReq({ payMethod: "qr" }));
  assert.equal(d.code, 200);
  assert.equal(d.body.duplicate, true);
  assert.equal(WRITES.length, n, "ไม่เขียนอะไรเพิ่ม");
  assert.equal(DATA.packageOrder[QR_UUID].imageId, QR_SLIP, "สลิปแรกที่แนบคงอยู่");
});

test("packageOrder qr: 🔒 ใบ QR ที่ companyPay paid/problem → แนบสลิป 409 pay_received ไม่เขียน · request/expired ยังแนบได้ · ใบไม่ใช่ order แล้ว = duplicate ธรรมดา", async () => {
  const h = packageOrder({ now: () => NOW });
  for (const payStatus of ["paid", "problem"]) {
    DATA = QR_DATA(); WRITES = [];
    assert.equal((await call(h, qrReq({ payMethod: "qr" }))).code, 200);
    DATA.companyPay = { [`package-${QR_UUID}`]: { kind: "package", orderUUID: QR_UUID, status: payStatus, amountSatang: 29900 } };
    const n = WRITES.length;
    const r = await call(h, qrReq({ slipUrl: QR_SLIP }));
    assert.equal(r.code, 409, payStatus);
    assert.equal(r.body.error, "pay_received");
    assert.equal(r.body.payStatus, payStatus);
    assert.equal(WRITES.length, n, "ไม่เขียน");
    assert.equal(DATA.packageOrder[QR_UUID].imageId, "", "ใบยังไม่มีสลิป");
  }
  for (const payStatus of ["request", "expired", "closed"]) {
    DATA = QR_DATA(); WRITES = [];
    assert.equal((await call(h, qrReq({ payMethod: "qr" }))).code, 200);
    DATA.companyPay = { [`package-${QR_UUID}`]: { kind: "package", orderUUID: QR_UUID, status: payStatus, amountSatang: 29900 } };
    const r = await call(h, qrReq({ slipUrl: QR_SLIP }));
    assert.equal(r.code, 200, payStatus);
    assert.equal(r.body.slipAttached, true, payStatus);
  }
  // ใบ QR ที่เปิดของแล้ว (status success) โดยไม่มี doc จ่าย (เช่น office อนุมัติมือ) = duplicate ธรรมดา ไม่แนบ
  DATA = QR_DATA(); WRITES = [];
  assert.equal((await call(h, qrReq({ payMethod: "qr" }))).code, 200);
  DATA.packageOrder[QR_UUID].status = "success";
  const n = WRITES.length;
  const r = await call(h, qrReq({ slipUrl: QR_SLIP }));
  assert.equal(r.code, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.slipAttached, undefined);
  assert.equal(WRITES.length, n);
});

test("packageOrder qr: qr แต่ส่งสลิปมา 400 · ไม่ส่ง payMethod ไม่มีสลิป 400 (รูปเดิม) · ใบสลิปเดิมไม่มีช่อง payMethod", async () => {
  DATA = QR_DATA(); WRITES = [];
  const h = packageOrder({ now: () => NOW });
  const a = await call(h, qrReq({ payMethod: "qr", slipUrl: QR_SLIP }));
  assert.equal(a.code, 400);
  const b = await call(h, qrReq({}));
  assert.equal(b.code, 400);
  assert.equal(WRITES.length, 0);
  const c = await call(h, qrReq({ slipUrl: QR_SLIP }));
  assert.equal(c.code, 200);
  assert.equal("payMethod" in DATA.packageOrder[QR_UUID], false, "ใบสลิปรูปเดิม 13 field ไม่เพิ่มช่อง");
  assert.equal(DATA.packageOrder[QR_UUID].imageId, QR_SLIP);
});

test("companyPayDocId ของ _orders.js = payDocId ของ _payCheck.js (นิยามซ้ำเพราะ require วนกัน)", () => {
  const { companyPayDocId, PAY_RECEIVED } = require("./_orders");
  const PC = require("./_payCheck");
  for (const k of ["package", "hardware", "image", "stock"]) assert.equal(companyPayDocId(k, "u-1"), PC.payDocId(k, "u-1"));
  assert.deepEqual([...PAY_RECEIVED].sort(), PC.FINAL_STATES.filter((s) => s !== "closed").sort(), "เงินเข้าแล้ว = สถานะจบที่ไม่ใช่ closed");
});

// ── ③b ใบแพ็กเกจขอใบกำกับ (DEV-0002 · Pack เคาะ 2026-11-07): รายปีเท่านั้น · VAT คิดที่ server ──
const PKG_DATA = () => ({
  shop: { A: { shopId: "A", name: "ร้าน" } },
  profile: { u1: { name: "ก", tel: "0" } },
  // รูปเดียวกับฐานจริง (วัด 2026-11-07): แถวราคามี day เป็นข้อความ
  admin: { package: { value: [{ name: "พรีเมี่ยม", status: true, price: [{ id: "1", price: 350, save: 0, day: "1 เดือน" }, { id: "2", price: 3500, save: 700, day: "12 เดือน" }] }] }, packageNumber: { value: 5 } },
});
const PKG_SLIP = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/packageOrder%2Fs.jpg?alt=media";
const PKG_REQ = (body) => ({ shopAccess: { shopId: "A", uid: "u1", role: "owner", rights: [] }, body: { shopId: "A", slipUrl: PKG_SLIP, orderUUID: "2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d", ...body } });

test("packageOrder vat: รายปีขอใบกำกับ → ใบมี vat true · totalPrice · vatAmount · vatDetail · net รวม VAT · ส่งซ้ำได้ใบเดิม", async () => {
  DATA = PKG_DATA();
  const h = packageOrder({ now: () => NOW });
  const req = PKG_REQ({ packageIds: ["2"], expectedNet: 3745, vat: true, vatDetail: "บริษัท ก จำกัด 0105556000000" });
  const r = await call(h, req);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.net, 3745);
  const o = DATA.packageOrder[req.body.orderUUID];
  assert.deepEqual([o.vat, o.totalPrice, o.vatAmount, o.vatDetail, o.net, o.email], [true, 3500, 245, "บริษัท ก จำกัด 0105556000000", 3745, ""]);
  const again = await call(h, { ...req, body: { ...req.body } });
  assert.deepEqual([again.code, again.body.duplicate, again.body.net], [200, true, 3745]);
  assert.equal(DATA.admin.packageNumber.value, 6);
});

test("packageOrder vat: รายเดือนขอใบกำกับ → 409 tax_invoice_yearly_only ไม่เขียนอะไร · ยอดก่อน VAT ของรายปี → 409 price_changed {net รวม VAT}", async () => {
  DATA = PKG_DATA();
  const h = packageOrder({ now: () => NOW });
  WRITES = [];
  const m = await call(h, PKG_REQ({ packageIds: ["1"], expectedNet: 374.5, vat: true, vatDetail: "x" }));
  assert.deepEqual([m.code, m.body.error, m.body.packageId], [409, "tax_invoice_yearly_only", "1"]);
  assert.equal(Object.keys(DATA.packageOrder || {}).length, 0);
  assert.equal(Object.keys(DATA.notification || {}).length, 0);
  assert.equal(DATA.admin.packageNumber.value, 5);
  const p = await call(h, PKG_REQ({ packageIds: ["2"], expectedNet: 3500, vat: true, vatDetail: "x" }));
  assert.deepEqual([p.code, p.body.error, p.body.net], [409, "price_changed", 3745]);
  // ไม่ขอใบกำกับ = รูปเดิม ไม่มีช่อง VAT เพิ่ม
  const n = await call(h, PKG_REQ({ packageIds: ["1"], expectedNet: 350, vatDetail: "ค้างจากจอ" }));
  assert.equal(n.code, 200);
  const o = Object.values(DATA.packageOrder)[0];
  assert.equal(o.vat, false);
  for (const k of ["totalPrice", "vatAmount", "vatDetail"]) assert.equal(k in o, false, k);
});

test("packageOrder vat: samePackages แยกใบที่ขอใบกำกับกับไม่ขอ", () => {
  const { samePackages } = require("./packageOrder");
  assert.equal(samePackages({ packageId: ["2"], vat: true }, { packageIds: ["2"], vat: true }), true);
  assert.equal(samePackages({ packageId: ["2"], vat: false }, { packageIds: ["2"] }), true);
  assert.equal(samePackages({ packageId: ["2"], vat: false }, { packageIds: ["2"], vat: true }), false);
  assert.equal(samePackages({ packageId: ["2"], vat: true }, { packageIds: ["2"], vat: false }), false);
});

// ── ④ สร้างร้าน: กดซ้ำ 2 ครั้งได้ร้านเดียว เลขเดียว ──
test("shopCreate: เรียกซ้ำด้วย requestId เดิม → ร้านเดียว · ตัวนับ +1 ครั้งเดียว · port เพิ่มครั้งเดียว", async () => {
  DATA = { shopchamShopId: { numOfStore: { total: 100 } }, profile: { u1: { name: "ก", port: [] } } };
  const h = shopCreate({ now: () => NOW });
  const body = { name: "ร้าน", tel: "0812345678", smartAddress: [1, 2, "3", "10200"], posId: "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b", uniqueId: "d", deviceName: "", requestId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" };
  const r1 = await call(h, { auth: { uid: "u1" }, body: { ...body } });
  const r2 = await call(h, { auth: { uid: "u1" }, body: { ...body } });
  assert.equal(r1.code, 200);
  assert.equal(r2.code, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(r1.body.shopId, r2.body.shopId);
  assert.equal(Object.keys(DATA.shop).length, 1);
  assert.equal(DATA.shopchamShopId.numOfStore.total, 101);
  assert.equal(DATA.profile.u1.port.length, 1);
  assert.equal(r2.body.scShopId, 101);
});

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
  let src = execFileSync("git", ["-C", APP, "show", `main3:src/config/${name}.js`], { encoding: "utf8" });
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

// เทส รหัสเข้าเว็บร้าน ScanGo จากแอปร้าน: scango.loginStatus · scango.loginStart (shop/) · scango.loginRedeem (settingsLogin.js) · _loginCode.js
//   ฐานปลอมที่เขียนลงจริง announcement/_testDb (create · transaction · update ช่องมีจุด) · ❌ ไม่แตะ Firebase จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { install, makeRes } = require("../announcement/_testDb");

const NOW = new Date("2026-11-12T05:00:00.000Z");
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const OTHER = "otherShop000000000001";
const OWNER = "oZlTxlxRjaRdmMoH4aXOORiBBK73";
const STAFF = "staffUid0000000000000001";
const SEAL_KEY = Buffer.alloc(32, 9).toString("base64");
const VIP_OK = [{ type: "staff", expire: new Date("2027-01-01T00:00:00Z") }];

const shopDoc = (over) => ({
  shopId: SHOP, name: "TEST Shopchamp", vip: VIP_OK,
  humanResource: [{ id: OWNER, name: "เจ้าของในร้าน", position: ["001"], status: "active" }, { id: STAFF, name: "พนักงาน", position: ["002"], status: "active" }],
  ...(over || {}),
});
const owner = { shopId: SHOP, uid: OWNER, role: "owner", rights: [] };
const staff = { shopId: SHOP, uid: STAFF, role: "staff", rights: [] };
const root = { shopId: SHOP, uid: "rootUid", role: "owner", rights: [], byAdmin: true, root: true };
const watcher = { shopId: SHOP, uid: "watchUid", role: "owner", rights: [], watcher: true, readOnly: true };

function load(seed) {
  const FILES = ["_loginCode.js", "settingsLogin.js", "shop/loginStart.js", "shop/loginStatus.js", "shop/_common.js", "_core.js"].map((f) => path.join(__dirname, f));
  const mem = install(seed || { [`shop/${SHOP}`]: shopDoc() }, FILES, () => NOW);
  const audit = [];
  let clock = NOW;
  const deps = { now: () => clock, sealKey: SEAL_KEY, audit: (l) => audit.push(l) };
  return {
    mem, audit, deps, setNow: (d) => { clock = d; },
    L: require("./_loginCode"), SL: require("./settingsLogin"), start: require("./shop/loginStart").loginStart, status: require("./shop/loginStatus").loginStatus,
  };
}
async function call(factory, deps, body, extra) {
  const res = makeRes();
  await factory(deps)({ body, ...(extra || {}) }, res);
  return res;
}

test("_loginCode: parseCode รับเฉพาะ '<id20>.<hex64>' · ผนึกผูก id/shopId/personId/secretHash/expiresAt · กุญแจไม่มี = error", () => {
  const { L } = load();
  const id = "A".repeat(20), sec = "f".repeat(64);
  assert.deepEqual(L.parseCode(` ${id}.${sec} `), { id, secret: sec });
  for (const bad of [undefined, 5, "", `${id}.${sec.toUpperCase()}`, `${id}x.${sec}`, `${id}.${sec}0`, `${id}${sec}`]) assert.equal(L.parseCode(bad), null, String(bad));
  const k = L.readSealKey({ sealKey: SEAL_KEY });
  assert.ok(Buffer.isBuffer(k.key));
  const exp = new Date(NOW.getTime() + 1000);
  const doc = { shopId: SHOP, personId: OWNER, secretHash: L.sha256Hex(sec), expiresAt: exp };
  doc.seal = L.sealOf(k.key, { id, shopId: SHOP, personId: OWNER, secretHash: doc.secretHash, expiresAtMs: exp.getTime() });
  assert.equal(L.sealMatches(k.key, id, doc), true);
  for (const tweak of [{ shopId: OTHER }, { personId: STAFF }, { secretHash: L.sha256Hex("x") }, { expiresAt: new Date(exp.getTime() + 1) }, { seal: "0".repeat(64) }, { expiresAt: null }]) {
    assert.equal(L.sealMatches(k.key, id, { ...doc, ...tweak }), false, JSON.stringify(Object.keys(tweak)));
  }
  assert.equal(L.sealMatches(k.key, "B".repeat(20), doc), false, "ย้ายผนึกข้าม doc ไม่ได้");
  // กุญแจคนละชุดกับผนึกของ webLogin (HKDF info ต่างกัน)
  const wl = require("../webLogin/core").readSealKey({ sealKey: SEAL_KEY });
  assert.notDeepEqual(wl.key, k.key);
  assert.ok(L.readSealKey({ env: {} }).error);
});

test("loginStatus: connected จาก merchantLinkedAt หรือ enabled เป็น boolean · มีแค่ productIds = false · isOwner จาก humanResource · ไม่เขียน", async () => {
  const cases = [
    [undefined, owner, { connected: false, isOwner: true }],
    [{ productIds: ["p1"] }, owner, { connected: false, isOwner: true }],
    [{ enabled: false }, owner, { connected: true, isOwner: true }],
    [{ merchantLinkedAt: NOW }, staff, { connected: true, isOwner: false }],
    [{ enabled: true }, root, { connected: true, isOwner: false }],
    [{ enabled: true }, watcher, { connected: true, isOwner: false }],
  ];
  for (const [scango, access, want] of cases) {
    const { status, deps, mem } = load({ [`shop/${SHOP}`]: shopDoc(scango ? { scango } : {}) });
    const r = await call(status, deps, { shopId: SHOP }, { shopAccess: access });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, ...want }, JSON.stringify(scango));
    assert.equal(mem.writes.length, 0);
  }
  const { status, deps } = load({});
  assert.equal((await call(status, deps, { shopId: SHOP }, { shopAccess: owner })).code, 404);
  assert.equal((await call(status, deps, { shopId: OTHER }, { shopAccess: owner })).body.error, "wrong_shop");
});

test("loginStart: เจ้าของได้รหัส '<id20>.<hex64>' อายุ 120 วิ · doc เก็บ hash + ผนึก ไม่มี secret ดิบ · log ไม่มีรหัส", async () => {
  const { start, deps, mem, audit, L } = load();
  const r = await call(start, deps, { shopId: SHOP }, { shopAccess: owner });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const p = L.parseCode(r.body.code);
  assert.ok(p, r.body.code);
  assert.equal(r.body.expiresAt, NOW.getTime() + 120000);
  const doc = mem.store.get(`scangoSettingsLogin/${p.id}`);
  assert.equal(doc.secretHash, L.sha256Hex(p.secret));
  assert.deepEqual([doc.shopId, doc.personId, doc.status, doc.expiresAt.getTime()], [SHOP, OWNER, "pending", NOW.getTime() + 120000]);
  assert.ok(!JSON.stringify(doc).includes(p.secret), "ไม่เก็บ secret ดิบ");
  assert.equal(L.sealMatches(L.readSealKey(deps).key, p.id, doc), true);
  assert.equal(mem.writes.length, 1);
  assert.ok(!JSON.stringify(audit).includes(p.secret) && audit.some((l) => l.event === "start" && l.result === "ok"));
  // 2 ครั้ง = 2 รหัสคนละตัว
  const r2 = await call(start, deps, { shopId: SHOP }, { shopAccess: owner });
  assert.notEqual(r2.body.code, r.body.code);
});

test("loginStart: พนักงาน / root ที่ไม่อยู่ในร้าน / เจ้าของ inActive = 403 owner_only · watcher 403 · ไม่มีกุญแจ 503 · ไม่เขียน", async () => {
  for (const [access, seed, code, error] of [
    [staff, null, 403, "owner_only"],
    [root, null, 403, "owner_only"],
    [owner, { [`shop/${SHOP}`]: shopDoc({ humanResource: [{ id: OWNER, position: ["001"], status: "inActive" }] }) }, 403, "owner_only"],
    [watcher, null, 403, "watcher_read_only"],
  ]) {
    const { start, deps, mem } = load(seed || undefined);
    const r = await call(start, deps, { shopId: SHOP }, { shopAccess: access });
    assert.deepEqual([r.code, r.body.error, r.body.code], [code, error, undefined], access.uid);
    assert.equal(mem.writes.length, 0);
  }
  const { start, deps, mem } = load();
  const r = await call(start, { ...deps, sealKey: undefined, env: {} }, { shopId: SHOP }, { shopAccess: owner });
  assert.deepEqual([r.code, r.body.error], [503, "scango_login_not_configured"]);
  assert.equal(mem.writes.length, 0);
});

test("loginRedeem: แลกครั้งเดียว → ตัวตนเจ้าของ · ใบ claimed · ประทับ merchantLinkedAt ครั้งแรก · ครั้งที่ 2 = 409 already_used", async () => {
  const { start, SL, deps, mem } = load();
  const { body } = await call(start, deps, { shopId: SHOP }, { shopAccess: owner });
  const r = await call(SL.loginRedeem, deps, { code: body.code });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, externalId: SHOP, personRef: OWNER, name: "เจ้าของในร้าน", venueName: "TEST Shopchamp" });
  const id = body.code.slice(0, 20);
  assert.equal(mem.store.get(`scangoSettingsLogin/${id}`).status, "claimed");
  assert.equal(mem.store.get(`shop/${SHOP}`).scango.merchantLinkedAt.getTime(), NOW.getTime());
  const again = await call(SL.loginRedeem, deps, { code: body.code });
  assert.deepEqual([again.code, again.body.error], [409, "already_used"]);
  // รหัสใหม่ของร้านที่ประทับแล้ว = ไม่เขียน shop ซ้ำ
  const n = mem.writes.length;
  const second = await call(start, deps, { shopId: SHOP }, { shopAccess: owner });
  await call(SL.loginRedeem, deps, { code: second.body.code });
  assert.deepEqual(mem.writes.slice(n).map((w) => w.path.split("/")[0]), ["scangoSettingsLogin", "scangoSettingsLogin"]);
});

test("loginRedeem: ขอบอายุ 120 วิพอดียังได้ · เกิน 1 ms = 410 code_expired (ใบยัง pending)", async () => {
  const a = load();
  const c1 = (await call(a.start, a.deps, { shopId: SHOP }, { shopAccess: owner })).body.code;
  a.setNow(new Date(NOW.getTime() + 120000));
  assert.equal((await call(a.SL.loginRedeem, a.deps, { code: c1 })).code, 200);
  const b = load();
  const c2 = (await call(b.start, b.deps, { shopId: SHOP }, { shopAccess: owner })).body.code;
  b.setNow(new Date(NOW.getTime() + 120001));
  const r = await call(b.SL.loginRedeem, b.deps, { code: c2 });
  assert.deepEqual([r.code, r.body.error], [410, "code_expired"]);
  assert.equal(b.mem.store.get(`scangoSettingsLogin/${c2.slice(0, 20)}`).status, "pending");
});

test("loginRedeem: เจ้าของถูกปิดสถานะ/ลดเป็นพนักงานหลังออกรหัส = 403 owner_only (ตรวจสด) · ใบไม่ถูกใช้", async () => {
  for (const hr of [[{ id: OWNER, position: ["001"], status: "inActive" }], [{ id: OWNER, position: ["002"], status: "active" }]]) {
    const { start, SL, deps, mem } = load();
    const code = (await call(start, deps, { shopId: SHOP }, { shopAccess: owner })).body.code;
    mem.store.set(`shop/${SHOP}`, shopDoc({ humanResource: hr }));
    const r = await call(SL.loginRedeem, deps, { code });
    assert.deepEqual([r.code, r.body.error], [403, "owner_only"], JSON.stringify(hr));
    assert.equal(mem.store.get(`scangoSettingsLogin/${code.slice(0, 20)}`).status, "pending");
  }
});

test("loginRedeem: secret ผิด / ไม่มีรหัส / doc ที่ client สร้างเอง (ไม่มีผนึกหรือผนึกผิด) = 404 code_not_found · รูปผิด 400 · ไม่มีกุญแจ 503 · ช่องเกิน 400", async () => {
  const { start, SL, deps, mem, L } = load();
  const code = (await call(start, deps, { shopId: SHOP }, { shopAccess: owner })).body.code;
  const [id] = code.split(".");
  const wrong = await call(SL.loginRedeem, deps, { code: `${id}.${"0".repeat(64)}` });
  assert.deepEqual([wrong.code, wrong.body.error, wrong.body.externalId], [404, "code_not_found", undefined]);
  assert.equal((await call(SL.loginRedeem, deps, { code: `${"Z".repeat(20)}.${"0".repeat(64)}` })).body.error, "code_not_found");
  // ปลอม: คนที่ login ได้สร้าง doc เองชี้ร้านคนอื่น + uid เจ้าของจริง (rules ที่ live ยังเปิด) — ไม่มีผนึก / ผนึกจากกุญแจอื่น
  const sec = "e".repeat(64);
  const forged = { secretHash: L.sha256Hex(sec), shopId: SHOP, personId: OWNER, status: "pending", createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60000) };
  mem.store.set(`scangoSettingsLogin/${"F".repeat(20)}`, forged);
  const otherKey = L.readSealKey({ sealKey: Buffer.alloc(32, 1).toString("base64") }).key;
  mem.store.set(`scangoSettingsLogin/${"G".repeat(20)}`, { ...forged, seal: L.sealOf(otherKey, { id: "G".repeat(20), shopId: SHOP, personId: OWNER, secretHash: forged.secretHash, expiresAtMs: forged.expiresAt.getTime() }) });
  for (const fid of ["F", "G"]) {
    const r = await call(SL.loginRedeem, deps, { code: `${fid.repeat(20)}.${sec}` });
    assert.deepEqual([r.code, r.body.error], [404, "code_not_found"], fid);
  }
  for (const bad of [{}, { code: "" }, { code: 5 }, { code: "abc.def" }]) assert.deepEqual([(await call(SL.loginRedeem, deps, bad)).body.error], ["code_invalid"], JSON.stringify(bad));
  assert.equal((await call(SL.loginRedeem, deps, { code, externalId: SHOP })).body.error, "invalid_request");
  assert.equal((await call(SL.loginRedeem, { ...deps, sealKey: undefined, env: {} }, { code })).code, 503);
  // ทั้งหมดข้างบนไม่ได้ใช้รหัสจริง
  assert.equal(mem.store.get(`scangoSettingsLogin/${id}`).status, "pending");
});

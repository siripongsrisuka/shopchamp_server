// เทส pos/scango/settingsLogin.js — login เว็บร้าน ScanGo ด้วยบัญชี Shopchamp (account · owner-check)
//   ฐานปลอม announcement/_testDb · verifyIdToken ฉีด (token "tok-<uid>") · ❌ ไม่แตะ Firebase จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { install, makeRes } = require("../announcement/_testDb");

const NOW = new Date("2026-11-12T05:00:00.000Z");
const SHOP = "wJNgra1ik0pzRQFlZNOD"; // doc id = field shopId
const LEGACY = "legacyDoc0000000000001"; // ร้านเก่า: doc id ≠ field shopId
const OTHER = "otherShop000000000001";
const OWNER = "oZlTxlxRjaRdmMoH4aXOORiBBK73";
const STAFF = "staffUid0000000000000001";
const VIP_OK = [{ type: "staff", expire: new Date("2027-01-01T00:00:00Z") }];
const VIP_GONE = [{ type: "staff", expire: new Date("2026-01-01T00:00:00Z") }];

function seedOf(over) {
  return {
    [`profile/${OWNER}`]: {
      name: "คุณเจ้าของ",
      port: [
        { position: ["002"], shopId: OTHER, shopName: "ร้านที่เป็นพนักงาน" },
        { position: ["001"], shopId: SHOP, shopName: "TEST Shopchamp" },
        { position: ["001"], shopId: "legacyField", shopName: "ร้านเก่า" },
        { position: ["001"], shopId: SHOP, shopName: "ซ้ำ" },
        { position: ["001"], shopId: "ghostField" }, // port ชี้ร้านที่ไม่มีแล้ว
      ],
    },
    [`profile/${STAFF}`]: { name: "พนักงาน", port: [{ position: ["001"], shopId: SHOP }] }, // port อ้างว่าเจ้าของ แต่ร้านบอกว่าพนักงาน
    [`shop/${SHOP}`]: { shopId: SHOP, name: "TEST Shopchamp", vip: VIP_OK, humanResource: [{ id: OWNER, name: "เจ้าของในร้าน", position: ["001"], status: "active" }, { id: STAFF, name: "พนักงาน", position: ["002"], status: "active" }] },
    [`shop/${LEGACY}`]: { shopId: "legacyField", name: "ร้านเก่า", humanResource: [{ id: OWNER, position: ["001"], status: "active" }] },
    [`shop/${OTHER}`]: { shopId: OTHER, name: "ร้านอื่น", vip: VIP_OK, humanResource: [{ id: "someoneElse", position: ["001"], status: "active" }, { id: OWNER, position: ["002"], status: "active" }] },
    ...(over || {}),
  };
}

function load(seedOver, depsOver) {
  const seed = Object.fromEntries(Object.entries(seedOf(seedOver)).filter(([, v]) => v !== undefined)); // undefined = ลบ doc นั้น
  const mem = install(seed, [path.join(__dirname, "_core.js"), path.join(__dirname, "settingsLogin.js")], () => NOW);
  const logs = [];
  const verifyCalls = [];
  const deps = {
    now: () => NOW,
    log: { warn: (...a) => logs.push(a), info() {}, error() {} },
    verifyIdToken: async (t, checkRevoked) => {
      verifyCalls.push([t, checkRevoked]);
      if (!/^tok-/.test(t)) throw Object.assign(new Error("bad token"), { code: "auth/argument-error" });
      if (t === "tok-revoked") throw Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" });
      const [uid, name] = t.slice(4).split("|");
      return { uid, ...(name ? { name } : {}) };
    },
    ...(depsOver || {}),
  };
  const mod = require("./settingsLogin");
  return { mem, deps, logs, verifyCalls, mod };
}
async function call(handler, body) {
  const res = makeRes();
  await handler({ body }, res);
  return res;
}

test("account: เจ้าของ → ร้านที่เป็นเจ้าของจริงเท่านั้น (port ยืนยันซ้ำกับ humanResource) · externalId = doc id · ไม่ซ้ำ · ไม่เขียน", async () => {
  const { mem, deps, verifyCalls, mod } = load();
  const r = await call(mod.loginAccount(deps), { idToken: `tok-${OWNER}` });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true, personRef: OWNER, name: "คุณเจ้าของ",
    shops: [{ externalId: SHOP, name: "TEST Shopchamp" }, { externalId: LEGACY, name: "ร้านเก่า" }],
  });
  assert.deepEqual(verifyCalls, [[`tok-${OWNER}`, true]], "ตรวจการเพิกถอนด้วย");
  assert.equal(mem.writes.length, 0);
});

test("account: port อ้างว่าเป็นเจ้าของ แต่ร้านบอกว่าเป็นพนักงาน → 403 owner_only (ไม่เชื่อ port)", async () => {
  const { deps, mod } = load();
  const r = await call(mod.loginAccount(deps), { idToken: `tok-${STAFF}` });
  assert.deepEqual([r.code, r.body.ok, r.body.error], [403, false, "owner_only"]);
  assert.equal(r.body.shops, undefined);
});

test("account: แถวเจ้าของ inActive / ไม่มี status = ไม่ใช่เจ้าของ · แถวเจ้าของไม่ใช่แถวแรกและแพ็กเกจพนักงานหมด = ไม่ใช่ (กติกาเดียวกับ requireShopAccess)", async () => {
  const hr = (rows) => ({ [`shop/${SHOP}`]: { shopId: SHOP, name: "TEST Shopchamp", vip: VIP_GONE, humanResource: rows }, [`shop/${LEGACY}`]: { shopId: "legacyField", humanResource: [] } });
  for (const rows of [
    [{ id: OWNER, position: ["001"], status: "inActive" }],
    [{ id: OWNER, position: ["001"] }],
    [{ id: "first", position: ["001"], status: "active" }, { id: OWNER, position: ["001"], status: "active" }],
  ]) {
    const { deps, mod } = load(hr(rows));
    const r = await call(mod.loginAccount(deps), { idToken: `tok-${OWNER}` });
    assert.deepEqual([r.code, r.body.error], [403, "owner_only"], JSON.stringify(rows));
  }
  // แพ็กเกจพนักงานยังไม่หมด → แถวที่ 2 ที่เป็นเจ้าของนับได้
  const { deps, mod } = load({ [`shop/${SHOP}`]: { shopId: SHOP, name: "TEST Shopchamp", vip: VIP_OK, humanResource: [{ id: "first", position: ["001"], status: "active" }, { id: OWNER, position: ["001"], status: "active" }] } });
  const r = await call(mod.loginAccount(deps), { idToken: `tok-${OWNER}` });
  assert.deepEqual(r.body.shops.map((s) => s.externalId), [SHOP, LEGACY]);
});

test("account: ไม่มี profile = 403 owner_only · ชื่อสำรอง = ชื่อใน token แล้วชื่อแถวเจ้าของ", async () => {
  const { deps, mod } = load({ [`profile/${OWNER}`]: undefined });
  const none = await call(mod.loginAccount(deps), { idToken: `tok-nobody` });
  assert.deepEqual([none.code, none.body.error], [403, "owner_only"]);

  const noName = { [`profile/${OWNER}`]: { port: [{ position: ["001"], shopId: SHOP }] } };
  const a = load(noName);
  const r1 = await call(a.mod.loginAccount(a.deps), { idToken: `tok-${OWNER}|ชื่อในบัญชี` });
  assert.equal(r1.body.name, "ชื่อในบัญชี");
  const b = load(noName);
  const r2 = await call(b.mod.loginAccount(b.deps), { idToken: `tok-${OWNER}` });
  assert.equal(r2.body.name, "เจ้าของในร้าน");
});

test("account: token ผิด/ถูกเพิกถอน → 401 account_token_invalid · log แค่รหัสเหตุ ไม่มี token · ไม่อ่านฐาน", async () => {
  for (const idToken of ["garbage", "tok-revoked"]) {
    const { deps, logs, mod, mem } = load();
    const r = await call(mod.loginAccount(deps), { idToken });
    assert.deepEqual([r.code, r.body.ok, r.body.error], [401, false, "account_token_invalid"], idToken);
    assert.ok(logs.length === 1 && !JSON.stringify(logs).includes(idToken), "log ไม่มี token");
    assert.equal(mem.writes.length, 0);
  }
  // verify คืนของไม่มี uid = 401 เหมือนกัน
  const { mod } = load();
  const r = await call(mod.loginAccount({ now: () => NOW, verifyIdToken: async () => ({}) }), { idToken: "tok-x" });
  assert.deepEqual([r.code, r.body.error], [401, "account_token_invalid"]);
});

test("account: รูปคำขอผิด → 400 invalid_request ไม่เรียก verify", async () => {
  const { deps, verifyCalls, mod } = load();
  const h = mod.loginAccount(deps);
  for (const body of [{}, { idToken: "" }, { idToken: 5 }, { idToken: "t".repeat(4097) }, { idToken: `tok-${OWNER}`, externalId: SHOP }]) {
    const r = await call(h, body);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(body).slice(0, 60));
  }
  assert.equal(verifyCalls.length, 0);
  // ยาวพอดี 4096 = ผ่านรูป (ไปตก verify)
  const r = await call(h, { idToken: "t".repeat(4096) });
  assert.equal(r.code, 401);
});

test("account: เพดาน — อ่าน port ≤50 ค่า · คืนร้าน ≤50", async () => {
  const port = Array.from({ length: 80 }, (_, i) => ({ position: ["001"], shopId: `f${i}` }));
  const shops = {};
  for (let i = 0; i < 80; i++) shops[`shop/d${i}`] = { shopId: `f${i}`, name: `ร้าน ${i}`, humanResource: [{ id: OWNER, position: ["001"], status: "active" }] };
  const { deps, mod } = load({ [`profile/${OWNER}`]: { name: "ก", port }, ...shops });
  const r = await call(mod.loginAccount(deps), { idToken: `tok-${OWNER}` });
  assert.equal(r.code, 200);
  assert.equal(r.body.shops.length, 50);
  assert.deepEqual(mod.portShopIds({ port }).length, 50);
  // แถว position '001' มาก่อน · ค่าไม่ซ้ำ · แถวผิดรูปข้าม
  assert.deepEqual(mod.portShopIds({ port: [{ position: ["002"], shopId: "s" }, null, { shopId: "a/b" }, { position: ["001"], shopId: "o" }, { position: ["001"], shopId: "o" }] }), ["o", "s"]);
});

test("owner-check: เจ้าของ → isOwner true + ชื่อ · พนักงาน/คนนอก → false ชื่อว่าง · ร้านไม่มี 404 · รูปผิด 400 · ไม่เขียน", async () => {
  const { mem, deps, mod } = load();
  const h = mod.loginOwnerCheck(deps);
  const yes = await call(h, { personRef: OWNER, externalId: SHOP });
  assert.deepEqual(yes.body, { ok: true, isOwner: true, name: "เจ้าของในร้าน", shopName: "TEST Shopchamp" });
  const staff = await call(h, { personRef: STAFF, externalId: SHOP });
  assert.deepEqual(staff.body, { ok: true, isOwner: false, name: "", shopName: "TEST Shopchamp" });
  const stranger = await call(h, { personRef: "nobody", externalId: SHOP });
  assert.equal(stranger.body.isOwner, false);
  const missing = await call(h, { personRef: OWNER, externalId: "ghost" });
  assert.deepEqual([missing.code, missing.body.error], [404, "shop_not_found"]);
  for (const body of [{}, { personRef: OWNER }, { personRef: "a/b", externalId: SHOP }, { personRef: OWNER, externalId: SHOP, idToken: "x" }]) {
    const r = await call(h, body);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(body));
  }
  assert.equal(mem.writes.length, 0);
});

test("owner-check: ถอดจากเจ้าของภายหลัง (inActive) → isOwner false", async () => {
  const { deps, mod } = load({ [`shop/${SHOP}`]: { shopId: SHOP, name: "TEST Shopchamp", humanResource: [{ id: OWNER, position: ["001"], status: "inActive" }] } });
  const r = await call(mod.loginOwnerCheck(deps), { personRef: OWNER, externalId: SHOP });
  assert.deepEqual([r.code, r.body.isOwner], [200, false]);
});

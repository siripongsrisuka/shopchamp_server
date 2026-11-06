// เทส ก้อน 10 รอบ 2c (DEV-0001) · รัน: node --test functions/pos/shopStaff/round2c.test.js
//   shop.lineSettings (LS-033) · profile.claimLegacyShop (LD-029) · ผู้อ่าน profile.currentLogin นอกแอป (เว็บเจ้าของร้าน · /bill/loading)
//   ฐานปลอมแบบมีสถานะ (testKit.makeStore) ⇒ วัดลำดับหลายคำขอ ส่งซ้ำ และของที่เขียนลงจริง
//   แต่ละกลุ่มมีตัวกลายพันธุ์ที่ต้องทำเทสแดง (คู่เทียบ 2 ทิศ)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const kit = require("./testKit");

// schema ที่ติดตั้งอาจยังไม่มีคำขอของรอบนี้ (ก่อนผูก vendor) ⇒ build จาก src ของ center ลง require.cache
(function ensureRound2cSchema() {
  const installed = require("@shopchamp/schema");
  if (installed.ShopLineSettingsRequest && installed.ProfileClaimLegacyShopRequest && installed.ProfileManageRequest) return;
  const esbuild = require(require.resolve("esbuild", { paths: [kit.CENTER] }));
  const src = path.join(kit.CENTER, "packages/schema/src");
  const entry = ["index", "requests/lineSettings", "requests/claimLegacyShop", "requests/shopStaff"].map((f) => `export * from ${JSON.stringify(path.join(src, f))};`).join("\n");
  const out = esbuild.buildSync({ stdin: { contents: entry, resolveDir: src, loader: "ts" }, bundle: true, platform: "node", format: "cjs", external: ["zod"], write: false });
  const abs = require.resolve("@shopchamp/schema");
  const m = new module.constructor(abs, module);
  m.filename = abs;
  m.paths = module.constructor._nodeModulePaths(path.dirname(abs));
  m._compile(out.outputFiles[0].text, abs);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: m.exports };
})();

const store = kit.makeStore();
kit.install(store);
const SB = require("../gateway/secretBox");
const L = require("./lineSettings");
const C = require("./claimLegacyShop");
const PM = require("./profileManage");
const { INITIAL_RIGHTS } = require("../_shared/auth");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");
const KEY = Buffer.from(KEY_B64, "base64");
const deps = { now: () => NOW, credKey: KEY_B64 };
const OWNER = { shopAccess: { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] } };
const STAFF_NO_SET = { shopAccess: { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["100"] } };
const far = new Date("2027-01-01T00:00:00.000Z");
const openBox = (box, shopId) => SB.open(box, { providerId: "line", field: "channelAccessToken", shopId }, { key: KEY });

function seedLine(extra) {
  store.reset({
    shop: {
      shopA: {
        shopId: "shopA",
        name: "ร้านทดสอบ",
        humanResource: [
          { id: "u-owner", position: ["001"], status: "active" },
          { id: "u-staff", position: [], status: "active", rights: ["100"] },
        ],
        vip: [{ type: "staff", expire: far }],
        line: { liff: "https://liff.line.me/old", userId: "Uold", channelAccessToken: "tok-old", extraKey: "คงไว้" },
        ...(extra || {}),
      },
    },
  });
}

// ─────────────── shop.lineSettings ───────────────

test("LINE: บันทึก token ใหม่ → ที่ลับถอดได้ token เดียวกัน · สำเนาเดิมรูปเดิม (แอปเก่าอ่านต่อได้) · คำตอบไม่มี token", async () => {
  seedLine();
  const call = kit.caller(L.lineSettings(deps));
  const r = await call({ shopId: "shopA", liff: "https://liff.line.me/new", userId: "U123", channelAccessToken: "tok-new" }, OWNER);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.fields.sort(), ["line", "secret"]);
  assert.equal(JSON.stringify(r.body).includes("tok-new"), false, "คำตอบห้ามมี token");
  assert.equal(r.body.line.hasToken, true);
  const sec = store.data.lineSecrets.shopA;
  assert.equal(JSON.stringify(sec).includes("tok-new"), false, "ที่ลับห้ามเก็บ token ดิบ");
  assert.equal(openBox(sec.channelAccessToken, "shopA").plain, "tok-new");
  assert.equal(openBox(sec.channelAccessToken, "shopB").error.code, "gateway_cred_unreadable", "ย้ายข้ามร้านถอดไม่ออก");
  const line = store.data.shop.shopA.line;
  assert.deepEqual(line, { liff: "https://liff.line.me/new", userId: "U123", channelAccessToken: "tok-new", extraKey: "คงไว้" });
  // แอปเก่า: อ่าน shop.line แล้วส่ง {user:[userId], channelAccessToken} ให้ /line/broadcast (LineSettingScreen.js:62-66)
  const { userId, channelAccessToken } = store.data.shop.shopA.line;
  assert.deepEqual({ user: [userId], channelAccessToken }, { user: ["U123"], channelAccessToken: "tok-new" });
});

test("LINE: ส่งซ้ำค่าเดิม = changed:false ไม่เขียน · ไม่ส่ง token = ใช้ของเดิม (ย้ายสำเนาเดิมเข้าที่ลับครั้งแรก)", async () => {
  seedLine();
  const call = kit.caller(L.lineSettings(deps));
  const a = await call({ shopId: "shopA", liff: "https://liff.line.me/old", userId: "Uold" }, OWNER);
  assert.equal(a.code, 200);
  assert.deepEqual(a.body.fields, ["secret"], "สำเนาเท่าเดิม · ที่ลับยังไม่มี = เขียนที่ลับอย่างเดียว");
  assert.equal(openBox(store.data.lineSecrets.shopA.channelAccessToken, "shopA").plain, "tok-old");
  const n = store.log.length;
  const b = await call({ shopId: "shopA", liff: "https://liff.line.me/old", userId: "Uold" }, OWNER);
  assert.equal(b.body.changed, false);
  assert.equal(store.log.length, n, "ไม่มีอะไรเปลี่ยน = ไม่เขียน");
});

test("LINE: แอปเก่าแก้สำเนาเดิมหลังแอปใหม่บันทึก → แอปใหม่บันทึกโดยไม่ส่ง token = ใช้สำเนา (ไม่ย้อนเป็น token เก่าในที่ลับ)", async () => {
  seedLine();
  const call = kit.caller(L.lineSettings(deps));
  await call({ shopId: "shopA", liff: "l", userId: "u", channelAccessToken: "tok-A" }, OWNER);
  store.data.shop.shopA.line.channelAccessToken = "tok-B"; // แอปเก่าเขียนตรง (LineSettingScreen รุ่นเก่า)
  const r = await call({ shopId: "shopA", liff: "l2", userId: "u" }, OWNER);
  assert.equal(r.code, 200);
  assert.equal(store.data.shop.shopA.line.channelAccessToken, "tok-B");
  assert.equal(openBox(store.data.lineSecrets.shopA.channelAccessToken, "shopA").plain, "tok-B");
});

test("LINE: ปัด · พนักงานไม่มี '101' 403 · ไม่มีกุญแจ 503 ไม่เขียน · ไม่มี token ที่ไหนเลย 400 token_required", async () => {
  seedLine();
  const call = kit.caller(L.lineSettings(deps));
  const body = { shopId: "shopA", liff: "x", userId: "y", channelAccessToken: "z" };
  assert.equal((await call(body, STAFF_NO_SET)).body.error, "right_required");
  const noKey = kit.caller(L.lineSettings({ now: () => NOW, env: {} }));
  const r = await noKey(body, OWNER);
  assert.equal(r.code, 503);
  assert.equal(r.body.error, "secret_key_missing");
  assert.equal(store.log.length, 0);
  seedLine({ line: { liff: "", userId: "", channelAccessToken: "" } });
  const t = await call({ shopId: "shopA", liff: "x", userId: "y" }, OWNER);
  assert.equal(t.code, 400);
  assert.equal(t.body.error, "token_required");
  assert.equal(store.log.length, 0);
});

test("LINE คู่เทียบ: ตัวกลายพันธุ์ที่ไม่เขียนสำเนาเดิม ต้องทำเทสสำเนาแดง", async () => {
  seedLine();
  // กลายพันธุ์: ตัด tx.update ของ shop ทิ้ง (เก็บที่ลับอย่างเดียว) ⇒ แอปเก่าเห็น token เดิม
  const realRun = store.db.runTransaction;
  store.db.runTransaction = (fn) => realRun((tx) => fn({ ...tx, update: () => tx }));
  try {
    const call = kit.caller(L.lineSettings(deps));
    await call({ shopId: "shopA", liff: "https://liff.line.me/new", userId: "U123", channelAccessToken: "tok-new" }, OWNER);
    assert.notEqual(store.data.shop.shopA.line.channelAccessToken, "tok-new", "กลายพันธุ์ต้องทำให้สำเนาไม่ตรง (เทสหลักจับได้)");
  } finally {
    store.db.runTransaction = realRun;
  }
});

// ─────────────── profile.claimLegacyShop ───────────────

function seedLegacy(extraShops) {
  store.reset({
    shop: {
      sLegacy: { shopId: "u-old", name: "ร้านรุ่นแรก", ownerName: "เจ้าของเก่า", tel: "0812345678", email: "old@example.com", logo: "https://img/logo.png", payment: [{ id: "001" }] },
      ...(extraShops || {}),
    },
  });
}
const OLD = { auth: { uid: "u-old" } };
const claimBody = { posId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", uniqueId: "dev-1", deviceName: "Tab" };

test("ร้านรุ่นแรก: เข้าครั้งแรก → profile + doc กะ + แถวเจ้าของ (active) + จุดขายแรก ใน tx เดียว · แล้ว enterShop เข้าร้านได้", async () => {
  seedLegacy();
  const call = kit.caller(C.claimLegacyShop({ now: () => NOW }));
  const r = await call(claimBody, OLD);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.claimed, true);
  const p = store.data.profile["u-old"];
  assert.deepEqual(p.currentLogin, { shopId: "u-old", printer: [], rights: [...INITIAL_RIGHTS] });
  assert.deepEqual(p.port, [{ position: ["001"], shopId: "u-old", shopName: "ร้านรุ่นแรก", logo: "https://img/logo.png" }]);
  assert.equal(p.name, "เจ้าของเก่า");
  const shop = store.data.shop.sLegacy;
  assert.equal(shop.humanResource[0].status, "active");
  assert.equal(shop.POSs.length, 1);
  const shift = store.data.shift[shop.POSs[0].shiftId];
  assert.equal(shift.posId, claimBody.posId);
  assert.equal(shift.shopId, "u-old");
  assert.equal(store.log.length, 3, "เขียน 3 doc ใน tx เดียว");
  // เปิดแอปครั้งถัดไป: เข้าร้านผ่าน profile.manage enterShop ได้ (แอปเก่าไม่ใส่ status = ตรงนี้ตก)
  const enter = kit.caller(PM.profileManage({ now: () => NOW }));
  const e = await enter({ op: "enterShop", shopId: "sLegacy" }, OLD);
  assert.equal(e.code, 200, JSON.stringify(e.body));
  assert.equal(e.body.access.role, "owner");
});

test("ร้านรุ่นแรก: ส่งซ้ำหลังสำเร็จ = claimed:false ไม่เขียน · ไม่มีร้าน 404 · ร้านมีพนักงานแล้ว 409 ไม่ทับ · หลายร้านเลือกตัวท้ายตาม doc id", async () => {
  seedLegacy();
  const call = kit.caller(C.claimLegacyShop({ now: () => NOW }));
  await call(claimBody, OLD);
  const n = store.log.length;
  const again = await call(claimBody, OLD);
  assert.equal(again.body.claimed, false);
  assert.equal(store.log.length, n);

  assert.equal((await call(claimBody, { auth: { uid: "u-nobody" } })).body.error, "legacy_shop_not_found");

  seedLegacy({ sLegacy: { shopId: "u-old", humanResource: [{ id: "u-x", position: [] }], POSs: [] } });
  const busy = await call(claimBody, OLD);
  assert.equal(busy.code, 409);
  assert.equal(busy.body.error, "shop_already_claimed");
  assert.equal(store.log.length, 0);

  seedLegacy({ aFirst: { shopId: "u-old", name: "ร้าน a" }, zLast: { shopId: "u-old", name: "ร้าน z" } });
  const many = await call(claimBody, OLD);
  assert.equal(many.body.shopDocId, "zLast");
  assert.equal(many.body.otherLegacyShops, 2);
  assert.equal(store.data.shop.aFirst.humanResource, undefined, "ร้านอื่นไม่ถูกแตะ");

  assert.equal((await call({ ...claimBody, posId: "not-uuid" }, OLD)).code, 400);
  assert.equal((await call({ ...claimBody, humanResource: [] }, OLD)).code, 400, "strict");
  assert.equal((await call(claimBody, {})).code, 401);
});

test("ร้านรุ่นแรก คู่เทียบ: แถวเจ้าของแบบแอปเก่า (ไม่มี status) → enterShop ปัด 403", async () => {
  seedLegacy();
  store.data.shop.sLegacy.humanResource = [{ id: "u-old", position: ["001"], name: "เจ้าของเก่า", imageId: "", email: "", tel: "" }];
  store.data.profile = { "u-old": { port: [], currentLogin: { shopId: "u-old", printer: [], rights: [] } } };
  const enter = kit.caller(PM.profileManage({ now: () => NOW }));
  const e = await enter({ op: "enterShop", shopId: "sLegacy" }, OLD);
  assert.equal(e.code, 403, "รูปแอปเก่าเข้าร้านไม่ได้ ⇒ status 'active' ที่ handler ใส่มีผลจริง");
});

// ─────────────── ผู้อ่าน currentLogin นอกแอป ───────────────
// ตรรกะเลือกร้านของเว็บเจ้าของร้าน คัดตรงตัวจาก `shopchamp_webowner/src/screens/HomeScreen.js:96-104` (currentShopId = ร้านที่เว็บจำไว้ในเครื่อง)
function webOwnerPick(profileDoc, currentShopId) {
  let loginByShopId = "";
  const { port, currentLogin } = profileDoc;
  const lastLogin = port.find((a) => a.shopId === currentShopId);
  if (lastLogin) loginByShopId = currentShopId;
  else if (currentLogin && currentLogin.shopId) loginByShopId = currentLogin.shopId;
  return loginByShopId;
}
// แล้วเว็บหา doc ร้านด้วย where('shopId','==',loginByShopId) (:107) · /bill/loading (`apis/bill.js:125-127`) ใช้ currentLogin.shopId เป็น doc id
const shopByField = (field) => Object.keys(store.data.shop).filter((id) => store.data.shop[id].shopId === field);

test("currentLogin: เข้าร้านด้วย enterShop (แอปใหม่) → เว็บเจ้าของร้านเลือกร้านเดียวกัน · ร้านรุ่นแรก (field ≠ doc id) ก็ถูก", async () => {
  store.reset({
    shop: {
      sNew: { shopId: "sNew", name: "ร้านใหม่", humanResource: [{ id: "u-o", position: ["001"], status: "active" }] },
      sLeg: { shopId: "u-o", name: "ร้านรุ่นแรก", humanResource: [{ id: "u-o", position: ["001"], status: "active" }] },
    },
    profile: { "u-o": { port: [], currentLogin: { shopId: "", printer: [], rights: [] } } },
  });
  const enter = kit.caller(PM.profileManage({ now: () => NOW }));
  for (const [docId, field] of [["sNew", "sNew"], ["sLeg", "u-o"]]) {
    const r = await enter({ op: "enterShop", shopId: docId }, { auth: { uid: "u-o" } });
    assert.equal(r.code, 200);
    const prof = store.data.profile["u-o"];
    const picked = webOwnerPick(prof, "ร้านที่เว็บไม่รู้จัก");
    assert.equal(picked, field);
    assert.deepEqual(shopByField(picked), [docId], "เว็บหาเจอร้านที่แอปเข้าอยู่");
  }
  // เปิดแอปใหม่ครั้งถัดไป: LoadingScreen ไม่เขียน currentLogin (f80e5706) · แอปเก่าเขียนแค่ shopId ตัวเดิม (main3 LoadingScreen.js:65,80-86)
  //   ⇒ ค่าที่เว็บใช้ (currentLogin.shopId) เท่ากันทั้ง 2 ทาง · ที่ต่างคือ rights/printer ซึ่งเว็บไม่อ่าน
  const before = store.data.profile["u-o"].currentLogin.shopId;
  const oldAppOpenWrite = { shopId: before, printer: [], rights: ["ค่าใหม่"] };
  assert.equal(webOwnerPick({ port: [], currentLogin: oldAppOpenWrite }, "x"), webOwnerPick(store.data.profile["u-o"], "x"));
});

test("currentLogin คู่เทียบ: ตัวกลายพันธุ์ enterShop ที่เขียน doc id แทน field ร้าน → เว็บหาร้านรุ่นแรกไม่เจอ", () => {
  const mutantProfile = { port: [], currentLogin: { shopId: "sLeg" } };
  store.reset({ shop: { sLeg: { shopId: "u-o" } } });
  assert.deepEqual(shopByField(webOwnerPick(mutantProfile, "x")), [], "เทสข้างบนจับความต่างนี้ได้");
});

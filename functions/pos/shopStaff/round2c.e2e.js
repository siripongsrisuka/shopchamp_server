// pos/shopStaff/round2c.e2e.js — shop.lineSettings · profile.claimLegacyShop บน Firestore emulator ตัวจริง (ก้อน 10 รอบ 2c · DEV-0001)
//   วัดสิ่งที่ฐานปลอมวัดไม่ได้: transaction จริง (2 เครื่องเข้าครั้งแรกพร้อมกัน) · query นอก tx · Timestamp จริง · กล่องลับถอดได้หลังผ่าน SDK
// รัน: cd shopchamp_server/functions && node pos/e2e/run.js pos/shopStaff/round2c.e2e.js
//   ❌ ไม่แตะฐานจริง: _env ปัดถ้าไม่ใช่ emulator บนเครื่องนี้ + project demo-
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const E = require("../e2e/_env");
const kit = require("./testKit");

// schema ที่ติดตั้งอาจยังไม่มีคำขอรอบนี้ (ก่อนผูก vendor) ⇒ build จาก src ของ center (ไม่แทน firebase)
(function ensureRound2cSchema() {
  const installed = require("@shopchamp/schema");
  if (installed.ShopLineSettingsRequest && installed.ProfileClaimLegacyShopRequest && installed.ProfileManageRequest) return;
  const esbuild = require(require.resolve("esbuild", { paths: [kit.CENTER] }));
  const src = path.join(kit.CENTER, "packages/schema/src");
  const out = esbuild.buildSync({ entryPoints: [path.join(src, "index.ts")], bundle: true, platform: "node", format: "cjs", external: ["zod"], write: false });
  const abs = require.resolve("@shopchamp/schema");
  const m = new module.constructor(abs, module);
  m.filename = abs;
  m.paths = module.constructor._nodeModulePaths(path.dirname(abs));
  m._compile(out.outputFiles[0].text, abs);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: m.exports };
})();

const SB = require("../gateway/secretBox");
const { lineSettings } = require("./lineSettings");
const { claimLegacyShop } = require("./claimLegacyShop");
const { profileManage } = require("./profileManage");

const { call, seed, get, where, T, ns, clock } = E;
before(() => E.ready());
const NOW = clock("2026-11-10T03:00:00.000Z");
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => 31 - i)).toString("base64");

test("e2e LINE: บันทึก → lineSecrets ถอดได้ token เดียวกัน · shop.line รูปเดิม · settingsUpdate.at เป็น Timestamp · คำตอบไม่มี token", async () => {
  const n = ns();
  const shopId = `shopL${n}`, owner = `u-owner${n}`;
  await seed({ shop: { [shopId]: { shopId, name: "ร้าน LINE", humanResource: [{ id: owner, position: ["001"], status: "active" }], line: { liff: "", userId: "", channelAccessToken: "" } } } });
  const deps = { ...NOW, credKey: KEY_B64 };
  const r = await call(lineSettings, deps, { body: { shopId, liff: "https://liff.line.me/x", userId: "Uabc", channelAccessToken: "tok-e2e" }, shopAccess: { shopId, uid: owner, role: "owner", rights: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.stringify(r.body).includes("tok-e2e"), false);
  const sec = await get("lineSecrets", shopId);
  assert.equal(JSON.stringify(sec).includes("tok-e2e"), false);
  const o = SB.open(sec.channelAccessToken, { providerId: "line", field: "channelAccessToken", shopId }, { key: Buffer.from(KEY_B64, "base64") });
  assert.equal(o.plain, "tok-e2e");
  assert.equal(typeof sec.updatedAt.toMillis, "function", "updatedAt เป็น Timestamp");
  const shop = await get("shop", shopId);
  assert.deepEqual(shop.line, { liff: "https://liff.line.me/x", userId: "Uabc", channelAccessToken: "tok-e2e" });
  assert.equal(typeof shop.settingsUpdate.at.toMillis, "function");
});

test("e2e ร้านรุ่นแรก: 2 เครื่องเข้าครั้งแรกพร้อมกัน → ร้านได้แถวเจ้าของ 1 แถว จุดขาย 1 จุด doc กะ 1 ใบ · แล้ว enterShop เข้าได้", async () => {
  const n = ns();
  const uid = `u-legacy${n}`, shopDoc = `sLeg${n}`;
  await seed({ shop: { [shopDoc]: { shopId: uid, name: "ร้านรุ่นแรก", ownerName: "เจ้าของเก่า", tel: "0812345678", email: "", payment: [{ id: "001" }] } } });
  const go = (posId, dev) => call(claimLegacyShop, NOW, { body: { posId, uniqueId: dev }, auth: { uid } });
  const [a, b] = await Promise.all([go("1b4e28ba-2fa1-41d2-883f-0016d3cca427", "dev-A"), go("2c5f39cb-3fb2-42e3-994f-1127e4ddb538", "dev-B")]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.deepEqual([a.body.claimed, b.body.claimed].sort(), [false, true], "ได้เครื่องเดียว อีกเครื่องเห็น profile แล้ว");
  const win = a.body.claimed ? a.body : b.body;
  const shop = await get("shop", shopDoc);
  assert.equal(shop.humanResource.length, 1);
  assert.equal(shop.humanResource[0].status, "active");
  assert.equal(shop.POSs.length, 1);
  assert.equal(shop.POSs[0].id, win.posId);
  const shifts = await where("shift", "shopId", uid);
  assert.equal(shifts.length, 1, "doc กะ 1 ใบ (tx ที่แพ้ไม่ทิ้ง doc ค้าง)");
  assert.equal(shifts[0].id, shop.POSs[0].shiftId);
  const prof = await get("profile", uid);
  assert.equal(typeof prof.timestamp.toMillis, "function");
  assert.equal(prof.currentLogin.shopId, uid);
  const e = await call(profileManage, NOW, { body: { op: "enterShop", shopId: shopDoc }, auth: { uid } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.access.role, "owner");
});

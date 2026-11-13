// เทส pos/scango/link.js — ScanGo บอกร้านเปิด/ปิดช่องทาง → shop.scango.enabled (ฐานปลอม announcement/_testDb · ❌ ไม่แตะ Firestore จริง)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { install, makeRes } = require("../announcement/_testDb");

const NOW = new Date("2026-11-13T05:00:00.000Z");
const SHOP = "wJNgra1ik0pzRQFlZNOD";
const FILES = ["_core.js", "link.js"].map((f) => path.join(__dirname, f));

function load(shop) {
  const mem = install({ [`shop/${SHOP}`]: shop || { name: "TEST Shopchamp", scango: { productIds: ["p1"], merchantLinkedAt: NOW, minOrder: 50 } } }, FILES, () => NOW);
  return { mem, link: require("./link").link };
}
async function call(link, body) {
  const res = makeRes();
  await link({ now: () => NOW })({ body }, res);
  return res;
}

test("linked true/false → เขียน scango.enabled ช่องเดียว (ช่องอื่นใน scango คงอยู่) · ตอบ {ok, linked}", async () => {
  const t = load();
  const on = await call(t.link, { externalId: SHOP, linked: true });
  assert.deepEqual([on.code, on.body], [200, { ok: true, linked: true }]);
  let s = t.mem.store.get(`shop/${SHOP}`);
  assert.equal(s.scango.enabled, true);
  assert.deepEqual(s.scango.productIds, ["p1"]);
  assert.equal(s.scango.minOrder, 50);
  assert.equal(s.name, "TEST Shopchamp");
  const off = await call(t.link, { externalId: SHOP, linked: false });
  assert.deepEqual([off.code, off.body], [200, { ok: true, linked: false }]);
  s = t.mem.store.get(`shop/${SHOP}`);
  assert.equal(s.scango.enabled, false);
  assert.deepEqual(s.scango.productIds, ["p1"]);
});

test("ร้านที่ยังไม่มีก้อน scango → สร้าง scango.enabled ได้", async () => {
  const t = load({ name: "ร้านใหม่" });
  const r = await call(t.link, { externalId: SHOP, linked: true });
  assert.equal(r.code, 200);
  assert.deepEqual(t.mem.store.get(`shop/${SHOP}`).scango, { enabled: true });
});

test("🔒 400 invalid_request (linked ไม่ใช่ boolean · ช่องเกิน · externalId ผิดรูป/ไม่ส่ง) · 404 shop_not_found · ไม่เขียน", async () => {
  const t = load();
  for (const body of [{ externalId: SHOP }, { externalId: SHOP, linked: "true" }, { externalId: SHOP, linked: 1 }, { externalId: SHOP, linked: true, enabled: true }, { externalId: "a/b", linked: true }, { linked: true }]) {
    const r = await call(t.link, body);
    assert.deepEqual([r.code, r.body.error], [400, "invalid_request"], JSON.stringify(body));
  }
  const none = await call(t.link, { externalId: "ghostShop000000000001", linked: true });
  assert.deepEqual([none.code, none.body.error], [404, "shop_not_found"]);
  assert.equal(t.mem.writes.length, 0);
});

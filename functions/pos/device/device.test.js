// เทสวงจรเครื่องรับแจ้งเตือน (DEV-0001 push) บนฐานปลอมแบบมีสถานะ (testKit) · สิ่งที่ harness ของสัญญาวัดไม่ได้:
//   ลงทะเบียน → ถูกเลือกเป็นผู้รับ → token ตาย → ส่ง token เดิมซ้ำต้องยังตาย → token ใหม่ปลุก → ออกร้าน/ออกระบบ = ไม่ถูกเลือกอีก
//   และ update ของ token เดิมต้อง "ไม่มี" ช่อง invalid/token (harness ตรวจได้แค่ว่ามี)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const kit = require("../shopStaff/testKit");

const store = kit.makeStore();
kit.install(store);
const { registerPushToken } = require("./registerPushToken");
const { signOutPush } = require("./signOutPush");
const { findTargets, markInvalid, deviceIdOf } = require("../_shared/push/tokenStore");

const T1 = "A".repeat(40) + ":APA91b-one";
const T2 = "B".repeat(40) + ":APA91b-two";
const now = () => new Date("2026-11-07T03:00:00.000Z");
const reg = kit.caller(registerPushToken({ now }));
const out = kit.caller(signOutPush({ now }));
const staff = (shopId, uid) => ({ shopAccess: { shopId, uid, role: "staff", rights: [] } });
const id = deviceIdOf("dk-1");
// ตัวค้นของ testKit รองรับแค่ == ⇒ ตัวอ่านสำหรับ findTargets (== และ in) อ่านจากสถานะเดียวกัน
const qdb = {
  collection: (c) => {
    const q = (filters) => ({
      where: (f, op, v) => q([...filters, [f, op, v]]),
      get: async () => ({ docs: Object.entries(store.data[c] || {}).filter(([, d]) => filters.every(([f, op, v]) => (op === "in" ? v.includes(d[f]) : d[f] === v))).map(([docId, d]) => ({ id: docId, data: () => d })) }),
    });
    return q([]);
  },
};
const found = async (to) => (await findTargets(to, { db: qdb })).map((t) => t.docId);

test("วงจรเต็ม: ลงทะเบียน → ตาย → token เดิมไม่ปลุก → token ใหม่ปลุก → ออกร้าน → ออกระบบ", async () => {
  store.reset({});
  let r = await reg({ shopId: "s1", deviceKey: "dk-1", pushToken: T1, platform: "android" }, staff("s1", "u1"));
  assert.equal(r.code, 200);
  assert.equal(r.body.result, "created");
  assert.deepEqual(await found({ kind: "staff", shopId: "s1", ids: ["u1"] }), [id]);
  assert.equal(JSON.stringify(store.data).includes("dk-1"), false, "ไม่เก็บ deviceKey ดิบ");

  // FCM บอกว่าตาย (markInvalid ใช้ batch · ฐานปลอมนี้ไม่มี batch ⇒ จำลองผลด้วยการแก้ข้อมูลตรง)
  store.data.pushDevices[id].invalid = true;
  assert.deepEqual(await found({ kind: "shop", shopId: "s1" }), []);
  store.log = [];
  r = await reg({ shopId: "s1", deviceKey: "dk-1", pushToken: T1, platform: "android" }, staff("s1", "u1"));
  assert.equal(r.body.result, "updated");
  assert.equal("invalid" in store.log[0].v, false, "token เดิม = ไม่แตะ invalid");
  assert.equal("token" in store.log[0].v, false);
  assert.equal(store.data.pushDevices[id].invalid, true);

  r = await reg({ shopId: "s1", deviceKey: "dk-1", pushToken: T2, platform: "android" }, staff("s1", "u1"));
  assert.equal(r.body.result, "token_updated");
  assert.equal(store.data.pushDevices[id].invalid, false);
  assert.equal(store.data.pushDevices[id].token, T2);
  assert.deepEqual(await found({ kind: "shop", shopId: "s1" }), [id]);

  // ย้ายร้าน = ร้านเดิมไม่เห็นเครื่องนี้อีก
  await reg({ shopId: "s2", deviceKey: "dk-1", pushToken: T2, platform: "android" }, staff("s2", "u1"));
  assert.deepEqual(await found({ kind: "shop", shopId: "s1" }), []);
  assert.deepEqual(await found({ kind: "shop", shopId: "s2" }), [id]);

  // คนอื่นล้างเครื่องเราไม่ได้
  r = await out({ deviceKey: "dk-1", scope: "all" }, { auth: { uid: "u-other" } });
  assert.equal(r.body.cleared, false);
  assert.deepEqual(await found({ kind: "shop", shopId: "s2" }), [id]);

  r = await out({ deviceKey: "dk-1", scope: "shop" }, { auth: { uid: "u1" } });
  assert.equal(r.body.cleared, true);
  assert.deepEqual(await found({ kind: "shop", shopId: "s2" }), []);
  assert.deepEqual(await found({ kind: "people", ids: ["u1"] }), [id], "ออกร้านแล้วยังรับรายคน (ผลสั่งซื้อ)");

  r = await out({ deviceKey: "dk-1", scope: "all" }, { auth: { uid: "u1" } });
  assert.equal(r.body.cleared, true);
  assert.deepEqual(await found({ kind: "people", ids: ["u1"] }), []);
});

test("watcher ลงทะเบียนไม่ได้ · ไม่มีอะไรถูกเขียน", async () => {
  store.reset({});
  const r = await reg({ shopId: "s1", deviceKey: "dk-1", pushToken: T1, platform: "ios" }, { shopAccess: { shopId: "s1", uid: "w", role: "owner", rights: [], watcher: true, readOnly: true } });
  assert.equal(r.code, 403);
  assert.deepEqual(store.data, {});
});

test("markInvalid ส่ง merge (ไม่ทับ doc ทั้งใบ)", async () => {
  const sets = [];
  const db = { collection: () => ({ doc: (x) => ({ path: x }) }), batch: () => ({ set: (r, d, o) => sets.push(o), commit: async () => {} }) };
  await markInvalid(["a"], "fcm_dead", { db });
  assert.deepEqual(sets, [{ merge: true }]);
});

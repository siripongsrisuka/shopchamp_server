// pos/e2e/push.e2e.js — แจ้งเตือนแอปใหม่บน emulator (DEV-0001 push · แอป 5.00.00 ไม่มี OneSignal)
//   handler ตัวจริง + tokenStore ตัวจริง (query == / in บน emulator) + ติดธง invalid ลงฐานจริงของ emulator
//   FCM = ปลอม (บันทึกข้อความ · ตอบ token ตายได้) · OneSignal = ไม่มีกุญแจ ⇒ ข้าม (พิสูจน์ด้วย onesignal.skipped)
// รัน: cd functions && node pos/e2e/run.js pos/e2e/push.e2e.js
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const { registerPushToken } = require("../device/registerPushToken");
const { signOutPush } = require("../device/signOutPush");
const { manage } = require("../shift/manage");
const { void: makeVoid } = require("../sale/void");
const { create } = require("../sale/create");
const { sendPush } = require("../_shared/push/send");
const { deviceIdOf } = require("../_shared/push/tokenStore");

const { call, seed, get, clock, saleBody, reqId } = E;
const OPEN = "2026-11-10T01:00:00.000Z";
before(() => E.ready());

/** FCM ปลอม: บันทึกทุกข้อความ · token ใน dead = ตอบ not-registered */
function fakeFcm(dead = new Set()) {
  const sent = [];
  const messaging = {
    sendEach: async (msgs) => {
      sent.push(...msgs);
      return { responses: msgs.map((m) => (dead.has(m.token) ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true, messageId: "m" })) };
    },
  };
  const results = [];
  const push = async (m) => { const r = await sendPush(m, { messaging, env: {}, log: { info: () => {}, warn: () => {} } }); results.push(r); return r; };
  return { sent, push, results };
}
const tok = (tag) => `${tag}-${"x".repeat(40)}:APA91b`;

test("ลงทะเบียน 3 เครื่อง → เปิดกะ → FCM ถึงเฉพาะเครื่อง notiShift ในร้านนี้ · token ตายติดธงในฐาน · ออกระบบแล้วไม่ถึง", async () => {
  const f = E.shopFixture();
  f.data.shop[f.id.shopA].notiShift = [f.id.owner, f.access.ownerB.uid];
  f.data.shift[f.id.sh1] = { ...E.INITIAL_SHIFT, shopId: f.id.shopA, posId: "pos-1", id: f.id.sh1, status: false, lastShiftDate: "20261109", shiftCount: 3 };
  await seed(f.data);
  const at = clock(OPEN);
  const K = { ownerPhone: `dk-o-${f.id.n}`, ownerTablet: `dk-t-${f.id.n}`, staff: `dk-s-${f.id.n}`, other: `dk-b-${f.id.n}` };

  // เครื่องเจ้าของ 2 เครื่อง (Android + iOS) · พนักงาน 1 · เจ้าของร้าน B 1 (ร้านอื่นต้องไม่ได้)
  const reg = (key, token, platform, shopAccess, shopId) => call(registerPushToken, at, { body: { shopId, deviceKey: key, pushToken: token, platform, appVersion: "5.00.00" }, shopAccess });
  for (const [k, t, p, a, s] of [
    [K.ownerPhone, tok("owner-phone"), "android", f.access.owner, f.id.shopA],
    [K.ownerTablet, tok("owner-ipad"), "ios", f.access.owner, f.id.shopA],
    [K.staff, tok("staff"), "android", f.access.staff, f.id.shopA],
    // เจ้าของร้าน B ใช้ uid เดียวกับเจ้าของร้าน A ไม่ได้ ⇒ ใส่ notiShift ของร้าน A เป็น uid เขา ก็ต้องไม่ได้ (คนละร้าน)
    [K.other, tok("other-shop"), "android", f.access.ownerB, f.id.shopB],
  ]) {
    const r = await reg(k, t, p, a, s);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result, "created");
  }
  const docOwner = await get("pushDevices", deviceIdOf(K.ownerPhone));
  const parsed = S.PushDevice.safeParse(docOwner);
  assert.ok(parsed.success, JSON.stringify(parsed.error && parsed.error.issues));
  assert.deepEqual([docOwner.staffId, docOwner.shopId, docOwner.client], [f.id.owner, f.id.shopA, "native"]);

  // เปิดกะ: notiShift = เจ้าของ ⇒ 2 เครื่องของเจ้าของ · iPad ตาย (FCM ตอบ not-registered)
  const fcm = fakeFcm(new Set([tok("owner-ipad")]));
  const o = await call(manage, { ...at, push: fcm.push }, { body: { op: "open", shopId: f.id.shopA, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), openCash: "500" }, shopAccess: f.access.owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.deepEqual(fcm.sent.map((m) => m.token).sort(), [tok("owner-ipad"), tok("owner-phone")]);
  const android = fcm.sent.find((m) => m.token === tok("owner-phone"));
  const ios = fcm.sent.find((m) => m.token === tok("owner-ipad"));
  assert.equal(android.notification, undefined, "Android data-only");
  assert.deepEqual([android.data.src, android.data.title, android.data.channel, android.data.sound], ["shopchamp", "เปิดกะที่ 1", "urgent", "เปิดกะที่ 1"]);
  assert.equal(ios.notification.title, "เปิดกะที่ 1");
  assert.equal(android.data.nid, ios.data.nid);
  assert.equal(fcm.results[0].onesignal.skipped, "no_key");
  const ipad = await get("pushDevices", deviceIdOf(K.ownerTablet));
  assert.deepEqual([ipad.invalid, ipad.invalidReason], [true, "fcm_dead"]);

  // แอปส่ง token เดิมของ iPad มาอีก = ยังตาย (ไม่ปลุก) · token ใหม่ = ปลุก
  await reg(K.ownerTablet, tok("owner-ipad"), "ios", f.access.owner, f.id.shopA);
  assert.equal((await get("pushDevices", deviceIdOf(K.ownerTablet))).invalid, true);
  await reg(K.ownerTablet, tok("owner-ipad2"), "ios", f.access.owner, f.id.shopA);
  assert.equal((await get("pushDevices", deviceIdOf(K.ownerTablet))).invalid, false);

  // ส่งซ้ำ requestId เดิมไม่มี … (ทดสอบใน harness) · ออกจากระบบเครื่องโทรศัพท์ → เงินเข้าออกถัดไปไม่ถึงเครื่องนั้น
  const so = await call(signOutPush, at, { body: { deviceKey: K.ownerPhone, scope: "all" }, auth: { uid: f.id.owner } });
  assert.deepEqual([so.status, so.body.cleared], [200, true]);
  const fcm2 = fakeFcm();
  const d = await call(manage, { ...clock("2026-11-10T01:30:00.000Z"), push: fcm2.push }, { body: { op: "during", shopId: f.id.shopA, shiftId: f.id.sh1, staffId: f.id.owner, staffName: "เจ้าของ", requestId: reqId(), type: 1, amount: "50", comment: "เติมเหรียญ" }, shopAccess: f.access.owner });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(fcm2.sent.map((m) => m.token), [tok("owner-ipad2")]);
});

test("ขายแล้วสต๊อกวิกฤต → notiStock · ยกเลิกบิล → notiCancelBill · แจ้งเตือนในแอปยังเขียนตามเดิม", async () => {
  const f = E.shopFixture();
  f.data.shop[f.id.shopA].notiCancelBill = [f.id.staff];
  f.data.shop[f.id.shopA].notiStock = [f.id.staff];
  f.data.stock[f.id.pWater] = { ...f.data.stock[f.id.pWater], stock: 6, safetyStock: { status: true, qty: 5 } };
  await seed(f.data);
  const at = clock("2026-11-10T03:00:00.000Z");
  await call(registerPushToken, at, { body: { shopId: f.id.shopA, deviceKey: `dk-s-${f.id.n}`, pushToken: tok("staff2"), platform: "android" }, shopAccess: f.access.staff });
  await call(registerPushToken, at, { body: { shopId: f.id.shopA, deviceKey: `dk-o-${f.id.n}`, pushToken: tok("owner2"), platform: "android" }, shopAccess: f.access.owner });

  const fcm = fakeFcm();
  const sale = await call(create, { ...at, push: fcm.push }, { body: saleBody(f, { product: [{ id: f.id.pWater, qty: 2, name: "น้ำดื่ม", net: 20, totalPrice: 20, totalCost: 12 }], payment: [{ id: 1, amount: 20, name: "เงินสด" }], moneyMustPaid: 20, change: 0 }), shopAccess: f.access.owner });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.deepEqual(fcm.sent.map((m) => m.token), [tok("staff2")], "สต๊อกวิกฤตถึง notiStock เท่านั้น");
  assert.match(fcm.sent[0].data.body, /^สินค้าคงเหลือวิกฤต\n.+ เหลือ 4 .*น้อยกว่าระดับปลอดภัย/);
  assert.equal(fcm.sent[0].data.title, "แชมป์บอท 🤖");

  const fcm2 = fakeFcm();
  const v = await call(makeVoid, { ...at, push: fcm2.push }, { body: { shopId: f.id.shopA, billId: sale.body.billId, requestId: reqId(), reason: "ลูกค้าเปลี่ยนใจ", staffId: f.id.owner, staffName: "เจ้าของ" }, shopAccess: f.access.owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(fcm2.sent.map((m) => m.token), [tok("staff2")]);
  assert.deepEqual([fcm2.sent[0].data.title, fcm2.sent[0].data.sound], ["ยกเลิกใบเสร็จ", "ยกเลิกใบเสร็จ โดย เจ้าของ"]);
  const noti = await E.where("notification", "shopId", f.id.shopA);
  assert.ok(noti.some((n) => n.heading === "ยกเลิกใบเสร็จ" && n.categoryId === 1), "แจ้งเตือนในแอป (แอปเก่าอ่าน) ยังเขียนตามเดิม");
});

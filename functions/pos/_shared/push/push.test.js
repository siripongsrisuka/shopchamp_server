// เทสตัวส่งแจ้งเตือนฝั่ง server (DEV-0001 push) · ไม่แตะ SDK จริง: db / messaging / fetch ปลอมทั้งหมด
//   2 ทิศ: ส่งถึงเครื่องที่ควรได้ (แอปใหม่ ร้านนี้ คนนี้) · ไม่ส่งถึงเครื่องที่ไม่ควรได้ (invalid · ร้านอื่น · client อื่น · ids ว่าง)
//   token ตาย = ติดธง invalid · ทั้งก้อนล้ม = ไม่ฆ่า token · ตัวส่งไม่ throw
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildMessage, nativeData } = require("./payload");
const { sendFcm } = require("./fcm");
const { findTargets, markInvalid, deviceIdOf } = require("./tokenStore");
const { sendPush } = require("./send");
const { notify, hasRecipients } = require("./notify");
const OS = require("./onesignalPipe");

// ── ฐานปลอม (รองรับ where == / in · batch.set) ──
function fakeDb(seed) {
  const writes = [];
  const q = (docs, filters) => ({
    where: (f, op, v) => q(docs, [...filters, [f, op, v]]),
    get: async () => {
      const out = Object.entries(docs).filter(([, d]) => filters.every(([f, op, v]) => (op === "==" ? d[f] === v : op === "in" ? v.includes(d[f]) : false)));
      return { docs: out.map(([id, d]) => ({ id, data: () => d })) };
    },
  });
  return {
    writes,
    collection: (c) => ({
      ...q(seed[c] || {}, []),
      doc: (id) => ({ path: `${c}/${id}`, get: async () => ({ exists: !!(seed[c] || {})[id], data: () => (seed[c] || {})[id] }) }),
    }),
    batch: () => ({ set: (ref, data, opt) => writes.push({ path: ref.path, data, opt }), commit: async () => {} }),
  };
}
const dev = (o) => ({ token: "tok-" + Math.random().toString(36).slice(2) + "x".repeat(20), platform: "android", client: "native", staffId: "u1", shopId: "s1", invalid: false, ...o });
const silent = { info: () => {}, warn: () => {} };

test("payload: Android data-only · iOS notification+aps sound · data string ทุกค่า · key ของเราชนะ · ตัด key ต้องห้าม", () => {
  const m = { heading: "เปิดกะที่ 1", content: "ยอด 500", data: { screen: "HomeScreen", sound: "เปิดกะที่ 1", src: "evil", n: 3, from: "x", "gcm.y": "z" } };
  const a = buildMessage(m, { platform: "android", nid: "n1" });
  assert.equal(a.notification, undefined);
  assert.equal(a.android.priority, "high");
  assert.equal(typeof a.android.ttl, "number");
  assert.deepEqual(a.data, { screen: "HomeScreen", sound: "เปิดกะที่ 1", n: "3", src: "shopchamp", v: "1", nid: "n1", title: "เปิดกะที่ 1", body: "ยอด 500", channel: "urgent" });
  const i = buildMessage(m, { platform: "ios", nid: "n1" });
  assert.deepEqual(i.notification, { title: "เปิดกะที่ 1", body: "ยอด 500" });
  assert.equal(i.apns.payload.aps.sound, "default");
  assert.equal(i.apns.payload.aps["mutable-content"], undefined);
  assert.equal(nativeData({ heading: "H" }, "x").body, "H", "content ว่าง = ใช้หัวข้อ");
});

test("findTargets: เลือกเฉพาะ native · ไม่ invalid · ร้าน/คนตรง · ids/shopId ว่าง = [] · token ซ้ำนับครั้งเดียว", async () => {
  const same = "same-token-" + "y".repeat(30);
  const db = fakeDb({ pushDevices: {
    a: dev({ staffId: "u1" }), b: dev({ staffId: "u2" }), c: dev({ staffId: "u1", invalid: true }),
    d: dev({ staffId: "u1", client: "onesignal" }), e: dev({ staffId: "u1", shopId: "s2" }), f: dev({ staffId: "u3", shopId: null }),
    g: dev({ staffId: "u4", token: same }), h: dev({ staffId: "u4", token: same }), k: dev({ platform: "web" }),
  } });
  const ids = async (to) => (await findTargets(to, { db })).map((t) => t.docId).sort();
  assert.deepEqual(await ids({ kind: "shop", shopId: "s1" }), ["a", "b", "g"]);
  assert.deepEqual(await ids({ kind: "staff", shopId: "s1", ids: ["u1"] }), ["a"]);
  assert.deepEqual(await ids({ kind: "staff", shopId: "s1", ids: ["u1", "u2"] }), ["a", "b"]);
  assert.deepEqual(await ids({ kind: "people", ids: ["u1"] }), ["a", "e"]);
  assert.deepEqual(await ids({ kind: "people", ids: ["u3"] }), ["f"], "ออกร้านแล้วยังรับรายคนได้");
  assert.deepEqual(await ids({ kind: "staff", shopId: "s1", ids: [] }), [], "ids ว่าง ห้ามตกไปทั้งร้าน");
  assert.deepEqual(await ids({ kind: "staff", shopId: "", ids: ["u1"] }), []);
  assert.deepEqual(await ids({ kind: "shop", shopId: "" }), []);
  assert.deepEqual(await ids({ kind: "people", ids: [""] }), []);
  assert.deepEqual(await ids({ kind: "everyone" }), []);
  assert.deepEqual(await ids(null), []);
});

test("sendFcm: ผลราย token · not-registered = dead · ทั้งก้อนล้ม = failed ไม่ dead · dryRun ส่ง flag true", async () => {
  const calls = [];
  const messaging = { sendEach: async (msgs, dry) => { calls.push({ n: msgs.length, dry }); return { responses: msgs.map((m) => (m.token === "t2" ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : m.token === "t3" ? { success: false, error: { code: "messaging/internal-error" } } : { success: true })) }; } };
  const targets = [{ docId: "a", token: "t1", platform: "android" }, { docId: "b", token: "t2", platform: "ios" }, { docId: "c", token: "t3", platform: "android" }];
  const r = await sendFcm({ targets, messageFor: (p) => ({ data: { p } }) }, { messaging });
  assert.deepEqual([r.sent, r.failed, r.dead], [1, 2, 1]);
  assert.equal(calls[0].dry, undefined);
  await sendFcm({ targets, messageFor: () => ({}), dryRun: true }, { messaging });
  assert.equal(calls[1].dry, true);
  const down = await sendFcm({ targets, messageFor: () => ({}) }, { messaging: { sendEach: async () => { throw new Error("net"); } } });
  assert.deepEqual([down.sent, down.failed, down.dead], [0, 3, 0]);
});

test("sendPush: ส่งถึงเครื่องร้านนี้ · token ตายติดธง invalid (merge) · ตัวที่ล้มชั่วคราวไม่ถูกติดธง · nid เดียวทั้ง 2 แพลตฟอร์ม", async () => {
  const db = fakeDb({ pushDevices: { a: dev({ token: "A".repeat(30) }), b: dev({ token: "B".repeat(30), platform: "ios" }), c: dev({ token: "C".repeat(30) }) } });
  const sent = [];
  const messaging = { sendEach: async (msgs) => { sent.push(...msgs); return { responses: msgs.map((m) => (m.token.startsWith("B") ? { success: false, error: { code: "messaging/invalid-registration-token" } } : m.token.startsWith("C") ? { success: false, error: { code: "messaging/unavailable" } } : { success: true })) }; } };
  const r = await sendPush({ to: { kind: "shop", shopId: "s1" }, heading: "H", content: "C" }, { db, messaging, log: silent, env: {}, uuid: () => "nid-1" });
  assert.equal(r.devices, 3);
  assert.equal(r.sent, 1);
  assert.equal(r.invalidated, 1);
  assert.deepEqual(db.writes.map((w) => w.path), ["pushDevices/b"]);
  assert.equal(db.writes[0].data.invalid, true);
  assert.deepEqual(db.writes[0].opt, { merge: true });
  assert.ok(sent.every((m) => m.data.nid === "nid-1"));
  assert.equal(sent.find((m) => m.token.startsWith("B")).notification.title, "H");
  assert.equal(r.onesignal.skipped, "no_key", "ไม่มีกุญแจ = ข้ามท่อ OneSignal");
});

test("sendPush: dryRun ไม่ติดธง invalid · ไม่มีเครื่อง = ไม่เรียก FCM · พังกลางทาง = ไม่ throw", async () => {
  const db = fakeDb({ pushDevices: { b: dev({ token: "B".repeat(30) }) } });
  const messaging = { sendEach: async (msgs) => ({ responses: msgs.map(() => ({ success: false, error: { code: "messaging/registration-token-not-registered" } })) }) };
  const r = await sendPush({ to: { kind: "shop", shopId: "s1" }, heading: "H" }, { db, messaging, dryRun: true, log: silent, env: {} });
  assert.equal(r.dead, 1);
  assert.equal(r.invalidated, 0);
  assert.equal(db.writes.length, 0);
  let called = 0;
  const none = await sendPush({ to: { kind: "shop", shopId: "nobody" }, heading: "H" }, { db, messaging: { sendEach: async () => { called++; } }, log: silent, env: {} });
  assert.equal(none.devices, 0);
  assert.equal(called, 0);
  const broken = await sendPush({ to: { kind: "shop", shopId: "s1" } }, { db: { collection: () => { throw new Error("db down"); } }, log: silent, env: {} });
  assert.match(broken.error, /db down/);
});

test("notify: ตัดข้อความไม่มีผู้รับก่อนเรียก · ตัวส่ง throw/ช้า ไม่ทำให้ผู้เรียกพัง", async () => {
  const seen = [];
  const push = async (m) => { seen.push(m.heading); return { ok: true }; };
  await notify({ push }, [
    { to: { kind: "staff", shopId: "s1", ids: [] }, heading: "x1" },
    { to: { kind: "staff", shopId: "s1", ids: ["u1"] }, heading: "ok1" },
    { to: { kind: "people", ids: [""] }, heading: "x2" },
    { to: { kind: "shop", shopId: "" }, heading: "x3" },
    null,
    { to: { kind: "shop", shopId: "s1" }, heading: "ok2" },
  ]);
  assert.deepEqual(seen, ["ok1", "ok2"]);
  const r = await notify({ push: async () => { throw new Error("boom"); } }, { to: { kind: "shop", shopId: "s1" } });
  assert.match(r[0].error, /boom/);
  assert.equal(hasRecipients({ to: { kind: "people", ids: ["u"] } }), true);
});

test("deviceIdOf: app- + sha256 32 ตัว · คงที่ · คนละ key คนละ id", () => {
  assert.equal(deviceIdOf("dk-android-1"), "app-101848b0781551abc5d63af084b6dafb");
  assert.notEqual(deviceIdOf("a"), deviceIdOf("b"));
});

test("markInvalid: ไม่มี id = ไม่เขียน", async () => {
  const db = fakeDb({});
  assert.equal(await markInvalid([], "x", { db }), 0);
  assert.equal(db.writes.length, 0);
});

// ── ท่อ OneSignal (ช่วงเปลี่ยนผ่าน · ลบทั้งก้อนเมื่อยกเลิก OneSignal) ──
test("onesignal: ไม่มีกุญแจ = ข้าม ไม่ยิง · dryRun = ข้าม", async () => {
  let n = 0;
  const fetch = async () => { n++; return { status: 200 }; };
  assert.equal((await OS.sendOneSignal({ to: { kind: "shop", shopId: "s1" } }, { env: {}, fetch, log: silent })).skipped, "no_key");
  assert.equal((await OS.sendOneSignal({ to: { kind: "shop", shopId: "s1" } }, { env: { ONESIGNAL_REST_API_KEY: "k", PUSH_DRY_RUN: "1" }, fetch, log: silent })).skipped, "dry_run");
  assert.equal(n, 0);
});

test("onesignal: filter tag แบบแอปเก่า · shopId = field shop.shopId (ไม่ใช่ doc id) · หลายคน = 1 คำขอต่อคน · รูป legacy /sendPush", async () => {
  const bodies = [];
  const fetch = async (url, p) => { bodies.push({ url, auth: p.headers.Authorization, body: JSON.parse(p.body) }); return { status: 200 }; };
  const db = fakeDb({ shop: { docA: { shopId: "legacyA" }, docB: {} } });
  const deps = { env: { ONESIGNAL_REST_API_KEY: "KEY" }, fetch, db, log: silent };
  const r = await OS.sendOneSignal({ to: { kind: "staff", shopId: "docA", ids: ["u1", "u2", "u1"] }, heading: "ปิดกะที่ 1", content: "C", data: { sound: "ปิดกะที่ 1" } }, deps);
  assert.deepEqual([r.requests, r.ok], [2, 2]);
  assert.equal(bodies[0].url, OS.ENDPOINT);
  assert.equal(bodies[0].auth, "Basic KEY");
  assert.deepEqual(bodies[0].body.filters, [{ field: "tag", key: "id", relation: "=", value: "u1" }, { operator: "AND" }, { field: "tag", key: "shopId", relation: "=", value: "legacyA" }]);
  assert.deepEqual(bodies[0].body.headings, { en: "ปิดกะที่ 1" });
  assert.equal(bodies[0].body.android_channel_id, OS.URGENT_CHANNEL);
  assert.equal(bodies[0].body.app_id, OS.DEFAULT_APP_ID);
  assert.equal(bodies[0].body.included_segments, undefined, "ห้าม broadcast");
  bodies.length = 0;
  await OS.sendOneSignal({ to: { kind: "shop", shopId: "docB" }, heading: "H" }, deps);
  assert.deepEqual(bodies[0].body.filters, [{ field: "tag", key: "shopId", relation: "=", value: "docB" }], "ไม่มี field shopId = doc id");
  bodies.length = 0;
  await OS.sendOneSignal({ to: { kind: "people", ids: ["u9"] }, heading: "H" }, deps);
  assert.deepEqual(bodies[0].body.filters, [{ field: "tag", key: "id", relation: "=", value: "u9" }]);
});

test("onesignal: ไม่มีผู้รับ = ไม่ยิง (ห้ามตกไปส่งทุกเครื่อง) · ยิงพัง = ไม่ throw", async () => {
  let n = 0;
  const deps = { env: { ONESIGNAL_REST_API_KEY: "KEY" }, fetch: async () => { n++; throw new Error("net"); }, db: fakeDb({ shop: {} }), log: silent };
  for (const to of [{ kind: "staff", shopId: "s", ids: [] }, { kind: "people", ids: [] }, { kind: "shop", shopId: "" }, { kind: "everyone" }]) {
    assert.equal((await OS.sendOneSignal({ to }, deps)).skipped, "no_target");
  }
  assert.equal(n, 0);
  const r = await OS.sendOneSignal({ to: { kind: "people", ids: ["u1"] } }, deps);
  assert.deepEqual([r.requests, r.failed], [1, 1]);
});

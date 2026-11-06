// เทส gateway/stations.js · รัน: node --test functions/pos/gateway/stations.test.js
//   ของใหม่ (พี่น้องไม่มี): ผูก/แก้/ถอดเครื่อง NTT EDC รายจุดคิดเงิน · เจ้าของเท่านั้น · เพดาน 20 จุด
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./handlerTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { stationEdcSet, MAX_STATIONS } = require("./stations");

const NOW = new Date("2026-11-10T03:00:00.000Z");
let H;
const body = (x) => ({ shopId: "shopA", stationId: "cashier-1", stationName: "หน้าร้าน", device: { ip: "192.168.1.50", port: 8020 }, ...x });

beforeEach(() => {
  S.reset({});
  H = stationEdcSet({ now: () => NOW });
});

test("ผูกเครื่องครั้งแรก → 200 · เขียน gatewayStations/{shopId}", async () => {
  const r = await K.callHandler(H, body(), K.OWNER);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, stationId: "cashier-1", device: { ip: "192.168.1.50", port: 8020 }, stationCount: 1 });
  assert.deepEqual(S.DATA["gatewayStations/shopA"], {
    stations: { "cashier-1": { name: "หน้าร้าน", providerId: "ntt-edc", device: { ip: "192.168.1.50", port: 8020 }, updatedAt: NOW, updatedBy: "u-owner" } },
    updatedAt: NOW, updatedBy: "u-owner",
  });
});

test("แก้เครื่องโดยไม่ส่งชื่อ → คงชื่อเดิม · จุดอื่นไม่หาย", async () => {
  S.DATA["gatewayStations/shopA"] = { stations: { "cashier-1": { name: "หน้าร้าน", providerId: "ntt-edc", device: { ip: "10.0.0.1", port: 8020 } }, bar: { name: "บาร์", device: { ip: "10.0.0.2", port: 8020 } } } };
  const r = await K.callHandler(H, body({ stationName: undefined, device: { ip: "10.0.0.9", port: 9000, name: "EDC-2" } }), K.OWNER);
  assert.equal(r.body.stationCount, 2);
  const st = S.DATA["gatewayStations/shopA"].stations;
  assert.equal(st["cashier-1"].name, "หน้าร้าน");
  assert.deepEqual(st["cashier-1"].device, { ip: "10.0.0.9", port: 9000, name: "EDC-2" });
  assert.equal(st.bar.name, "บาร์");
});

test("ถอดเครื่อง (device null) → ลบจุดนั้น · ไม่มีอยู่แล้ว = removed:false ไม่เขียน", async () => {
  S.DATA["gatewayStations/shopA"] = { stations: { "cashier-1": { name: "x" }, bar: { name: "y" } } };
  let r = await K.callHandler(H, body({ device: null }), K.OWNER);
  assert.deepEqual(r.body, { ok: true, stationId: "cashier-1", device: null, removed: true, stationCount: 1 });
  assert.deepEqual(Object.keys(S.DATA["gatewayStations/shopA"].stations), ["bar"]);
  S.LOG = [];
  r = await K.callHandler(H, body({ device: null }), K.OWNER);
  assert.equal(r.body.removed, false);
  assert.equal(S.LOG.length, 0);
});

test(`ครบ ${MAX_STATIONS} จุดแล้วเพิ่มจุดใหม่ → 409 too_many_stations ไม่เขียน · แก้จุดเดิมได้`, async () => {
  const stations = {};
  for (let i = 0; i < MAX_STATIONS; i++) stations[`s${i}`] = { name: `s${i}` };
  S.DATA["gatewayStations/shopA"] = { stations };
  let r = await K.callHandler(H, body({ stationId: "new" }), K.OWNER);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "too_many_stations");
  assert.equal(S.LOG.length, 0);
  r = await K.callHandler(H, body({ stationId: "s3" }), K.OWNER);
  assert.equal(r.code, 200);
});

test("พนักงาน → 403 owner_required ไม่เขียน · ทีมงานได้ + รอย byAdmin", async () => {
  const r = await K.callHandler(H, body(), K.STAFF);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "owner_required");
  assert.equal(S.LOG.length, 0);
  const a = await K.callHandler(H, body(), K.ADMIN);
  assert.equal(a.body.byAdmin, true);
  assert.equal(S.DATA["gatewayStations/shopA"].stations["cashier-1"].adminUid, "u-company");
});

test("IP ผิดรูป / พอร์ตเกิน → 400", async () => {
  assert.equal((await K.callHandler(H, body({ device: { ip: "999.1.1.1", port: 8020 } }), K.OWNER)).code, 400);
  assert.equal((await K.callHandler(H, body({ device: { ip: "10.0.0.1", port: 70000 } }), K.OWNER)).code, 400);
  assert.equal(S.LOG.length, 0);
});

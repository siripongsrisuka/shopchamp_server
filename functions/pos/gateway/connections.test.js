// เทส gateway/connections.js (connectionsGet · testAndSave · channelsCheck) · รัน: node --test functions/pos/gateway/connections.test.js
//   ยกเรื่องที่พิสูจน์จากเทสของพี่น้อง (connections.test.js): คำตอบไม่มีค่า · ทดสอบล้ม = ไม่เขียน · ช่องที่ไม่ส่ง = คงเดิม ·
//   ทะเบียนเจ้าของ · open:null ไม่จำ · ระดับยืนยัน · + ของบ้านนี้: ช่องลับเป็นกล่อง secretBox · เครื่อง EDC มาจากจุดคิดเงิน
//   ฐานปลอม + ทะเบียนปลอม (connectionsTestKit) · ❌ ไม่แตะ Firestore จริง · ❌ ไม่ออกเน็ต
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const K = require("./connectionsTestKit");
const SB = require("./secretBox");

const S = K.makeStore();
K.installFakeFirebase(S);
const { connectionsGet, testAndSave, channelsCheck } = require("./connections");

const PW_BOX = K.sealTest("pw-secret-9999", { providerId: "ntt-h2h", field: "password", shopId: "shopA" });
const seed = (x) => ({
  "shop/shopA": { shopId: "shopA", vip: K.GATEWAY_VIP },
  "gatewayCreds/shopA": { "ntt-h2h": { terminalId: "TID-778899", password: PW_BOX }, "kbank-qr": { merchantId: "KB-MID-12345" } },
  "shop/shopA/meta/paymentGateway": {
    thaiQr: { legacy: true },
    "ntt-h2h": { _status: { verifiedAt: K.NOW, verifiedLevel: "full", verifiedNote: "ok", verifiedFields: ["terminalId", "password", "ghost"], channels: { nttThaiQr: { enabled: true, open: true, checkedAt: "2026-11-01T00:00:00.000Z" } } } },
    "beam-bolt": { _status: { pairedDevice: { deviceId: "dev-1", pairedAt: K.NOW, boltConnectionIdTail: "WXYZ", boltConnectionId: "FULL-ID-WXYZ" } } },
  },
  "gatewayStations/shopA": { stations: { st1: { name: "แคชเชียร์ 1", providerId: "ntt-edc", device: { ip: "192.168.1.50", port: 8020 } } } },
  ...(x || {}),
});

let P;
let REG;
const deps = (x) => ({ now: () => K.NOW, credKey: K.TEST_KEY, registry: REG.registry, ...(x || {}) });
const req = (body, shopAccess = K.OWNER) => ({ body: { shopId: "shopA", ...body }, shopAccess });

beforeEach(() => {
  S.reset(seed());
  P = {
    testConnection: { ok: true, data: { verifiedFields: ["terminalId", "password"], note: "ขอ token ผ่าน" } },
    checkChannels: { ok: true, data: { results: [{ channelId: "nttThaiQr", open: false, checkedAt: "2026-11-10T03:00:00.000Z" }, { channelId: "nttShopeePay", open: null }, { channelId: "stray", open: true }] } },
  };
  REG = K.makeRegistry(P);
});

// ── connectionsGet ──────────────────────────────────────────────────────────────
test("connectionsGet: พนักงานดูได้ · คำตอบไม่มีค่าการเชื่อมต่อสักช่อง (แม้ช่องไม่ลับ) · บอกแค่ช่องไหนกรอกแล้ว", async () => {
  const r = await K.call(connectionsGet(deps()), req({}, K.STAFF));
  assert.equal(r.code, 200);
  const json = JSON.stringify(r.body);
  for (const v of ["TID-778899", "pw-secret-9999", "KB-MID-12345", PW_BOX.ct, PW_BOX.iv, "FULL-ID-WXYZ"]) assert.ok(!json.includes(v), `ค่าหลุด: ${v}`);
  const ntt = r.body.connections.find((c) => c.providerId === "ntt-h2h");
  assert.deepEqual(ntt.fields, [{ key: "terminalId", secret: false, required: true, set: true }, { key: "password", secret: true, required: true, set: true }]);
  assert.equal(ntt.configured, true);
  assert.equal(ntt.verifiedLevel, "full");
  assert.equal(ntt.verifiedAt, K.NOW.toISOString());
  assert.deepEqual(ntt.verifiedFields, ["terminalId", "password"], "ชื่อที่เจ้าไม่ได้ประกาศถูกคัดทิ้ง");
  assert.deepEqual(ntt.channels.nttThaiQr, { enabled: true, open: true, checkedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(ntt.channels.nttShopeePay, { enabled: false, open: null, checkedAt: null });
  const beam = r.body.connections.find((c) => c.providerId === "beam-bolt");
  assert.equal(beam.configured, false);
  assert.equal(beam.verifiedLevel, null, "ยังไม่เคยทดสอบ = null (ระดับที่ 3)");
  assert.deepEqual(beam.pairedDevice, { deviceId: "dev-1", pairedAt: K.NOW.toISOString(), boltConnectionIdTail: "WXYZ" });
  const spec = r.body.providers.find((p) => p.id === "beam-bolt");
  assert.deepEqual(spec.channels.map((c) => c.channelId), ["beamBoltPromptPay"], "แถว sellable:false ไม่ออกถึงจอ");
  assert.equal(spec.canPair, true);
  assert.equal(r.body.providers.find((p) => p.id === "ntt-h2h").canCheckChannels, true);
  assert.equal(S.LOG.length, 0);
});

test("connectionsGet: เครื่อง EDC มาจากจุดคิดเงินที่ขอ (ip/port) · ไม่ขอจุด = deviceConfig null", async () => {
  const a = await K.call(connectionsGet(deps()), req({ stationId: "st1" }));
  const edc = a.body.connections.find((c) => c.providerId === "ntt-edc");
  assert.deepEqual(edc.deviceConfig, { ip: "192.168.1.50", port: 8020, name: null });
  assert.equal(edc.configured, true);
  assert.equal(a.body.providers.find((p) => p.id === "ntt-edc").channels[0].tradeType, "CARD");
  const b = await K.call(connectionsGet(deps()), req({}));
  assert.equal(b.body.connections.find((c) => c.providerId === "ntt-edc").deviceConfig, null);
  const c = await K.call(connectionsGet(deps()), req({ stationId: "nope" }));
  assert.equal(c.body.connections.find((x) => x.providerId === "ntt-edc").deviceConfig, null);
});

test("connectionsGet: ไม่มี shopAccess 401 · ร้านอื่น 403 · field เกิน 400", async () => {
  assert.equal((await K.call(connectionsGet(deps()), { body: { shopId: "shopA" } })).code, 401);
  assert.equal((await K.call(connectionsGet(deps()), req({ shopId: "shopB" }))).body.error, "wrong_shop");
  assert.equal((await K.call(connectionsGet(deps()), req({ extra: 1 }))).body.error, "invalid_request");
});

// ── testAndSave ─────────────────────────────────────────────────────────────────
test("testAndSave: พนักงาน → 403 owner_required ไม่ยิงเจ้า ไม่เขียน", async () => {
  const r = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: { terminalId: "X" } }, K.STAFF));
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "owner_required");
  assert.equal(REG.calls.testConnection, undefined);
  assert.equal(S.LOG.length, 0);
});

test("testAndSave: ผ่าน → เจ้าได้ค่าดิบ · ช่องลับเก็บเป็นกล่องใหม่ · สถานะ full · คำตอบไม่มีค่า · 6 ก้อนเดิมไม่ขยับ", async () => {
  const r = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: { terminalId: "TID-NEW-1", password: "new-pass-5555" }, channels: { nttShopeePay: true } }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, providerId: "ntt-h2h", saved: true, verifiedLevel: "full", verifiedFields: ["terminalId", "password"], verifiedNote: "ขอ token ผ่าน" });
  assert.deepEqual(REG.calls.testConnection[0].config, { terminalId: "TID-NEW-1", password: "new-pass-5555" });
  assert.equal(REG.calls.testConnection[0].shopId, "shopA");
  const creds = S.DATA["gatewayCreds/shopA"]["ntt-h2h"];
  assert.equal(creds.terminalId, "TID-NEW-1");
  assert.ok(SB.isBox(creds.password));
  assert.ok(!JSON.stringify(S.DATA["gatewayCreds/shopA"]).includes("new-pass-5555"), "ไม่มีค่าดิบของช่องลับในฐาน");
  const { key } = SB.readKey({ deps: { credKey: K.TEST_KEY } });
  assert.equal(SB.open(creds.password, { providerId: "ntt-h2h", field: "password", shopId: "shopA" }, { key }).plain, "new-pass-5555");
  assert.deepEqual(S.DATA["gatewayCreds/shopA"]["kbank-qr"], { merchantId: "KB-MID-12345" }, "เจ้าอื่นไม่ขยับ");
  const st = S.DATA["shop/shopA/meta/paymentGateway"];
  assert.deepEqual(st.thaiQr, { legacy: true });
  assert.equal(st["ntt-h2h"]._status.verifiedLevel, "full");
  assert.deepEqual(st["ntt-h2h"]._status.channels.nttThaiQr, { enabled: true, open: true, checkedAt: "2026-11-01T00:00:00.000Z" }, "ช่องที่ไม่ส่ง = คงเดิม รวมผลตรวจ");
  assert.equal(st["ntt-h2h"]._status.channels.nttShopeePay.enabled, true);
  assert.ok(!JSON.stringify(st).includes("TID-NEW-1"), "สถานะไม่มีค่า");
});

test("testAndSave: ช่องที่ไม่ส่ง = คงค่าเดิม (กล่องเดิมทั้งก้อน ไม่เข้ารหัสใหม่) · เจ้าได้ค่าเดิมที่ถอดแล้ว", async () => {
  const r = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: { terminalId: "TID-2" } }));
  assert.equal(r.code, 200);
  assert.deepEqual(REG.calls.testConnection[0].config, { terminalId: "TID-2", password: "pw-secret-9999" });
  assert.deepEqual(S.DATA["gatewayCreds/shopA"]["ntt-h2h"].password, PW_BOX);
});

test("🔒 testAndSave: ทดสอบไม่ผ่าน → 422 test_failed · ไม่เขียนสักช่อง · ข้อความถูกปิดบังค่า", async () => {
  P.testConnection = { ok: false, error: { code: "ntt_auth_failed", message: "login fail for pw-secret-9999 / TID-778899" } };
  const r = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: {} }));
  assert.equal(r.code, 422);
  assert.equal(r.body.error, "test_failed");
  assert.equal(r.body.providerCode, "ntt_auth_failed");
  assert.ok(!r.body.message.includes("pw-secret-9999") && !r.body.message.includes("TID-778899"), r.body.message);
  assert.equal(S.LOG.length, 0);
});

test("testAndSave: เจ้าโยน → 502 provider_error ไม่เขียน", async () => {
  P.testConnection = new Error("socket hang up pw-secret-9999");
  const r = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h" }));
  assert.equal(r.code, 502);
  assert.equal(r.body.error, "provider_error");
  assert.equal(S.LOG.length, 0);
});

test("testAndSave: 4xx ก่อนยิงเจ้า — unknown_provider · unknown_channel · unknown_field · missing_fields · ไม่เขียน", async () => {
  const cases = [
    [{ providerId: "kbank-edc" }, 400, "unknown_provider"],
    [{ providerId: "ntt-h2h", channels: { kbankThaiQr: true } }, 400, "unknown_channel"],
    [{ providerId: "ntt-h2h", fields: { pin: "1" } }, 400, "unknown_field"],
    [{ providerId: "ntt-h2h", fields: { password: "" } }, 400, "missing_fields"],
    [{ providerId: "ntt-h2h", fields: { terminalId: 5 } }, 400, "invalid_request"],
  ];
  for (const [b, code, err] of cases) {
    const r = await K.call(testAndSave(deps()), req(b));
    assert.equal(r.code, code, JSON.stringify(b));
    assert.equal(r.body.error, err, JSON.stringify(b));
  }
  assert.equal(REG.calls.testConnection, undefined);
  assert.equal(S.LOG.length, 0);
});

test("testAndSave: ไม่มีกุญแจเข้ารหัสของระบบ → 500 gateway_cred_key_missing ไม่ยิงเจ้า ไม่เขียน (fail-closed)", async () => {
  const r = await K.call(testAndSave(deps({ credKey: undefined, env: {} })), req({ providerId: "ntt-h2h", fields: { password: "x" } }));
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "gateway_cred_key_missing");
  assert.equal(REG.calls.testConnection, undefined);
  assert.equal(S.LOG.length, 0);
});

test("🔒 testAndSave ทะเบียนเจ้าของ: รหัสเป็นของร้านอื่น → 409 ไม่ยิงเจ้า ไม่เขียน · ไม่บอกว่าร้านไหน", async () => {
  S.DATA["beamBoltConnections/BC-1"] = { shopId: "shopB", providerId: "beam-bolt" };
  const r = await K.call(testAndSave(deps()), req({ providerId: "beam-bolt", fields: { boltConnectionId: "BC-1" } }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "connection_owned_by_other_shop");
  assert.ok(!JSON.stringify(r.body).includes("shopB"));
  assert.equal(REG.calls.testConnection, undefined);
  assert.equal(S.LOG.length, 0);
});

test("testAndSave ทะเบียนเจ้าของ: ไม่มีแถว = จองให้ร้านนี้ใน transaction เดียวกับค่า · เป็นของเราแล้ว = ไม่เขียนทะเบียนซ้ำ", async () => {
  P.testConnection = { ok: true, data: { verifiedFields: ["boltConnectionId"] } };
  S.DATA["gatewayCreds/shopA"]["beam-bolt"] = { boltConnectionId: "BC-9" }; // ของยุคก่อน: ถือค่าแต่ทะเบียนไม่มีแถว
  const r = await K.call(testAndSave(deps()), req({ providerId: "beam-bolt", fields: { boltConnectionId: "BC-9" } }));
  assert.equal(r.code, 200);
  assert.equal(S.DATA["beamBoltConnections/BC-9"].shopId, "shopA");
  assert.equal(S.DATA["gatewayCreds/shopA"]["beam-bolt"].boltConnectionId, "BC-9");
  S.LOG = [];
  const again = await K.call(testAndSave(deps()), req({ providerId: "beam-bolt", fields: {} }));
  assert.equal(again.code, 200);
  assert.equal(S.writesTo("beamBoltConnections").length, 0);
  assert.equal(S.DATA["shop/shopA/meta/paymentGateway"]["beam-bolt"]._status.pairedDevice.boltConnectionIdTail, "WXYZ", "ค่าเดิม = pairedDevice อยู่ต่อ");
  const other = await K.call(testAndSave(deps()), req({ providerId: "beam-bolt", fields: { boltConnectionId: "BC-NEW" } }));
  assert.equal(other.code, 200);
  assert.equal(S.DATA["shop/shopA/meta/paymentGateway"]["beam-bolt"]._status.pairedDevice, undefined, "พิมพ์รหัสใหม่ทับ = เครื่องเดิมไม่ใช่แล้ว");
});

test("testAndSave เจ้า device (ntt-edc): ส่งช่องมา = 400 device_fields_per_station · ส่งแค่ช่องทาง = เก็บสวิตช์ partial ไม่แตะ gatewayCreds", async () => {
  const a = await K.call(testAndSave(deps()), req({ providerId: "ntt-edc", fields: { ip: "1.2.3.4" } }));
  assert.equal(a.code, 400);
  assert.equal(a.body.error, "device_fields_per_station");
  const b = await K.call(testAndSave(deps()), req({ providerId: "ntt-edc", channels: { nttEdcCard: true } }));
  assert.equal(b.code, 200);
  assert.equal(b.body.verifiedLevel, "partial");
  assert.equal(S.writesTo("gatewayCreds").length, 0);
  assert.equal(S.DATA["shop/shopA/meta/paymentGateway"]["ntt-edc"]._status.channels.nttEdcCard.enabled, true);
});

test("testAndSave ทีมงาน: เขียนรอย byAdmin adminUid · คำตอบ byAdmin", async () => {
  const r = await K.call(testAndSave(deps()), req({ providerId: "kbank-qr", fields: { merchantId: "KB-2" } }, K.ADMIN));
  assert.equal(r.code, 200);
  assert.equal(r.body.byAdmin, true);
  assert.equal(S.DATA["gatewayCreds/shopA"].byAdmin, true);
  assert.equal(S.DATA["gatewayCreds/shopA"].adminUid, "u-company");
  assert.equal(S.DATA["gatewayCreds/shopA"].updatedBy, "u-company");
});

test("🔬 กลายพันธุ์: ถอด return ของทดสอบไม่ผ่าน → มีการเขียน = ยืนยันว่าบรรทัดนั้นคือตัวกัน", async () => {
  const file = path.join(__dirname, "connections.js");
  const src = fs.readFileSync(file, "utf8");
  const needle = 'return fail(res, 422, "test_failed"';
  assert.ok(src.includes(needle));
  const m = new Module(file + ".mutant", module);
  m.filename = file;
  m.paths = module.paths;
  m._compile(src.replace(needle, 'void fail(res, 422, "test_failed"'), file);
  P.testConnection = { ok: false, error: { code: "x" }, data: { verifiedFields: [] } };
  REG = K.makeRegistry(P);
  try { await K.call(m.exports.testAndSave(deps()), req({ providerId: "kbank-qr", fields: { merchantId: "KB-3" } })); } catch (_) { /* กลายพันธุ์อาจพัง */ }
  assert.ok(S.LOG.length > 0, "กลายพันธุ์ต้องเขียน — ไม่เขียนแปลว่ามีด่านอื่นบัง");
});

// ── channelsCheck ───────────────────────────────────────────────────────────────
test("channelsCheck: เก็บเฉพาะผลที่รู้จริง (open boolean) · open:null ไม่จำ · สวิตช์ร้านไม่ขยับ · แถวแปลกทิ้ง", async () => {
  const r = await K.call(channelsCheck(deps()), req({ providerId: "ntt-h2h" }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results, [
    { channelId: "nttThaiQr", open: false, checkedAt: "2026-11-10T03:00:00.000Z" },
    { channelId: "nttShopeePay", open: null, checkedAt: null },
  ]);
  assert.deepEqual(REG.calls.checkChannels[0].config, { terminalId: "TID-778899", password: "pw-secret-9999" });
  const ch = S.DATA["shop/shopA/meta/paymentGateway"]["ntt-h2h"]._status.channels;
  assert.deepEqual(ch.nttThaiQr, { enabled: true, open: false, checkedAt: "2026-11-10T03:00:00.000Z" });
  assert.equal(ch.nttShopeePay, undefined);
  assert.equal(S.DATA["shop/shopA/meta/paymentGateway"]["ntt-h2h"]._status.verifiedLevel, "full", "สถานะอื่นคงเดิม");
});

test("channelsCheck: เจ้าที่ตรวจไม่ได้ 400 · ตั้งค่าไม่ครบ 409 · เจ้าตอบล้ม 422 ไม่เขียน · พนักงาน 403", async () => {
  assert.equal((await K.call(channelsCheck(deps()), req({ providerId: "kbank-qr" }))).body.error, "check_not_supported");
  delete S.DATA["gatewayCreds/shopA"];
  const nc = await K.call(channelsCheck(deps()), req({ providerId: "ntt-h2h" }));
  assert.equal(nc.code, 409);
  assert.deepEqual(nc.body.missing, ["terminalId", "password"]);
  S.reset(seed());
  P.checkChannels = { ok: false, error: { code: "ntt_token", message: "bad TID-778899" } };
  const f = await K.call(channelsCheck(deps()), req({ providerId: "ntt-h2h" }));
  assert.equal(f.code, 422);
  assert.ok(!f.body.message.includes("TID-778899"));
  assert.equal(S.LOG.length, 0);
  assert.equal((await K.call(channelsCheck(deps()), req({ providerId: "ntt-h2h" }, K.STAFF))).code, 403);
});

// ── แพ็กเกจ Payment Gateway (packageGate.js · Pack เคาะ 2a 2026-11-08) ──
const PG = require("./packageGate");
const EXPIRED = [{ type: "gateway", expire: "2026-11-09T10:00:00.000Z" }]; // 9 พ.ย. ไทย · K.NOW = 10 พ.ย.

test("🔒 แพ็กเกจ: testAndSave · channelsCheck ไม่มีแพ็กเกจ / หมดแล้ว → 403 package_required ไม่ยิงเจ้า ไม่เขียน", async () => {
  for (const vip of [undefined, EXPIRED]) {
    S.reset(seed());
    S.DATA["shop/shopA"] = vip ? { shopId: "shopA", vip } : { shopId: "shopA" };
    const t = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: { terminalId: "TID-NEW-1", password: "new-pass-5555" } }));
    assert.equal(t.code, 403);
    assert.equal(t.body.error, "package_required");
    const c = await K.call(channelsCheck(deps()), req({ providerId: "ntt-h2h" }));
    assert.equal(c.code, 403);
    assert.equal(c.body.error, "package_required");
    assert.equal(REG.calls.testConnection, undefined);
    assert.equal(REG.calls.checkChannels, undefined);
    assert.equal(S.LOG.length, 0);
  }
});

test("แพ็กเกจ: connectionsGet ไม่ติดด่าน · คืน packageActive true/false ตามแพ็กเกจ (พนักงานก็เห็น)", async () => {
  const on = await K.call(connectionsGet(deps()), req({}, K.STAFF));
  assert.equal(on.code, 200);
  assert.equal(on.body.packageActive, true);
  for (const shop of [{ shopId: "shopA" }, { shopId: "shopA", vip: EXPIRED }, undefined]) {
    S.reset(seed());
    if (shop === undefined) delete S.DATA["shop/shopA"];
    else S.DATA["shop/shopA"] = shop;
    const off = await K.call(connectionsGet(deps()), req({}, K.STAFF));
    assert.equal(off.code, 200, JSON.stringify(shop));
    assert.equal(off.body.packageActive, false);
    assert.ok(Array.isArray(off.body.connections));
  }
});

test("แพ็กเกจ: doc ร้านที่ด่านฝากไว้ = ไม่อ่าน shop/shopA ซ้ำ · ไม่มีของฝาก = อ่าน 1 ครั้ง", async () => {
  await K.call(connectionsGet(deps()), req({}));
  assert.equal(S.READS.filter((p) => p === "shop/shopA").length, 1);
  S.reset(seed());
  await K.call(connectionsGet(deps()), req({}, PG.attachShopData({ ...K.OWNER }, { shopId: "shopA", vip: K.GATEWAY_VIP })));
  assert.equal(S.READS.filter((p) => p === "shop/shopA").length, 0);
  S.reset(seed());
  const t = await K.call(testAndSave(deps()), req({ providerId: "ntt-h2h", fields: { terminalId: "TID-NEW-1" } }, PG.attachShopData({ ...K.OWNER }, { shopId: "shopA", vip: K.GATEWAY_VIP })));
  assert.equal(t.code, 200, JSON.stringify(t.body));
  assert.equal(S.READS.filter((p) => p === "shop/shopA").length, 0);
});

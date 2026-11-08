// เทส gateway/pairing.js (pair · unpair) · รัน: node --test functions/pos/gateway/pairing.test.js
//   ยกเรื่องที่พิสูจน์จากเทสของพี่น้อง (pairing.test.js · pairing.guards.test.js): เจ้าของเท่านั้น · ล้ม = ไม่เขียน ·
//   ค่า + สถานะ + ทะเบียนเจ้าของ ใน transaction เดียว · รหัสเต็มไม่อยู่ใน _status · ร้านอื่นตัดไม่ได้ · สวิตช์ร้านคงเดิม · ยุคก่อน
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const K = require("./connectionsTestKit");

const S = K.makeStore();
K.installFakeFirebase(S);
const { pair, unpair } = require("./pairing");

let P;
let REG;
const deps = () => ({ now: () => K.NOW, credKey: K.TEST_KEY, registry: REG.registry });
const req = (body, shopAccess = K.OWNER) => ({ body: { shopId: "shopA", providerId: "beam-bolt", ...body }, shopAccess });
const seed = (x) => ({
  "shop/shopA": { shopId: "shopA", vip: K.GATEWAY_VIP },
  "shop/shopA/meta/paymentGateway": { "beam-bolt": { _status: { channels: { beamBoltPromptPay: { enabled: true, open: null, checkedAt: null } } } } },
  ...(x || {}),
});

beforeEach(() => {
  S.reset(seed());
  P = {
    pair: { ok: true, data: { boltConnectionId: "BOLT-CONN-ABCD1234", deviceId: "dev-77", merchantId: "m-1" } },
    unpair: { ok: true, data: { alreadyGone: false } },
  };
  REG = K.makeRegistry(P);
});

test("pair: สำเร็จ → ค่า (gatewayCreds) + สถานะ (4 ตัวท้าย) + ทะเบียน ใน transaction เดียว · สวิตช์ร้านคงเดิม", async () => {
  const r = await K.call(pair(deps()), req({ pairingCode: " ab12cd34 " }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.boltConnectionId, "BOLT-CONN-ABCD1234", "รหัสเต็มคืนครั้งเดียวตอนจับคู่");
  assert.equal(REG.calls.pair[0].pairingCode, "AB12CD34");
  assert.equal(REG.calls.pair[0].credKey, K.TEST_KEY, "เจ้าได้กุญแจทดสอบไปถอดกุญแจรายร้าน");
  assert.equal(S.DATA["gatewayCreds/shopA"]["beam-bolt"].boltConnectionId, "BOLT-CONN-ABCD1234");
  const st = S.DATA["shop/shopA/meta/paymentGateway"]["beam-bolt"]._status;
  assert.deepEqual(st.pairedDevice, { deviceId: "dev-77", pairedAt: K.NOW, boltConnectionIdTail: "1234" });
  assert.ok(!JSON.stringify(st).includes("BOLT-CONN-ABCD1234"), "สถานะไม่มีรหัสเต็ม");
  assert.equal(st.verifiedLevel, "full");
  assert.equal(st.channels.beamBoltPromptPay.enabled, true);
  assert.deepEqual(S.DATA["beamBoltConnections/BOLT-CONN-ABCD1234"], { shopId: "shopA", providerId: "beam-bolt", deviceId: "dev-77", pairedAt: K.NOW, merchantId: "m-1" });
  assert.equal(S.LOG.length, 3);
});

test("pair: พนักงาน 403 · เจ้าที่จับคู่ไม่ได้ 400 · ไม่มีรหัส 400 · ไม่ยิงเจ้า", async () => {
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "X" }, K.STAFF))).body.error, "owner_required");
  assert.equal((await K.call(pair(deps()), req({ providerId: "ntt-h2h", pairingCode: "X" }))).body.error, "pair_not_supported");
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "   " }))).body.error, "invalid_request");
  assert.equal(REG.calls.pair, undefined);
  assert.equal(S.LOG.length, 0);
});

test("pair: มีเครื่องของร้านนี้อยู่แล้ว (มีทะเบียน หรือยุคก่อนไม่มีทะเบียน) → 409 already_paired ไม่ยิงเจ้า", async () => {
  S.DATA["gatewayCreds/shopA"] = { "beam-bolt": { boltConnectionId: "OLD-0001" } };
  const a = await K.call(pair(deps()), req({ pairingCode: "X" }));
  assert.equal(a.code, 409);
  assert.equal(a.body.error, "already_paired");
  S.DATA["beamBoltConnections/OLD-0001"] = { shopId: "shopA" };
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "X" }))).body.error, "already_paired");
  assert.equal(REG.calls.pair, undefined);
  assert.equal(S.LOG.length, 0);
});

test("pair: ค่าเก่าที่ทะเบียนบอกว่าเป็นของร้านอื่น (รูเดิม) → จับคู่เครื่องตัวเองทับได้ (ไม่ติดตาย)", async () => {
  S.DATA["gatewayCreds/shopA"] = { "beam-bolt": { boltConnectionId: "STOLEN-9" } };
  S.DATA["beamBoltConnections/STOLEN-9"] = { shopId: "shopB" };
  const r = await K.call(pair(deps()), req({ pairingCode: "X" }));
  assert.equal(r.code, 200);
  assert.equal(S.DATA["gatewayCreds/shopA"]["beam-bolt"].boltConnectionId, "BOLT-CONN-ABCD1234");
  assert.equal(S.DATA["beamBoltConnections/STOLEN-9"].shopId, "shopB", "ทะเบียนของร้านอื่นไม่ถูกแตะ");
});

test("🔒 pair: รหัสที่เจ้าออกให้เป็นของร้านอื่นในทะเบียน → 409 ไม่เขียนสักช่อง", async () => {
  S.DATA["beamBoltConnections/BOLT-CONN-ABCD1234"] = { shopId: "shopB" };
  const r = await K.call(pair(deps()), req({ pairingCode: "X" }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "connection_owned_by_other_shop");
  assert.equal(S.LOG.length, 0);
});

test("pair: เจ้าปัดรหัส 422 · บัญชี Beam ยังไม่ตั้ง 409 · รหัสที่เจ้าคืนใช้ไม่ได้ 502 · เจ้าโยน 502 · ไม่เขียน", async () => {
  P.pair = { ok: false, error: { code: "pairing_code_rejected", message: "รหัสจับคู่ไม่ถูกต้องหรือหมดอายุ" } };
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "X" }))).code, 422);
  P.pair = { ok: false, error: { code: "beam_merchant_not_configured", message: "x" } };
  const nc = await K.call(pair(deps()), req({ pairingCode: "X" }));
  assert.equal(nc.code, 409);
  assert.match(nc.body.message, /Shopchamp/);
  P.pair = { ok: true, data: { boltConnectionId: "a/b" } };
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "X" }))).body.error, "bad_response");
  P.pair = { ok: false, error: { code: "beam_http_500", status: 500 } };
  const pe = await K.call(pair(deps()), req({ pairingCode: "X" }));
  assert.equal(pe.code, 502);
  assert.equal(pe.body.providerCode, "beam_http_500");
  P.pair = new Error("timeout");
  assert.equal((await K.call(pair(deps()), req({ pairingCode: "X" }))).body.error, "provider_error");
  assert.equal(S.LOG.length, 0);
});

test("unpair: สำเร็จ → ลบทะเบียน + ลบช่องออกจากก้อน + ล้าง pairedDevice · สวิตช์คงเดิม", async () => {
  S.DATA["gatewayCreds/shopA"] = { "beam-bolt": { boltConnectionId: "BC-1234" }, "kbank-qr": { merchantId: "K" } };
  S.DATA["beamBoltConnections/BC-1234"] = { shopId: "shopA" };
  S.DATA["shop/shopA/meta/paymentGateway"]["beam-bolt"]._status.pairedDevice = { deviceId: "d", boltConnectionIdTail: "1234" };
  const r = await K.call(unpair(deps()), req({}));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, providerId: "beam-bolt", unpaired: true, alreadyGone: false });
  assert.equal(REG.calls.unpair[0].boltConnectionId, "BC-1234");
  assert.equal(S.DATA["beamBoltConnections/BC-1234"], undefined);
  assert.deepEqual(S.DATA["gatewayCreds/shopA"]["beam-bolt"], {});
  assert.deepEqual(S.DATA["gatewayCreds/shopA"]["kbank-qr"], { merchantId: "K" });
  const st = S.DATA["shop/shopA/meta/paymentGateway"]["beam-bolt"]._status;
  assert.equal(st.pairedDevice, undefined);
  assert.equal(st.verifiedLevel, "partial");
  assert.equal(st.channels.beamBoltPromptPay.enabled, true);
});

test("🔒 unpair: ไม่ได้จับคู่ 409 · ทะเบียนเป็นของร้านอื่น 409 ไม่ยิงเจ้า · เจ้าล้ม 502 ไม่เขียน", async () => {
  assert.equal((await K.call(unpair(deps()), req({}))).body.error, "not_paired");
  S.DATA["gatewayCreds/shopA"] = { "beam-bolt": { boltConnectionId: "BC-X" } };
  S.DATA["beamBoltConnections/BC-X"] = { shopId: "shopB" };
  const o = await K.call(unpair(deps()), req({}));
  assert.equal(o.code, 409);
  assert.equal(o.body.error, "connection_owned_by_other_shop");
  assert.equal(REG.calls.unpair, undefined);
  delete S.DATA["beamBoltConnections/BC-X"];
  P.unpair = { ok: false, error: { code: "beam_credentials_invalid", message: "401" } };
  assert.equal((await K.call(unpair(deps()), req({}))).code, 502);
  assert.equal(S.LOG.length, 0);
});

// ── แพ็กเกจ Payment Gateway (packageGate.js · Pack เคาะ 2a 2026-11-08) ──
test("🔒 แพ็กเกจ: pair ไม่มีแพ็กเกจ / หมดแล้ว → 403 package_required ไม่ยิงเจ้า ไม่เขียน · unpair ยังถอดได้ (ไม่ติดด่าน)", async () => {
  for (const vip of [undefined, [{ type: "gateway", expire: "2026-11-09T10:00:00.000Z" }]]) {
    S.reset(seed());
    S.DATA["shop/shopA"] = vip ? { shopId: "shopA", vip } : { shopId: "shopA" };
    const r = await K.call(pair(deps()), req({ pairingCode: "AB12CD34" }));
    assert.equal(r.code, 403);
    assert.equal(r.body.error, "package_required");
    assert.equal(REG.calls.pair, undefined);
    assert.equal(S.LOG.length, 0);
    S.DATA["gatewayCreds/shopA"] = { "beam-bolt": { boltConnectionId: "BC-1234" } };
    S.DATA["beamBoltConnections/BC-1234"] = { shopId: "shopA" };
    const u = await K.call(unpair(deps()), req({}));
    assert.equal(u.code, 200, JSON.stringify(u.body));
    assert.equal(u.body.unpaired, true);
    assert.equal(S.DATA["beamBoltConnections/BC-1234"], undefined);
  }
});

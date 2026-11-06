// pos/gateway/providers/index.test.js — ทะเบียนเจ้ารับชำระ (ก้อน 7 · DEV-0001)
//   ส่วนแรก = ทะเบียนจริง (require('./index')) · ส่วนหลัง = buildRegistry + เจ้าปลอม (คุมทุกกิ่ง)
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const real = require("./index");
const { buildRegistry, MODULES } = real;

const ids = (list) => list.map((c) => c.channelId);
const EXPECTED = ["ntt-h2h", "ntt-edc", "kbank-qr", "beam-bolt", "posxpay"];

// ── ทะเบียนจริง ──
test("ทะเบียนจริง: MODULES = 5 เจ้าตาม decision · ไม่มี kbank-edc", () => {
  assert.deepEqual(MODULES, ["./ntt", "./ntt-edc", "./kbank-qr", "./beam-bolt", "./posxpay"]);
  assert.ok(!MODULES.some((m) => m.includes("kbank-edc")));
  assert.deepEqual(real.listProviders().map((s) => s.id), EXPECTED);
  assert.equal(real.getProvider("kbank-edc"), null);
});

test("ทะเบียนจริง: ไม่มีไฟล์ kbank-edc ในโฟลเดอร์", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "kbank-edc.js")));
});

test("ทะเบียนจริง: ทุกช่อง secret ไม่มี store · ไม่มีช่องไหนประกาศ store เลย", () => {
  let secrets = 0;
  for (const spec of real.listProviders()) {
    for (const f of spec.connection.fields) {
      assert.ok(!Object.prototype.hasOwnProperty.call(f, "store"), `${spec.id}.${f.key} มี store`);
      if (real.isSecretField(f)) secrets++;
    }
  }
  assert.ok(secrets >= 2, "อย่างน้อย NTT password + POSxPay token ต้องเป็น secret");
});

test("ทะเบียนจริง: รหัสผ่าน NTT และ token POSxPay = secret:true", () => {
  const field = (pid, key) => real.getProvider(pid).spec.connection.fields.find((f) => f.key === key);
  assert.equal(field("ntt-h2h", "password").secret, true);
  assert.equal(field("posxpay", "token").secret, true);
});

test("ทะเบียนจริง: ความสามารถ derive จากฟังก์ชันจริง", () => {
  const can = (pid, fn) => fn(real.getProvider(pid));
  assert.equal(can("kbank-qr", real.canCancelOf), true);
  assert.equal(can("beam-bolt", real.canCancelOf), true);
  assert.equal(can("ntt-h2h", real.canCancelOf), false);
  assert.equal(can("posxpay", real.canCancelOf), false);
  assert.equal(can("beam-bolt", real.canPairOf), true);
  assert.equal(can("ntt-h2h", real.canPairOf), false);
  assert.equal(can("ntt-h2h", real.canCheckChannelsOf), true);
  assert.deepEqual(real.ownershipOf(real.getProvider("beam-bolt").spec), { field: "boltConnectionId", registry: "beamBoltConnections" });
  assert.equal(real.ownershipOf(real.getProvider("ntt-h2h").spec), null);
});

test("ทะเบียนจริง: ไม่มี stored = ผลเท่า listSellableChannels() เป๊ะ", () => {
  assert.deepEqual(real.listSellableChannelsForShop(null), real.listSellableChannels());
  assert.deepEqual(real.listSellableChannelsForShop({}), real.listSellableChannels());
});

test("ทะเบียนจริง: ทุกแถวที่ขายได้รายร้าน = resolveSalesChannel ok", () => {
  const s = { "ntt-h2h": { _status: { channels: { nttBblQr: { open: true }, nttThaiQr: { open: false } } } } };
  for (const c of real.listSellableChannelsForShop(s)) {
    const live = real.shopChannelStatusOf({ stored: s, providerId: c.providerId, channelId: c.channelId });
    assert.ok(real.resolveSalesChannel(c.channelId, live).ok, c.channelId);
  }
});

test("ทะเบียนจริง: ไม่มีเจ้า runtime device หลุดเข้าลิสต์ขาย · ntt-edc ตอบ channel_not_server_runtime", () => {
  for (const c of real.listSellableChannelsForShop(null)) assert.equal(c.runtime, "server", c.channelId);
  const edc = real.listChannels().find((c) => c.providerId === "ntt-edc");
  assert.ok(edc, "ntt-edc ต้องมีช่องทางในหน้าตั้งค่า");
  assert.equal(real.resolveSalesChannel(edc.channelId).reason, "channel_not_server_runtime");
  assert.ok(real.findChannel(edc.channelId));
});

test("ไม่มีไฟล์ใดในโฟลเดอร์ gateway require package ของพี่น้อง หรือเอ่ยชื่อพี่น้อง", () => {
  const root = path.join(__dirname, "..");
  const banned = new RegExp(["s", "c", "a", "n", "f", "o", "o", "d"].join(""), "i");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith(".js") ? [p] : [];
  });
  const files = walk(root);
  assert.ok(files.length > 5);
  for (const f of files) assert.ok(!banned.test(fs.readFileSync(f, "utf8")), path.relative(root, f));
});

// ── shopChannelStatusOf · channelIsOpen ──
test("shopChannelStatusOf: คืนแถวดิบ · ขาดชั้นไหน/รูปเพี้ยน = null", () => {
  const row = { enabled: true, open: false, checkedAt: "x" };
  assert.deepEqual(real.shopChannelStatusOf({ stored: { p: { _status: { channels: { c: row } } } }, providerId: "p", channelId: "c" }), row);
  for (const stored of [null, undefined, "x", {}, { p: null }, { p: {} }, { p: { _status: "x" } }, { p: { _status: { channels: null } } }, { p: { _status: { channels: { c: "on" } } } }]) {
    assert.equal(real.shopChannelStatusOf({ stored, providerId: "p", channelId: "c" }), null, JSON.stringify(stored));
  }
});

test("channelIsOpen: open boolean ชนะทะเบียน 2 ทิศ · ไม่มี = lastKnownAvailable", () => {
  assert.equal(real.channelIsOpen({ open: true }, { lastKnownAvailable: false }), true);
  assert.equal(real.channelIsOpen({ open: false }, { lastKnownAvailable: true }), false);
  assert.equal(real.channelIsOpen({ open: "true" }, { lastKnownAvailable: false }), false);
  assert.equal(real.channelIsOpen(null, { lastKnownAvailable: true }), true);
  assert.equal(real.channelIsOpen(null, null), false);
});

// ── buildRegistry + เจ้าปลอม ──
const fake = (id, channels, more, fieldMore) => ({
  spec: {
    id, labelKey: `p.${id}`, labelFallback: id, runtime: "server", ...(more || {}),
    connection: { fields: [{ key: "k", labelKey: `f.${id}.k`, labelFallback: "k", required: true, ...(fieldMore || {}) }], test: { kind: "auth", note: "ครอบ k" } },
    channels: channels.map(([channelId, lastKnownAvailable]) => ({ channelId, nameKey: `c.${channelId}`, nameFallback: channelId, tranType: "T", qrKind: "text", lastKnownAvailable })),
  },
  async createQR() { return { ok: true, data: {} }; },
  async inquiry() { return { ok: true, data: {} }; },
  async testConnection() { return { ok: true, data: { verifiedFields: ["k"], note: "ok" } }; },
});

test("ปลอม: at-setup ใช้ open สด · at-bill ผ่านทะเบียนเสมอ", () => {
  const reg = buildRegistry([fake("setup", [["sOn", true], ["sOff", false]]), fake("bill", [["bOff", false]], { channelChoice: "at-bill" })]);
  assert.deepEqual(ids(reg.listSellableChannelsForShop(null)), ["sOn", "bOff"]);
  const s = { setup: { _status: { channels: { sOn: { open: false }, sOff: { open: true } } } }, bill: { _status: { channels: { bOff: { open: false, enabled: false } } } } };
  assert.deepEqual(ids(reg.listSellableChannelsForShop(s)), ["sOff", "bOff"]);
  const r = reg.resolveSalesChannel("sOff");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_channel");
  assert.equal(r.fromRegistry, true);
  assert.equal(reg.resolveSalesChannel("sOn", { open: false }).fromRegistry, false);
  assert.equal(reg.getChannel("nope"), null);
  assert.equal(reg.findChannel("sOff").channel.channelId, "sOff");
});

test("ปลอม: sellable:false ไม่โผล่ในลิสต์ขาย", () => {
  const m = fake("h", [["hA", true], ["hB", true]]);
  m.spec.channels[1].sellable = false;
  const reg = buildRegistry([m]);
  assert.deepEqual(ids(reg.listSellableChannels()), ["hA"]);
  assert.equal(reg.isHiddenChannel(m.spec.channels[1]), true);
});

test("ปลอม: ไม่ประกาศ channelChoice = at-setup ถูกเติมตั้งแต่ลงทะเบียน · label ↔ labelKey ค่าเดียว", () => {
  const m = fake("d", [["dA", true]]);
  const reg = buildRegistry([m]);
  assert.equal(reg.listProviders()[0].channelChoice, "at-setup");
  assert.equal(m.spec.label, "p.d");
});

test("ปลอม: secret:true ผ่าน · ประกาศ store ทุกรูป = ปัด (รวม store เดิมของพี่น้อง)", () => {
  assert.doesNotThrow(() => buildRegistry([fake("s1", [["s1A", true]], {}, { secret: true })]));
  for (const store of ["sha256-base64", "plain", undefined, "x"]) {
    assert.throws(() => buildRegistry([fake("s2", [["s2A", true]], {}, { secret: true, store })]), /store ห้ามประกาศ/, String(store));
  }
  assert.throws(() => buildRegistry([fake("s3", [["s3A", true]], {}, { secret: "yes" })]), /secret ต้องเป็น true/);
  assert.equal(real.STORES, undefined);
});

test("ปลอม: ด่านสเปก — i18n · fallback · required · ซ้ำ · ประกาศความสามารถเอง", () => {
  const cases = [
    [(m) => { m.spec.labelKey = "ชื่อไทย"; }, /i18n key/],
    [(m) => { delete m.spec.labelFallback; }, /ข้อความสำรอง/],
    [(m) => { m.spec.labelFallback = "p.x"; }, /ไม่ใช่ i18n key ซ้ำ/],
    [(m) => { m.spec.runtime = "cloud"; }, /runtime/],
    [(m) => { m.spec.channelChoice = "at_bill"; }, /channelChoice/],
    [(m) => { m.spec.canCancel = true; }, /canCancel/],
    [(m) => { m.spec.canPair = true; }, /canPair/],
    [(m) => { m.spec.canCheckChannels = true; }, /canCheckChannels/],
    [(m) => { m.spec.configKeys = []; }, /configKeys/],
    [(m) => { delete m.spec.connection.fields[0].required; }, /required/],
    [(m) => { m.spec.connection.fields.push({ ...m.spec.connection.fields[0] }); }, /ซ้ำ/],
    [(m) => { m.spec.connection.test.note = "ไม่พูดถึงอะไร"; }, /ช่องบังคับ "k"/],
    [(m) => { m.spec.connection.test.kind = "magic"; }, /test.kind/],
    [(m) => { m.spec.channels = []; }, /channels/],
    [(m) => { m.spec.channels[0].available = true; }, /lastKnownAvailable/],
    [(m) => { delete m.spec.channels[0].lastKnownAvailable; }, /lastKnownAvailable/],
    [(m) => { m.spec.channels[0].qrKind = "svg"; }, /qrKind/],
    [(m) => { m.spec.channels[0].sellable = "no"; }, /sellable/],
    [(m) => { delete m.inquiry; }, /inquiry/],
    [(m) => { delete m.testConnection; }, /testConnection/],
  ];
  for (const [mutate, re] of cases) {
    const m = fake("z", [["zA", true]]);
    mutate(m);
    assert.throws(() => buildRegistry([m]), re, String(re));
  }
});

test("ปลอม: runtime device ไม่ต้องมี createQR/inquiry", () => {
  const m = fake("dev", [["devA", false]], { runtime: "device" });
  m.spec.connection.test = { kind: "device-ping", note: "แอปเคาะเครื่อง k" };
  delete m.createQR; delete m.inquiry; delete m.testConnection;
  const reg = buildRegistry([m]);
  assert.equal(reg.resolveSalesChannel("devA").reason, "channel_not_server_runtime");
});

test("ปลอม: pair/unpair ต้องมาเป็นคู่ และต้องประกาศ ownership ที่ชี้ช่องจริง", () => {
  const withPair = (own, pair = true, unpair = true) => {
    const m = fake("b", [["bA", true]]);
    if (own !== undefined) m.spec.connection.ownership = own;
    if (pair) m.pair = async () => ({ ok: true, data: {} });
    if (unpair) m.unpair = async () => ({ ok: true, data: {} });
    return m;
  };
  assert.doesNotThrow(() => buildRegistry([withPair({ field: "k", registry: "reg" })]));
  assert.throws(() => buildRegistry([withPair({ field: "k", registry: "reg" }, true, false)]), /มาเป็นคู่/);
  assert.throws(() => buildRegistry([withPair(undefined)]), /ownership/);
  assert.throws(() => buildRegistry([withPair({ field: "ghost", registry: "reg" })]), /ownership.field/);
  assert.throws(() => buildRegistry([withPair({ field: "k", registry: "a/b" })]), /ownership.registry/);
  const reg = buildRegistry([withPair({ field: "k", registry: "reg" })]);
  assert.equal(reg.canPairOf(reg.getProvider("b")), true);
  assert.equal(reg.canCancelOf(reg.getProvider("b")), false);
});

test("ปลอม: providerId ซ้ำ · channelId ซ้ำข้ามเจ้า = ปัด", () => {
  assert.throws(() => buildRegistry([fake("x", [["xA", true]]), fake("x", [["xB", true]])]), /providerId ซ้ำ/);
  assert.throws(() => buildRegistry([fake("x", [["dup", true]]), fake("y", [["dup", true]])]), /channelId ซ้ำ/);
});

test("ปลอม: ทะเบียนที่ buildRegistry คืน มี API ครบชื่อเดียวกับทะเบียนจริง", () => {
  const reg = buildRegistry([fake("a", [["aA", true]])]);
  const names = ["getChannel", "resolveSalesChannel", "findChannel", "listChannels", "listSellableChannels", "listSellableChannelsForShop",
    "shopChannelStatusOf", "channelIsOpen", "getProvider", "listProviders", "listProviderModules", "isHiddenChannel", "isSecretField",
    "channelChoiceOf", "canCheckChannelsOf", "canPairOf", "canCancelOf", "ownershipOf"];
  for (const n of names) {
    assert.equal(typeof reg[n], "function", n);
    assert.equal(typeof real[n], "function", n);
  }
  assert.equal(reg.shopChannelStatusOf, real.shopChannelStatusOf);
});

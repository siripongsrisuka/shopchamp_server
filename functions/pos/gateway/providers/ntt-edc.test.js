// pos/gateway/providers/ntt-edc.test.js — เทสเจ้า NTT LinkPOS (runtime:'device') · ยกจากบ้านพี่น้อง ก้อน 7
// รัน: cd shopchamp_server/functions && node --test pos/gateway/providers/ntt-edc.test.js
// เคสหัวใจ: ① ลงทะเบียนผ่านทั้งที่ไม่มีฟังก์ชัน ② ช่องทางหลุดเข้าเส้นขายฝั่ง server ไม่ได้ (เหตุ channel_not_server_runtime)
//          ③ ยังโผล่ในหน้าตั้งค่า ④ รหัสกระเป๋าตรงตาราง LinkPOS ไม่ใช่ของ h2h ⑤ ตัวช่วยล้วนของ handler
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EDC = require("./ntt-edc");
const EDC_CHANNEL_IDS = EDC.spec.channels.map((c) => c.channelId);

// ทะเบียน + ntt-h2h เขียนโดยผู้ทำคนอื่นขนานกัน · ยังไม่มีไฟล์ = ข้ามเคสที่ต้องใช้ (บอกเหตุใน skip)
function optional(rel) {
  try {
    return require(rel);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(rel.replace("./", ""))) return null;
    throw e;
  }
}
const INDEX = optional("./index");
const H2H = optional("./ntt");
const needIndex = INDEX ? false : "ยังไม่มี providers/index.js";
const needBoth = INDEX && H2H ? false : "ยังไม่มี providers/index.js หรือ providers/ntt.js";

// ══ ① ลงทะเบียน ══════════════════════════════════════════════════════════════
test("ไม่ export createQR/inquiry/testConnection/checkChannels/cancelQR/pair/unpair (ไม่ใช่ฟังก์ชันหลอก)", () => {
  for (const fn of ["createQR", "inquiry", "testConnection", "checkChannels", "cancelQR", "pair", "unpair"]) {
    assert.equal(typeof EDC[fn], "undefined", `ห้ามมี ${fn}() — เซิร์ฟเวอร์ทำแทนไม่ได้`);
  }
});

test("เจ้า device ที่ไม่มีฟังก์ชันสักตัว → ลงทะเบียนผ่าน", { skip: needIndex }, () => {
  assert.doesNotThrow(() => INDEX.buildRegistry([EDC]));
});

test("mutant: เปลี่ยน runtime เป็น server แล้วไม่มี createQR → ทะเบียนต้องปัด", { skip: needIndex }, () => {
  const fake = { spec: { ...EDC.spec, id: "edc-as-server", runtime: "server" } };
  assert.throws(() => INDEX.buildRegistry([fake]), /createQR/);
});

test("mutant: ไม่ประกาศ runtime / ค่าไม่รู้จัก → ทะเบียนปัด", { skip: needIndex }, () => {
  const noRuntime = { spec: { ...EDC.spec } };
  delete noRuntime.spec.runtime;
  assert.throws(() => INDEX.buildRegistry([noRuntime]), /runtime/);
  assert.throws(() => INDEX.buildRegistry([{ spec: { ...EDC.spec, runtime: "edge" } }]), /runtime/);
});

test("mutant: ใส่ store ให้ช่องกรอก → ทะเบียนปัด (Shopchamp ห้ามมี store)", { skip: needIndex }, () => {
  const withStore = { spec: { ...EDC.spec, connection: { ...EDC.spec.connection, fields: EDC.spec.connection.fields.map((f) => ({ ...f, store: "plain" })) } } };
  assert.throws(() => INDEX.buildRegistry([withStore]));
});

test("ลงทะเบียนซ้ำ → ปัด (providerId ซ้ำ · channelId ซ้ำ)", { skip: needIndex }, () => {
  assert.throws(() => INDEX.buildRegistry([EDC, EDC]));
  assert.throws(() => INDEX.buildRegistry([EDC, { ...EDC, spec: { ...EDC.spec, id: "another-edc" } }]));
});

// ══ ② เส้นขายฝั่ง server ปัดทุกช่องทาง ═══════════════════════════════════════
test("ทุกช่องทาง: getChannel = null · resolveSalesChannel = channel_not_server_runtime", { skip: needIndex }, () => {
  const reg = INDEX.buildRegistry([EDC]);
  for (const id of EDC_CHANNEL_IDS) {
    assert.equal(reg.getChannel(id), null, id);
    const r = reg.resolveSalesChannel(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.reason, "channel_not_server_runtime", `${id}: ไม่ใช่ unknown_channel`);
  }
  assert.equal(reg.listSellableChannels().filter((c) => EDC_CHANNEL_IDS.includes(c.channelId)).length, 0);
});

test("listSellableChannels = เฉพาะช่องทาง h2h ที่เปิด (ทิศกลับ: ลิสต์ไม่ว่าง)", { skip: needBoth }, () => {
  const reg = INDEX.buildRegistry([H2H, EDC]);
  const sellable = reg.listSellableChannels().map((c) => c.channelId);
  const h2hOpen = H2H.spec.channels.filter((c) => c.lastKnownAvailable).map((c) => c.channelId);
  assert.deepEqual([...sellable].sort(), [...h2hOpen].sort());
  assert.ok(sellable.length > 0, "ลิสต์ว่าง = เทสข้างบนเขียวฟรี");
});

test("mutant: lastKnownAvailable=true ทุกแถว → ยังขายฝั่ง server ไม่ได้ (ปัดด้วย runtime ไม่ใช่บังเอิญ false)", { skip: needIndex }, () => {
  const openEdc = { spec: { ...EDC.spec, channels: EDC.spec.channels.map((c) => ({ ...c, lastKnownAvailable: true })) } };
  const reg = INDEX.buildRegistry([openEdc]);
  for (const id of EDC_CHANNEL_IDS) {
    assert.equal(reg.getChannel(id), null, id);
    assert.equal(reg.resolveSalesChannel(id).reason, "channel_not_server_runtime", id);
  }
});

// ══ ③ หน้าตั้งค่ายังเห็นครบ ══════════════════════════════════════════════════
test("listChannels / findChannel ยังเห็นครบ 12 แถว ติด runtime device", { skip: needIndex }, () => {
  const reg = INDEX.buildRegistry([EDC]);
  const all = reg.listChannels();
  for (const id of EDC_CHANNEL_IDS) {
    const row = all.find((c) => c.channelId === id);
    assert.ok(row, `${id} หายจากหน้าตั้งค่า`);
    assert.equal(row.providerId, "ntt-edc");
    assert.equal(row.runtime, "device");
    const hit = reg.findChannel(id);
    assert.ok(hit, `${id}: บิลเก่าต้องตามได้`);
    assert.equal(hit.provider.spec.id, "ntt-edc");
  }
  assert.equal(reg.getProvider("ntt-edc"), EDC);
});

test("ทะเบียนตัวจริงมี ntt-edc · derive canCancel/canPair/canCheckChannels = false", { skip: needIndex }, () => {
  const ids = INDEX.listProviders().map((s) => s.id);
  assert.ok(ids.includes("ntt-edc"), JSON.stringify(ids));
  assert.ok(!ids.includes("kbank-edc"), "Pack: EDC = NTT เท่านั้น");
  for (const k of ["canCancel", "canPair", "canCheckChannels"]) {
    assert.equal(k in EDC.spec, false, `${k} ต้องไม่ประกาศใน spec (derive จากฟังก์ชัน)`);
  }
});

// ══ ④ เนื้อ spec ═════════════════════════════════════════════════════════════
test("id · runtime device · channelChoice at-bill · คง 12 แถว", () => {
  assert.equal(EDC.spec.id, "ntt-edc");
  assert.equal(EDC.spec.runtime, "device");
  assert.equal(EDC.spec.channelChoice, "at-bill");
  assert.equal(EDC.spec.channels.length, 12, "at-bill ไม่ได้แปลว่าตัดกระเป๋า — จอตอนขายกางจากลิสต์นี้");
});

test("รหัสกระเป๋า = ตาราง trade_type ของ LinkPOS เป๊ะ (11 + ให้เครื่องเลือกเอง)", () => {
  const EXPECTED = [
    ["nttEdcAny", ""],
    ["nttEdcCard", "CARD"],
    ["nttEdcAlipayPlus", "ALIPAY+"],
    ["nttEdcWechat", "WECHATPAYCIL"],
    ["nttEdcTrueMoney", "TRUEMONEY"],
    ["nttEdcLinePay", "LINEPAY"],
    ["nttEdcShopeePay", "SHOPEE"],
    ["nttEdcBblQr", "BBL QRCS"],
    ["nttEdcThaiQr", "THAIQRCODE"],
    ["nttEdcAtome", "ATOME"],
    ["nttEdcSabuyMoney", "SABUYMONEY"],
    ["nttEdcMaxMe", "MAXME"],
  ];
  assert.deepEqual(EDC.spec.channels.map((c) => [c.channelId, c.tradeType]), EXPECTED);
  assert.deepEqual(Object.entries(EDC.TRADE_TYPES), EXPECTED, "TRADE_TYPES derive จาก spec");
  assert.ok(Object.isFrozen(EDC.TRADE_TYPES));
});

test("รหัสของ LinkPOS ต้องไม่ใช่ชุดตัวอักษรเดี่ยวของ h2h", () => {
  for (const c of EDC.spec.channels) {
    if (c.tradeType === "") continue;
    assert.ok(c.tradeType.length > 1, `${c.channelId}: ${c.tradeType}`);
    assert.equal(c.tradeType, c.tradeType.toUpperCase());
    assert.equal("tranType" in c, false, `${c.channelId}: tranType เป็นของ h2h`);
  }
});

test("รหัสไม่ชนกับ h2h · channelId ไม่ชน (ทิศกลับ: h2h ยังเป็นตัวอักษรเดี่ยว)", { skip: needBoth }, () => {
  const h2hCodes = new Set(H2H.spec.channels.map((c) => c.tranType));
  const h2hIds = new Set(H2H.spec.channels.map((c) => c.channelId));
  for (const c of EDC.spec.channels) {
    assert.ok(!h2hCodes.has(c.tradeType), c.channelId);
    assert.ok(!h2hIds.has(c.channelId), c.channelId);
  }
  for (const c of H2H.spec.channels) assert.equal(c.tranType.length, 1, c.channelId);
});

test("lastKnownAvailable = false ทุกแถว", () => {
  for (const c of EDC.spec.channels) assert.equal(c.lastKnownAvailable, false, c.channelId);
});

test("serviceTypes ตามตารางสเปกทีละแถว · nttEdcAny ไม่ประกาศ (ยังไม่รู้ ≠ ไม่มี)", () => {
  const EXPECTED = {
    nttEdcCard: [],
    nttEdcAlipayPlus: ["SCAN", "SHOWQR"],
    nttEdcWechat: ["SCAN", "SHOWQR"],
    nttEdcTrueMoney: ["SCAN"],
    nttEdcLinePay: ["SCAN", "SHOWQR"],
    nttEdcShopeePay: ["SCAN", "SHOWQR"],
    nttEdcBblQr: ["SHOWQR"],
    nttEdcThaiQr: ["SHOWQR"],
    nttEdcAtome: ["SHOWQR"],
    nttEdcSabuyMoney: ["SCAN"],
    nttEdcMaxMe: ["SCAN", "SHOWQR"],
  };
  for (const c of EDC.spec.channels) {
    if (c.channelId === "nttEdcAny") {
      assert.equal("serviceTypes" in c, false);
      continue;
    }
    assert.deepEqual(c.serviceTypes, EXPECTED[c.channelId], c.channelId);
  }
});

test("ไม่ประกาศ qrKind สักแถว (ไม่มี QR payload กลับมาถึงเรา)", () => {
  for (const c of EDC.spec.channels) assert.equal("qrKind" in c, false, c.channelId);
});

// ══ ⑤ การเชื่อมต่อ ═══════════════════════════════════════════════════════════
test("connection: ip บังคับ · port ไม่บังคับ default 8020 · ไม่มี secret/store/env", () => {
  assert.deepEqual(EDC.spec.connection.fields.map((f) => f.key), ["ip", "port"], "ชื่อตรงกับ device ของจุดคิดเงิน {ip, port}");
  const [ip, port] = EDC.spec.connection.fields;
  assert.equal(ip.required, false); // ที่อยู่จริงรายจุดคิดเงินอยู่ gatewayStations
  assert.equal(port.required, false);
  assert.equal(port.default, 8020);
  assert.equal(EDC.DEFAULT_PORT, port.default, "ค่าตั้งต้นที่เดียว");
  for (const f of EDC.spec.connection.fields) {
    assert.equal("secret" in f, false, `${f.key}: LinkPOS ไม่มี credential (linkpos:251-254)`);
    assert.equal("store" in f, false, `${f.key}: store ถูกห้ามในบ้านนี้`);
    assert.equal("env" in f, false, `${f.key}: IP เป็นของร้าน ไม่ใช่ค่าใน env`);
  }
});

test("connection.test = device-ping · note เอ่ยทุกช่องบังคับ + บอกว่าทดสอบแทนไม่ได้ + ไม่ครอบอะไร", () => {
  const t = EDC.spec.connection.test;
  assert.equal(t.kind, "device-ping");
  for (const f of EDC.spec.connection.fields.filter((x) => x.required)) assert.ok(t.note.includes(f.key), f.key);
  assert.match(t.note, /ทดสอบแทนไม่ได้/);
  assert.ok(t.note.includes("ไม่ครอบ"));
});

// ══ ⑥ i18n ══════════════════════════════════════════════════════════════════
test("i18n key ครบ 15 ตัว · รูป ASCII มีจุด · ไม่ซ้ำ · fallback ไทยครบทุกแถว", () => {
  const I18N = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;
  const keys = EDC.I18N_KEYS;
  assert.equal(keys.length, 1 + 2 + 12);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) {
    assert.ok(I18N.test(k), k);
    assert.ok(k.startsWith("screens.paymentGateway."), k);
    assert.ok(!/[฀-๿]/.test(k), k);
  }
  for (const c of EDC.spec.channels) assert.ok(keys.includes(c.nameKey), c.channelId);
  const fallbacks = [EDC.spec.labelFallback, ...EDC.spec.connection.fields.map((f) => f.labelFallback), ...EDC.spec.channels.map((c) => c.nameFallback)];
  for (const v of fallbacks) {
    assert.equal(typeof v, "string");
    assert.ok(v.trim());
    assert.ok(!I18N.test(v), `ก๊อป key มาวางแทนข้อความสำรอง — ${v}`);
  }
});

// ══ ⑦ ตัวช่วยล้วน ═══════════════════════════════════════════════════════════
test("channelOf / tradeTypeOf: ของเจ้านี้คืนแถว · ไม่รู้จัก/ไม่ใช่ string = null · nttEdcAny = ''", () => {
  assert.equal(EDC.channelOf("nttEdcThaiQr").tradeType, "THAIQRCODE");
  assert.equal(EDC.tradeTypeOf("nttEdcBblQr"), "BBL QRCS");
  assert.equal(EDC.tradeTypeOf("nttEdcAny"), "");
  assert.equal(EDC.channelOf("nttThaiQr"), null);
  assert.equal(EDC.tradeTypeOf("nope"), null);
  assert.equal(EDC.channelOf(undefined), null);
  assert.equal(EDC.channelOf({}), null);
});

test("deviceConfigOf: คัด {ip, port, name?} · port ผิด = 8020 · ip ผิด = null · ไม่ spread ของแปลก", () => {
  assert.deepEqual(EDC.deviceConfigOf({ ip: "192.168.1.55", port: 9001, name: " เคาน์เตอร์ 1 " }), { ip: "192.168.1.55", port: 9001, name: "เคาน์เตอร์ 1" });
  assert.deepEqual(EDC.deviceConfigOf({ ip: " 10.0.0.5 " }), { ip: "10.0.0.5", port: 8020 });
  assert.deepEqual(EDC.deviceConfigOf({ ip: "10.0.0.5", port: "9001" }), { ip: "10.0.0.5", port: 9001 }, "port สตริงตัวเลขจากฐานเก่า = แปลงเป็นเลข");
  for (const bad of [0, 65536, 1.5, "abc", null, -1]) {
    assert.equal(EDC.deviceConfigOf({ ip: "10.0.0.5", port: bad }).port, 8020, `port ${bad}`);
  }
  for (const badIp of ["", "  ", "300.1.1.1", "printer.local", "::1", 123, null]) {
    assert.equal(EDC.deviceConfigOf({ ip: badIp, port: 8020 }), null, `ip ${badIp}`);
  }
  for (const v of [null, undefined, "10.0.0.5", [], 5]) assert.equal(EDC.deviceConfigOf(v), null);
  const out = EDC.deviceConfigOf({ ip: "10.0.0.5", port: 8020, secretThing: "x", updatedBy: "u1" });
  assert.deepEqual(Object.keys(out).sort(), ["ip", "port"]);
  assert.equal(EDC.deviceConfigOf({ ip: "10.0.0.5", name: "x".repeat(100) }).name.length, 64);
});

test("saleRecordOf: trim ทุกช่อง · ว่าง/ไม่ใช่ string = null · ไม่มีช่องร้านอาหาร", () => {
  const rec = EDC.saleRecordOf({ invoiceNo: " 000123 ", posRefNo: "", tradeType: "THAIQRCODE", approvalCode: 5, terminalId: " T1 ", merchantId: null, checkoutType: "x" });
  assert.deepEqual(rec, { invoiceNo: "000123", posRefNo: null, tradeType: "THAIQRCODE", approvalCode: null, terminalId: "T1", merchantId: null });
  assert.equal("checkoutType" in rec, false);
  assert.deepEqual(EDC.saleRecordOf(undefined), { invoiceNo: null, posRefNo: null, tradeType: null, approvalCode: null, terminalId: null, merchantId: null });
});

test("hasSaleRef: ต้องมี invoiceNo หรือ posRefNo อย่างน้อย 1 ช่องที่มีเนื้อ", () => {
  assert.equal(EDC.hasSaleRef({ invoiceNo: "1" }), true);
  assert.equal(EDC.hasSaleRef({ posRefNo: "R1" }), true);
  assert.equal(EDC.hasSaleRef({ invoiceNo: "  ", posRefNo: null }), false);
  assert.equal(EDC.hasSaleRef({ approvalCode: "A1" }), false, "approvalCode ไม่นับเป็นเลขอ้างอิง");
  assert.equal(EDC.hasSaleRef(null), false);
});

test("saleReferenceIdOf: edcsale- + sha256(shopId|invoiceNo|posRefNo) 32 hex · คงที่ · ไม่ชนข้ามร้าน", () => {
  const expected = "edcsale-" + crypto.createHash("sha256").update("shopA|000123|R9", "utf8").digest("hex").slice(0, 32);
  assert.equal(EDC.saleReferenceIdOf({ shopId: "shopA", invoiceNo: "000123", posRefNo: "R9" }), expected);
  assert.match(expected, /^edcsale-[0-9a-f]{32}$/);
  assert.equal(EDC.saleReferenceIdOf({ shopId: "shopA", invoiceNo: " 000123 ", posRefNo: "R9" }), expected, "trim ก่อน = ยิงซ้ำได้เลขเดิม");
  const onlyInv = "edcsale-" + crypto.createHash("sha256").update("shopA|000123|", "utf8").digest("hex").slice(0, 32);
  assert.equal(EDC.saleReferenceIdOf({ shopId: "shopA", invoiceNo: "000123" }), onlyInv, "ช่องที่ไม่ส่ง = สตริงว่าง");
  assert.notEqual(EDC.saleReferenceIdOf({ shopId: "shopB", invoiceNo: "000123", posRefNo: "R9" }), expected);
  // ย้ายเลขข้ามช่องต้องได้คนละใบ (ตัวคั่นทำงาน)
  assert.notEqual(EDC.saleReferenceIdOf({ shopId: "shopA", invoiceNo: "R9", posRefNo: "000123" }), expected);
});

// ══ ⑧ ของที่ตัดทิ้ง ══════════════════════════════════════════════════════════
test("ไฟล์ provider ไม่มีของร้านอาหาร/เจ้าที่ตัดทิ้ง", () => {
  const src = fs.readFileSync(path.join(__dirname, "ntt-edc.js"), "utf8");
  for (const w of ["checkoutType", "autoCheckout", "kbank-edc", "receiptData", "require(\"@"]) {
    assert.ok(!src.includes(w), `เจอ ${w}`);
  }
});

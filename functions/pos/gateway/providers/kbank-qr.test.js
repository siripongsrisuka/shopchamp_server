// kbank-qr.test.js — รัน: cd shopchamp_server/functions && node --test pos/gateway/providers/kbank-qr.test.js
// 🔴 ห้ามออกเน็ต: เส้นนี้วิ่งผ่านเครื่องกลางที่ต่อธนาคารจริง และ createQR แปลงยอด 0 เป็น ฿1
//    ⇒ ฉีด http ปลอมผ่าน _setHttp ทุกเคส · env ฉีดผ่าน _setEnv (ไม่แตะ process.env)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KB = require("./kbank-qr");
const { spec, createQR, inquiry, cancelQR, testConnection, parseCallback, I18N_KEYS, mapTxnStatus } = KB;

// ── http ปลอม ────────────────────────────────────────────────────────────────
let CALLS = []; // { kind, url, body, headers }
let ROUTES = {};

function kindOf(url) {
  if (/\/createQR$/i.test(url)) return "createQR";
  if (/\/inquiry$/i.test(url)) return "inquiry";
  if (/\/cancel$/i.test(url)) return "cancel";
  return "unknown";
}

async function fakeHttp(url, body, opts) {
  const kind = kindOf(url);
  const headers = (opts && opts.headers) || {};
  CALLS.push({ kind, url, body, headers, timeout: opts && opts.timeout });
  const h = ROUTES[kind];
  if (!h) throw new Error(`เทสไม่ได้ตั้ง route สำหรับ ${kind} (${url})`);
  const out = await h(body, headers);
  if (out && out.__throw) throw out.__throw;
  return { status: 200, data: out };
}

// ค่าทดสอบ (ปลอม · ไม่ใช่ของจริง)
const FAKE_KEY = "fake-proxy-key-for-tests-only";
const FAKE_HEADER = "x-proxy-key";
const BASE_ENV = { KBANK_PROXY_URL: "https://proxy.example.invalid/uat/", KBANK_PROXY_KEY: FAKE_KEY, KBANK_PROXY_KEY_HEADER: FAKE_HEADER, KBANK_TEST_THROTTLE_MS: "0" };

const MID = "010555615233087";
const MID_OTHER = "010999999999999";
const CONFIG = { merchantId: MID };
const CH = spec.channels[0];

const envOk = (data) => ({ success: true, data });
const httpErr = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const netErr = () => Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
const timeoutErr = () => Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" });

function reset(routes, envExtra) {
  CALLS = [];
  ROUTES = Object.assign({}, routes || {});
  KB.__resetConnectionTestCache();
  KB._setHttp(fakeHttp);
  KB._setEnv(Object.assign({}, BASE_ENV, envExtra || {}));
}
const count = (kind) => CALLS.filter((c) => c.kind === kind).length;

test.after(() => {
  KB._resetHttp();
  KB._resetEnv();
});

// ══ ① สเปก ════════════════════════════════════════════════════════════════════
test("สเปก: id · runtime · 1 ช่องกรอก ไม่มี store/secret · 1 ช่องทาง ThaiQR qrType '3'", () => {
  assert.equal(spec.id, "kbank-qr");
  assert.equal(spec.runtime, "server");
  assert.deepEqual(spec.connection.fields.map((f) => f.key), ["merchantId"]);
  assert.equal(spec.connection.fields[0].required, true);
  for (const f of spec.connection.fields) {
    assert.ok(!("store" in f), "ช่อง store ห้ามมี (ทะเบียนปัด)");
    assert.equal(f.secret, undefined, "merchantId ไม่ใช่ความลับ");
  }
  assert.deepEqual(spec.channels.map((c) => c.channelId), ["kbankThaiQr"]);
  assert.equal(CH.qrKind, "text");
  assert.equal(CH.lastKnownAvailable, true);
  assert.equal(CH.qrType, "3");
  for (const k of ["canCancel", "canPair", "canCheckChannels"]) assert.ok(!(k in spec), `${k} ห้ามประกาศในสเปก`);
});

test("ทะเบียนรับเจ้านี้ได้ (ถ้ามี providers/index.js แล้ว)", (t) => {
  const idx = path.join(__dirname, "index.js");
  if (!fs.existsSync(idx)) return t.skip("providers/index.js ยังไม่มี");
  const { buildRegistry } = require("./index");
  assert.doesNotThrow(() => buildRegistry([KB]));
});

test("note ของปุ่มทดสอบเอ่ย merchantId + บอกว่าไม่ครอบอะไร + ไม่สร้างรายการเงิน", () => {
  const t = spec.connection.test;
  assert.equal(t.kind, "query-nonexistent");
  assert.ok(t.note.includes("merchantId"));
  assert.ok(t.note.includes("ไม่ครอบ"));
  assert.ok(/ไม่สร้างรายการเงิน/.test(t.note));
});

// ══ ② env ไม่ครบ = fail-closed · ไม่ยิงสักครั้ง ═════════════════════════════════════
test("🔴 env ขาด/ว่าง ตัวใดตัวหนึ่ง → kbank_proxy_not_configured ทุกฟังก์ชัน · http 0 ครั้ง · ไม่มีกุญแจในข้อความ", async () => {
  const allOk = () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b", txnStatus: "PAID" });
  const variants = [
    { KBANK_PROXY_URL: undefined },
    { KBANK_PROXY_URL: "   " },
    { KBANK_PROXY_KEY: undefined },
    { KBANK_PROXY_KEY: "" },
    { KBANK_PROXY_KEY_HEADER: undefined },
  ];
  for (const v of variants) {
    reset({ createQR: allOk, inquiry: allOk, cancel: allOk });
    const env = Object.assign({}, BASE_ENV);
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete env[k];
      else env[k] = val;
    }
    KB._setEnv(env);
    const results = [
      await createQR({ channel: CH, config: CONFIG, amount: 10, referenceId: "R" }),
      await inquiry({ channel: CH, config: CONFIG, providerRef: "P" }),
      await cancelQR({ channel: CH, config: CONFIG, providerRef: "P" }),
      await testConnection({ config: CONFIG }),
    ];
    for (const r of results) {
      assert.equal(r.ok, false, JSON.stringify(v));
      assert.equal(r.error.code, "kbank_proxy_not_configured", JSON.stringify(v));
      assert.ok(!JSON.stringify(r).includes(FAKE_KEY), "กุญแจห้ามหลุดในข้อความ");
      assert.ok(/Shopchamp/.test(r.error.message));
    }
    assert.equal(CALLS.length, 0, `${JSON.stringify(v)}: ยิงออกไปแล้ว = ไม่ fail-closed`);
  }
});

test("process.env เป็นค่าตั้งต้นเมื่อไม่ฉีด · env ใน input ชนะ _setEnv", async () => {
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b" }) });
  KB._resetEnv();
  const saved = {};
  for (const k of Object.keys(BASE_ENV)) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const r = await createQR({ channel: CH, config: CONFIG, amount: 1, referenceId: "R" });
    assert.equal(r.error.code, "kbank_proxy_not_configured", "process.env ว่าง = ปิด");
    Object.assign(process.env, BASE_ENV);
    const r2 = await createQR({ channel: CH, config: CONFIG, amount: 1, referenceId: "R" });
    assert.equal(r2.ok, true, JSON.stringify(r2));
  } finally {
    for (const k of Object.keys(BASE_ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b" }) });
  const r3 = await createQR({ channel: CH, config: CONFIG, amount: 1, referenceId: "R", env: { ...BASE_ENV, KBANK_PROXY_URL: "https://other.example.invalid/x" } });
  assert.equal(r3.ok, true);
  assert.equal(CALLS[0].url, "https://other.example.invalid/x/createQR");
});

test("URL + header กุญแจ มาจาก env (ตัด / ท้าย) · timeout ตั้งได้", async () => {
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b" }) }, { KBANK_TIMEOUT_MS: "5000" });
  await createQR({ channel: CH, config: CONFIG, amount: 1, referenceId: "R" });
  assert.equal(CALLS[0].url, "https://proxy.example.invalid/uat/createQR");
  assert.equal(CALLS[0].headers[FAKE_HEADER], FAKE_KEY);
  assert.equal(CALLS[0].timeout, 5000);
});

test("ไม่มีกุญแจ/URL ฝังในโค้ด (ไล่ไฟล์จริง)", () => {
  const src = fs.readFileSync(path.join(__dirname, "kbank-qr.js"), "utf8");
  assert.ok(!/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(src), "ห้ามมี URL ในโค้ด");
  assert.ok(!/1234/.test(src), "ห้ามมีกุญแจเดิม");
});

// ══ ③ ปุ่มทดสอบ ═════════════════════════════════════════════════════════════════
test("ปุ่มทดสอบผ่าน → verifiedFields ['merchantId'] · ยิง inquiry 1 · createQR 0", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00" }) });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.verifiedFields, ["merchantId"]);
  assert.ok(/ไม่มีรายการเงิน/.test(r.data.note));
  assert.equal(r.data.throttled, false);
  assert.equal(count("createQR"), 0);
  assert.equal(count("inquiry"), 1);
});

test("ปุ่มทดสอบส่ง merchantId ที่กรอกจริง (trim) · เลขรายการชนของจริงไม่ได้ และสุ่มใหม่ทุกครั้ง", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00" }) });
  await testConnection({ config: { merchantId: "  " + MID + "  " } });
  const sent = CALLS[0].body;
  assert.equal(sent.merchantId, MID);
  assert.ok(sent.origPartnerTxnUid.includes("-"), "เลขจริง = ตัวอักษรต่อตัวเลข ไม่มีขีด");
  assert.ok(!/^[A-Z]+\d+$/.test(sent.origPartnerTxnUid));
  reset({ inquiry: () => envOk({ statusCode: "00" }) });
  await testConnection({ config: { merchantId: MID_OTHER } });
  assert.notEqual(CALLS[0].body.origPartnerTxnUid, sent.origPartnerTxnUid);
});

const BANK_A = { statusCode: "10", errorCode: "invalid_origPartnerTxnUid", errorDesc: "origPartnerTxnUid does not exist. (EMITDNE)" };
const BANK_B = { statusCode: "10", errorCode: "invalid_merchant", errorDesc: "Merchant ID does not exist. (EMDNE)" };

test("ของจริง A: รหัสร้านถูก (invalid_origPartnerTxnUid · statusCode 10) = ผ่าน", async () => {
  reset({ inquiry: () => envOk(BANK_A) });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.verifiedFields, ["merchantId"]);
});

test("ของจริง B: invalid_merchant → kbank_merchant_rejected · แนบรหัส · ไม่แปะ errorDesc", async () => {
  reset({ inquiry: () => envOk(BANK_B) });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "kbank_merchant_rejected");
  assert.ok(/invalid_merchant/.test(r.error.message));
  assert.ok(!/EMDNE|does not exist/.test(r.error.message));
});

test("รหัสไม่รู้จัก → kbank_test_inconclusive (ไม่ผ่าน · ไม่ว่าเลขผิด · แสดงรหัสดิบ)", async () => {
  for (const code of ["invalid_something_new", "EGENERR"]) {
    reset({ inquiry: () => envOk({ statusCode: "10", errorCode: code, errorDesc: "Something we have never seen" }) });
    const r = await testConnection({ config: CONFIG });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "kbank_test_inconclusive");
    assert.ok(!/ไม่ถูกต้อง|รหัสร้านผิด/.test(r.error.message));
    assert.ok(r.error.message.includes(code));
    assert.ok(!/never seen/.test(r.error.message));
  }
  reset({ inquiry: () => envOk({ statusCode: "10" }) });
  const blank = await testConnection({ config: CONFIG });
  assert.equal(blank.error.code, "kbank_test_inconclusive");
});

test("เทียบรหัสไม่สนตัวพิมพ์ ทั้งทางผ่านและทางรหัสร้านผิด", async () => {
  for (const code of ["INVALID_ORIGPARTNERTXNUID", "invalid_origpartnertxnuid", "Invalid_OrigPartnerTxnUid"]) {
    reset({ inquiry: () => envOk({ statusCode: "10", errorCode: code }) });
    assert.equal((await testConnection({ config: CONFIG })).ok, true, code);
  }
  reset({ inquiry: () => envOk({ statusCode: "10", errorCode: "INVALID_MERCHANT" }) });
  assert.equal((await testConnection({ config: CONFIG })).error.code, "kbank_merchant_rejected");
});

test("🔴 ตัวกลาง/ธนาคารล่ม 4 รูป → 4 code แยก · ไม่ใช่รหัสร้านผิด · ไม่มีกุญแจในผล", async () => {
  const cases = [
    [() => ({ __throw: httpErr(500, { success: false, error: "getaddrinfo ENOTFOUND kbank" }) }), "kbank_upstream_error"],
    [() => ({ __throw: httpErr(403, { error: "Unauthorized" }) }), "kbank_proxy_unauthorized"],
    [() => ({ __throw: netErr() }), "kbank_proxy_unreachable"],
    [() => ({ __throw: timeoutErr() }), "kbank_proxy_timeout"],
  ];
  const seen = new Set();
  for (const [route, expected] of cases) {
    reset({ inquiry: route });
    const r = await testConnection({ config: CONFIG });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, expected);
    assert.ok(/ยังตรวจ|ไม่ใช่รหัสร้าน/.test(r.error.message), r.error.message);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
    seen.add(r.error.code);
  }
  assert.equal(seen.size, 4);
});

test("error ของปลายทางที่สะท้อนกุญแจกลับมา → ถูกปิดเป็น *** (ไม่หลุดขึ้นข้อความ)", async () => {
  reset({ inquiry: () => ({ __throw: httpErr(500, { success: false, error: `bad key ${FAKE_KEY}` }) }) });
  const r = await inquiry({ channel: CH, config: CONFIG, providerRef: "X" });
  assert.equal(r.error.code, "kbank_upstream_error");
  assert.ok(!r.error.message.includes(FAKE_KEY));
  reset({ inquiry: () => ({ success: false, error: `echo ${FAKE_KEY}` }) });
  const r2 = await inquiry({ channel: CH, config: CONFIG, providerRef: "X" });
  assert.ok(!r2.error.message.includes(FAKE_KEY));
});

test("200 แต่ซองไม่มี data → kbank_upstream_error", async () => {
  reset({ inquiry: () => ({ success: false, error: "boom" }) });
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.error.code, "kbank_upstream_error");
});

test("ไม่กรอก merchantId → config_missing ก่อนแตะเน็ต", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00" }) });
  for (const bad of [undefined, {}, { merchantId: "" }, { merchantId: "   " }]) {
    const r = await testConnection({ config: bad });
    assert.equal(r.error.code, "config_missing");
  }
  assert.equal(CALLS.length, 0);
});

test("รหัสใหม่ใส่ env ได้ (KBANK_QR_TEST_NOTFOUND_CODES) · ทับ invalid_merchant ไม่ได้", async () => {
  reset({ inquiry: () => envOk({ statusCode: "99", errorCode: "TXN404" }) });
  assert.equal((await testConnection({ config: CONFIG })).error.code, "kbank_test_inconclusive");
  reset({ inquiry: () => envOk({ statusCode: "99", errorCode: "txn404" }) }, { KBANK_QR_TEST_NOTFOUND_CODES: " TXN404 , OTHER " });
  assert.equal((await testConnection({ config: CONFIG })).ok, true);
  reset({ inquiry: () => envOk(BANK_B) }, { KBANK_QR_TEST_NOTFOUND_CODES: "INVALID_MERCHANT" });
  assert.equal((await testConnection({ config: CONFIG })).error.code, "kbank_merchant_rejected");
});

test("เบรกกดรัว: จำผลต่อ merchantId (ทั้งผ่านและล้ม) · คนละร้าน = ยิงจริง", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00" }) }, { KBANK_TEST_THROTTLE_MS: "60000" });
  assert.equal((await testConnection({ config: CONFIG })).data.throttled, false);
  const b = await testConnection({ config: CONFIG });
  assert.equal(b.data.throttled, true);
  assert.equal(count("inquiry"), 1);
  await testConnection({ config: { merchantId: MID_OTHER } });
  assert.equal(count("inquiry"), 2);
  reset({ inquiry: () => ({ __throw: netErr() }) }, { KBANK_TEST_THROTTLE_MS: "60000" });
  await testConnection({ config: CONFIG });
  await testConnection({ config: CONFIG });
  assert.equal(count("inquiry"), 1, "ผลล้มต้องถูกจำด้วย");
});

test("verifiedFields ตรง connection.fields[].key และครบทุกช่องบังคับ", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00" }) });
  const r = await testConnection({ config: CONFIG });
  const required = spec.connection.fields.filter((f) => f.required).map((f) => f.key);
  assert.deepEqual([...r.data.verifiedFields].sort(), [...required].sort());
});

// ══ ④ createQR ═════════════════════════════════════════════════════════════════
test("createQR สำเร็จ: partnerTxnUid → providerRef+chargeId · ref1 · ref2=shopId · ref3 · ❌ ไม่มี ref4", async () => {
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "TXN1755000000000", qrCode: "00020101021229370016A00000006770101" }) });
  const r = await createQR({ channel: CH, config: CONFIG, amount: 125.5, referenceId: "pgabc", shopId: "shopA", checkoutType: "autoCheckout" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data, { providerRef: "TXN1755000000000", chargeId: "TXN1755000000000", qrPayload: "00020101021229370016A00000006770101", qrKind: "text" });
  const sent = CALLS[0].body;
  assert.deepEqual(sent, { qrType: "3", merchantId: MID, amount: 125.5, ref1: "pgabc", ref3: "SHOPCHAMP", ref2: "shopA" });
  assert.ok(!("ref4" in sent), "checkoutType ถูกถอดแล้ว");
});

test("createQR ไม่มี shopId = ไม่ส่ง ref2", async () => {
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b" }) });
  await createQR({ channel: CH, config: CONFIG, amount: 1, referenceId: "R" });
  assert.ok(!("ref2" in CALLS[0].body));
});

test("🪤 createQR ยอด ≤ 0 / ไม่ใช่ตัวเลข → bad_amount ก่อนแตะเน็ต", async () => {
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "x", qrCode: "y" }) });
  for (const amount of [0, -5, "", null, undefined, NaN, "abc", " "]) {
    const r = await createQR({ channel: CH, config: CONFIG, amount, referenceId: "R" });
    assert.equal(r.error.code, "bad_amount", String(amount));
  }
  assert.equal(CALLS.length, 0);
});

test("createQR ธนาคารปฏิเสธ/ตอบไม่ครบ/input ผิด", async () => {
  reset({ createQR: () => envOk({ statusCode: "99", errorCode: "E01", errorDesc: "invalid merchant" }) });
  let r = await createQR({ channel: CH, config: CONFIG, amount: 10, referenceId: "R" });
  assert.equal(r.error.code, "kbank_error");
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "abc" }) });
  r = await createQR({ channel: CH, config: CONFIG, amount: 10, referenceId: "R" });
  assert.equal(r.error.code, "bad_response");
  reset({ createQR: () => envOk({ statusCode: "00", qrCode: "z" }) });
  r = await createQR({ channel: CH, config: CONFIG, amount: 10, referenceId: "R" });
  assert.equal(r.error.code, "bad_response");
  reset({ createQR: () => envOk({ statusCode: "00", partnerTxnUid: "a", qrCode: "b" }) });
  r = await createQR({ channel: CH, config: CONFIG, amount: 10, referenceId: "" });
  assert.equal(r.error.code, "bad_input");
  r = await createQR({ channel: { channelId: "x" }, config: CONFIG, amount: 10, referenceId: "R" });
  assert.equal(r.error.code, "bad_channel");
  assert.equal(CALLS.length, 0);
});

// ══ ⑤ inquiry ══════════════════════════════════════════════════════════════════
test("inquiry PAID → paid + amountPaid + raw · body {merchantId, origPartnerTxnUid}", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00", txnStatus: "PAID", txnAmount: 125.5 }) });
  const r = await inquiry({ channel: CH, config: CONFIG, providerRef: "TXN1", expectedAmount: 125.5 });
  assert.equal(r.data.state, "paid");
  assert.equal(r.data.amountPaid, 125.5);
  assert.equal(r.data.raw.txnStatus, "PAID");
  assert.deepEqual(CALLS[0].body, { merchantId: MID, origPartnerTxnUid: "TXN1" });
});

test("inquiry REQUESTED → waiting (amountPaid = ยอดของรายการ แม้ยังไม่จ่าย) · EXPIRED → closed", async () => {
  reset({ inquiry: () => envOk({ statusCode: "00", txnStatus: "REQUESTED", txnAmount: 129 }) });
  let r = await inquiry({ channel: CH, config: CONFIG, providerRef: "TXN1" });
  assert.equal(r.data.state, "waiting");
  assert.equal(r.data.amountPaid, 129);
  reset({ inquiry: () => envOk({ statusCode: "00", txnStatus: "EXPIRED", txnAmount: 129 }) });
  r = await inquiry({ channel: CH, config: CONFIG, providerRef: "TXN1" });
  assert.equal(r.data.state, "closed");
});

test("🔴 mapTxnStatus: ไม่รู้จัก = error (ไม่ใช่ waiting) · ชุดควบคุมที่รู้จักต้องแปลได้", () => {
  KB._setEnv({});
  assert.equal(mapTxnStatus("paid"), "paid");
  assert.equal(mapTxnStatus("requested"), "waiting");
  assert.equal(mapTxnStatus("expired"), "closed");
  for (const s of ["PENDING", "CANCELED", "VOIDED", "", null, undefined, 123, {}]) assert.equal(mapTxnStatus(s), "error", JSON.stringify(s));
});

test("สถานะเติมทาง env ได้ · ทับ PAID ไม่ได้ · ไม่มีคันโยก STATUS_PAID", () => {
  KB._setEnv({ KBANK_QR_STATUS_WAITING: "PENDING, notpay ", KBANK_QR_STATUS_CLOSED: "CANCELED,paid" });
  assert.equal(mapTxnStatus("PENDING"), "waiting");
  assert.equal(mapTxnStatus("notpay"), "waiting");
  assert.equal(mapTxnStatus("Canceled"), "closed");
  assert.equal(mapTxnStatus("PAID"), "paid");
  assert.equal(mapTxnStatus("VOIDED"), "error");
  KB._setEnv({ KBANK_QR_STATUS_PAID: "PENDING" });
  assert.equal(mapTxnStatus("PENDING"), "error");
  KB._setEnv({});
  assert.equal(mapTxnStatus("PENDING"), "error", "ถอน env แล้วกลับไป fail-closed ทันที");
});

test("inquiry statusCode ≠ 00 → kbank_error · ล่ม → code ชั้นเครือข่าย · providerRef ว่าง → bad_input", async () => {
  reset({ inquiry: () => envOk({ statusCode: "99", errorDesc: "not found" }) });
  assert.equal((await inquiry({ channel: CH, config: CONFIG, providerRef: "X" })).error.code, "kbank_error");
  reset({ inquiry: () => ({ __throw: httpErr(500, { success: false, error: "upstream down" }) }) });
  assert.equal((await inquiry({ channel: CH, config: CONFIG, providerRef: "X" })).error.code, "kbank_upstream_error");
  reset({ inquiry: () => envOk({ statusCode: "00", txnStatus: "PAID" }) });
  assert.equal((await inquiry({ channel: CH, config: CONFIG, providerRef: "  " })).error.code, "bad_input");
  assert.equal(CALLS.length, 0);
});

// ══ ⑥ cancelQR ═════════════════════════════════════════════════════════════════
test("cancelQR สำเร็จ → canceled:true · ยิง /cancel · ไม่แตะ createQR", async () => {
  reset({ cancel: () => envOk({ statusCode: "00" }) });
  const r = await cancelQR({ channel: CH, config: CONFIG, providerRef: "TXN1" });
  assert.equal(r.data.canceled, true);
  assert.deepEqual(CALLS[0].body, { merchantId: MID, origPartnerTxnUid: "TXN1" });
  assert.equal(count("createQR"), 0);
});

test("cancelQR ธนาคารปฏิเสธ → kbank_error · เน็ตล้ม → kbank_proxy_unreachable · ref ว่าง → bad_input", async () => {
  reset({ cancel: () => envOk({ statusCode: "10", errorCode: "invalid_origPartnerTxnUid" }) });
  assert.equal((await cancelQR({ channel: CH, config: CONFIG, providerRef: "NOPE" })).error.code, "kbank_error");
  reset({ cancel: () => ({ __throw: netErr() }) });
  assert.equal((await cancelQR({ channel: CH, config: CONFIG, providerRef: "TXN1" })).error.code, "kbank_proxy_unreachable");
  reset({});
  assert.equal((await cancelQR({ channel: CH, config: CONFIG, providerRef: "  " })).error.code, "bad_input");
  assert.equal(CALLS.length, 0);
});

// ══ ⑦ parseCallback ════════════════════════════════════════════════════════════
test("parseCallback: reference1 → referenceId (trim · ตัวเลขเป็นสตริง) + ค่าใบ้ providerRef/amount/state + raw", () => {
  KB._setEnv({});
  const body = { partnerTxnUid: "TXN9", partnerId: "P1", statusCode: "00", txnAmount: "129.50", txnStatus: "PAID", reference1: " pgabc ", reference2: "shopA" };
  const r = parseCallback(body);
  assert.deepEqual(r, { ok: true, referenceId: "pgabc", raw: body, providerRef: "TXN9", amount: 129.5, state: "paid" });
  assert.equal(parseCallback({ reference1: 123 }).referenceId, "123");
  const minimal = parseCallback({ reference1: "pgx" });
  assert.equal(minimal.ok, true);
  for (const k of ["providerRef", "amount", "state"]) assert.ok(!(k in minimal), `${k} ไม่มีใน body = ไม่มีในผล`);
});

test("parseCallback: ไม่มี reference1 / มี '/' / body เพี้ยน → ok:false", () => {
  assert.equal(parseCallback({ partnerTxnUid: "x" }).error.code, "no_reference1");
  assert.equal(parseCallback({ reference1: "  " }).error.code, "no_reference1");
  assert.equal(parseCallback({ reference1: "a/b" }).error.code, "no_reference1");
  assert.equal(parseCallback({ reference1: null }).error.code, "no_reference1");
  for (const bad of [null, undefined, "str", [], 5]) assert.equal(parseCallback(bad).error.code, "bad_callback");
});

test("parseCallback บริสุทธิ์: ไม่แตะ http แม้ env พร้อม", () => {
  reset({});
  parseCallback({ reference1: "pgabc", txnStatus: "PAID" });
  assert.equal(CALLS.length, 0);
});

// ══ ⑧ i18n ═════════════════════════════════════════════════════════════════════
test("I18N_KEYS ครบ 3 · derive จากสเปก · ไม่มีอักษรไทย · fallback ไม่ซ้ำ key", () => {
  assert.deepEqual(I18N_KEYS, [
    "screens.paymentGateway.provider.kbank-qr.name",
    "screens.paymentGateway.field.kbank-qr.merchantId",
    "screens.paymentGateway.channel.kbankThaiQr",
  ]);
  for (const k of I18N_KEYS) assert.ok(!/[฀-๿]/.test(k));
  for (const v of [spec.labelFallback, spec.connection.fields[0].labelFallback, CH.nameFallback]) {
    assert.ok(typeof v === "string" && v.trim() && /[฀-๿]/.test(v));
  }
});
